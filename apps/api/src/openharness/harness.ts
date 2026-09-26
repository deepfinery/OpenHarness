import { randomUUID } from 'node:crypto';
import { workflowSchema, type Stored, type Workflow } from '../../../../packages/core/src/schema.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import { config } from '../../../../packages/core/src/config.js';
import { collection, db } from '../../../../packages/core/src/db.js';
import { gatewayConfigured } from '../../../../packages/core/src/devices.js';
import { chat, ownedProvider } from '../../../../packages/core/src/llm.js';
import { queueChannel, JOB_QUEUE } from '../../../../packages/core/src/queue.js';
import { encrypt, safeError, validateRemoteUrl } from '../../../../packages/core/src/security.js';
import { configuredVectorStores, vectorStore } from '../../../../packages/core/src/vectorstores/index.js';
import { rateLimit, type User } from '../auth.js';
import { defaultProviderId } from '../tenant.js';
import { requireAccess } from './access.js';
import { notFound, notSupported, OhError } from './errors.js';
import { pageOf, pageQuery, type OperationRegistry, type Operation } from './operations.js';
import { specVersion } from './spec.js';

const startedAt = new Date();
export const harnessVersion = (() => {
  try {
    return String(
      JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version ?? '0.0.0',
    );
  } catch {
    return '0.0.0';
  }
})();

