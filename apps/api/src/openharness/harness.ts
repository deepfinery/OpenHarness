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
        const all = [harness].filter(
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
          harness_id: config.OPENHARNESS_HARNESS_ID,
          harness_name: 'OpenHarness',
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
          check('vector_store', () => ready(`${config.WEAVIATE_URL}/v1/.well-known/ready`)),
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
    // A single installation serves exactly one harness, so the registry itself cannot be changed.
    ...(['harnesses.register', 'harnesses.update', 'harnesses.unregister'] as const).map((id): Operation => ({
      id,
      handler: (req) => {
        requireAccess(req, 'read');
        if (id !== 'harnesses.register' && req.params.harnessId !== config.OPENHARNESS_HARNESS_ID)
          throw notFound('Harness');
        throw notSupported(
          'harnesses',
          id,
          'This installation serves a single harness; the registry is read-only',
          {
            suggestion: 'Configure the harness with OPENHARNESS_HARNESS_ID and the studio settings',
          },
        );
      },
    })),
  ];
}
