import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import { connectMcp, ownedConnection, type ConnectionRecord } from '../../../../packages/core/src/mcp.js';
import { safeError } from '../../../../packages/core/src/security.js';
import { validateToolArguments } from '../../../../packages/core/src/toolValidation.js';
import { rateLimit } from '../auth.js';
import { requireAccess } from './access.js';
import { notFound, notSupported, OhError } from './errors.js';
import { pageOf, pageQuery, type Operation, type OperationRegistry } from './operations.js';

/** The spec's Tool: MCP tools (including machine tools, which reach the device through its gateway) and built-ins. */
type Tool = {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'mcp' | 'skill' | 'custom';
  source_id?: string;
  input_schema: object;
  'x-openharness'?: Record<string, unknown>;
};
const LOAD_SKILL: Tool = {
  id: 'builtin.load_skill',
  name: 'load_skill',
  description:
    'Returns the full instructions of a workspace skill by name. Agents call it before following a skill.',
  source: 'builtin',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name' } },
    required: ['name'],
    additionalProperties: false,
  },
};
const MCP_ID = /^mcp\.([0-9a-f-]{36})\.(.+)$/;
const mcpToolId = (connectionId: string, name: string) => `mcp.${connectionId}.${name}`;

async function allTools(tenantId: string): Promise<Tool[]> {
  const connections = await collection<ConnectionRecord & { kind?: string; deviceId?: string }>('connections')
    .find({ ownerId: tenantId, enabled: true })
    .sort({ createdAt: 1 })
    .toArray();
  const tools = connections.flatMap((c) =>
    (c.tools ?? []).map((t): Tool => ({
      id: mcpToolId(c._id, t.name),
      name: t.name,
      description: t.description ?? '',
      source: 'mcp',
      source_id: c._id,
      input_schema: (t.inputSchema as object) ?? { type: 'object' },
      'x-openharness': {
        server: c.name,
        ...(c.kind === 'device' ? { machine_id: c.deviceId } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      },
    })),
  );
  return [LOAD_SKILL, ...tools];
}
async function findTool(tenantId: string, id: string) {
  if (id === LOAD_SKILL.id) return { tool: LOAD_SKILL };
  const match = MCP_ID.exec(id);
  if (!match) throw notFound('Tool');
  const tool = (await allTools(tenantId)).find((t) => t.id === id);
  if (!tool) throw notFound('Tool');
  return { tool, connectionId: match[1], name: match[2] };
}
type Invocation = { success: boolean; output: object; duration_ms: number; error?: string };
/**
 * Calls one tool outside of any run, through the same MCP client, argument validation, output cap and (for
 * machines) gateway policy that agents use. Every call is recorded in `tool_invocations`.
 */
async function invoke(
  req: Request,
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void,
): Promise<Invocation> {
  const principal = requireAccess(req, 'manage');
  const input = z.object({ input: z.record(z.unknown()).default({}) }).parse(req.body ?? {}).input;
  const found = await findTool(principal.tenantId, String(req.params.toolId));
  await rateLimit(`tool-invoke:${principal.tenantId}`, 60);
  const started = Date.now();
  let result: Invocation;
  if (!found.connectionId) {
    const skill = await collection<{ _id: string; name: string; instructions: string; enabled: boolean }>(
      'skills',
    ).findOne({ ownerId: principal.tenantId, name: String(input.name ?? ''), enabled: true });
    result = skill
      ? { success: true, output: { content: skill.instructions }, duration_ms: Date.now() - started }
      : {
          success: false,
          output: {},
          duration_ms: Date.now() - started,
          error: `Unknown skill ${String(input.name ?? '')}`,
        };
  } else {
    const validation = validateToolArguments(found.tool.input_schema as Record<string, unknown>, input);
    if (validation)
      throw new OhError(400, 'VALIDATION_ERROR', validation, { details: { tool: found.tool.id } });
    const connection = await ownedConnection(principal.tenantId, found.connectionId);
    const session = await connectMcp(connection, AbortSignal.timeout(90000));
    try {
      const output = await session.client.callTool(
        { name: found.name!, arguments: input, _meta: { idempotencyKey: `invoke:${randomUUID()}` } },
        undefined,
        {
          timeout: 60000,
          ...(onProgress ? { onprogress: onProgress, resetTimeoutOnProgress: true } : {}),
        },
      );
      const content = JSON.stringify(output.structuredContent ?? output.content).slice(0, 12000);
      result = {
        success: !output.isError,
        output: {
          content: output.content,
          ...(output.structuredContent ? { structured: output.structuredContent } : {}),
        },
        duration_ms: Date.now() - started,
        ...(output.isError ? { error: content.slice(0, 1000) } : {}),
      };
    } catch (error) {
      result = { success: false, output: {}, duration_ms: Date.now() - started, error: safeError(error) };
    } finally {
      await session.close();
    }
  }
  await collection('tool_invocations').insertOne({
    _id: randomUUID(),
    ownerId: principal.tenantId,
    toolId: found.tool.id,
    input: JSON.stringify(input).slice(0, 6000),
    success: result.success,
    durationMs: result.duration_ms,
    ...(result.error ? { error: result.error.slice(0, 1000) } : {}),
    initiatedBy: principal.user._id,
    ...(principal.token ? { tokenId: principal.token._id } : {}),
    createdAt: new Date(),
  });
  return result;
}

export function toolOperations(registry: OperationRegistry): Operation[] {
  registry.declare('mcp', {
    limitations: ['Custom tools are not registered directly; serve them over MCP and connect the server'],
  });
  const custom = () => {
    throw notSupported(
      'tools',
      'tools.register',
      'Custom tools must be served over MCP; connect an MCP server instead',
      {
        suggestion: 'Connect the server in the studio (MCP connections) and discover its tools',
      },
    );
  };
  return [
    {
      id: 'tools.list',
      handler: async (req) => {
        const principal = requireAccess(req, 'read');
        const query = pageQuery
          .extend({ source: z.enum(['builtin', 'mcp', 'skill', 'custom']).optional() })
          .parse(req.query);
        const tools = (await allTools(principal.tenantId)).filter(
          (t) => !query.source || t.source === query.source,
        );
        return pageOf(tools, query);
      },
    },
    {
      id: 'tools.get',
      handler: async (req) => {
        const principal = requireAccess(req, 'read');
        return { tool: (await findTool(principal.tenantId, String(req.params.toolId))).tool };
      },
    },
    { id: 'tools.register', handler: custom },
    {
      id: 'tools.unregister',
      handler: async (req) => {
        const principal = requireAccess(req, 'manage');
        await findTool(principal.tenantId, String(req.params.toolId));
        throw new OhError(
          409,
          'CONFLICT',
          'Only custom tools can be unregistered; this is a built-in or MCP tool',
          {
            details: { suggestion: 'Disconnect the MCP server, or narrow the tools an agent may use' },
          },
        );
      },
    },
    { id: 'tools.invoke', handler: async (req) => invoke(req) },
    {
      id: 'tools.invokeStream',
      handler: async (req: Request, res: Response) => {
        // Validate and resolve before the stream opens, so errors keep their HTTP status.
        const principal = requireAccess(req, 'manage');
        await findTool(principal.tenantId, String(req.params.toolId));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        let seq = 0;
        const send = (event: Record<string, unknown> & { type: string }) =>
          res.write(`event: ${event.type}\nid: ${++seq}\ndata: ${JSON.stringify(event)}\n\n`);
        try {
          const result = await invoke(req, (p) =>
            send({
              type: 'progress',
              percentage: p.total ? Math.min(100, Math.round((p.progress / p.total) * 100)) : 0,
              message: p.message ?? '',
            }),
          );
          if (result.success) send({ type: 'output', data: result.output });
          else
            send({
              type: 'error',
              code: 'TOOL_EXECUTION_FAILED',
              message: result.error ?? 'The tool failed',
            });
          send({ type: 'done', success: result.success, duration_ms: result.duration_ms });
        } catch (error) {
          const e = error instanceof OhError ? error : undefined;
          send({ type: 'error', code: e?.code ?? 'TOOL_EXECUTION_FAILED', message: safeError(error) });
          send({ type: 'done', success: false, duration_ms: 0 });
        }
        res.end();
      },
    },
  ];
}
