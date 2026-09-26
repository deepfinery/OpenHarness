import { snapshotGuardrails } from './guardrails.js';
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { hash, HttpError, safeError } from './security.js';
import { publish } from './queue.js';
import type {
  Agent,
  KnowledgeDocument,
  Run,
  RunInput,
  RunOverrides,
  RunStatus,
  Skill,
  Stored,
  Workflow,
} from './schema.js';
import { workflowSchema } from './schema.js';
import { agentWithResources } from './workflow.js';
import { discoverTools } from './mcp.js';
import { resumeDecision } from './runtime.js';
import { settleConversation } from './conversations.js';
import { nextScheduledAt } from './schedule.js';

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
    evaluation?: boolean;
    /** Per-run changes applied to every agent's snapshot; the stored agents and workflow are untouched. */
    overrides?: RunOverrides;
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
      overrides: options.overrides,
      evaluation: options.evaluation,
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
    (await runs.countDocuments({ ownerId, status: { $in: ['queued', 'running', 'waiting_for_human'] } })) >=
    config.MAX_ACTIVE_RUNS
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
  if (options.overrides) {
    const o = options.overrides;
    if (o.providerId && !(await collection('providers').findOne({ _id: o.providerId, ownerId })))
      throw new HttpError(400, 'Model provider unavailable');
    const apply = (a: Agent): Agent => ({
      ...a,
      ...(o.systemPrompt ? { systemPrompt: `${a.systemPrompt}\n\n${o.systemPrompt}`.slice(0, 32000) } : {}),
      ...(o.providerId ? { providerId: o.providerId } : {}),
      ...(o.skillIds?.length
        ? { skillIds: [...new Set([...(a.skillIds ?? []), ...o.skillIds])].slice(0, 20) }
        : {}),
    });
    for (const id of Object.keys(nodeAgents)) nodeAgents[id] = apply(nodeAgents[id]);
    for (const id of Object.keys(agents)) agents[id] = apply(agents[id]);
  }
  // Skills are snapshotted so editing one never changes a run that was already accepted.
  const withSkills = async (a: Agent): Promise<Agent> => {
    if (!a.skillIds?.length) return { ...a, skills: [] };
    const found = await collection<Stored<Skill>>('skills')
      .find({ _id: { $in: a.skillIds }, ownerId, enabled: true })
      .toArray();
    return {
      ...a,
      skills: found.map((s) => ({
        id: s._id,
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        enabled: true,
      })),
    };
  };
  for (const id of Object.keys(nodeAgents)) nodeAgents[id] = await withSkills(nodeAgents[id]);
  for (const id of Object.keys(agents)) agents[id] = await withSkills(agents[id]);
  // A machine chosen for the run or chat grants its tools (through its gateway connection) to every agent, and takes
  // the place of any machine the workflow's agents already have, so the agent operates exactly the machine the user
  // picked. The agents' other MCP tools stay.
  let device: Run['device'];
  if (input.deviceId) {
    const connection = await collection<{
      _id: string;
      name: string;
      platform?: Run['device'] extends infer D ? (D extends { platform: infer P } ? P : never) : never;
      tools?: { name: string }[];
      enabled: boolean;
    }>('connections').findOne({
      ownerId,
      kind: 'device',
      deviceId: input.deviceId,
    });
    if (!connection || !connection.enabled) throw new HttpError(404, 'Machine unavailable');
    let tools = (connection.tools ?? []).map((t) => t.name);
    // The tool list is stored when the machine syncs; a machine that connected since then is discovered now.
    if (!tools.length) {
      try {
        tools = (await discoverTools(ownerId, connection._id)).map((t) => t.name);
      } catch (error) {
        throw new HttpError(
          400,
          `Could not reach the machine "${connection.name}" to load its tools; make sure it is online (${safeError(error)})`,
        );
      }
    }
    if (!tools.length)
      throw new HttpError(
        400,
        `The machine "${connection.name}" allows no tools; enable some on the Machines page`,
      );
    const machines = new Set(
      (
        await collection<{ _id: string }>('connections')
          .find({ ownerId, kind: 'device' }, { projection: { _id: 1 } })
          .toArray()
      ).map((c) => c._id),
    );
    const attach = (a: Agent): Agent => ({
      ...a,
      connections: [
        ...a.connections.filter((c) => !machines.has(c.connectionId)),
        { connectionId: connection._id, tools },
      ],
    });
    for (const id of Object.keys(nodeAgents)) nodeAgents[id] = attach(nodeAgents[id]);
    for (const id of Object.keys(agents)) agents[id] = attach(agents[id]);
    device = {
      id: input.deviceId,
      name: connection.name,
      platform: connection.platform ?? 'linux',
      connectionId: connection._id,
    };
  }
  const tenant = await collection<{ _id: string; guardrailIds?: string[] }>('tenants').findOne({
    _id: ownerId,
  });
  const defaultGuardrailIds = [
    ...new Set([...(tenant?.guardrailIds ?? []), ...(workflow?.guardrailIds ?? [])]),
  ];
  const guardrails = await snapshotGuardrails(ownerId, [
    ...defaultGuardrailIds,
    ...Object.values({ ...agents, ...nodeAgents }).flatMap((a) => a.guardrailIds ?? []),
  ]);
  const now = new Date();
  const { runId, overrides, ...attributes } = options;
  const run: Run = {
    ...(device ? { device } : {}),
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
    snapshot: { ...(workflow ? { workflow, nodeAgents } : {}), agents, guardrails, defaultGuardrailIds },
    approvalOwnerId:
      workflowRecord?.createdBy ??
      (input.agentId ? (agents[input.agentId] as Stored<Agent>).createdBy : undefined) ??
      options.initiatedBy,
    ...(overrides ? { overrides } : {}),
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
export const terminalStatuses: RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];
/**
 * Requests cancellation of the run matched by `filter`: a queued run is cancelled at once, a running one is
 * flagged so its runner stops at the next boundary. Returns whether the run was still active.
 */
