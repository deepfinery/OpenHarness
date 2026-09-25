import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { hash, HttpError, safeError } from './security.js';
import { publish } from './queue.js';
import type { Agent, KnowledgeDocument, Run, RunInput, Stored, Workflow } from './schema.js';
import { workflowSchema } from './schema.js';
import { agentWithResources } from './workflow.js';
import { resumeDecision } from './runtime.js';
import { settleConversation } from './conversations.js';

export async function createRun(
  ownerId: string,
  input: RunInput,
  options: {
    idempotencyKey?: string;
    tokenId?: string;
    embedId?: string;
    scheduleKey?: string;
    initiatedBy?: string;
    trigger?: Run['trigger'];
    webhookId?: string;
    conversationId?: string;
    runId?: string;
  } = {},
) {
  const runs = collection<Run>('runs');
  const requestHash = hash(
    JSON.stringify({
      ...input,
      tokenId: options.tokenId,
      embedId: options.embedId,
      initiatedBy: options.initiatedBy,
      webhookId: options.webhookId,
    }),
  );
  if (options.idempotencyKey) {
    const existing = await runs.findOne({ ownerId, idempotencyKey: options.idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new HttpError(409, 'This idempotency key was used for a different request');
      return existing;
    }
  }
  if (options.scheduleKey) {
    const existing = await runs.findOne({ scheduleKey: options.scheduleKey, ownerId });
    if (existing) return existing;
  }
  if (
    (await runs.countDocuments({ ownerId, status: { $in: ['queued', 'running'] } })) >= config.MAX_ACTIVE_RUNS
  )
    throw new HttpError(429, 'Too many active runs. Wait for a run to finish.');
  const workflowRecord = input.workflowId
    ? await collection<Stored<Workflow>>('workflows').findOne({
        _id: input.workflowId,
        ownerId,
        enabled: true,
      })
    : null;
  if (input.workflowId && !workflowRecord) throw new HttpError(404, 'Workflow unavailable');
  const workflow = workflowRecord ? workflowSchema.parse(workflowRecord) : null;
  const ids = new Set<string>(input.agentId ? [input.agentId] : []);
  for (const node of workflow?.nodes ?? []) {
    if (node.type === 'agent' && node.agentId) ids.add(node.agentId);
    if (node.type === 'parallel') node.agentIds.forEach((id) => ids.add(id));
  }
  const agents: Record<string, Agent> = {};
  for (const id of ids) {
    const agent = await collection<Stored<Agent>>('agents').findOne({ _id: id, ownerId, enabled: true });
    if (!agent) throw new HttpError(400, 'A required agent is missing or disabled');
    agents[id] = agent;
  }
  const nodeAgents: Record<string, Agent> = {};
  for (const node of workflow?.nodes ?? [])
    if (node.type === 'agent') {
      const base = node.config ?? agents[node.agentId!];
      if (!base?.enabled) throw new HttpError(400, 'A required agent is missing or disabled');
      nodeAgents[node.id] = agentWithResources(workflow!, node.id, base);
    }
  const now = new Date();
  const { runId, ...attributes } = options;
  const run: Run = {
    _id: runId ?? randomUUID(),
    ownerId,
    ...input,
    ...attributes,
    requestHash,
    createdAt: now,
    updatedAt: now,
    label: workflow?.name ?? agents[input.agentId!]?.name ?? 'Run',
    status: 'queued',
    events: [],
    outputs: {},
    snapshot: { ...(workflow ? { workflow, nodeAgents } : {}), agents },
  };
  try {
    await runs.insertOne(run);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await runs.findOne(
        options.scheduleKey
          ? { ownerId, scheduleKey: options.scheduleKey }
          : { ownerId, idempotencyKey: options.idempotencyKey },
      );
      if (existing && existing.requestHash === requestHash) return existing;
      throw new HttpError(409, 'Duplicate run request');
    }
    throw error;
  }
  // The durable Mongo record is the outbox. Broker failure leaves it queued for the dispatcher.
  void publish({ kind: 'run', id: run._id })
    .then(() => runs.updateOne({ _id: run._id, status: 'queued' }, { $set: { publishedAt: now } }))
    .catch(() => {});
  return run;
}
export async function dispatchPending() {
  const stale = new Date(Date.now() - 30000);
  const pending = { $or: [{ publishedAt: { $exists: false } }, { publishedAt: { $lt: stale } }] };
  for (const run of await collection<Run>('runs')
    .find({ status: 'queued', ...pending })
    .limit(100)
    .toArray()) {
    await publish({ kind: 'run', id: run._id });
    await collection<Run>('runs').updateOne(
      { _id: run._id, status: 'queued' },
      { $set: { publishedAt: new Date() } },
    );
  }
  for (const doc of await collection<KnowledgeDocument>('documents')
    .find({ status: { $in: ['queued', 'deleting'] }, ...pending })
    .limit(100)
    .toArray()) {
    await publish({ kind: doc.status === 'deleting' ? 'delete' : 'index', id: doc._id });
    await collection<KnowledgeDocument>('documents').updateOne(
      { _id: doc._id, status: doc.status },
      { $set: { publishedAt: new Date() } },
    );
  }
}
/**
 * Runs whose lease expired belong to a runner that died. Resume them from the last checkpoint when the
 * in-flight step cannot have acted on an external system (or the workflow opts in); otherwise fail safe.
 */
