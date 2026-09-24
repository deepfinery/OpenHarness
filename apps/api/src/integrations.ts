import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from '../../../packages/core/src/db.js';
import { config } from '../../../packages/core/src/config.js';
import { hash, HttpError, randomToken } from '../../../packages/core/src/security.js';
import { createRun } from '../../../packages/core/src/runs.js';
import { id, type Run } from '../../../packages/core/src/schema.js';
import { rateLimit, type ApiToken, type User } from './auth.js';

export type Embed = {
  _id: string;
  ownerId: string;
  name: string;
  tokenHash: string;
  agentId?: string;
  workflowId?: string;
  origins: string[];
  expiresAt: Date;
  createdAt: Date;
  createdBy?: string;
};
export function publicRun(run: Run) {
  const { _id, ownerId, leaseId, leaseUntil, snapshot, requestHash, idempotencyKey, publishedAt, ...data } =
    run;
  return { id: _id, ...data };
}
async function validateTargets(ownerId: string, agentIds: string[], workflowIds: string[]) {
  if (!agentIds.length && !workflowIds.length) throw new HttpError(400, 'Select at least one target');
  for (const [kind, ids] of [
    ['agents', agentIds],
    ['workflows', workflowIds],
  ] as const) {
    for (const targetId of ids)
      if (!(await collection<{ _id: string; ownerId: string }>(kind).findOne({ _id: targetId, ownerId })))
        throw new HttpError(400, 'Integration target unavailable');
  }
}
export const integrations = Router();
integrations.get('/tokens', async (req, res) => {
  res.json(
    (
      await collection<ApiToken>('api_tokens')
        .find({ ownerId: req.principal!.tenantId })
        .sort({ createdAt: -1 })
        .toArray()
    ).map(({ _id, tokenHash, ownerId, ...t }) => ({ id: _id, ...t })),
  );
});
integrations.post('/tokens', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      agentIds: z.array(id).max(100).default([]),
      workflowIds: z.array(id).max(100).default([]),
      scopes: z
        .array(z.enum(['execute', 'read']))
        .min(1)
        .default(['read', 'execute']),
      expiresDays: z.number().int().min(1).max(365).default(30),
    })
    .parse(req.body);
  const ownerId = req.principal!.tenantId;
  await validateTargets(ownerId, body.agentIds, body.workflowIds);
  const token = `ao_${randomToken()}`;
  const { expiresDays, ...rest } = body;
  const record: ApiToken = {
    _id: randomUUID(),
    ownerId,
    ...rest,
    createdBy: req.principal!.user._id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + expiresDays * 86400000),
    createdAt: new Date(),
  };
  await collection<ApiToken>('api_tokens').insertOne(record);
  res.status(201).json({ id: record._id, token, expiresAt: record.expiresAt });
});
integrations.delete('/tokens/:id', async (req, res) => {
  await collection<ApiToken>('api_tokens').deleteOne({
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
  });
  res.status(204).end();
});
integrations.get('/embeds', async (req, res) => {
  res.json(
    (
      await collection<Embed>('embeds')
        .find({ ownerId: req.principal!.tenantId })
        .sort({ createdAt: -1 })
        .toArray()
    ).map(({ _id, ownerId, tokenHash, ...t }) => ({ id: _id, ...t })),
  );
});
integrations.post('/embeds', async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).max(100),
      agentId: id.optional(),
      workflowId: id.optional(),
      origins: z
        .array(
          z
            .string()
            .url()
            .refine((s) => {
              const u = new URL(s);
              return ['https:', 'http:'].includes(u.protocol) && u.origin === s;
            }, 'Use exact origins such as https://example.com'),
        )
        .min(1)
        .max(20),
      expiresDays: z.number().int().min(1).max(30).default(7),
    })
    .refine((b) => Boolean(b.agentId) !== Boolean(b.workflowId), 'Choose one target')
    .parse(req.body);
  const ownerId = req.principal!.tenantId;
  await validateTargets(
    ownerId,
    body.agentId ? [body.agentId] : [],
    body.workflowId ? [body.workflowId] : [],
  );
  const token = randomToken();
  const { expiresDays, ...rest } = body;
  const record: Embed = {
    _id: randomUUID(),
    ownerId,
    ...rest,
    createdBy: req.principal!.user._id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + expiresDays * 86400000),
    createdAt: new Date(),
  };
  await collection<Embed>('embeds').insertOne(record);
  res.status(201).json({
    id: record._id,
    url: `${config.PUBLIC_URL}/embed/${record._id}#${token}`,
    expiresAt: record.expiresAt,
  });
});
integrations.delete('/embeds/:id', async (req, res) => {
  await collection<Embed>('embeds').deleteOne({
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
  });
  res.status(204).end();
});
export const embedApi = Router();
embedApi.use('/:id', async (req, res, next) => {
  try {
    const token = req.headers.authorization?.startsWith('Embed ') ? req.headers.authorization.slice(6) : '';
    const embed = await collection<Embed>('embeds').findOne({
      _id: String(req.params.id),
      tokenHash: hash(token),
      expiresAt: { $gt: new Date() },
    });
    const creator =
      embed &&
      (await collection<User>('users').findOne({ _id: embed.createdBy ?? embed.ownerId, enabled: true }));
    if (!token || !embed || !creator || (creator.tenantId ?? creator._id) !== embed.ownerId)
      throw new HttpError(401, 'This embed link has expired or been revoked');
    res.locals.embed = embed;
    next();
  } catch (error) {
    next(error);
  }
});
embedApi.get('/:id', (req, res) => {
  const e: Embed = res.locals.embed;
  res.json({ name: e.name, expiresAt: e.expiresAt });
});
embedApi.post('/:id/runs', async (req, res) => {
  const embed: Embed = res.locals.embed;
  await rateLimit(`embed:${embed._id}`, 20);
  const body = z
    .object({
      input: z.string().min(1).max(8000),
      history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(16000) }))
        .max(10)
        .default([]),
    })
    .parse(req.body);
  const run = await createRun(
    embed.ownerId,
    { ...body, agentId: embed.agentId, workflowId: embed.workflowId },
    { embedId: embed._id, trigger: 'embed' },
  );
  res.status(202).json({ id: run._id, status: run.status });
});
embedApi.get('/:id/runs/:runId', async (req, res) => {
  const embed: Embed = res.locals.embed;
  const run = await collection<Run>('runs').findOne({
    _id: String(req.params.runId),
    ownerId: embed.ownerId,
    embedId: embed._id,
  });
  if (!run) throw new HttpError(404, 'Run not found');
  // Embedded visitors receive the answer, not the internal prompts, arguments or traces.
  res.json({
    id: run._id,
    status: run.status,
    output: run.output,
    error: run.error ? 'The run could not finish. Please contact the studio owner.' : undefined,
  });
});
