// The fleet endpoint: an MCP server whose tools describe the registered devices.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DeviceHub } from './hub.js';
import type { DeviceRecord, Registry } from './registry.js';

export function deviceView(record: DeviceRecord, hub: DeviceHub, publicUrl: string) {
  const session = hub.session(record.device_id);
  const httpBase = publicUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
  return {
    device_id: record.device_id,
    name: record.name || record.device_id,
    platform: record.platform,
    owner: record.owner,
    online: Boolean(session?.online),
    disabled: record.disabled,
    hostname: session?.hostname ?? null,
    connector_version: session?.connectorVersion ?? null,
    capabilities: session?.capabilities ?? [],
    last_seen: session?.online ? new Date().toISOString() : (record.last_seen ?? null),
    connected_at: session?.online ? session.connectedAt.toISOString() : null,
    session_id: session?.online ? session.sessionId : null,
    pending_requests: session?.pending ?? 0,
    allowed_tools: record.allowed_tools,
    tool_count: session?.tools?.length ?? null,
    created_at: record.created_at,
    endpoint: `${httpBase}/mcp/${record.device_id}`,
  };
}
export function createFleetServer({
  hub,
  registry,
  publicUrl,
}: {
  hub: DeviceHub;
  registry: Registry;
  publicUrl: string;
}) {
  const server = new McpServer({ name: 'openharness-gateway-fleet', version: '0.1.0' });
  server.registerTool(
    'list_devices',
    {
      title: 'List devices',
      description: 'Registered devices with their platform, online state and allowed tools.',
      inputSchema: { owner: z.string().optional() },
    },
    async ({ owner }) => {
      const devices = (await registry.list(owner)).map((r) => deviceView(r, hub, publicUrl));
      return {
        content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }],
        structuredContent: { devices },
      };
    },
  );
  server.registerTool(
    'device_status',
    {
      title: 'Device status',
      description: 'Live status of one device.',
      inputSchema: { device_id: z.string() },
    },
    async ({ device_id }) => {
      const record = await registry.get(device_id);
      if (!record) return { content: [{ type: 'text', text: `unknown device ${device_id}` }], isError: true };
      const view = deviceView(record, hub, publicUrl);
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }], structuredContent: view };
    },
  );
  return server;
}
