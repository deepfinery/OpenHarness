import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import {
  defaultFailMode,
  hookEvents,
  newHookSecret,
  type HookRecord,
} from '../../../../packages/core/src/hooks.js';
import type { HarnessEvent, WebhookRecord } from '../../../../packages/core/src/harnessEvents.js';
import { encrypt, privateHostAllowed, validateRemoteUrl } from '../../../../packages/core/src/security.js';
import { requireAccess } from './access.js';
import { notFound, OhError } from './errors.js';
import { page, pageQuery, type Operation, type OperationRegistry } from './operations.js';

const hooks = () => collection<HookRecord>('hooks');
const webhooks = () => collection<WebhookRecord>('harness_webhooks');
const events = () => collection<HarnessEvent>('harness_events');

const handlerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), url: z.string().url().max(2000) }),
  z.object({ type: z.literal('command'), command: z.string(), args: z.array(z.string()).optional() }),
]);
const extension = z
  .object({
    fail_mode: z.enum(['closed', 'open']).optional(),
    timeout_ms: z.number().int().min(500).max(30000).optional(),
  })
  .optional();
/** Endpoints must be HTTPS, except hosts this deployment already trusts as private (ALLOWED_PRIVATE_HOSTS). */
async function checkUrl(url: string) {
  await validateRemoteUrl(url);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !privateHostAllowed(parsed.hostname))
    throw new OhError(400, 'VALIDATION_ERROR', 'Hook and webhook URLs must use HTTPS');
}
function hookView(h: HookRecord) {
  return {
    id: h._id,
    event: h.event,
    handler: h.handler,
    enabled: h.enabled,
    'x-openharness': {
      fail_mode: h.failMode,
      timeout_ms: h.timeoutMs,
      created_at: h.createdAt.toISOString(),
    },
  };
}
function webhookView(w: WebhookRecord) {
  // The secret is shown once, when the webhook is registered.
  return {
    id: w._id,
    url: w.url,
    events: w.events,
    secret: '********',
    enabled: w.enabled,
    created_at: w.createdAt.toISOString(),
  };
}
async function ownedHook(req: Request) {
  const principal = requireAccess(req, 'manage');
  const hook = await hooks().findOne({ _id: String(req.params.hookId), ownerId: principal.tenantId });
  if (!hook) throw notFound('Hook');
  return hook;
}
function eventView(e: HarnessEvent) {
  return { id: e._id, type: e.type, data: e.data, timestamp: e.createdAt.toISOString() };
}

