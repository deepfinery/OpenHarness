import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import multer from 'multer';
import { basename } from 'node:path';
import { collection } from '../../../packages/core/src/db.js';
import { config } from '../../../packages/core/src/config.js';
import {
  agentSchema,
  connectionSchema,
  knowledgeSchema,
  providerSchema,
  workflowSchema,
  type KnowledgeDocument,
} from '../../../packages/core/src/schema.js';
import { encrypt, HttpError, validateRemoteUrl } from '../../../packages/core/src/security.js';
import { discoverTools, startOAuth } from '../../../packages/core/src/mcp.js';
import { chat, ownedProvider } from '../../../packages/core/src/llm.js';
import { searchKnowledge } from '../../../packages/core/src/knowledge.js';
import { filePath, removeFile, saveFile } from '../../../packages/core/src/storage.js';
import { rateLimit } from './auth.js';

type Resource = { _id: string; ownerId: string; createdAt: Date; updatedAt: Date; [key: string]: any };
export function publicResource(record: Resource) {
  const {
    _id,
    ownerId,
    apiKeyEncrypted,
    tokenEncrypted,
    clientSecretEncrypted,
    oauthClientEncrypted,
    oauthTokensEncrypted,
    ...data
  } = record;
  return {
    id: _id,
    ...data,
    hasApiKey: Boolean(apiKeyEncrypted),
    hasToken: Boolean(tokenEncrypted),
    hasClientSecret: Boolean(clientSecretEncrypted),
    authorized: Boolean(oauthTokensEncrypted),
  };
}
async function assertOwned(name: string, ownerId: string, id: string) {
  if (!(await collection<Resource>(name).findOne({ _id: id, ownerId })))
    throw new HttpError(400, `Referenced ${name} resource is unavailable`);
}
async function validateReferences(kind: string, ownerId: string, body: any) {
  if (kind === 'agents') {
    await assertOwned('providers', ownerId, body.providerId);
    for (const binding of body.connections) {
      const c = await collection<Resource>('connections').findOne({ _id: binding.connectionId, ownerId });
      if (!c) throw new HttpError(400, 'An MCP connection does not belong to this workspace');
      if (binding.tools.some((t: string) => !c.tools?.some((tool: { name: string }) => tool.name === t)))
        throw new HttpError(400, 'Discover the connection’s tools before attaching them to an agent');
    }
    for (const id of body.knowledgeBaseIds) await assertOwned('knowledge', ownerId, id);
  }
  if (kind === 'knowledge') {
    const p = await ownedProvider(ownerId, body.providerId);
    if (!p.embeddingModel || p.kind === 'anthropic')
      throw new HttpError(400, 'This knowledge base needs a provider with a supported embedding model');
  }
  if (kind === 'workflows') {
    for (const resource of body.resources ?? []) {
      if (resource.type === 'knowledge') await assertOwned('knowledge', ownerId, resource.knowledgeBaseId);
      else {
        const c = await collection<Resource>('connections').findOne({ _id: resource.connectionId, ownerId });
        if (
          !c?.enabled ||
          resource.tools.some((name: string) => !c.tools?.some((t: { name: string }) => t.name === name))
        )
          throw new HttpError(
            400,
            'Attach discovered tools from an enabled MCP connection in this workspace',
          );
      }
    }
    for (const n of body.nodes) {
      if (n.type === 'agent') {
        if (n.agentId) await assertOwned('agents', ownerId, n.agentId);
        if (n.config) await validateReferences('agents', ownerId, n.config);
      }
      if (n.type === 'parallel') for (const id of n.agentIds) await assertOwned('agents', ownerId, id);
      if (n.type === 'tool') {
        const c = await collection<Resource>('connections').findOne({ _id: n.connectionId, ownerId });
        if (!c?.tools?.some((t: { name: string }) => t.name === n.tool))
          throw new HttpError(400, 'Choose a discovered tool from an owned MCP connection');
      }
    }
  }
}
export const resources = Router();
const definitions = {
  agents: agentSchema,
  providers: providerSchema,
  connections: connectionSchema,
  knowledge: knowledgeSchema,
  workflows: workflowSchema,
};
for (const [kind, schema] of Object.entries(definitions)) {
  const records = () => collection<Resource>(kind);
  resources.get(`/${kind}`, async (req, res) => {
    res.json(
      (
        await records()
          .find({ ownerId: req.principal!.tenantId })
          .sort({ createdAt: -1 })
          .limit(500)
          .toArray()
      ).map(publicResource),
    );
  });
  resources.get(`/${kind}/:id`, async (req, res) => {
    const record = await records().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
    if (!record) throw new HttpError(404, 'Resource not found');
    res.json(publicResource(record));
  });
  for (const method of ['post', 'put'] as const)
    resources[method](`/${kind}${method === 'put' ? '/:id' : ''}`, async (req, res) => {
      const ownerId = req.principal!.tenantId;
      const body: any = schema.parse(req.body);
      const id = method === 'put' ? String((req.params as Record<string, string>).id) : randomUUID();
      const previous = method === 'put' ? await records().findOne({ _id: id, ownerId }) : null;
      if (method === 'put' && !previous) throw new HttpError(404, 'Resource not found');
      if (kind === 'providers' || kind === 'connections') await validateRemoteUrl(body.baseUrl ?? body.url);
      await validateReferences(kind, ownerId, body);
      if (
        kind === 'providers' &&
        previous &&
        ['kind', 'baseUrl', 'embeddingModel'].some((k) => previous[k] !== body[k]) &&
        (await collection<Resource>('knowledge').findOne({ ownerId, providerId: id }))
      )
        throw new HttpError(
          409,
          'This provider is used by a knowledge base. Create a new provider to change its embedding configuration.',
        );
      if (
        kind === 'knowledge' &&
        previous &&
        previous.providerId !== body.providerId &&
        (await collection<KnowledgeDocument>('documents').findOne({ ownerId, knowledgeBaseId: id }))
      )
        throw new HttpError(409, 'Remove the documents before changing the embedding provider');
      const data = { ...body };
      for (const [plain, encrypted] of [
        ['apiKey', 'apiKeyEncrypted'],
        ['token', 'tokenEncrypted'],
        ['oauthClientSecret', 'clientSecretEncrypted'],
      ]) {
        if (data[plain] !== undefined) data[encrypted] = data[plain] ? encrypt(data[plain]) : '';
        delete data[plain];
      }
      const clear: Record<string, string> = {};
      if (
        kind === 'connections' &&
        previous &&
        ['url', 'authType', 'oauthClientId', 'oauthScope'].some((k) => previous[k] !== body[k])
      ) {
        for (const key of ['tools', 'oauthTokensEncrypted', 'oauthClientEncrypted', 'lastCheckedAt'])
          clear[key] = '';
      }
      if (
        kind === 'workflows' &&
        previous &&
        JSON.stringify(previous.schedule) !== JSON.stringify(body.schedule)
      )
        clear.nextRunAt = '';
      const now = new Date();
      if (method === 'put') {
        const expected = req.headers['if-match'];
        if (expected !== undefined && String(previous?.revision ?? 0) !== expected)
          throw new HttpError(
            409,
            'This workflow was changed by a teammate. Close and reopen it before saving.',
          );
        const result = await records().updateOne(
          {
            _id: id,
            ownerId,
            ...(expected === undefined
              ? {}
              : previous?.revision === undefined
                ? { revision: { $exists: false } }
                : { revision: previous.revision }),
          },
          {
            $set: { ...data, updatedAt: now, updatedBy: req.principal!.user._id },
            $inc: { revision: 1 },
            ...(Object.keys(clear).length ? { $unset: clear } : {}),
          },
        );
        if (!result.matchedCount) throw new HttpError(409, 'This resource changed. Reopen it before saving.');
      } else
        await records().insertOne({
          ...data,
          _id: id,
          ownerId,
          createdBy: req.principal!.user._id,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      res
        .status(method === 'post' ? 201 : 200)
        .json(publicResource((await records().findOne({ _id: id, ownerId }))!));
    });
  resources.delete(`/${kind}/:id`, async (req, res) => {
    const id = String(req.params.id);
    const ownerId = req.principal!.tenantId;
    const blockers: [string, Record<string, unknown>][] =
      kind === 'providers'
        ? [
            ['agents', { providerId: id }],
            ['knowledge', { providerId: id }],
            ['workflows', { 'nodes.config.providerId': id }],
          ]
        : kind === 'connections'
          ? [
              ['agents', { 'connections.connectionId': id }],
              [
                'workflows',
                {
                  $or: [
                    { 'nodes.connectionId': id },
                    { 'resources.connectionId': id },
                    { 'nodes.config.connections.connectionId': id },
                  ],
                },
              ],
            ]
          : kind === 'agents'
            ? [['workflows', { $or: [{ 'nodes.agentId': id }, { 'nodes.agentIds': id }] }]]
            : kind === 'knowledge'
              ? [
                  ['agents', { knowledgeBaseIds: id }],
                  ['documents', { knowledgeBaseId: id }],
                  [
                    'workflows',
                    { $or: [{ 'resources.knowledgeBaseId': id }, { 'nodes.config.knowledgeBaseIds': id }] },
                  ],
                ]
              : [];
    for (const [name, query] of blockers)
      if (await collection<Resource>(name).findOne({ ownerId, ...query }))
        throw new HttpError(409, `Remove this resource’s references in ${name} first`);
    const result = await records().deleteOne({ _id: id, ownerId });
    if (!result.deletedCount) throw new HttpError(404, 'Resource not found');
    res.status(204).end();
  });
}
resources.post('/providers/:id/test', async (req, res) => {
  await rateLimit(`provider-test:${req.principal!.tenantId}`, 10);
  const provider = await ownedProvider(req.principal!.tenantId, String(req.params.id));
  const response = await chat(provider, [{ role: 'user', content: 'Reply with the word Connected.' }], []);
  res.json({ text: response.text });
});
resources.post('/connections/:id/discover', async (req, res) => {
  await rateLimit(`mcp-discover:${req.principal!.tenantId}`, 20);
  res.json(await discoverTools(req.principal!.tenantId, String(req.params.id)));
});
resources.post('/connections/:id/oauth', async (req, res) => {
  res.json(await startOAuth(req.principal!.tenantId, String(req.params.id), req.principal!.sessionHash!));
});
resources.post('/connections/:id/disconnect', async (req, res) => {
  await collection<Resource>('connections').updateOne(
    { _id: String(req.params.id), ownerId: req.principal!.tenantId },
    { $unset: { oauthTokensEncrypted: '', oauthClientEncrypted: '', tools: '', lastCheckedAt: '' } },
  );
  res.status(204).end();
});
resources.get('/knowledge/:id/documents', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  await assertOwned('knowledge', ownerId, String(req.params.id));
  const docs = await collection<KnowledgeDocument>('documents')
    .find({ knowledgeBaseId: String(req.params.id), ownerId })
    .sort({ createdAt: -1 })
    .limit(1000)
    .toArray();
  res.json(docs.map(({ _id, storageKey, ownerId, leaseId, leaseUntil, ...d }) => ({ id: _id, ...d })));
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});
resources.post('/knowledge/:id/documents', upload.single('file'), async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const knowledgeBaseId = String(req.params.id);
  await assertOwned('knowledge', ownerId, knowledgeBaseId);
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const filename = basename(req.file.originalname)
    .replace(/[\r\n\0]/g, '')
    .slice(0, 200);
  if (!/\.(txt|md|csv|json|yaml|yml|pdf|docx)$/i.test(filename))
    throw new HttpError(400, 'Supported files: TXT, MD, CSV, JSON, YAML, PDF and DOCX');
  const _id = randomUUID();
  const storageKey = `${ownerId}/${_id}`;
  const now = new Date();
  await saveFile(storageKey, req.file.buffer);
  const doc: KnowledgeDocument = {
    _id,
    ownerId,
    knowledgeBaseId,
    filename,
    storageKey,
    size: req.file.size,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await collection<KnowledgeDocument>('documents').insertOne(doc);
  } catch (e) {
    await removeFile(storageKey);
    throw e;
  }
  res.status(202).json({ id: _id, filename, status: 'queued' });
});
resources.get('/documents/:id/download', async (req, res) => {
  const doc = await collection<KnowledgeDocument>('documents').findOne({
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
    status: { $ne: 'deleting' },
  });
  if (!doc) throw new HttpError(404, 'Document not found');
  res.download(filePath(doc.storageKey), doc.filename);
});
resources.post('/documents/:id/reindex', async (req, res) => {
  const r = await collection<KnowledgeDocument>('documents').updateOne(
    { _id: String(req.params.id), ownerId: req.principal!.tenantId, status: { $in: ['ready', 'failed'] } },
    {
      $set: { status: 'queued', updatedAt: new Date() },
      $unset: { publishedAt: '', error: '', leaseId: '', leaseUntil: '' },
    },
  );
  if (!r.matchedCount) throw new HttpError(409, 'Document is unavailable or already being processed');
  res.status(202).json({ status: 'queued' });
});
resources.delete('/documents/:id', async (req, res) => {
  const r = await collection<KnowledgeDocument>('documents').updateOne(
    { _id: String(req.params.id), ownerId: req.principal!.tenantId },
    { $set: { status: 'deleting', updatedAt: new Date() }, $unset: { publishedAt: '' } },
  );
  if (!r.matchedCount) throw new HttpError(404, 'Document not found');
  res.status(202).json({ status: 'deleting' });
});
resources.post('/knowledge/:id/search', async (req, res) => {
  const body = z.object({ query: z.string().min(1).max(4000) }).parse(req.body);
  await rateLimit(`knowledge-search:${req.principal!.tenantId}`, 30);
  res.json(await searchKnowledge(req.principal!.tenantId, String(req.params.id), body.query));
});
