import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../../../packages/core/src/config.js';
import { collection } from '../../../../packages/core/src/db.js';
import { createRun, requestCancel } from '../../../../packages/core/src/runs.js';
import { agentSchema, deviceIdPattern, type Run } from '../../../../packages/core/src/schema.js';
import { hash } from '../../../../packages/core/src/security.js';
import { rateLimit } from '../auth.js';
import { defaultProviderId } from '../tenant.js';
import { requireAccess, runScope } from './access.js';
import { notFound, notSupported, OhError } from './errors.js';
import {
  closingEvents,
  EventTranslator,
  executionResult,
  executionView,
  isTerminal,
  runStatusesFor,
  type SpecEvent,
  unsentOutput,
} from './events.js';
import { page, pageQuery, type Operation, type OperationRegistry } from './operations.js';

const runs = () => collection<Run>('runs');
const executeSchema = z.object({
  message: z.string().min(1).max(100000),
  agent_id: z.string().min(1).max(200).optional(),
  skills: z.array(z.string().uuid()).max(20).optional(),
  model: z.string().min(1).max(200).optional(),
  max_tokens: z.number().int().min(1).max(200000).optional(),
  temperature: z.number().min(0).max(1).optional(),
  system_prompt: z.string().max(32000).optional(),
  session_id: z.string().max(200).optional(),
  'x-openharness': z
    .object({
      machine_id: z.string().regex(deviceIdPattern).optional(),
      payload: z.record(z.unknown()).optional(),
    })
    .optional(),
});
const MAX_INPUT = 32000;
/** A stable UUID per workspace for the agent used when an execute request names none. */
const defaultAgentId = (tenantId: string) => {
  const h = hash(`openharness-default-agent:${tenantId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
async function ensureDefaultAgent(tenantId: string) {
  const providerId = await defaultProviderId(tenantId);
  if (!providerId) throw new OhError(422, 'NO_MODEL_PROVIDER', 'Add a model provider before executing tasks');
  const _id = defaultAgentId(tenantId);
  const now = new Date();
  const {
    providerId: _provider,
    enabled: _enabled,
    ...agent
  } = agentSchema.parse({
    name: 'Open Harness default agent',
    description: 'Answers Open Harness API requests that do not name an agent.',
    systemPrompt: 'You are a helpful assistant. Answer clearly and concisely.',
    providerId,
  });
  // It follows the workspace default provider, so changing the default in Settings changes this agent too.
  await collection<Record<string, unknown> & { _id: string }>('agents').updateOne(
    { _id, ownerId: tenantId },
    { $set: { providerId, enabled: true, updatedAt: now }, $setOnInsert: { ...agent, createdAt: now } },
    { upsert: true },
  );
  return _id;
}
/** Agents are workflows; the older stand-alone agent records are addressable too. */
async function resolveTarget(tenantId: string, agentId?: string) {
  if (!agentId) return { agentId: await ensureDefaultAgent(tenantId) };
  if (!z.string().uuid().safeParse(agentId).success) throw notFound('Agent');
  if (await collection('workflows').findOne({ _id: agentId, ownerId: tenantId }))
    return { workflowId: agentId };
  if (await collection('agents').findOne({ _id: agentId, ownerId: tenantId })) return { agentId };
  throw notFound('Agent');
}
async function resolveModel(tenantId: string, model?: string) {
  if (!model) return undefined;
  const providers = await collection<{ _id: string; name: string; model: string }>('providers')
    .find({ ownerId: tenantId })
    .toArray();
  const match =
    providers.find((p) => p._id === model) ??
    providers.find((p) => p.name === model) ??
    providers.find((p) => p.model === model);
  if (!match)
    throw new OhError(400, 'model_not_available', `Model ${model} is not available on this harness`, {
      details: { available: [...new Set(providers.map((p) => p.model))] },
    });
  return match._id;
}
async function resolveSkills(tenantId: string, skills?: string[]) {
  if (!skills?.length) return undefined;
  const found = await collection('skills')
    .find({ _id: { $in: skills }, ownerId: tenantId, enabled: true })
    .project({ _id: 1 })
    .toArray();
  const missing = skills.filter((id) => !found.some((f) => f._id === id));
  if (missing.length)
    throw new OhError(400, 'VALIDATION_ERROR', 'Unknown or disabled skills', {
      details: { skills: missing },
    });
  return skills;
}
const streamUrl = (id: string) =>
  `${config.PUBLIC_URL.replace(/\/$/, '')}${config.OPENHARNESS_BASE_PATH}/harnesses/${config.OPENHARNESS_HARNESS_ID}/executions/${id}/stream`;

async function execute(req: Request) {
  const principal = requireAccess(req, 'execute');
  const body = executeSchema.parse(req.body);
  if (body.message.length > MAX_INPUT)
    throw new OhError(400, 'context_length_exceeded', `Messages are limited to ${MAX_INPUT} characters`);
  if (body.session_id)
    throw notSupported(
      'sessions',
      'execution.run',
      'session_id needs the sessions domain, which is not supported yet',
    );
  const tenantId = principal.tenantId;
  const target = await resolveTarget(tenantId, body.agent_id);
  requireAccess(req, 'execute', body.agent_id ? target : {});
  const providerId = await resolveModel(tenantId, body.model);
  const skillIds = await resolveSkills(tenantId, body.skills);
  await rateLimit(`run:${tenantId}`, 60);
  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = rawKey ? z.string().min(1).max(128).parse(rawKey) : undefined;
  const extension = body['x-openharness'];
  const overrides = {
    ...(body.system_prompt ? { systemPrompt: body.system_prompt } : {}),
    ...(providerId ? { providerId } : {}),
    ...(skillIds ? { skillIds } : {}),
  };
  return createRun(
    tenantId,
    {
      ...target,
      input: body.message,
      history: [],
      ...(extension?.machine_id ? { deviceId: extension.machine_id } : {}),
      ...(extension?.payload ? { payload: extension.payload } : {}),
    },
    {
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(principal.token ? { tokenId: principal.token._id } : {}),
      initiatedBy: principal.user._id,
      trigger: 'api',
      ...(Object.keys(overrides).length ? { overrides } : {}),
    },
  );
}
async function findRun(req: Request, need: 'read' | 'execute' = 'read') {
  const principal = requireAccess(req, need);
  const filter = { _id: String(req.params.executionId), ownerId: principal.tenantId, ...runScope(req) };
  const run = await runs().findOne(filter);
  if (!run) throw notFound('Execution');
  requireAccess(req, need, { workflowId: run.workflowId, agentId: run.workflowId ? undefined : run.agentId });
  return { run, filter };
}

type Cursor = { events: number; text: number };
function parseCursor(value: unknown): Cursor | undefined {
  const match = typeof value === 'string' ? /^(\d+)\.(\d+)$/.exec(value) : null;
  return match ? { events: Number(match[1]), text: Number(match[2]) } : undefined;
}
/**
 * Streams an execution as spec events. Each event id is `<run events consumed>.<characters of the current text
 * segment sent>`, so a client reconnecting with Last-Event-ID resumes without repeats. Tool and progress events
 * come from the persisted run log; `text` streams the model output as it is written and, when the run finishes,
 * whatever part of the final answer the client has not seen yet. Every stream ends with exactly one `done`.
 */
async function stream(req: Request, res: Response, first: Run, filter: object, cursor?: Cursor) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Execution-ID': first._id,
  });
  const translator = new EventTranslator(first);
  let consumed = Math.min(cursor?.events ?? 0, first.events.length);
  for (let i = 0; i < consumed; i++) translator.translate(first.events[i], i);
  let sent = cursor?.text ?? 0;
  // The text of the current segment when this connection saw it; unknown after a resume.
  let segment: string | undefined = cursor ? undefined : '';
  let closed = false;
  let busy = false;
  const send = (event: SpecEvent) => {
    if (!closed)
      res.write(`event: ${event.type}\nid: ${consumed}.${sent}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(keepAlive);
    clearTimeout(deadline);
    res.end();
  };
  const finish = (run: Run) => {
    if (run.status === 'succeeded') {
      const rest = unsentOutput(run.output ?? '', segment, sent);
      if (rest) {
        sent += rest.length;
        send({ type: 'text', content: rest });
      }
    }
    for (const event of closingEvents(run, translator.usage)) send(event);
    end();
  };
  const tick = async (run?: Run | null) => {
    if (busy || closed) return;
    busy = true;
    try {
      run ??= await runs().findOne(filter);
      if (!run) return end();
      const partial = run.partial ?? '';
      // A new agent or step starts a new text segment.
      if (partial.length < sent || (segment && !partial.startsWith(segment))) {
        sent = 0;
        segment = '';
      }
      if (partial.length > sent) {
        const delta = partial.slice(sent);
        sent = partial.length;
        segment = partial;
        send({ type: 'text', content: delta });
      }
      while (consumed < run.events.length) {
        const index = consumed++;
        for (const event of translator.translate(run.events[index], index)) send(event);
      }
      if (isTerminal(run.status)) finish(run);
    } catch {
      // Transient database errors: keep the stream open and retry on the next tick.
    } finally {
      busy = false;
    }
  };
  const poll = setInterval(() => void tick(), 300);
  const keepAlive = setInterval(() => !closed && res.write(': keep-alive\n\n'), 15000);
  const deadline = setTimeout(() => {
    send({
      type: 'error',
      code: 'STREAM_TIMEOUT',
      message: 'Reattach to keep following this execution',
      recoverable: true,
    });
    end();
  }, 35 * 60000);
  req.on('close', end);
  await tick(first);
}
const STREAM_RETENTION_MS = 3600000;

