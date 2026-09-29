import { clusterGatewayUrl } from './clusterInstall.js';

export type InstallOptions = {
  /** PEM of the certificate authority that signed the harness certificate; the commands write it out. */
  caPem?: string;
  /** Where that CA file already is on the target machine; the commands use it from there. Wins over caPem. */
  caPath?: string;
  /** The harness certificate is publicly trusted: no CA is needed, and the commands carry no CA hints. */
  publicCertificate?: boolean;
};

/** Accepts only a PEM certificate chain (markers and base64 body), so nothing else can be spliced into a shell heredoc. */
export function normalizeCaPem(pem: string | undefined): string | undefined {
  if (!pem) return undefined;
  const text = pem.replace(/\r\n?/g, '\n').trim();
  if (!/^(-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?)+$/.test(`${text}\n`))
    return undefined;
  return text;
}

/**
 * Validates a CA path typed by the user before it goes into a shell or PowerShell command. On Linux it must be absolute
 * or start with ~/ (returned as $HOME/... so it expands inside double quotes); on Windows a drive path. Quotes, $,
 * backticks and other characters a shell would interpret are refused.
 */
export function normalizeCaPath(path: string | undefined, platform?: string): string | undefined {
  const text = (path ?? '').trim();
  if (!text) return undefined;
  // Chrome runs on either system; its path only appears in the instructions, so accept both forms there.
  if (platform === 'windows' || (platform === 'chrome' && /^[A-Za-z]:\\/.test(text))) {
    if (!/^[A-Za-z]:\\[\w .()@+\\-]*$/.test(text))
      throw new Error(
        'Enter the CA path as a full Windows path, for example C:\\certs\\ca.crt, without quotes.',
      );
    return text;
  }
  const home = text.startsWith('~/');
  const rest = home ? text.slice(2) : text;
  if (!(home || text.startsWith('/')) || !/^[\w./ @+-]+$/.test(rest))
    throw new Error(
      'Enter the CA path as an absolute path such as /home/you/ca.crt, or one starting with ~/, without quotes, $ or backslashes.',
    );
  return home ? `$HOME/${rest}` : text;
}

