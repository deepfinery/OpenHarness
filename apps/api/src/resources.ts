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
  skillSchema,
  workflowSchema,
  type KnowledgeDocument,
} from '../../../packages/core/src/schema.js';
import { encrypt, HttpError, safeError, validateRemoteUrl } from '../../../packages/core/src/security.js';
import { discoverTools, startOAuth } from '../../../packages/core/src/mcp.js';
import { chat, embed, ownedProvider } from '../../../packages/core/src/llm.js';
import { dropKnowledgeIndex, searchKnowledge } from '../../../packages/core/src/knowledge.js';
import { configuredVectorStores, storeEmbeds } from '../../../packages/core/src/vectorstores/index.js';
import { createNote, noteFilename } from '../../../packages/core/src/workspace.js';
import {
  filePath,
  readStoredFile,
  removeFile,
  replaceFile,
  saveFile,
} from '../../../packages/core/src/storage.js';
import { emitHarnessEvent } from '../../../packages/core/src/harnessEvents.js';
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
export async function validateReferences(kind: string, ownerId: string, body: any) {
  if (kind === 'connections' && body.kind === 'device')
    throw new HttpError(400, 'Machines are managed on the Machines page, not as manual connections');
  if (kind === 'agents') {
    await assertOwned('providers', ownerId, body.providerId);
    for (const binding of body.connections) {
      const c = await collection<Resource>('connections').findOne({ _id: binding.connectionId, ownerId });
      if (!c) throw new HttpError(400, 'An MCP connection does not belong to this workspace');
      if (binding.tools.some((t: string) => !c.tools?.some((tool: { name: string }) => tool.name === t)))
        throw new HttpError(400, 'Discover the connection’s tools before attaching them to an agent');
    }
    for (const id of body.knowledgeBaseIds) await assertOwned('knowledge', ownerId, id);
    for (const id of body.skillIds ?? []) await assertOwned('skills', ownerId, id);
    // The server resolves skills at run time; stored agents never carry a client-supplied snapshot.
    delete body.skills;
  }
  if (kind === 'knowledge') {
    const p = await ownedProvider(ownerId, body.providerId);
    // Stores that embed text themselves need no embedding model of ours.
    if (!storeEmbeds(body.vectorStore ?? 'weaviate') && (!p.embeddingModel || p.kind === 'anthropic'))
      throw new HttpError(400, 'This knowledge base needs a provider with a supported embedding model');
  }
  if (kind === 'workflows') {
    if (body.workspace) await assertOwned('knowledge', ownerId, body.workspace.knowledgeBaseId);
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
  skills: skillSchema,
};
for (const [kind, schema] of Object.entries(definitions)) {
  const records = () => collection<Resource>(kind);
  resources.get(`/${kind}`, async (req, res) => {
    const ownerId = req.principal!.tenantId;
    const list = (await records().find({ ownerId }).sort({ createdAt: -1 }).limit(500).toArray()).map(
      publicResource,
    );
    if (kind === 'knowledge' && list.length) {
      // File counts for the knowledge-base cards, in one grouped query.
      const counts = await collection<KnowledgeDocument>('documents')
        .aggregate<{ _id: string; n: number }>([
          { $match: { ownerId, status: { $ne: 'deleting' } } },
          { $group: { _id: '$knowledgeBaseId', n: { $sum: 1 } } },
        ])
        .toArray();
      const byId = new Map(counts.map((c) => [c._id, c.n]));
      for (const k of list) (k as Record<string, unknown>).documentCount = byId.get(k.id) ?? 0;
    }
    res.json(list);
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
      if (kind === 'knowledge')
        // The store is chosen once; bases from before stores were pluggable are on Weaviate.
        body.vectorStore = previous
          ? (body.vectorStore ?? previous.vectorStore ?? 'weaviate')
          : (body.vectorStore ?? config.VECTOR_STORE);
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
      if (kind === 'knowledge') {
        if (!configuredVectorStores().includes(body.vectorStore))
          throw new HttpError(
            400,
            `The ${body.vectorStore} vector store is not configured on this deployment`,
          );
        if (
          previous &&
          (previous.vectorStore ?? 'weaviate') !== body.vectorStore &&
          (await collection<KnowledgeDocument>('documents').findOne({ ownerId, knowledgeBaseId: id }))
        )
          throw new HttpError(
            409,
            'Remove the documents before moving this knowledge base to another vector store',
          );
      }
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
      if (kind === 'skills' && method === 'post')
        await emitHarnessEvent(ownerId, 'skill.installed', { skill_id: id, name: body.name });
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
          : kind === 'skills'
            ? [
                ['agents', { skillIds: id }],
                ['workflows', { 'nodes.config.skillIds': id }],
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
    const removed = await records().findOneAndDelete({ _id: id, ownerId });
    if (!removed) throw new HttpError(404, 'Resource not found');
    if (kind === 'knowledge')
      await dropKnowledgeIndex(removed as { _id: string; vectorStore?: 'weaviate' | 'qdrant' }).catch(
        (error) => console.warn('Could not remove a knowledge index:', safeError(error)),
      );
    if (kind === 'skills') await emitHarnessEvent(ownerId, 'skill.uninstalled', { skill_id: id });
    res.status(204).end();
  });
}
/** Tests a provider definition before it is saved; an existing provider's stored key is reused when `providerId` is set. */
resources.post('/providers/test-config', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  await rateLimit(`provider-test:${ownerId}`, 10);
  const body = providerSchema.extend({ providerId: z.string().uuid().optional() }).parse(req.body);
  await validateRemoteUrl(body.baseUrl);
  const stored = body.providerId ? await ownedProvider(ownerId, body.providerId) : undefined;
  const { apiKey, providerId, ...rest } = body;
  const candidate = {
    ...rest,
    _id: providerId ?? 'draft',
    ownerId,
    createdAt: new Date(),
    updatedAt: new Date(),
    apiKeyEncrypted: apiKey ? encrypt(apiKey) : stored?.apiKeyEncrypted,
  };
  const result: {
    chat: { ok: boolean; text?: string; error?: string };
    embedding?: { ok: boolean; dimensions?: number; error?: string };
  } = {
    chat: { ok: false },
  };
  try {
    const response = await chat(candidate, [{ role: 'user', content: 'Reply with the word Connected.' }], []);
    result.chat = { ok: true, text: response.text.slice(0, 200) };
  } catch (error) {
    result.chat = { ok: false, error: safeError(error) };
  }
  if (candidate.embeddingModel) {
    try {
      const vector = await embed(candidate, 'Embedding connectivity test');
      result.embedding = { ok: true, dimensions: vector.length };
    } catch (error) {
      result.embedding = { ok: false, error: safeError(error) };
    }
  }
  res.json(result);
});
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
// Notes: text written in the studio, stored like any other document and re-indexed on every save.
const noteBody = z.object({ title: z.string().trim().min(1).max(150), content: z.string().max(2_000_000) });
const textDocument = (filename: string) => /\.(txt|md|csv|json|yaml|yml)$/i.test(filename);
resources.post('/knowledge/:id/notes', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const knowledgeBaseId = String(req.params.id);
  await assertOwned('knowledge', ownerId, knowledgeBaseId);
  const body = noteBody.extend({ folder: z.string().max(80).optional() }).parse(req.body);
  const doc = await createNote(ownerId, knowledgeBaseId, body);
  res.status(202).json({
    id: doc._id,
    filename: doc.filename,
    status: doc.status,
    kind: 'note',
    ...(doc.folder ? { folder: doc.folder } : {}),
  });
});
resources.get('/documents/:id/content', async (req, res) => {
  const doc = await collection<KnowledgeDocument>('documents').findOne({
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
    status: { $ne: 'deleting' },
  });
  if (!doc) throw new HttpError(404, 'Document not found');
  if (!textDocument(doc.filename)) throw new HttpError(415, 'Only text documents open in the editor');
  if (doc.size > 2_000_000) throw new HttpError(413, 'This document is too large to edit here');
  res.json({
    id: doc._id,
    filename: doc.filename,
    kind: doc.kind ?? 'upload',
    status: doc.status,
    content: (await readStoredFile(doc.storageKey)).toString('utf8'),
  });
});
resources.put('/documents/:id', async (req, res) => {
  const body = noteBody.partial({ title: true }).parse(req.body);
  const documents = collection<KnowledgeDocument>('documents');
  const doc = await documents.findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!doc || doc.status === 'deleting') throw new HttpError(404, 'Document not found');
  if (doc.status === 'indexing')
    throw new HttpError(409, 'This document is being indexed. Try again shortly.');
  if (!textDocument(doc.filename)) throw new HttpError(415, 'Only text documents can be edited');
  const buffer = Buffer.from(body.content, 'utf8');
  await replaceFile(doc.storageKey, buffer);
  const empty = !body.content.trim();
  await documents.updateOne(
    { _id: doc._id, ownerId: doc.ownerId },
    {
      $set: {
        filename: body.title ? noteFilename(body.title) : doc.filename,
        size: buffer.length,
        kind: 'note',
        status: empty ? 'ready' : 'queued',
        updatedAt: new Date(),
        ...(empty ? { chunks: 0 } : {}),
      },
      $unset: { publishedAt: '', error: '', leaseId: '', leaseUntil: '' },
    },
  );
  res.status(202).json({ status: empty ? 'ready' : 'queued' });
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
