import { randomUUID, createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import { createRun } from '../../../../packages/core/src/runs.js';
import { settleConversation, type Conversation } from '../../../../packages/core/src/conversations.js';
import { config } from '../../../../packages/core/src/config.js';
import { rateLimit } from '../auth.js';
import type { Run, RunOverrides } from '../../../../packages/core/src/schema.js';
import { requireAccess } from './access.js';
import { resolveTarget, stream } from './execution.js';
import { isTerminal } from './events.js';
import { notFound, OhError } from './errors.js';
import { pageOf, pageQuery, type Operation, type OperationRegistry } from './operations.js';
import { harnessId } from './scope.js';
export type ApiSession = Conversation & {
  harnessId: string;
  name?: string;
  status: 'active' | 'paused' | 'ended';
  nodeId?: string;
  skillIds?: string[];
  systemPrompt?: string;
};
const sessions = () => collection<ApiSession>('conversations');
function actor(req: Request) {
  const p = req.principal!;
  return p.token && !p.token.scopes.includes('harness') ? { actor: `token:${p.token._id}` } : {};
}
export async function sessionFor(
  req: Request,
  need: 'read' | 'execute' = 'read',
  id = String(req.params.sessionId),
) {
  const p = requireAccess(req, need);
  const s = await sessions().findOne({
    _id: id,
    ownerId: p.tenantId,
    harnessId: harnessId(req),
    ...actor(req),
  });
  if (!s) throw notFound('Session');
  requireAccess(req, need, { workflowId: s.workflowId, agentId: s.workflowId ? undefined : s.agentId });
  return s;
}
function view(s: ApiSession) {
  return {
    id: s._id,
    harness_id: s.harnessId,
    agent_id: s.nodeId ?? s.workflowId ?? s.agentId,
    name: s.name,
    status: s.status,
    message_count: s.messages.length,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}
function connectUrl(s: ApiSession) {
  return `${config.PUBLIC_URL.replace(/^http/, 'ws').replace(/\/$/, '')}${config.OPENHARNESS_BASE_PATH}/harnesses/${s.harnessId}/sessions/${s._id}/connect`;
}
function history(s: ApiSession) {
  return s.messages.map((m, i) => ({
    id: (m as any).id ?? `${s._id}:${i}`,
    role: m.role,
    content: m.content,
    created_at: (m as any).createdAt ?? s.updatedAt.toISOString(),
  }));
}
export async function sessionMessage(
  req: Request,
  content: string,
  id = String(req.params.sessionId),
  overrides: RunOverrides = {},
  /** The caller's timezone for this turn's runtime clock. */
  timezone?: string,
) {
  const p = requireAccess(req, 'execute');
  let s = await sessionFor(req, 'execute', id);
  if (s.status !== 'active')
    throw new OhError(409, 'CONFLICT', 'Resume the session before sending a message');
  await rateLimit(`run:${p.tenantId}`, 60);
  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = rawKey
    ? `session:${createHash('sha256')
        .update(JSON.stringify([s._id, p.token?._id ?? p.user._id, z.string().min(1).max(128).parse(rawKey)]))
        .digest('hex')}`
    : undefined;
  if (idempotencyKey) {
    const previous = await collection<Run>('runs').findOne({
      ownerId: p.tenantId,
      conversationId: s._id,
      idempotencyKey,
    });
    if (previous) {
      if (
        previous.input !== content ||
        JSON.stringify(previous.overrides ?? {}) !==
          JSON.stringify({ systemPrompt: s.systemPrompt, skillIds: s.skillIds, ...overrides })
      )
        throw new OhError(409, 'CONFLICT', 'Idempotency key used for a different session request');
      return previous;
    }
  }
  if (s.pending) {
    const run = await collection<Run>('runs').findOne({ _id: s.pending.runId, ownerId: p.tenantId });
    if (run) await settleConversation(run);
    else if (Date.now() - s.pending.since.getTime() > 60000)
      await sessions().updateOne(
        { _id: s._id, ownerId: p.tenantId, 'pending.runId': s.pending.runId },
        { $unset: { pending: '' } },
      );
  }
  const runId = randomUUID();
  const reserved = await sessions().findOneAndUpdate(
    { _id: s._id, ownerId: p.tenantId, status: 'active', pending: { $exists: false } },
    { $set: { pending: { runId, since: new Date() }, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!reserved) throw new OhError(409, 'CONFLICT', 'Session already has an active turn');
  try {
    return await createRun(
      p.tenantId,
      {
        workflowId: s.workflowId,
        agentId: s.agentId,
        input: z.string().min(1).max(32000).parse(content),
        history: reserved.messages.slice(-20).map(({ role, content }) => ({ role, content })),
        ...(s.deviceId ? { deviceId: s.deviceId } : {}),
        ...(timezone ? { timezone } : {}),
      },
      {
        runId,
        idempotencyKey,
        conversationId: s._id,
        apiHarnessId: req.harness?._id,
        agentNodeId: s.nodeId,
        initiatedBy: p.user._id,
        trigger: 'chat',
        ...(p.token ? { tokenId: p.token._id } : {}),
        overrides: { systemPrompt: s.systemPrompt, skillIds: s.skillIds, ...overrides },
      },
    );
  } catch (e) {
    await sessions().updateOne(
      { _id: s._id, ownerId: p.tenantId, 'pending.runId': runId },
      { $unset: { pending: '' } },
    );
    throw e;
  }
}
export function sessionOperations(registry: OperationRegistry): Operation[] {
  registry.declare('sessions', {
    operations: ['connect'],
    limitations: ['Session history retains the latest 100 messages; prompts use the latest 20 messages'],
  });
  return [
    {
      id: 'sessions.list',
      provides: { domain: 'sessions', operations: ['list'] },
      handler: async (req) => {
        const p = requireAccess(req, 'read'),
          q = pageQuery.parse(req.query);
        const rows = await sessions()
          .find({ ownerId: p.tenantId, harnessId: harnessId(req), ...actor(req) })
          .sort({ updatedAt: -1 })
          .toArray();
        return pageOf(
          rows
            .filter(
              (s) =>
                (!req.query.status || s.status === req.query.status) &&
                (!req.query.agent_id || (s.nodeId ?? s.workflowId ?? s.agentId) === req.query.agent_id),
            )
            .map(view),
          q,
        );
      },
    },
    {
      id: 'sessions.create',
      provides: { domain: 'sessions', operations: ['create'] },
      handler: async (req, res) => {
        const p = requireAccess(req, 'execute');
        const b = z
          .object({
            name: z.string().min(1).max(100).optional(),
            agent_id: z.string().max(200).optional(),
            skills: z.array(z.string().uuid()).max(20).optional(),
            system_prompt: z.string().max(32000).optional(),
            'x-openharness': z.object({ machine_id: z.string().max(63).optional() }).optional(),
          })
          .parse(req.body ?? {});
        const target = req.harness
          ? { workflowId: req.harness._id }
          : await resolveTarget(p.tenantId, b.agent_id);
        requireAccess(req, 'execute', target);
        if (
          req.harness &&
          b.agent_id &&
          !req.harness.nodes.some((n) => n.type === 'agent' && n.id === b.agent_id)
        )
          throw notFound('Agent');
        if (
          b.skills &&
          (await collection('skills').countDocuments({
            _id: { $in: b.skills },
            ownerId: p.tenantId,
            enabled: true,
          })) !== new Set(b.skills).size
        )
          throw new OhError(400, 'VALIDATION_ERROR', 'Unknown skills');
        const s: ApiSession = {
          _id: randomUUID(),
          ownerId: p.tenantId,
          actor: p.token ? `token:${p.token._id}` : `user:${p.user._id}`,
          ...target,
          harnessId: harnessId(req),
          ...(req.harness && b.agent_id ? { nodeId: b.agent_id } : {}),
          name: b.name,
          status: 'active',
          messages: [],
          skillIds: b.skills,
          systemPrompt: b.system_prompt,
          deviceId: b['x-openharness']?.machine_id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await sessions().insertOne(s);
        res.status(201).json({ session: view(s), connect_url: connectUrl(s) });
      },
    },
    { id: 'sessions.get', handler: async (req) => ({ session: view(await sessionFor(req)) }) },
    ...(['update', 'resume', 'end'] as const).map((action): Operation => ({
      id: `sessions.${action}`,
      provides: { domain: 'sessions', operations: [action] },
      handler: async (req, res) => {
        const s = await sessionFor(req, 'execute');
        if (s.pending) throw new OhError(409, 'CONFLICT', 'Wait for or cancel the active turn first');
        const b = z
          .object({
            name: z.string().min(1).max(100).optional(),
            status: z.enum(['active', 'paused']).optional(),
            delete_history: z.boolean().optional(),
          })
          .parse(req.body ?? {});
        if (s.status === 'ended' && action !== 'end')
          throw new OhError(409, 'CONFLICT', 'Ended sessions cannot resume');
        const updated = {
          ...s,
          ...(b.name ? { name: b.name } : {}),
          status:
            action === 'end'
              ? ('ended' as const)
              : action === 'resume'
                ? ('active' as const)
                : (b.status ?? s.status),
          updatedAt: new Date(),
        };
        if (action === 'end' && (b.delete_history || req.query.delete_history === 'true'))
          updated.messages = [];
        const r = await sessions().replaceOne(
          { _id: s._id, ownerId: s.ownerId, updatedAt: s.updatedAt, pending: { $exists: false } },
          updated,
        );
        if (!r.matchedCount) throw new OhError(409, 'CONFLICT', 'Session changed; retry');
        if (action === 'end') return res.status(204).end();
        return {
          session: view(updated),
          ...(action === 'resume' ? { connect_url: connectUrl(updated) } : {}),
        };
      },
    })),
    {
      id: 'sessions.history',
      provides: { domain: 'sessions', operations: ['history'] },
      handler: async (req) => {
        const s = await sessionFor(req);
        const q = pageQuery.extend({ since: z.string().datetime().optional() }).parse(req.query);
        return pageOf(
          history(s).filter((m) => !q.since || m.created_at > q.since),
          q,
        );
      },
    },
    {
      id: 'sessions.fork',
      provides: { domain: 'sessions', operations: ['fork'] },
      handler: async (req, res) => {
        const s = await sessionFor(req, 'execute'),
          b = z
            .object({
              new_name: z.string().min(1).max(100).optional(),
              from_message_id: z.string().max(200).optional(),
            })
            .parse(req.body ?? {});
        const h = history(s),
          at = b.from_message_id ? h.findIndex((m) => m.id === b.from_message_id) : h.length - 1;
        if (b.from_message_id && at < 0) throw notFound('Message');
        const { pending: _pending, lastRunId: _last, lastTurn: _turn, ...base } = s;
        const copy = {
          ...base,
          _id: randomUUID(),
          name: b.new_name ?? s.name,
          status: 'active' as const,
          messages: s.messages.slice(0, at + 1),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await sessions().insertOne(copy);
        res
          .status(201)
          .json({ session: view(copy), forked_from: s._id, message_count: copy.messages.length });
      },
    },
    ...(['sendMessage', 'sendMessageStream'] as const).map((id): Operation => ({
      id: `sessions.${id}`,
      provides: { domain: 'sessions', operations: [id === 'sendMessage' ? 'message' : 'stream'] },
      handler: async (req, res) => {
        const content = z.object({ content: z.string().min(1).max(32000) }).parse(req.body).content;
        const run = await sessionMessage(req, content);
        if (id === 'sendMessageStream') return stream(req, res, run, { _id: run._id, ownerId: run.ownerId });
        const deadline = Date.now() + 20 * 60000;
        let current = run;
        while (!isTerminal(current.status)) {
          if (current.status === 'waiting_for_human')
            throw new OhError(409, 'INPUT_REQUIRED', 'Execution is waiting for human input', {
              details: { execution_id: run._id },
            });
          if (Date.now() > deadline)
            throw new OhError(408, 'TIMEOUT', 'Execution is still running', {
              details: { execution_id: run._id },
            });
          await new Promise((r) => setTimeout(r, 250));
          current = (await collection<Run>('runs').findOne({ _id: run._id, ownerId: run.ownerId }))!;
        }
        await settleConversation(current);
        if (current.status !== 'succeeded')
          throw new OhError(422, 'EXECUTION_FAILED', current.error ?? 'Execution failed');
        return {
          message: { id: `${run._id}:user`, role: 'user', content, created_at: run.createdAt.toISOString() },
          response: {
            id: `${run._id}:assistant`,
            role: 'assistant',
            content: current.output ?? '',
            created_at: current.finishedAt?.toISOString() ?? new Date().toISOString(),
          },
        };
      },
    })),
  ];
}