export async function requestCancel(filter: { _id: string; ownerId: string; tokenId?: string }) {
  const runs = collection<Run>('runs');
  const now = new Date();
  const queued = await runs.updateOne(
    { ...filter, status: { $in: ['queued', 'waiting_for_human'] } },
    { $set: { cancelRequested: true, status: 'cancelled', updatedAt: now, finishedAt: now } },
  );
  const running = await runs.updateOne(
    { ...filter, status: 'running' },
    { $set: { cancelRequested: true, updatedAt: now } },
  );
  if (queued.modifiedCount) {
    const current = await runs.findOne(filter);
    if (current) await settleConversation(current);
    const children = await runs
      .find({ parentRunId: filter._id, ownerId: filter.ownerId })
      .project({ _id: 1 })
      .toArray();
    await runs.updateMany(
      { parentRunId: filter._id, ownerId: filter.ownerId, status: { $in: ['waiting_for_human', 'queued'] } },
      { $set: { status: 'cancelled', cancelRequested: true, finishedAt: now } },
    );
    await collection('human_requests').updateMany(
      {
        runId: { $in: [filter._id, ...children.map((r) => r._id)] },
        ownerId: filter.ownerId,
        status: 'pending',
      },
      { $set: { status: 'cancelled' } },
    );
  }
  return queued.modifiedCount + running.modifiedCount > 0;
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
      await runs.updateMany(
        { parentRunId: run._id, status: { $in: ['running', 'waiting_for_human'] } },
        {
          $set: {
            status: 'interrupted',
            error: 'The parent runner was lost',
            finishedAt: now,
            updatedAt: now,
          },
        },
      );
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
    // A schedule with a wall-clock time waits for that time instead of firing the moment it is saved.
    if (!w.nextRunAt && w.schedule.at && w.schedule.everyMinutes >= 1440) {
      await workflows.updateOne(
        { _id: w._id, nextRunAt: { $exists: false } },
        { $set: { nextRunAt: nextScheduledAt(w.schedule) } },
      );
      continue;
    }
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
        $set: { nextRunAt: nextScheduledAt(w.schedule) },
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
