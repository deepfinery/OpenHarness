import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { hash, HttpError, safeError } from './security.js';
import { publish } from './queue.js';
import type { Agent, KnowledgeDocument, Run, RunInput, Stored, Workflow } from './schema.js';

export async function createRun(
  ownerId: string,
  input: RunInput,
  options: { idempotencyKey?: string; tokenId?: string; embedId?: string; scheduleKey?: string } = {},
) {
  const runs = collection<Run>('runs');
  const requestHash = hash(JSON.stringify({ ...input, tokenId: options.tokenId, embedId: options.embedId }));
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
  const workflow = input.workflowId
    ? await collection<Stored<Workflow>>('workflows').findOne({
        _id: input.workflowId,
        ownerId,
        enabled: true,
      })
    : null;
  if (input.workflowId && !workflow) throw new HttpError(404, 'Workflow unavailable');
  const ids = new Set<string>(input.agentId ? [input.agentId] : []);
  for (const node of workflow?.nodes ?? []) {
    if (node.type === 'agent') ids.add(node.agentId);
    if (node.type === 'parallel') node.agentIds.forEach((id) => ids.add(id));
  }
  const agents: Record<string, Agent> = {};
  for (const id of ids) {
    const agent = await collection<Stored<Agent>>('agents').findOne({ _id: id, ownerId, enabled: true });
    if (!agent) throw new HttpError(400, 'A required agent is missing or disabled');
    agents[id] = agent;
  }
  const now = new Date();
  const run: Run = {
    _id: randomUUID(),
    ownerId,
    ...input,
    ...options,
    requestHash,
    createdAt: now,
    updatedAt: now,
    label: workflow?.name ?? agents[input.agentId!]?.name ?? 'Run',
    status: 'queued',
    events: [],
    outputs: {},
    snapshot: { ...(workflow ? { workflow } : {}), agents },
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
export async function recoverStaleJobs() {
  const now = new Date();
  await collection<Run>('runs').updateMany(
    { status: 'running', leaseUntil: { $lt: now } },
    {
      $set: {
        status: 'interrupted',
        finishedAt: now,
        updatedAt: now,
        error:
          'Runner interrupted. An external tool may already have acted. Review the trace before starting a new run.',
      },
    },
  );
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
        { scheduleKey: `${w._id}:${dueAt.toISOString()}` },
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
