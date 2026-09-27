import { clusterGatewayUrl } from './clusterInstall.js';

export function machineInstallSnippets(
  device: { device_id: string; access_mode?: 'restricted' | 'host' },
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
    docker: `${clone}\n\n${saved}\n\ndocker build -f connector-linux/Dockerfile -t openharness-connector-linux .\n# For an existing installation, stop/remove its old connector first.\n# This replaces only the connector container; the work directory is on the host.\n# docker rm -f ${name}\nmkdir -p machine-work\n${host ? '' : 'sudo chown 1000:1000 machine-work\n'}docker run -d --name ${name} --restart unless-stopped \\\n  --env-file ./machine.env -e DEVICE_HOSTNAME="$(hostname)"${host ? ' \\\n  --privileged --pid=host --user 0 -e HOST_ACCESS=true -e MACHINE_ACCESS_MODE=host' : ' \\\n  --security-opt no-new-privileges:true --cap-drop ALL -e MACHINE_ACCESS_MODE=restricted'} \\\n  -v "$PWD/machine-work:/work" openharness-connector-linux\ndocker logs --tail 50 ${name}`,
    windows: `# PowerShell as Administrator, from a checkout of this repository (connector-windows ships in the next release):\n$env:GATEWAY_URL='${connectUrl}'; $env:DEVICE_ID='${device.device_id}'; $env:DEVICE_TOKEN='${token}'${insecure ? "; $env:GATEWAY_ALLOW_INSECURE='true'" : ''}\n.\\connector-windows\\install.ps1`,
    chrome: `1. Load connector-chrome/dist as an unpacked extension (chrome://extensions, Developer mode).\n2. Open the extension options and enter:\n   Gateway: ${connectUrl}\n   Device ID: ${device.device_id}\n   Token: ${token}\n3. Allow the sites the agent may control. (The Chrome connector ships in the next release.)`,
  };
}
