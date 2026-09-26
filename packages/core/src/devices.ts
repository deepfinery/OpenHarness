// Machines: devices enrolled at the gateway, mirrored as `device` connections so agents can use their tools.
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { encrypt, HttpError } from './security.js';
import { discoverTools } from './mcp.js';
import type { devicePlatforms } from './schema.js';

export type Platform = (typeof devicePlatforms)[number];
export type DeviceView = {
  device_id: string;
  cluster_id?: string;
  name: string;
  platform: Platform;
  owner: string;
  online: boolean;
  disabled: boolean;
  hostname: string | null;
  connector_version: string | null;
  capabilities: string[];
  last_seen: string | null;
  connected_at: string | null;
  allowed_tools: string[];
  tool_count: number | null;
  created_at: string;
  endpoint: string;
  pending_requests: number;
};
export type Machine = DeviceView & { connectionId?: string; tools: { name: string; description?: string }[] };
type ConnectionRecord = {
  _id: string;
  ownerId: string;
  name: string;
  url: string;
  transport: 'http';
  authType: 'token';
  tokenEncrypted: string;
  tokenHeader: string;
  enabled: boolean;
  kind: 'device';
  deviceId: string;
  platform: Platform;
  tools?: { name: string; description?: string }[];
  createdBy?: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Tools each connector platform ships; the enrollment form offers them as the allow-list. */
export const deviceToolCatalog: Record<Platform, { name: string; description: string; risky?: boolean }[]> = {
  linux: [
    { name: 'run_command', description: 'Run an allow-listed program (argv, no shell)', risky: true },
    { name: 'read_file', description: 'Read a text file in the work directory' },
    { name: 'write_file', description: 'Write a text file in the work directory', risky: true },
    { name: 'list_dir', description: 'List a directory' },
    { name: 'search_files', description: 'Find files by name or content' },
    { name: 'system_info', description: 'Host, OS, CPU, memory, load' },
    { name: 'gpu_inspect', description: 'Host NVIDIA, NVLink, DCGM and kernel logs (host access required)' },
    {
      name: 'gpu_remediate',
      description: 'Controlled GPU reset, Fabric Manager restart or host reboot',
      risky: true,
    },
    { name: 'process_list', description: 'Running processes' },
  ],
  windows: [
    { name: 'run_command', description: 'Run an allow-listed program or PowerShell script', risky: true },
    { name: 'read_file', description: 'Read a text file in the work directory' },
    { name: 'write_file', description: 'Write a text file in the work directory', risky: true },
    { name: 'list_dir', description: 'List a directory' },
    { name: 'search_files', description: 'Find files by name or content' },
    { name: 'system_info', description: 'Host, OS, CPU, memory' },
    { name: 'process_list', description: 'Running processes' },
    { name: 'list_windows', description: 'Top-level windows (UI Automation)', risky: true },
    { name: 'get_ui_tree', description: 'Accessibility tree of a window (UI Automation)', risky: true },
    { name: 'click_element', description: 'Click a UI element (UI Automation)', risky: true },
    { name: 'set_text', description: 'Type into a UI element (UI Automation)', risky: true },
  ],
  chrome: [
    { name: 'list_tabs', description: 'Open tabs' },
    { name: 'navigate', description: 'Open a URL in a tab', risky: true },
    { name: 'get_accessibility_tree', description: 'Accessibility tree of a page' },
    { name: 'click', description: 'Click an element', risky: true },
    { name: 'type', description: 'Type into an element', risky: true },
    { name: 'press_key', description: 'Press a key', risky: true },
    { name: 'observe_network', description: 'Recent network requests of a tab' },
    { name: 'evaluate_js', description: 'Run JavaScript in a page (feature flag)', risky: true },
  ],
};
export const gatewayConfigured = () =>
  Boolean(config.GATEWAY_URL && config.GATEWAY_API_TOKEN && config.GATEWAY_ADMIN_TOKEN);
export const gatewayPublicUrl = () => (config.GATEWAY_PUBLIC_URL || config.GATEWAY_URL).replace(/\/$/, '');
const connections = () => collection<ConnectionRecord>('connections');

export async function gatewayAdmin<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!gatewayConfigured())
    throw new HttpError(
      501,
      'No device gateway is configured (GATEWAY_URL, GATEWAY_API_TOKEN, GATEWAY_ADMIN_TOKEN)',
    );
  let response: Response;
  try {
    response = await fetch(`${config.GATEWAY_URL.replace(/\/$/, '')}/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.GATEWAY_ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new HttpError(
      502,
      `The device gateway is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new HttpError(
      response.status === 401 ? 502 : response.status,
      data.error ?? `Gateway request failed (${response.status})`,
    );
  return data as T;
}
/** Creates or refreshes the `device` connection that lets agents call this machine through the gateway. */
export async function ensureDeviceConnection(ownerId: string, device: DeviceView, userId?: string) {
  const now = new Date();
  const fields = {
    name: device.name || device.device_id,
    url: `${config.GATEWAY_URL.replace(/\/$/, '')}/mcp/${device.device_id}`,
    transport: 'http' as const,
    authType: 'token' as const,
    tokenEncrypted: encrypt(config.GATEWAY_API_TOKEN),
    tokenHeader: 'Authorization',
    enabled: !device.disabled,
    kind: 'device' as const,
    deviceId: device.device_id,
    platform: device.platform,
    updatedAt: now,
  };
  const record = await connections()
    .findOneAndUpdate(
      { ownerId, kind: 'device', deviceId: device.device_id },
      {
        $set: fields,
        $inc: { revision: 1 },
        $setOnInsert: {
          _id: randomUUID(),
          ownerId,
          createdAt: now,
          ...(userId ? { createdBy: userId } : {}),
        },
      },
      { upsert: true, returnDocument: 'after' },
    )
    .catch(async (error) => {
      if (error?.code !== 11000) throw error;
      return connections().findOne({ ownerId, kind: 'device', deviceId: device.device_id });
    });
  const id = record!._id;
  // Tool discovery needs the device online; a failure leaves the previous list in place.
  if (device.online) await discoverTools(ownerId, id!).catch(() => undefined);
  return id!;
}
export async function listMachines(
  ownerId: string,
): Promise<{ configured: boolean; publicUrl: string; machines: Machine[] }> {
  if (!gatewayConfigured()) return { configured: false, publicUrl: '', machines: [] };
  const { devices } = await gatewayAdmin<{ devices: DeviceView[] }>(
    `/devices?owner=${encodeURIComponent(ownerId)}`,
  );
  let records = await connections().find({ ownerId, kind: 'device' }).toArray();
  // A machine that came online after enrollment has no tool list yet: discover it now, so no manual sync is needed.
  const pending = devices.filter(
    (d) => d.online && !d.disabled && !records.find((r) => r.deviceId === d.device_id)?.tools?.length,
  );
  if (pending.length) {
    await Promise.all(
      pending.slice(0, 8).map((d) => ensureDeviceConnection(ownerId, d).catch(() => undefined)),
    );
    records = await connections().find({ ownerId, kind: 'device' }).toArray();
  }
  const machines = devices.map((d) => {
    const record = records.find((r) => r.deviceId === d.device_id);
    return { ...d, connectionId: record?._id, tools: record?.tools ?? [] };
  });
  return { configured: true, publicUrl: gatewayPublicUrl(), machines };
}
/** Keeps connections in step with the gateway: online devices get fresh tool lists, removed devices lose their connection. */
export async function syncMachines(ownerId: string, userId?: string) {
  const { devices } = await gatewayAdmin<{ devices: DeviceView[] }>(
    `/devices?owner=${encodeURIComponent(ownerId)}`,
  );
  for (const device of devices) await ensureDeviceConnection(ownerId, device, userId);
  const known = new Set(devices.map((d) => d.device_id));
  const stale = (await connections().find({ ownerId, kind: 'device' }).toArray()).filter(
    (r) => !known.has(r.deviceId),
  );
  for (const r of stale) await connections().deleteOne({ _id: r._id, ownerId });
  return listMachines(ownerId);
}
export function installSnippets(device: DeviceView, token: string, connectUrl: string) {
  const insecure = connectUrl.startsWith('ws://');
  // Inside a container, localhost is the container itself; reach a gateway on the same host through the Docker host gateway.
  const local = /^wss?:\/\/(localhost|127\.0\.0\.1)(?=[:/])/.test(connectUrl);
  const containerUrl = local
    ? connectUrl.replace(/\/\/(localhost|127\.0\.0\.1)/, '//host.docker.internal')
    : connectUrl;
  const env = `GATEWAY_URL=${connectUrl} DEVICE_ID=${device.device_id} DEVICE_TOKEN=${token}${insecure ? ' GATEWAY_ALLOW_INSECURE=true' : ''}`;
  return {
    linux: `# On the machine (Node.js 22.13+ installed), from a checkout of this repository:\nnpm --prefix connector-core ci && npm --prefix connector-core run build\nnpm --prefix connector-linux ci && npm --prefix connector-linux run build\nsudo ${env} sh connector-linux/install.sh`,
    docker: `# Any host with Docker, from a checkout of this repository:\ndocker build -f connector-linux/Dockerfile -t openharness-connector-linux .\ndocker run -d --name openharness-${device.device_id} --restart unless-stopped${local ? ' --add-host host.docker.internal:host-gateway' : ''} \\\n  -e GATEWAY_URL=${containerUrl} -e DEVICE_ID=${device.device_id} -e DEVICE_TOKEN=${token}${insecure ? ' -e GATEWAY_ALLOW_INSECURE=true' : ''} \\\n  -v "$PWD/machine-work:/work" openharness-connector-linux`,
    windows: `# PowerShell as Administrator, from a checkout of this repository (connector-windows ships in the next release):\n$env:GATEWAY_URL='${connectUrl}'; $env:DEVICE_ID='${device.device_id}'; $env:DEVICE_TOKEN='${token}'${insecure ? "; $env:GATEWAY_ALLOW_INSECURE='true'" : ''}\n.\\connector-windows\\install.ps1`,
    chrome: `1. Load connector-chrome/dist as an unpacked extension (chrome://extensions, Developer mode).\n2. Open the extension options and enter:\n   Gateway: ${connectUrl}\n   Device ID: ${device.device_id}\n   Token: ${token}\n3. Allow the sites the agent may control. (The Chrome connector ships in the next release.)`,
  };
}
export async function enrollMachine(
  ownerId: string,
  input: { deviceId: string; name: string; platform: Platform; allowedTools: string[] },
  userId?: string,
) {
  const result = await gatewayAdmin<{ device: DeviceView; token: string; connect_url: string }>(
    '/devices',
    'POST',
    {
      device_id: input.deviceId,
      name: input.name,
      platform: input.platform,
      owner: ownerId,
      allowed_tools: input.allowedTools,
    },
  );
  const connectionId = await ensureDeviceConnection(ownerId, result.device, userId);
  const connectUrl = `${gatewayPublicUrl()}/connect`;
  return {
    machine: { ...result.device, connectionId, tools: [] },
    token: result.token,
    connectUrl,
    install: installSnippets(result.device, result.token, connectUrl),
  };
}
async function owned(ownerId: string, deviceId: string) {
  const { devices } = await gatewayAdmin<{ devices: DeviceView[] }>(
    `/devices?owner=${encodeURIComponent(ownerId)}`,
  );
  const device = devices.find((d) => d.device_id === deviceId);
  if (!device) throw new HttpError(404, 'Machine not found');
  return device;
}
export async function updateMachine(
  ownerId: string,
  deviceId: string,
  patch: { name?: string; allowedTools?: string[]; disabled?: boolean },
  userId?: string,
) {
  await owned(ownerId, deviceId);
  const result = await gatewayAdmin<{ device: DeviceView }>(`/devices/${deviceId}`, 'PUT', {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.allowedTools !== undefined ? { allowed_tools: patch.allowedTools } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
  });
  const connectionId = await ensureDeviceConnection(ownerId, result.device, userId);
  const record = await connections().findOne({ _id: connectionId });
  return { ...result.device, connectionId, tools: record?.tools ?? [] } as Machine;
}
export async function rotateMachineToken(ownerId: string, deviceId: string) {
  const device = await owned(ownerId, deviceId);
  const result = await gatewayAdmin<{ token: string; connect_url: string }>(
    `/devices/${deviceId}/rotate-token`,
    'POST',
  );
  const connectUrl = `${gatewayPublicUrl()}/connect`;
  return { token: result.token, connectUrl, install: installSnippets(device, result.token, connectUrl) };
}
export async function removeMachine(ownerId: string, deviceId: string) {
  await owned(ownerId, deviceId);
  const record = await connections().findOne({ ownerId, kind: 'device', deviceId });
  if (record) {
    const used = await collection('workflows').findOne({
      ownerId,
      $or: [
        { 'nodes.connectionId': record._id },
        { 'resources.connectionId': record._id },
        { 'nodes.config.connections.connectionId': record._id },
      ],
    });
    if (used) throw new HttpError(409, 'A workflow still uses this machine; remove it from the canvas first');
    await connections().deleteOne({ _id: record._id, ownerId });
  }
  await gatewayAdmin(`/devices/${deviceId}`, 'DELETE');
}
