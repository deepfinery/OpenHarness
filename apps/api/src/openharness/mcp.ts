import { z } from 'zod';
import { connectMcp } from '../../../../packages/core/src/mcp.js';
import { encrypt, safeError, validateRemoteUrl } from '../../../../packages/core/src/security.js';
import { connectionSchema } from '../../../../packages/core/src/schema.js';
import { pageOf, pageQuery, type Operation, type OperationRegistry } from './operations.js';
import { OhError } from './errors.js';
import { repository, workspace, type RecordData } from './resources.js';
const repo = repository('connections');
const transportSchema = z.object({ type: z.enum(['http', 'sse']), url: z.string().url().max(2000) });
const bodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  transport: transportSchema,
  auto_reconnect: z.boolean().default(true),
  'x-openharness': z
    .object({
      token: z.string().max(8192).optional(),
      auth_type: z.enum(['none', 'token', 'oauth']).optional(),
    })
    .optional(),
});
function view(row: RecordData) {
  const url = new URL(row.url);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
  return {
    id: row._id,
    name: row.name,
    transport: { type: row.transport ?? 'http', url: url.toString() },
    status: !row.enabled
      ? 'disconnected'
      : row.lastError
        ? 'error'
        : row.lastCheckedAt
          ? 'connected'
          : 'disconnected',
    tools: (row.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema,
    })),
    resources: row.mcpResources ?? [],
    prompts: row.mcpPrompts ?? [],
    'x-openharness': {
      read_only: row.kind === 'device',
      needs_authorization: row.authType === 'oauth' && !row.oauthTokensEncrypted,
    },
  };
}
function mutable(row: RecordData) {
  if (row.kind === 'device')
    throw new OhError(409, 'CONFLICT', 'Manage enrolled machines in Machines & clusters');
}
async function discover(row: RecordData) {
  if (row.authType === 'oauth' && !row.oauthTokensEncrypted)
    throw new OhError(409, 'NEEDS_AUTHORIZATION', 'Authorize this MCP server in the studio');
  const session = await connectMcp(row as any, AbortSignal.timeout(30000));
  try {
    const caps = session.client.getServerCapabilities();
    const tools = caps?.tools ? await session.tools() : [];
    const resources: any[] = [],
      prompts: any[] = [];
    for (const kind of ['resources', 'prompts'] as const) {
      if (!caps?.[kind]) continue;
      let cursor: string | undefined;
      for (let n = 0; n < 20; n++) {
        if (kind === 'resources') {
          const r = await session.client.listResources({ cursor });
          resources.push(...r.resources.map((x) => ({ uri: x.uri, name: x.name, mime_type: x.mimeType })));
          cursor = r.nextCursor;
        } else {
          const r = await session.client.listPrompts({ cursor });
          prompts.push(...r.prompts);
          cursor = r.nextCursor;
        }
        if (!cursor) break;
        if (n === 19) throw new Error('MCP discovery exceeded 20 pages');
      }
    }
    return await repo.update(row, {
      tools,
      mcpResources: resources,
      mcpPrompts: prompts,
      lastCheckedAt: new Date(),
      lastError: null,
    });
  } finally {
    await session.close();
  }
}
export function mcpOperations(registry: OperationRegistry): Operation[] {
  registry.declare('mcp', {
    limitations: [
      'HTTP and SSE transports only; run stdio servers behind an MCP bridge',
      'OAuth authorization takes place in the studio; enrolled machine servers are read-only',
    ],
  });
  return [
    {
      id: 'mcp.list',
      provides: { domain: 'mcp', operations: ['list'] },
      handler: async (req) => {
        const rows = (
          await repo
            .records()
            .find({ ownerId: workspace(req) })
            .toArray()
        ).map(view);
        return pageOf(
          rows.filter((r) => !req.query.status || r.status === req.query.status),
          pageQuery.parse(req.query),
        );
      },
    },
    {
      id: 'mcp.get',
      handler: async (req) => ({ server: view(await repo.get(workspace(req), String(req.params.serverId))) }),
    },
    {
      id: 'mcp.connect',
      provides: { domain: 'mcp', operations: ['connect'] },
      handler: async (req, res) => {
        const ownerId = workspace(req),
          b = bodySchema.parse(req.body);
        await validateRemoteUrl(b.transport.url);
        const parsed = connectionSchema.parse({
          name: b.name,
          url: b.transport.url,
          transport: b.transport.type,
          authType: b['x-openharness']?.auth_type ?? (b['x-openharness']?.token ? 'token' : 'none'),
        });
        let row = await repo.create(ownerId, {
          ...parsed,
          autoReconnect: b.auto_reconnect,
          ...(b['x-openharness']?.token ? { tokenEncrypted: encrypt(b['x-openharness'].token) } : {}),
        });
        try {
          row = await discover(row);
        } catch (e) {
          row = await repo.update(row, { lastError: safeError(e) });
        }
        res.status(201).json({ server: view(row) });
      },
    },
    {
      id: 'mcp.update',
      handler: async (req) => {
        let row = await repo.get(workspace(req), String(req.params.serverId));
        mutable(row);
        const b = bodySchema.partial().parse(req.body);
        if (b.transport) await validateRemoteUrl(b.transport.url);
        row = await repo.update(row, {
          ...(b.name ? { name: b.name } : {}),
          ...(b.transport
            ? {
                transport: b.transport.type,
                url: b.transport.url,
                tools: [],
                mcpResources: [],
                mcpPrompts: [],
                lastCheckedAt: null,
                oauthTokensEncrypted: null,
                oauthClientEncrypted: null,
                tokenEncrypted: null,
              }
            : {}),
          ...(b.auto_reconnect !== undefined ? { autoReconnect: b.auto_reconnect } : {}),
        });
        return { server: view(row) };
      },
    },
    {
      id: 'mcp.disconnect',
      provides: { domain: 'mcp', operations: ['disconnect'] },
      handler: async (req, res) => {
        const row = await repo.get(workspace(req), String(req.params.serverId));
        mutable(row);
        await repo.update(row, { enabled: false });
        res.status(204).end();
      },
    },
    ...(['listTools', 'listResources', 'listPrompts'] as const).map((method): Operation => ({
      id: `mcp.${method}`,
      provides: {
        domain: 'mcp',
        operations: [method === 'listTools' ? 'tools' : method === 'listResources' ? 'resources' : 'prompts'],
      },
      handler: async (req) => {
        const row = await repo.get(workspace(req), String(req.params.serverId));
        const updated = row.enabled ? await discover(row) : row,
          result = view(updated);
        return method === 'listTools'
          ? { tools: result.tools }
          : method === 'listResources'
            ? { resources: result.resources }
            : { prompts: result.prompts };
      },
    })),
    {
      id: 'mcp.health',
      provides: { domain: 'mcp', operations: ['health'] },
      handler: async (req) => {
        const row = await repo.get(workspace(req), String(req.params.serverId));
        const start = Date.now();
        try {
          if (!row.enabled) throw new Error('Server is disconnected');
          await discover(row);
          return { status: 'healthy', latency_ms: Date.now() - start };
        } catch (e) {
          return { status: 'unhealthy', latency_ms: Date.now() - start, last_error: safeError(e) };
        }
      },
    },
  ];
}
