import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from '../../../packages/core/src/db.js';
import { config } from '../../../packages/core/src/config.js';
import { hash, HttpError, randomToken } from '../../../packages/core/src/security.js';
import { id, type Run } from '../../../packages/core/src/schema.js';
import { createRun } from '../../../packages/core/src/runs.js';
import { settleConversation, type Conversation } from '../../../packages/core/src/conversations.js';
import { checkTokenScope, rateLimit, type User } from './auth.js';

export type Webhook = {
  _id: string;
  ownerId: string;
  createdBy: string;
  name: string;
  tokenHash: string;
  agentId?: string;
  workflowId?: string;
  inputPath: string;
  expiresAt: Date;
  createdAt: Date;
};
const targetSchema = z
  .object({ agentId: id.optional(), workflowId: id.optional() })
  .refine((v) => Boolean(v.agentId) !== Boolean(v.workflowId), 'Choose one target');
export const webhookSettings = Router();
webhookSettings.get('/', async (req, res) => {
  const rows = await collection<Webhook>('webhooks')
    .find({ ownerId: req.principal!.tenantId })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(
    rows.map(({ _id, tokenHash, ownerId, ...rest }) => ({
      id: _id,
      ...rest,
      url: `${config.PUBLIC_URL}/api/hooks/${_id}`,
    })),
  );
});
webhookSettings.post('/', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      agentId: id.optional(),
      workflowId: id.optional(),
      inputPath: z
        .string()
        .regex(/^[\w.-]*$/)
        .max(200)
        .default(''),
      expiresDays: z.number().int().min(1).max(365).default(30),
    })
    .parse(req.body);
  targetSchema.parse(body);
  if (body.inputPath.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)))
    throw new HttpError(400, 'Invalid input path');
  const ownerId = req.principal!.tenantId;
  const target = await collection<{ _id: string; ownerId: string }>(
    body.agentId ? 'agents' : 'workflows',
  ).findOne({ _id: (body.agentId ?? body.workflowId)!, ownerId });
  if (!target) throw new HttpError(400, 'Webhook target unavailable');
  const secret = `wh_${randomToken()}`;
  const { expiresDays, ...rest } = body;
  const record: Webhook = {
    ...rest,
    _id: randomUUID(),
    ownerId,
    createdBy: req.principal!.user._id,
    tokenHash: hash(secret),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + expiresDays * 86400000),
  };
  await collection<Webhook>('webhooks').insertOne(record);
  res.status(201).json({
    id: record._id,
    url: `${config.PUBLIC_URL}/api/hooks/${record._id}`,
    secret,
    expiresAt: record.expiresAt,
  });
});
webhookSettings.delete('/:id', async (req, res) => {
  await collection<Webhook>('webhooks').deleteOne({
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
  });
  res.status(204).end();
});
async function authenticateWebhook(webhookId: string, authorization?: string) {
  const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const hook = await collection<Webhook>('webhooks').findOne({
    _id: webhookId,
    tokenHash: hash(secret),
    expiresAt: { $gt: new Date() },
  });
  const creator = hook && (await collection<User>('users').findOne({ _id: hook.createdBy, enabled: true }));
  if (!secret || !hook || !creator || (creator.tenantId ?? creator._id) !== hook.ownerId)
    throw new HttpError(401, 'Webhook is unavailable');
  return hook;
}
export const webhookApi = Router();
webhookApi.get('/:id/runs/:runId', async (req, res) => {
  const hook = await authenticateWebhook(String(req.params.id), req.headers.authorization);
  const run = await collection<Run>('runs').findOne({
    _id: String(req.params.runId),
    ownerId: hook.ownerId,
    webhookId: hook._id,
  });
  if (!run) throw new HttpError(404, 'Run not found');
  res.json({
    id: run._id,
    status: run.status,
    output: run.output,
    error: run.error ? 'Workflow execution failed; inspect the run in the studio.' : undefined,
  });
});
webhookApi.post('/:id', async (req, res) => {
  const hook = await authenticateWebhook(String(req.params.id), req.headers.authorization);
  await rateLimit(`hook:${hook._id}`, 60);
  const payload = z.record(z.unknown()).parse(req.body);
  let value: unknown = hook.inputPath ? payload : (payload.input ?? payload);
  if (hook.inputPath)
    for (const part of hook.inputPath.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part))
        throw new HttpError(400, 'Webhook input path is missing from the JSON payload');
      value = (value as Record<string, unknown>)[part];
    }
  const input = z
    .string()
    .min(1)
    .max(32000)
    .parse(typeof value === 'string' ? value : JSON.stringify(value));
  const key = req.headers['idempotency-key']
    ? z.string().min(1).max(128).parse(req.headers['idempotency-key'])
    : undefined;
  const run = await createRun(
    hook.ownerId,
    { agentId: hook.agentId, workflowId: hook.workflowId, input, payload, history: [] },
    {
      webhookId: hook._id,
      trigger: 'webhook',
      ...(key ? { idempotencyKey: `hook:${hook._id}:${key}` } : {}),
    },
  );
  res.status(202).json({ id: run._id, status: run.status });
});