async function harnessView(req: Request, registry: OperationRegistry) {
  if (req.harness) return scopedView(req.harness, registry);
  const tenantId = req.principal!.tenantId;
  const first = await collection<User>('users')
    .find({ $or: [{ tenantId }, { _id: tenantId }] })
    .sort({ createdAt: 1 })
    .limit(1)
    .next();
  const created = first?.createdAt ?? startedAt;
  return {
    id: config.OPENHARNESS_HARNESS_ID,
    name: 'OpenHarness',
    vendor: 'OpenHarness',
    description:
      'Self-hosted agent harness: workflows of agents with MCP tools, skills, knowledge bases and remote machines.',
    execution_type: 'hosted' as const,
    status: 'active' as const,
    capabilities: registry.manifest(),
    created_at: created.toISOString(),
    updated_at: (startedAt > created ? startedAt : created).toISOString(),
    // Extension fields are namespaced so they never collide with future spec fields.
    'x-openharness': {
      version: harnessVersion,
      spec_version: specVersion,
      base_path: config.OPENHARNESS_BASE_PATH,
    },
  };
}
function scopedView(w: Stored<Workflow>, registry: OperationRegistry) {
  return {
    id: w._id,
    name: w.name,
    vendor: 'OpenHarness',
    description: w.description,
    execution_type: 'hosted',
    status: w.enabled ? 'active' : 'maintenance',
    capabilities: registry.manifest(),
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
    'x-openharness': {
      version: harnessVersion,
      spec_version: specVersion,
      base_path: config.OPENHARNESS_BASE_PATH,
    },
  };
}
async function check(name: string, run: () => Promise<unknown>) {
  const started = Date.now();
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 3000).unref()),
    ]);
    return { name, status: 'pass' as const, latency_ms: Date.now() - started };
  } catch (error) {
    return { name, status: 'fail' as const, message: safeError(error), latency_ms: Date.now() - started };
  }
}
async function ready(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
const essential = new Set(['database', 'queue']);

export function harnessOperations(registry: OperationRegistry): Operation[] {
  return [
    {
      id: 'harnesses.list',
      handler: async (req) => {
        requireAccess(req, 'read');
        const query = pageQuery
          .extend({
            status: z.enum(['active', 'beta', 'coming_soon', 'maintenance', 'deprecated']).optional(),
            execution_type: z.enum(['hosted', 'sdk', 'ide']).optional(),
          })
          .parse(req.query);
        const harness = await harnessView(req, registry);
        const token = req.principal!.token;
        const rows = await collection<Stored<Workflow>>('workflows')
          .find({
            ownerId: req.principal!.tenantId,
            ...(token && !token.scopes.includes('harness') ? { _id: { $in: token.workflowIds } } : {}),
          })
          .toArray();
        const all = rows
          .map((w) => scopedView(w, registry))
          .filter(
            (h) =>
              (!query.status || h.status === query.status) &&
              (!query.execution_type || h.execution_type === query.execution_type),
          );
        return pageOf(all, query);
      },
    },
    {
      id: 'harnesses.get',
      handler: async (req) => {
        requireAccess(req, 'read');
        return { harness: await harnessView(req, registry) };
      },
    },
    {
      id: 'harnesses.capabilities',
      handler: async (req) => {
        requireAccess(req, 'read');
        return {
          harness_id: req.harness?._id ?? config.OPENHARNESS_HARNESS_ID,
          harness_name: req.harness?.name ?? 'OpenHarness',
          vendor: 'OpenHarness',
          version: harnessVersion,
          capabilities: registry.manifest(),
        };
      },
    },
    {
      id: 'harnesses.health',
      auth: 'optional',
      handler: async (req) => {
        const started = Date.now();
        const checks = await Promise.all([
          check('database', () => db.command({ ping: 1 })),
          check('queue', async () => (await queueChannel()).checkQueue(JOB_QUEUE)),
          check('vector_store', () => vectorStore().health()),
          ...configuredVectorStores()
            .filter((kind) => kind !== config.VECTOR_STORE)
            .map((kind) => check(`vector_store:${kind}`, () => vectorStore(kind).health())),
          ...(gatewayConfigured()
            ? [check('device_gateway', () => ready(`${config.GATEWAY_URL.replace(/\/$/, '')}/healthz`))]
            : []),
        ]);
        const failed = checks.filter((c) => c.status === 'fail');
        // Anonymous callers learn only pass/fail, not internal error messages.
        const detailed = Boolean(req.principal);
        return {
          status: failed.some((c) => essential.has(c.name))
            ? 'unhealthy'
            : failed.length
              ? 'degraded'
              : 'healthy',
          latency_ms: Date.now() - started,
          version: harnessVersion,
          checks: checks.map(({ name, status, message, latency_ms }) => ({
            name,
            status,
            ...(detailed && message ? { message } : {}),
            ...(detailed ? { latency_ms } : {}),
          })),
        };
      },
    },
    {
      id: 'harnesses.validateCredentials',
      handler: async (req) => {
        const principal = requireAccess(req, 'read');
        const body = z
          .object({
            api_key: z.string().min(1).max(4000),
            base_url: z.string().url().max(2000).optional(),
            store: z.boolean().default(false),
          })
          .parse(req.body);
        if (body.store) requireAccess(req, 'manage');
        await rateLimit(`provider-test:${principal.tenantId}`, 10);
        // Harness credentials here are the model provider's: they are tested against the workspace default provider.
        const providerId = await defaultProviderId(principal.tenantId);
        if (!providerId)
          throw new OhError(422, 'NO_MODEL_PROVIDER', 'Add a model provider before validating credentials', {
            details: { suggestion: 'Create a provider in Settings, or through the studio API' },
          });
        const provider = await ownedProvider(principal.tenantId, providerId);
        if (body.base_url) await validateRemoteUrl(body.base_url);
        const candidate = {
          ...provider,
          baseUrl: body.base_url ?? provider.baseUrl,
          apiKeyEncrypted: encrypt(body.api_key),
        };
        try {
          await chat(candidate, [{ role: 'user', content: 'Reply with the word Connected.' }], []);
        } catch (error) {
          return { valid: false, stored: false, error: safeError(error) };
        }
        if (body.store) {
          await collection<{ _id: string; ownerId: string }>('providers').updateOne(
            { _id: provider._id, ownerId: principal.tenantId },
            {
              $set: {
                apiKeyEncrypted: candidate.apiKeyEncrypted,
                ...(body.base_url ? { baseUrl: body.base_url } : {}),
                updatedAt: new Date(),
              },
            },
          );
        }
        return { valid: true, stored: body.store };
      },
    },
    {
      id: 'harnesses.register',
      handler: async (req, res) => {
        const p = requireAccess(req, 'manage');
        const b = z
          .object({
            id: z.string().uuid().optional(),
            name: z.string().min(1).max(100),
            description: z.string().max(1000).default(''),
            vendor: z.string().max(100).optional(),
            execution_type: z.literal('hosted').default('hosted'),
            config: z.object({}).strict().default({}),
          })
          .parse(req.body);
        const now = new Date();
        const row = {
          ...workflowSchema.parse({
            name: b.name,
            description: b.description,
            startAt: 'start',
            nodes: [
              { id: 'start', name: 'Start', type: 'start', next: 'finish' },
              { id: 'finish', name: 'Finish', type: 'finish', template: '{{input}}' },
            ],
          }),
          _id: b.id ?? randomUUID(),
          ownerId: p.tenantId,
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        try {
          await collection<Stored<Workflow>>('workflows').insertOne(row);
        } catch (e) {
          if ((e as { code?: number }).code === 11000)
            throw new OhError(409, 'CONFLICT', 'Harness id already exists');
          throw e;
        }
        res.status(201).json({ harness: scopedView(row, registry) });
      },
    },
    {
      id: 'harnesses.update',
      handler: async (req) => {
        requireAccess(req, 'manage');
        if (!req.harness)
          throw notSupported('harnesses', 'harnesses.update', 'The legacy workspace alias is read-only');
        const b = z
          .object({
            name: z.string().min(1).max(100).optional(),
            description: z.string().max(1000).optional(),
            status: z.enum(['active', 'maintenance']).optional(),
            config: z.object({}).strict().optional(),
          })
          .parse(req.body);
        const w = req.harness;
        const row = await collection<Stored<Workflow>>('workflows').findOneAndUpdate(
          { _id: w._id, ownerId: w.ownerId, updatedAt: w.updatedAt },
          {
            $set: {
              ...(b.name ? { name: b.name } : {}),
              ...(b.description !== undefined ? { description: b.description } : {}),
              ...(b.status ? { enabled: b.status === 'active' } : {}),
              updatedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
          { returnDocument: 'after' },
        );
        if (!row) throw new OhError(409, 'CONFLICT', 'Harness changed; reload');
        return { harness: scopedView(row, registry) };
      },
    },
    {
      id: 'harnesses.unregister',
      handler: async (req, res) => {
        requireAccess(req, 'manage');
        const w = req.harness;
        if (!w)
          throw notSupported('harnesses', 'harnesses.unregister', 'The legacy workspace alias is read-only');
        if (
          (await collection('runs').findOne({
            ownerId: w.ownerId,
            workflowId: w._id,
            status: { $in: ['queued', 'running', 'waiting_for_human'] },
          })) ||
          (await collection('conversations').findOne({
            ownerId: w.ownerId,
            workflowId: w._id,
            status: { $ne: 'ended' },
          }))
        )
          throw new OhError(409, 'CONFLICT', 'Harness has active sessions or executions');
        await collection('workflows').deleteOne({ _id: w._id, ownerId: w.ownerId });
        res.status(204).end();
      },
    },
  ];
}
