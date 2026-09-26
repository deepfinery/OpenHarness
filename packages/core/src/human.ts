import { config } from './config.js';
import { sendEmail } from './email.js';
import { memorySettings, resolveNotebook } from './notebooks.js';
import { writeNotebookNote } from './workspace.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { collection } from './db.js';
import { humanSettingsSchema, type HumanSettings, type Run } from './schema.js';
import { HttpError } from './security.js';
import { emitHarnessEvent } from './harnessEvents.js';
import { validateToolArguments } from './toolValidation.js';
import { readStoredFile, replaceFile } from './storage.js';
import type { ToolDefinition } from './llm.js';

export class HumanPause extends Error {
  constructor() {
    super('Waiting for human input');
  }
}
export type HumanActor = { id: string; role: string };
export const humanDecisionSchema = z
  .object({
    decision: z.enum(['answer', 'approve', 'deny']),
    answer: z.string().max(32000).optional(),
    arguments: z.record(z.unknown()).optional(),
    feedback: z.string().max(4000).optional(),
  })
  .strict();
export type HumanDecision = z.infer<typeof humanDecisionSchema>;
export type HumanRequest = {
  _id: string;
  ownerId: string;
  runId: string;
  key: string;
  kind: 'question' | 'approval' | 'review';
  prompt: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  settings: HumanSettings;
  initiatedBy?: string;
  approvalOwnerId?: string;
  status: 'pending' | 'resolved' | 'cancelled';
  createdAt: Date;
  expiresAt: Date;
  escalatedAt?: Date;
  notebookId?: string;
  notebookRetryAt?: Date;
  notifiedAt?: Date;
  notifyAfter?: Date;
  notifyLease?: Date;
  notebookRecordedAt?: Date;
  decision?: HumanDecision;
  decidedBy?: string;
  decidedAt?: Date;
};
export function stableId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function canAnswer(request: HumanRequest, actor: HumanActor) {
  const p = request.settings.approvers;
  return (
    (p.admins && actor.role === 'admin') ||
    (p.owner && (request.approvalOwnerId ?? request.initiatedBy) === actor.id) ||
    p.userIds.includes(actor.id)
  );
}
export function needsApproval(
  settings: HumanSettings | undefined,
  tool: string,
  annotations?: Record<string, unknown>,
  riskScore = 0,
) {
  const mode = settings?.tools[tool] ?? settings?.mode ?? 'never';
  return (
    mode === 'always' ||
    (mode === 'when_risky' &&
      (riskScore >= 0.5 || annotations?.destructiveHint === true || annotations?.readOnlyHint !== true))
  );
}
export const askHumanTool: ToolDefinition = {
  name: 'ask_human',
  description:
    'Ask a person a question needed to continue. Execution pauses durably until they answer or the request expires. Do not assume an answer or approval.',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', minLength: 1, maxLength: 8000 } },
    required: ['question'],
    additionalProperties: false,
  },
};
/** Deterministic keys bind an answer to one exact call in one immutable run snapshot. */
export async function requestHuman(
  ownerId: string,
  runId: string,
  key: string,
  details: Pick<HumanRequest, 'kind' | 'prompt' | 'tool' | 'arguments' | 'inputSchema'>,
  policy?: HumanSettings,
): Promise<HumanDecision> {
  const requests = collection<HumanRequest>('human_requests');
  const _id = stableId(`${ownerId}:${runId}:${key}`);
  let request = await requests.findOne({ _id, ownerId, runId });
  if (!request) {
    const run = await collection<Run>('runs').findOne({
      _id: runId,
      ownerId,
      status: 'running',
      cancelRequested: { $ne: true },
    });
    if (!run) throw new Error('Run is no longer active');
    const settings = humanSettingsSchema.parse(policy ?? {});
    if ((await requests.countDocuments({ ownerId, runId })) >= 100)
      return { decision: 'deny', feedback: 'Human request limit reached; summarize the available evidence.' };
    const now = new Date();
    const parts = key.split(':');
    const agent =
      run.snapshot.nodeAgents?.[parts[2]] ??
      run.snapshot.agents[parts[2]] ??
      run.snapshot.nodeAgents?.[parts[0]] ??
      run.snapshot.agents[run.agentId ?? ''];
    const notebookId = resolveNotebook(agent, memorySettings(run)).workspace?.knowledgeBaseId;
    const doc: HumanRequest = {
      _id,
      ownerId,
      runId,
      key,
      ...details,
      settings,
      notebookId,
      initiatedBy: run.initiatedBy,
      approvalOwnerId: run.approvalOwnerId,
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(now.getTime() + settings.timeoutSeconds * 1000),
    };
    await requests.updateOne({ _id }, { $setOnInsert: doc }, { upsert: true });
    request = (await requests.findOne({ _id }))!;
    await collection<Run>('runs').updateOne(
      { _id: runId, ownerId, status: 'running' },
      {
        $push: {
          events: {
            $each: [
              {
                at: now.toISOString(),
                type: 'human_requested',
                message: details.prompt.slice(0, 300),
                data: { requestId: _id, kind: details.kind },
              },
            ],
            $slice: -500,
          },
        },
      },
    );
    await emitHarnessEvent(ownerId, 'human.requested', {
      request_id: _id,
      execution_id: runId,
      kind: details.kind,
      expires_at: request.expiresAt.toISOString(),
    });
  }
  if (request.status === 'cancelled') return { decision: 'deny', feedback: 'Request cancelled' };
  if (request.status === 'resolved') return request.decision!;
  throw new HumanPause();
}
/** Wake is also retried by the dispatcher, covering answers racing with worker parking or queue outages. */
export async function wakeHumanRun(runId: string) {
  const runs = collection<Run>('runs');
  const child = await runs.findOne({ _id: runId });
  if (child?.parentRunId) runId = child.parentRunId;
  const descendants = await runs.find({ parentRunId: runId }).project({ _id: 1 }).toArray();
  const requests = collection<HumanRequest>('human_requests');
  if (
    await requests.countDocuments({
      runId: { $in: [runId, ...descendants.map((r) => r._id)] },
      status: 'pending',
    })
  )
    return;
  await collection<Run>('runs').updateOne(
    { _id: runId, status: 'waiting_for_human', cancelRequested: { $ne: true } },
    {
      $set: { status: 'queued', resumeFromHuman: true, updatedAt: new Date() },
      $inc: { humanResumeCount: 1 },
      $unset: { leaseId: '', leaseUntil: '', publishedAt: '', waitingSince: '' },
    },
  );
}
export async function decideHuman(ownerId: string, id: string, actor: HumanActor, raw: unknown) {
  const requests = collection<HumanRequest>('human_requests');
  const request = await requests.findOne({ _id: id, ownerId });
  if (!request) throw new HttpError(404, 'Human request not found');
  if (!canAnswer(request, actor)) throw new HttpError(403, 'You are not an approver for this request');
  const decision = humanDecisionSchema.parse(raw);
  if (request.kind === 'question' && decision.decision === 'approve')
    throw new HttpError(400, 'Supply an answer to this question');
  if (request.kind !== 'question' && decision.decision === 'answer')
    throw new HttpError(400, 'Approve or deny this request');
  if (decision.decision === 'answer' && !decision.answer?.trim())
    throw new HttpError(400, 'An answer is required');
  if (decision.arguments && (request.kind !== 'approval' || decision.decision !== 'approve'))
    throw new HttpError(400, 'Only approved tool arguments may be edited');
  if (decision.arguments && request.inputSchema) {
    const invalid = validateToolArguments(request.inputSchema, decision.arguments);
    if (invalid) throw new HttpError(400, invalid);
  }
  if (JSON.stringify(decision).length > 64000) throw new HttpError(400, 'Decision is too large');
  const run = await collection<Run>('runs').findOne({
    _id: request.runId,
    ownerId,
    status: { $in: ['running', 'waiting_for_human'] },
    cancelRequested: { $ne: true },
  });
  if (!run) throw new HttpError(409, 'Run is no longer waiting');
  const now = new Date();
  const updated = await requests.findOneAndUpdate(
    { _id: id, ownerId, status: 'pending', expiresAt: { $gt: now } },
    {
      $set: { status: 'resolved', decision, decidedAt: now, decidedBy: actor.id },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new HttpError(409, 'Request has expired or already been answered');
  await collection<Run>('runs').updateOne(
    { _id: request.runId, ownerId },
    {
      $push: {
        events: {
          $each: [
            {
              at: now.toISOString(),
              type: 'human_decided',
              message: `Human ${decision.decision}`,
              data: { requestId: id, actorId: actor.id, decision },
            },
          ],
          $slice: -500,
        },
      },
    },
  );
  await emitHarnessEvent(ownerId, 'human.decided', {
    request_id: id,
    execution_id: request.runId,
    decision: decision.decision,
    actor_id: actor.id,
  });
  await wakeHumanRun(request.runId);
  return updated;
}
export async function dispatchHumanRequests() {
  const requests = collection<HumanRequest>('human_requests');
  for (const r of await requests
    .find({ status: 'pending', expiresAt: { $lte: new Date() } })
    .limit(100)
    .toArray()) {
    if (r.settings.timeoutAction === 'escalate' && !r.escalatedAt) {
      const changed = await requests.updateOne(
        { _id: r._id, status: 'pending', escalatedAt: { $exists: false } },
        {
          $set: {
            escalatedAt: new Date(),
            'settings.approvers.admins': true,
            expiresAt: new Date(Date.now() + r.settings.timeoutSeconds * 1000),
          },
          $unset: { notifiedAt: '', notifyAfter: '' },
        },
      );
      if (changed.modifiedCount)
        await emitHarnessEvent(r.ownerId, 'human.escalated', { request_id: r._id, execution_id: r.runId });
      continue;
    }
    // A timeout can continue without an answer, but never silently authorizes a tool.
    const decision: HumanDecision =
      r.settings.timeoutAction === 'continue' && r.kind === 'review'
        ? {
            decision: 'approve',
            feedback:
              'Configured timeout action continued the workflow with the original result; no human approved it.',
          }
        : {
            decision: 'deny',
            feedback:
              'Human request expired; no approval or answer was supplied. Continue using only existing evidence.',
          };
    const changed = await requests.updateOne(
      { _id: r._id, status: 'pending', expiresAt: { $lte: new Date() } },
      {
        $set: { status: 'resolved', decidedAt: new Date(), decidedBy: 'timeout', decision },
      },
    );
    if (changed.modifiedCount) {
      await collection<Run>('runs').updateOne(
        { _id: r.runId, ownerId: r.ownerId },
        {
          $push: {
            events: {
              $each: [
                {
                  at: new Date().toISOString(),
                  type: 'human_decided',
                  message: 'Human request expired',
                  data: { requestId: r._id, actorId: 'timeout', decision },
                },
              ],
              $slice: -500,
            },
          },
        },
      );
      await emitHarnessEvent(r.ownerId, 'human.decided', {
        request_id: r._id,
        execution_id: r.runId,
        decision: decision.decision,
        actor_id: 'timeout',
      });
    }
  }
  for (const run of await collection<Run>('runs')
    .find({ status: 'waiting_for_human', parentRunId: { $exists: false } })
    .sort({ humanCheckedAt: 1 })
    .limit(100)
    .toArray()) {
    await collection<Run>('runs').updateOne({ _id: run._id }, { $set: { humanCheckedAt: new Date() } });
    await wakeHumanRun(run._id);
  }
  // Select terminal requests on the server so old live requests cannot starve cleanup.
  const abandoned = await requests
    .aggregate<{ _id: string }>([
      { $match: { status: 'pending' } },
      {
        $lookup: {
          from: 'runs',
          localField: 'runId',
          foreignField: '_id',
          pipeline: [{ $project: { status: 1, cancelRequested: 1 } }],
          as: 'run',
        },
      },
      { $unwind: { path: '$run', preserveNullAndEmptyArrays: true } },
      {
        $match: {
          $or: [
            { 'run.status': { $nin: ['running', 'queued', 'waiting_for_human'] } },
            { 'run.cancelRequested': true },
          ],
        },
      },
      { $limit: 100 },
      { $project: { _id: 1 } },
    ])
    .toArray();
  if (abandoned.length)
    await requests.updateMany(
      { _id: { $in: abandoned.map((r) => r._id) }, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
}
/** Continuations live in the shared storage interface, avoiding Mongo's document-size ceiling. */
export async function saveContinuation(ownerId: string, runId: string, key: string, value: unknown) {
  const _id = stableId(`${runId}:${key}`);
  const storageKey = `${ownerId}/${_id}`;
  await replaceFile(storageKey, Buffer.from(JSON.stringify(value)));
  await collection('continuations').updateOne(
    { _id },
    { $set: { ownerId, runId, key, storageKey } },
    { upsert: true },
  );
}
export async function loadContinuation<T>(
  ownerId: string,
  runId: string,
  key: string,
): Promise<T | undefined> {
  const doc = await collection('continuations').findOne({ _id: stableId(`${runId}:${key}`), ownerId, runId });
  return doc ? (JSON.parse((await readStoredFile(String(doc.storageKey))).toString()) as T) : undefined;
}

/** Links identify an expiring request; login and approver authorization are still mandatory. */
export function humanLinkToken(request: HumanRequest) {
  return createHmac('sha256', Buffer.from(config.ENCRYPTION_KEY, 'hex'))
    .update(`human-link:${request.ownerId}:${request._id}:${request.expiresAt.toISOString()}`)
    .digest('hex');
}
export function validHumanLink(request: HumanRequest, token: string) {
  const expected = humanLinkToken(request);
  return (
    request.expiresAt.getTime() > Date.now() &&
    /^[a-f0-9]{64}$/.test(token) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(token))
  );
}
export async function deliverHumanNotifications() {
  const requests = collection<HumanRequest>('human_requests');
  const now = new Date();
  const pending = await requests
    .find({
      status: 'pending',
      'settings.notifyEmail': true,
      notifiedAt: { $exists: false },
      $and: [
        { $or: [{ notifyAfter: { $exists: false } }, { notifyAfter: { $lte: now } }] },
        { $or: [{ notifyLease: { $exists: false } }, { notifyLease: { $lte: now } }] },
      ],
    })
    .limit(10)
    .toArray();
  for (const r of pending) {
    const claimed = await requests.updateOne(
      {
        _id: r._id,
        status: 'pending',
        notifiedAt: { $exists: false },
        $or: [{ notifyLease: { $exists: false } }, { notifyLease: { $lte: now } }],
      },
      { $set: { notifyLease: new Date(Date.now() + 60000) } },
    );
    if (!claimed.modifiedCount) continue;
    try {
      const users = await collection<{ _id: string; email: string; role: string }>('users')
        .find({ tenantId: r.ownerId, enabled: { $ne: false } })
        .toArray();
      const recipients = users
        .filter((u) => canAnswer(r, { id: u._id, role: u.role }))
        .map((u) => u.email)
        .slice(0, 50);
      if (recipients.length)
        await sendEmail(r.ownerId, {
          to: recipients.join(','),
          subject: `OpenHarness: ${r.kind === 'question' ? 'input' : 'approval'} needed`,
          text: `Run ${r.runId} is waiting. Sign in to review the request before ${r.expiresAt.toISOString()}.\n${config.PUBLIC_URL.replace(/\/$/, '')}/inbox?requestId=${r._id}&token=${humanLinkToken(r)}`,
        });
      await requests.updateOne(
        { _id: r._id, expiresAt: r.expiresAt },
        { $set: { notifiedAt: new Date() }, $unset: { notifyLease: '' } },
      );
    } catch {
      await requests.updateOne(
        { _id: r._id },
        { $set: { notifyAfter: new Date(Date.now() + 60000) }, $unset: { notifyLease: '' } },
      );
    }
  }
  // Consent is recorded as consent, never as evidence that a proposed action succeeded.
  for (const r of await requests
    .find({
      status: 'resolved',
      notebookRecordedAt: { $exists: false },
      $or: [{ notebookRetryAt: { $exists: false } }, { notebookRetryAt: { $lte: new Date() } }],
    })
    .limit(20)
    .toArray()) {
    try {
      const run = await collection<Run>('runs').findOne({ _id: r.runId, ownerId: r.ownerId });
      const kb = r.notebookId ?? (run && memorySettings(run).workspace?.knowledgeBaseId);
      if (kb) {
        await writeNotebookNote({ ownerId: r.ownerId, workspaceId: kb, readable: [] }, kb, {
          id: `human-decision:${r._id}`,
          title: `Human decision ${r._id}`,
          folder: 'decisions',
          content: `# Human decision\n\nRequest: ${r.prompt}\n\nDecision: ${r.decision?.decision}\nActor: ${r.decidedBy}\nTime: ${r.decidedAt?.toISOString()}\nAnswer: ${r.decision?.answer ?? ''}\nFeedback: ${r.decision?.feedback ?? ''}\n\nThis records input or authorization, not execution success. Consult run ${r.runId} for the outcome.`,
          meta: {
            kind: 'decision',
            run_id: r.runId,
            human_request_id: r._id,
            decision: r.decision?.decision,
            actor: r.decidedBy,
          },
        });
      }
      await requests.updateOne({ _id: r._id }, { $set: { notebookRecordedAt: new Date() } });
    } catch {
      await requests.updateOne({ _id: r._id }, { $set: { notebookRetryAt: new Date(Date.now() + 60000) } });
    }
  }
}