export function machineInstallSnippets(
  device: { device_id: string; access_mode?: 'restricted' | 'host'; platform?: string },
  suppliedToken: string,
  gateway: string,
  options: InstallOptions = {},
) {
  const connectUrl = clusterGatewayUrl(gateway);
  const token = suppliedToken || 'REPLACE_WITH_SAVED_DEVICE_TOKEN';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(device.device_id) || !/^[A-Za-z0-9._-]{16,512}$/.test(token))
    throw new Error('Invalid device ID or token');
  const insecure = connectUrl.startsWith('ws://');
  // How the connector trusts the harness certificate: a CA file already on the machine, the CA written out by the
  // command itself, a publicly trusted certificate, or (none of those known) a hint to add one.
  const caPath = insecure ? undefined : normalizeCaPath(options.caPath, device.platform);
  const caPem = insecure || caPath || options.publicCertificate ? undefined : normalizeCaPem(options.caPem);
  const caHints = !insecure && !caPath && !caPem && !options.publicCertificate;
  const caSource = caPath ?? (caPem ? '$PWD/ca.crt' : undefined);
  const host = device.access_mode === 'host';
  const clone = 'git clone https://github.com/deepfinery/OpenHarness.git\ncd OpenHarness';
  const caFile = caPem ? `cat > ca.crt <<'OPENHARNESS_CA'\n${caPem}\nOPENHARNESS_CA\n` : '';
  const caMount = caSource ? `  -v "${caSource}:/certs/ca.crt:ro" \\\n` : '';
  const environment = (caVariable: string) =>
    `GATEWAY_URL=${connectUrl}\nDEVICE_ID=${device.device_id}\nDEVICE_TOKEN=${token}\nGATEWAY_ALLOW_INSECURE=${insecure}\n${caSource ? `${caVariable}=/certs/ca.crt\n` : ''}`;
  const saved = (caVariable: string) =>
    `umask 077\n${caFile}cat > machine.env <<'OPENHARNESS_ENV'\n${environment(caVariable)}OPENHARNESS_ENV`;
  const caHint = (caVariable: string) =>
    caHints
      ? `# Self-signed harness certificate? Copy its ca.crt here and add to the run command:\n#   -v "$PWD/ca.crt:/certs/ca.crt:ro" -e ${caVariable}=/certs/ca.crt\n`
      : '';
  // The OpenShell edge reads its CA inside the container, where ./certs is mounted as /certs; the edge runs as its own
  // user, so the file must be readable by others (a copy made under umask 077 is not).
  const openshellCa = caPem
    ? `mkdir -p certs && cat > certs/ca.crt <<'OPENHARNESS_CA'\n${caPem}\nOPENHARNESS_CA\nchmod 644 certs/ca.crt\n`
    : caPath
      ? `mkdir -p certs && cp "${caPath}" certs/ca.crt && chmod 644 certs/ca.crt\n`
      : '';
  const openshellCaEnv =
    caSource || caHints
      ? `${caHints ? '# Self-signed harness certificate: copy the server\u2019s data/tls/ca.crt to ./certs/ca.crt first.\n# Keep the value below as it is: it is the path inside the edge container, where ./certs is mounted as /certs.\n' : ''}OPENHARNESS_CA_FILE=/certs/ca.crt\n`
      : '';
  const windowsCa = caPem
    ? `@'\n${caPem}\n'@ | Set-Content -Path ca.crt -Encoding ascii\nImport-Certificate -FilePath ca.crt -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null\n`
    : caPath
      ? `Import-Certificate -FilePath '${caPath}' -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null\n`
      : '';
  const chromeCa = caPath
    ? `\n4. Import the harness CA at ${options.caPath!.trim()} into the operating system trust store, which Chrome uses.`
    : caPem || caHints
      ? '\n4. Self-signed harness certificate: import its ca.crt into the operating system trust store, which Chrome uses.'
      : '';
  const name = `openharness-${device.device_id}`;
  return {
    linux: host
      ? 'Privileged host access uses the Container tab. The native Linux service is restricted.'
      : `${clone}\n# Node.js 22.13+ and npm must be installed.\nnpm --prefix connector-core ci && npm --prefix connector-core run build\nnpm --prefix connector-linux ci && npm --prefix connector-linux run build\n${caFile}sudo GATEWAY_URL='${connectUrl}' DEVICE_ID='${device.device_id}' DEVICE_TOKEN='${token}' GATEWAY_ALLOW_INSECURE=${insecure}${caSource ? ` GATEWAY_CA_FILE="${caSource}"` : ''} sh connector-linux/install.sh${caHints ? '\n# Self-signed harness certificate? Add GATEWAY_CA_FILE=<path to its ca.crt> to the install command.' : ''}`,
    docker: host
      ? `${clone}\n\n${saved('NODE_EXTRA_CA_CERTS')}\n\ndocker build -f connector-linux/Dockerfile -t openharness-connector-linux .\n# For an existing installation, stop/remove its old connector first.\n# This replaces only the connector container; the work directory is on the host.\n# docker rm -f ${name}\nmkdir -p machine-work\ndocker run -d --name ${name} --restart unless-stopped \\\n  --env-file ./machine.env -e DEVICE_HOSTNAME="$(hostname)" \\\n  --privileged --pid=host --user 0 -e HOST_ACCESS=true -e MACHINE_ACCESS_MODE=host \\\n${caMount}  -v "$PWD/machine-work:/work" openharness-connector-linux\n${caHint('NODE_EXTRA_CA_CERTS')}docker logs --tail 50 ${name}`
      : `${clone}\n\n${saved('GATEWAY_CA_FILE')}\n\n# The Go connector: one small image, no host install. Build it once (or pull it from your registry).\ndocker build -f connector-go/Dockerfile -t openharness-connector .\n# For an existing installation, stop/remove its old connector first: docker rm -f ${name}\nmkdir -p machine-work && sudo chown 1000:1000 machine-work\ndocker run -d --name ${name} --restart unless-stopped \\\n  --env-file ./machine.env -e DEVICE_HOSTNAME="$(hostname)" \\\n  --security-opt no-new-privileges:true --cap-drop ALL \\\n${caMount}  -v "$PWD/machine-work:/work" openharness-connector\n${caHint('GATEWAY_CA_FILE')}docker logs --tail 50 ${name}`,
    windows: `# PowerShell as Administrator, from a checkout of this repository (connector-windows ships in the next release):\n${windowsCa}$env:GATEWAY_URL='${connectUrl}'; $env:DEVICE_ID='${device.device_id}'; $env:DEVICE_TOKEN='${token}'${insecure ? "; $env:GATEWAY_ALLOW_INSECURE='true'" : ''}\n.\\connector-windows\\install.ps1`,
    openshell: `# On the OpenShell host (the machine that will run the sandboxes). Docker Engine 28+ and a Landlock-capable kernel are required.\n${clone}\n\n# 1. Build the edge and executor images on this host (or pull them from your registry).\nsh deploy/openshell/build-images.sh\n\n# 2. Configure the deployment with this machine's token.\ncd deploy/openshell\numask 077\n${openshellCa}cat > .env <<'OPENHARNESS_ENV'\nOPENHARNESS_GATEWAY_URL=${connectUrl}\nOPENHARNESS_DEVICE_ID=${device.device_id}\nOPENHARNESS_TOKEN=${token}\nOPENHARNESS_ALLOW_INSECURE=${insecure}\n${openshellCaEnv}OPENSHELL_VERSION=0.1.2\nEXECUTOR_IMAGE=openharness-connector:local\nEDGE_IMAGE=openharness-edge:local\nOPENHARNESS_ENV\n\n# 3. Start OpenShell and the edge (the first run creates the OpenShell PKI); the machine turns online in the inventory.\nsh up.sh\ndocker compose logs -f openharness-edge`,
    chrome: `1. Load connector-chrome/dist as an unpacked extension (chrome://extensions, Developer mode).\n2. Open the extension options and enter:\n   Gateway: ${connectUrl}\n   Device ID: ${device.device_id}\n   Token: ${token}\n3. Allow the sites the agent may control. (The Chrome connector ships in the next release.)${chromeCa}`,
  };
}