export const conversationApi = Router();
conversationApi.post('/chat', async (req, res) => {
  const body = z
    .object({
      conversationId: id.optional(),
      agentId: id.optional(),
      workflowId: id.optional(),
      message: z.string().min(1).max(32000),
    })
    .parse(req.body);
  const principal = req.principal!;
  const ownerId = principal.tenantId;
  const actor = principal.token ? `token:${principal.token._id}` : `user:${principal.user._id}`;
  await rateLimit(`chat:${ownerId}`, 60);
  const conversations = collection<Conversation>('conversations');
  let conversation: Conversation | null;
  if (body.conversationId) {
    conversation = await conversations.findOne({ _id: body.conversationId, ownerId, actor });
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    if (
      (body.agentId && body.agentId !== conversation.agentId) ||
      (body.workflowId && body.workflowId !== conversation.workflowId)
    )
      throw new HttpError(400, 'A conversation cannot change its target');
  } else {
    const target = targetSchema.parse(body);
    checkTokenScope(req, 'execute', target);
    const record = await collection<{ _id: string; ownerId: string; enabled: boolean }>(
      target.agentId ? 'agents' : 'workflows',
    ).findOne({ _id: (target.agentId ?? target.workflowId)!, ownerId, enabled: true });
    if (!record) throw new HttpError(404, 'Conversation target unavailable');
    conversation = {
      _id: randomUUID(),
      ownerId,
      actor,
      ...target,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await conversations.insertOne(conversation);
  }
  checkTokenScope(req, 'execute', conversation);
  if (conversation.pending) {
    const previous = await collection<Run>('runs').findOne({ _id: conversation.pending.runId, ownerId });
    if (previous) await settleConversation(previous);
    else if (Date.now() - conversation.pending.since.getTime() > 60000)
      await conversations.updateOne(
        { _id: conversation._id, 'pending.runId': conversation.pending.runId },
        { $unset: { pending: '' } },
      );
  }
  const runId = randomUUID();
  const reserved = await conversations.findOneAndUpdate(
    { _id: conversation._id, ownerId, actor, pending: { $exists: false } },
    { $set: { pending: { runId, since: new Date() } } },
    { returnDocument: 'after' },
  );
  if (!reserved) throw new HttpError(409, 'Wait for the current conversation turn to finish');
  try {
    const run = await createRun(
      ownerId,
      {
        agentId: reserved.agentId,
        workflowId: reserved.workflowId,
        input: body.message,
        history: reserved.messages,
      },
      {
        runId,
        conversationId: reserved._id,
        initiatedBy: principal.user._id,
        trigger: 'chat',
        ...(principal.token ? { tokenId: principal.token._id } : {}),
      },
    );
    res.status(202).json({ id: run._id, runId: run._id, conversationId: reserved._id, status: run.status });
  } catch (error) {
    await conversations.updateOne({ _id: reserved._id, 'pending.runId': runId }, { $unset: { pending: '' } });
    throw error;
  }
});
conversationApi.get('/conversations/:id', async (req, res) => {
  const principal = req.principal!;
  const filter = {
    _id: String(req.params.id),
    ownerId: principal.tenantId,
    actor: principal.token ? `token:${principal.token._id}` : `user:${principal.user._id}`,
  };
  let c = await collection<Conversation>('conversations').findOne(filter);
  if (!c) throw new HttpError(404, 'Conversation not found');
  checkTokenScope(req, 'read', c);
  if (c.pending) {
    const run = await collection<Run>('runs').findOne({ _id: c.pending.runId, ownerId: c.ownerId });
    if (run) await settleConversation(run);
    c = (await collection<Conversation>('conversations').findOne(filter))!;
  }
  res.json({
    id: c._id,
    agentId: c.agentId,
    workflowId: c.workflowId,
    messages: c.messages,
    activeRunId: c.pending?.runId,
  });
});
