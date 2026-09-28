import { clusterGatewayUrl } from './clusterInstall.js';

export function machineInstallSnippets(
  device: { device_id: string; access_mode?: 'restricted' | 'host'; platform?: string },
  suppliedToken: string,
  gateway: string,
) {
  const connectUrl = clusterGatewayUrl(gateway);
  const token = suppliedToken || 'REPLACE_WITH_SAVED_DEVICE_TOKEN';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(device.device_id) || !/^[A-Za-z0-9._-]{16,512}$/.test(token))
    throw new Error('Invalid device ID or token');
  const insecure = connectUrl.startsWith('ws://');
  const host = device.access_mode === 'host';
  const clone = 'git clone https://github.com/deepfinery/OpenHarness.git\ncd OpenHarness';
  const environment = `GATEWAY_URL=${connectUrl}\nDEVICE_ID=${device.device_id}\nDEVICE_TOKEN=${token}\nGATEWAY_ALLOW_INSECURE=${insecure}\n`;
  const saved = `umask 077\ncat > machine.env <<'OPENHARNESS_ENV'\n${environment}OPENHARNESS_ENV`;
  const name = `openharness-${device.device_id}`;
  return {
    linux: host
      ? 'Privileged host access uses the Container tab. The native Linux service is restricted.'
      : `${clone}\n# Node.js 22.13+ and npm must be installed.\nnpm --prefix connector-core ci && npm --prefix connector-core run build\nnpm --prefix connector-linux ci && npm --prefix connector-linux run build\nsudo GATEWAY_URL='${connectUrl}' DEVICE_ID='${device.device_id}' DEVICE_TOKEN='${token}' GATEWAY_ALLOW_INSECURE=${insecure} sh connector-linux/install.sh`,
    docker: host
      ? `${clone}\n\n${saved}\n\ndocker build -f connector-linux/Dockerfile -t openharness-connector-linux .\n# For an existing installation, stop/remove its old connector first.\n# This replaces only the connector container; the work directory is on the host.\n# docker rm -f ${name}\nmkdir -p machine-work\ndocker run -d --name ${name} --restart unless-stopped \\\n  --env-file ./machine.env -e DEVICE_HOSTNAME="$(hostname)" \\\n  --privileged --pid=host --user 0 -e HOST_ACCESS=true -e MACHINE_ACCESS_MODE=host \\\n  -v "$PWD/machine-work:/work" openharness-connector-linux\ndocker logs --tail 50 ${name}`
      : `${clone}\n\n${saved}\n\n# The Go connector: one small image, no host install. Build it once (or pull it from your registry).\ndocker build -f connector-go/Dockerfile -t openharness-connector .\n# For an existing installation, stop/remove its old connector first: docker rm -f ${name}\nmkdir -p machine-work && sudo chown 1000:1000 machine-work\ndocker run -d --name ${name} --restart unless-stopped \\\n  --env-file ./machine.env -e DEVICE_HOSTNAME="$(hostname)" \\\n  --security-opt no-new-privileges:true --cap-drop ALL \\\n  -v "$PWD/machine-work:/work" openharness-connector\n# Self-signed harness certificate? Copy its ca.crt here and add to the run command:\n#   -v "$PWD/ca.crt:/etc/openharness/ca.crt:ro" -e GATEWAY_CA_FILE=/etc/openharness/ca.crt\ndocker logs --tail 50 ${name}`,
    windows: `# PowerShell as Administrator, from a checkout of this repository (connector-windows ships in the next release):\n$env:GATEWAY_URL='${connectUrl}'; $env:DEVICE_ID='${device.device_id}'; $env:DEVICE_TOKEN='${token}'${insecure ? "; $env:GATEWAY_ALLOW_INSECURE='true'" : ''}\n.\\connector-windows\\install.ps1`,
    openshell: `# On the OpenShell host (the machine that will run the sandboxes). Docker Engine 28+ and a Landlock-capable kernel are required.\n${clone}\n\n# 1. Build the edge and executor images on this host (or pull them from your registry).\nsh deploy/openshell/build-images.sh\n\n# 2. Configure the deployment with this machine's token.\ncd deploy/openshell && cp .env.example .env\numask 077\ncat > .env <<'OPENHARNESS_ENV'\nOPENHARNESS_GATEWAY_URL=${connectUrl}\nOPENHARNESS_DEVICE_ID=${device.device_id}\nOPENHARNESS_TOKEN=${token}\nOPENHARNESS_ALLOW_INSECURE=${insecure}\n${insecure ? '' : '# Self-signed harness certificate: copy the server\u2019s data/tls/ca.crt into ./certs first.\nOPENHARNESS_CA_FILE=/certs/ca.crt\n'}OPENSHELL_VERSION=0.1.2\nEXECUTOR_IMAGE=openharness-connector:local\nEDGE_IMAGE=openharness-edge:local\nOPENHARNESS_ENV\n\n# 3. Start OpenShell and the edge; the machine turns online in the inventory.\ndocker compose up -d\ndocker compose logs -f openharness-edge`,
    chrome: `1. Load connector-chrome/dist as an unpacked extension (chrome://extensions, Developer mode).\n2. Open the extension options and enter:\n   Gateway: ${connectUrl}\n   Device ID: ${device.device_id}\n   Token: ${token}\n3. Allow the sites the agent may control. (The Chrome connector ships in the next release.)`,
  };
}