export async function recoverStaleJobs() {
  const now = new Date();
  const runs = collection<Run>('runs');
  const stale = await runs
    .find({ status: 'running', leaseUntil: { $lt: now } })
    .limit(100)
    .toArray();
  for (const run of stale) {
    const claim = {
      _id: run._id,
      status: 'running' as const,
      leaseId: run.leaseId,
      leaseUntil: { $lt: now },
    };
    if (run.cancelRequested) {
      await runs.updateOne(claim, {
        $set: { status: 'cancelled', finishedAt: now, updatedAt: now },
        $unset: { leaseId: '', leaseUntil: '', partial: '' },
      });
      continue;
    }
    const decision = resumeDecision(run);
    if (decision.resume) {
      await runs.updateOne(claim, {
        $set: { status: 'queued', updatedAt: now },
        $unset: { leaseId: '', leaseUntil: '', publishedAt: '', partial: '' },
        $inc: { resumeCount: 1 },
        $push: {
          events: {
            $each: [
              {
                at: now.toISOString(),
                type: 'resumed',
                ...(run.checkpoint?.cursor ? { nodeId: run.checkpoint.cursor } : {}),
                message: `Runner lost mid-run. Resuming from the last checkpoint because ${decision.reason}.`,
              },
            ],
            $slice: -500,
          },
        },
      });
    } else {
      const error = `Runner interrupted and not resumed because ${decision.reason}. An external tool may already have acted. Review the trace before starting a new run.`;
      await runs.updateOne(claim, {
        $set: { status: 'interrupted', finishedAt: now, updatedAt: now, error },
        $unset: { leaseId: '', leaseUntil: '', partial: '' },
        $push: {
          events: { $each: [{ at: now.toISOString(), type: 'interrupted', message: error }], $slice: -500 },
        },
      });
      const finished = await runs.findOne({ _id: run._id });
      if (finished) await settleConversation(finished);
    }
  }
  await collection<KnowledgeDocument>('documents').updateMany(
    { status: 'indexing', leaseUntil: { $lt: now } },
    {
      $set: { status: 'queued', updatedAt: now },
      $unset: { leaseId: '', publishedAt: '' },
    },
  );
}
export async function dispatchSchedules() {
  const workflows = collection<Stored<Workflow> & { nextRunAt?: Date; lastScheduleError?: string }>(
    'workflows',
  );
  const due = await workflows
    .find({
      enabled: true,
      'schedule.enabled': true,
      $or: [{ nextRunAt: { $lte: new Date() } }, { nextRunAt: { $exists: false } }],
    })
    .limit(30)
    .toArray();
  for (const w of due) {
    if (!w.schedule) continue;
    const dueAt = w.nextRunAt ?? w.createdAt;
    const filter = {
      _id: w._id,
      ...(w.nextRunAt ? { nextRunAt: w.nextRunAt } : { nextRunAt: { $exists: false } }),
    };
    try {
      // A deterministic key makes concurrent dispatchers and restarts harmless. Advance only after persistence.
      await createRun(
        w.ownerId,
        { workflowId: w._id, input: w.schedule.input, history: [] },
        { scheduleKey: `${w._id}:${dueAt.toISOString()}`, trigger: 'schedule' },
      );
      await workflows.updateOne(filter, {
        $set: { nextRunAt: new Date(Date.now() + w.schedule.everyMinutes * 60000) },
        $unset: { lastScheduleError: '' },
      });
    } catch (error) {
      // One unavailable agent or a saturated account must not starve other schedules.
      await workflows.updateOne(filter, {
        $set: { nextRunAt: new Date(Date.now() + 60000), lastScheduleError: safeError(error) },
      });
    }
  }
}