export function executionOperations(registry: OperationRegistry): Operation[] {
  registry.declare('execution', {
    limitations: [
      'temperature and max_tokens are accepted but not applied; choose the model with the model field',
      'session_id needs the sessions domain, which is not supported yet',
      `Messages are limited to ${MAX_INPUT} characters`,
      'Artifacts are not recorded yet',
    ],
  });
  registry.declare('models', {
    operations: ['multi-model', 'model-switch'],
    limitations: ['model selects a configured provider by id, name or model name for one execution'],
  });
  return [
    {
      id: 'execution.run',
      provides: { domain: 'execution', operations: ['sync'] },
      handler: async (req, res) => {
        const run = await execute(req);
        res.status(202).json({
          execution_id: run._id,
          status: executionView(run).status,
          stream_url: streamUrl(run._id),
        });
      },
    },
    {
      id: 'execution.stream',
      provides: { domain: 'execution', operations: ['stream'] },
      handler: async (req, res) => {
        const run = await execute(req);
        await stream(req, res, run, { _id: run._id, ownerId: run.ownerId });
      },
    },
    {
      id: 'execution.attachStream',
      provides: { domain: 'execution', operations: ['stream'] },
      handler: async (req, res) => {
        const { run, filter } = await findRun(req);
        if (
          isTerminal(run.status) &&
          run.finishedAt &&
          Date.now() - run.finishedAt.getTime() > STREAM_RETENTION_MS
        )
          throw new OhError(
            410,
            'GONE',
            'The stream of this execution is no longer available; read its result',
          );
        await stream(req, res, run, filter, parseCursor(req.headers['last-event-id']));
      },
    },
    {
      id: 'execution.list',
      handler: async (req) => {
        const principal = requireAccess(req, 'read');
        const query = pageQuery
          .extend({
            status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
            agent_id: z.string().max(200).optional(),
            since: z.string().datetime({ offset: true }).optional(),
          })
          .parse(req.query);
        const filter = {
          ownerId: principal.tenantId,
          ...runScope(req),
          ...(query.status ? { status: { $in: runStatusesFor(query.status) } } : {}),
          ...(query.agent_id ? { $or: [{ workflowId: query.agent_id }, { agentId: query.agent_id }] } : {}),
          ...(query.since ? { createdAt: { $gte: new Date(query.since) } } : {}),
        };
        const [total, items] = await Promise.all([
          runs().countDocuments(filter),
          runs()
            .find(filter, {
              projection: { outputs: 0, history: 0, 'snapshot.agents': 0, 'snapshot.nodeAgents': 0 },
            })
            .sort({ createdAt: -1 })
            .skip(query.offset)
            .limit(query.limit)
            .toArray(),
        ]);
        return page(
          items.map((run) => executionView(run)),
          query,
          total,
        );
      },
    },
    {
      id: 'execution.get',
      handler: async (req) => ({ execution: executionView((await findRun(req)).run) }),
    },
    {
      id: 'execution.cancel',
      provides: { domain: 'execution', operations: ['cancel'] },
      handler: async (req) => {
        const { run, filter } = await findRun(req, 'execute');
        if (isTerminal(run.status)) throw new OhError(409, 'CONFLICT', 'The execution has already finished');
        const cancelled = await requestCancel(filter as { _id: string; ownerId: string });
        const current = (await runs().findOne(filter)) ?? run;
        return { execution: executionView(current), cancelled };
      },
    },
    {
      id: 'execution.result',
      handler: async (req) => {
        const { run } = await findRun(req);
        if (!isTerminal(run.status)) throw new OhError(409, 'CONFLICT', 'The execution is still running');
        return { result: executionResult(run) };
      },
    },
    {
      id: 'execution.listToolCalls',
      provides: { domain: 'execution', operations: ['tool-calls'] },
      handler: async (req) => {
        const { run } = await findRun(req);
        return { tool_calls: [...EventTranslator.replay(run).calls.values()] };
      },
    },
  ];
}