export function hookOperations(registry: OperationRegistry): Operation[] {
  registry.declare('hooks', {
    limitations: [
      'Handlers are webhooks; command handlers are not supported',
      'pre_tool and post_tool hooks cover MCP and machine tools; custom hooks are accepted but never fired',
    ],
  });
  return [
    {
      id: 'hooks.list',
      handler: async (req) => {
        const principal = requireAccess(req, 'manage');
        const query = z.object({ event: z.enum(hookEvents).optional() }).parse(req.query);
        const list = await hooks()
          .find({ ownerId: principal.tenantId, ...(query.event ? { event: query.event } : {}) })
          .sort({ createdAt: 1 })
          .toArray();
        return { hooks: list.map(hookView) };
      },
    },
    {
      id: 'hooks.register',
      provides: { domain: 'hooks', operations: ['pre-tool', 'post-tool', 'stop'] },
      handler: async (req, res) => {
        const principal = requireAccess(req, 'manage');
        const body = z
          .object({
            event: z.enum(hookEvents),
            handler: handlerSchema,
            enabled: z.boolean().default(true),
            'x-openharness': extension,
          })
          .parse(req.body);
        if (body.handler.type === 'command')
          throw new OhError(
            400,
            'COMMAND_HOOKS_UNSUPPORTED',
            'Command hooks are not supported; use a webhook handler',
          );
        await checkUrl(body.handler.url);
        const secret = newHookSecret();
        const now = new Date();
        const record: HookRecord = {
          _id: randomUUID(),
          ownerId: principal.tenantId,
          event: body.event,
          handler: { type: 'webhook', url: body.handler.url },
          secretEncrypted: encrypt(secret),
          enabled: body.enabled,
          failMode: body['x-openharness']?.fail_mode ?? defaultFailMode(body.event),
          timeoutMs: body['x-openharness']?.timeout_ms ?? 10000,
          createdAt: now,
          updatedAt: now,
          createdBy: principal.user._id,
        };
        await hooks().insertOne(record);
        res.status(201).json({ hook: hookView(record), 'x-openharness': { secret } });
      },
    },
    { id: 'hooks.get', handler: async (req) => ({ hook: hookView(await ownedHook(req)) }) },
    {
      id: 'hooks.update',
      handler: async (req) => {
        const hook = await ownedHook(req);
        const body = z
          .object({
            handler: handlerSchema.optional(),
            enabled: z.boolean().optional(),
            'x-openharness': extension,
          })
          .parse(req.body);
        if (body.handler?.type === 'command')
          throw new OhError(
            400,
            'COMMAND_HOOKS_UNSUPPORTED',
            'Command hooks are not supported; use a webhook handler',
          );
        if (body.handler) await checkUrl(body.handler.url);
        const $set: Partial<HookRecord> = {
          updatedAt: new Date(),
          ...(body.handler ? { handler: { type: 'webhook' as const, url: body.handler.url } } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body['x-openharness']?.fail_mode ? { failMode: body['x-openharness'].fail_mode } : {}),
          ...(body['x-openharness']?.timeout_ms ? { timeoutMs: body['x-openharness'].timeout_ms } : {}),
        };
        await hooks().updateOne({ _id: hook._id, ownerId: hook.ownerId }, { $set });
        return { hook: hookView((await hooks().findOne({ _id: hook._id, ownerId: hook.ownerId }))!) };
      },
    },
    {
      id: 'hooks.unregister',
      handler: async (req, res) => {
        const hook = await ownedHook(req);
        await hooks().deleteOne({ _id: hook._id, ownerId: hook.ownerId });
        res.status(204).end();
      },
    },
    {
      id: 'hooks.listEvents',
      provides: { domain: 'hooks', operations: ['events'] },
      handler: async (req) => {
        const principal = requireAccess(req, 'manage');
        const query = pageQuery
          .extend({
            type: z.string().max(100).optional(),
            since: z.string().datetime({ offset: true }).optional(),
          })
          .parse(req.query);
        const filter = {
          ownerId: principal.tenantId,
          ...(query.type ? { type: query.type } : {}),
          ...(query.since ? { createdAt: { $gte: new Date(query.since) } } : {}),
        };
        const [total, items] = await Promise.all([
          events().countDocuments(filter),
          events().find(filter).sort({ _id: -1 }).skip(query.offset).limit(query.limit).toArray(),
        ]);
        return page(items.map(eventView), query, total);
      },
    },
    {
      id: 'hooks.streamEvents',
      provides: { domain: 'hooks', operations: ['events'] },
      handler: async (req: Request, res: Response) => {
        const principal = requireAccess(req, 'manage');
        const types = z
          .union([z.string(), z.array(z.string())])
          .optional()
          .parse(req.query.events);
        const wanted =
          types === undefined ? undefined : (Array.isArray(types) ? types : types.split(',')).filter(Boolean);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        // Without Last-Event-ID the stream starts now; with it, it replays what was missed.
        let last =
          typeof req.headers['last-event-id'] === 'string'
            ? req.headers['last-event-id']
            : `${Date.now().toString().padStart(14, '0')}`;
        let closed = false;
        let busy = false;
        const poll = setInterval(async () => {
          if (busy || closed) return;
          busy = true;
          try {
            const next = await events()
              .find({
                ownerId: principal.tenantId,
                _id: { $gt: last },
                ...(wanted ? { type: { $in: wanted } } : {}),
              })
              .sort({ _id: 1 })
              .limit(100)
              .toArray();
            for (const e of next) {
              last = e._id;
              res.write(
                `event: ${e.type}\nid: ${e._id}\ndata: ${JSON.stringify({ type: e.type, ...e.data, timestamp: e.createdAt.toISOString() })}\n\n`,
              );
            }
          } catch {
            // Keep the stream open through transient database errors.
          } finally {
            busy = false;
          }
        }, 500);
        const keepAlive = setInterval(() => !closed && res.write(': keep-alive\n\n'), 15000);
        const deadline = setTimeout(() => end(), 35 * 60000);
        const end = () => {
          if (closed) return;
          closed = true;
          clearInterval(poll);
          clearInterval(keepAlive);
          clearTimeout(deadline);
          res.end();
        };
        req.on('close', end);
        res.write(': connected\n\n');
      },
    },
    {
      id: 'webhooks.register',
      handler: async (req, res) => {
        const principal = requireAccess(req, 'manage');
        const body = z
          .object({
            url: z.string().url().max(2000),
            events: z.array(z.string().min(1).max(100)).min(1).max(50),
            secret: z.string().min(16).max(200).optional(),
          })
          .parse(req.body);
        await checkUrl(body.url);
        const secret = body.secret ?? newHookSecret();
        const record: WebhookRecord = {
          _id: randomUUID(),
          ownerId: principal.tenantId,
          url: body.url,
          events: [...new Set(body.events)],
          secretEncrypted: encrypt(secret),
          enabled: true,
          createdAt: new Date(),
          createdBy: principal.user._id,
        };
        await webhooks().insertOne(record);
        res.status(201).json({ webhook: { ...webhookView(record), secret } });
      },
    },
    {
      id: 'webhooks.list',
      handler: async (req) => {
        const principal = requireAccess(req, 'manage');
        return {
          webhooks: (
            await webhooks().find({ ownerId: principal.tenantId }).sort({ createdAt: 1 }).toArray()
          ).map(webhookView),
        };
      },
    },
    {
      id: 'webhooks.delete',
      handler: async (req, res) => {
        const principal = requireAccess(req, 'manage');
        const result = await webhooks().deleteOne({
          _id: String(req.params.webhookId),
          ownerId: principal.tenantId,
        });
        if (!result.deletedCount) throw notFound('Webhook');
        await collection('webhook_deliveries').deleteMany({
          ownerId: principal.tenantId,
          webhookId: String(req.params.webhookId),
          status: 'pending',
        });
        res.status(204).end();
      },
    },
  ];
}
