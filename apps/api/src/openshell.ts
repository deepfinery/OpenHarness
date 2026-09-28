// OpenShell console API: sandboxes, policies and rule proposals of an OpenShell managed machine, driven through
// the connector's tools over the device gateway's admin path. Reads need a session; changes need an administrator.
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError } from '../../../packages/core/src/security.js';
import { callDeviceTool, listMachines, ownedMachine } from '../../../packages/core/src/devices.js';

export const openshell = Router();
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const workspaceQuery = z.object({
  workspace: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
    .optional(),
});

async function call(
  tenantId: string,
  deviceId: string,
  tool: string,
  args: Record<string, unknown> = {},
  timeoutSeconds?: number,
) {
  const device = await ownedMachine(tenantId, deviceId);
  if (device.platform !== 'openshell')
    throw new HttpError(400, `${device.name} is not an OpenShell managed machine`);
  const result = await callDeviceTool(tenantId, deviceId, tool, args, timeoutSeconds);
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  // Refusals by the connector's own policy are the caller's problem (403); anything else is the machine's (502).
  const refused =
    /not allowed|allow-list|disabled by the connector|not created by this connector|sandbox limit|choose an image|denied/i.test(
      text,
    );
  if (result.isError) throw new HttpError(refused ? 403 : 502, text || `${tool} failed`);
  return result.structuredContent ?? { text };
}
const ws = (req: { query: unknown }) => workspaceQuery.parse(req.query).workspace;

openshell.get('/machines', async (req, res) => {
  const { configured, machines } = await listMachines(req.principal!.tenantId);
  res.json({ configured, machines: machines.filter((m) => m.platform === 'openshell') });
});
openshell.get('/:deviceId/status', async (req, res) => {
  res.json(await call(req.principal!.tenantId, String(req.params.deviceId), 'openshell_status'));
});
openshell.get('/:deviceId/workspaces', async (req, res) => {
  res.json(await call(req.principal!.tenantId, String(req.params.deviceId), 'list_workspaces'));
});
openshell.get('/:deviceId/sandboxes', async (req, res) => {
  const query = workspaceQuery.extend({ selector: z.string().max(500).optional() }).parse(req.query);
  res.json(await call(req.principal!.tenantId, String(req.params.deviceId), 'list_sandboxes', query));
});
openshell.post('/:deviceId/sandboxes', requireAdmin, async (req, res) => {
  const body = z
    .object({
      name: name.optional(),
      image: z.string().max(500).optional(),
      template: z.string().max(200).optional(),
      command: z.array(z.string().max(4000)).max(200).optional(),
      policy: z.string().max(200_000).optional(),
      labels: z.record(z.string().max(128), z.string().max(128)).optional(),
      providers: z.array(z.string().max(200)).max(50).optional(),
      cpu: z.string().max(20).optional(),
      memory: z.string().max(20).optional(),
      no_keep: z.boolean().optional(),
      workspace: workspaceQuery.shape.workspace,
    })
    .parse(req.body);
  res
    .status(201)
    .json(await call(req.principal!.tenantId, String(req.params.deviceId), 'create_sandbox', body, 330));
});
openshell.get('/:deviceId/sandboxes/:name', async (req, res) => {
  res.json(
    await call(req.principal!.tenantId, String(req.params.deviceId), 'get_sandbox', {
      name: name.parse(req.params.name),
      workspace: ws(req),
    }),
  );
});
openshell.delete('/:deviceId/sandboxes/:name', requireAdmin, async (req, res) => {
  res.json(
    await call(req.principal!.tenantId, String(req.params.deviceId), 'delete_sandbox', {
      name: name.parse(req.params.name),
      workspace: ws(req),
    }),
  );
});
for (const action of ['start', 'stop'] as const)
  openshell.post(`/:deviceId/sandboxes/:name/${action}`, requireAdmin, async (req, res) => {
    res.json(
      await call(
        req.principal!.tenantId,
        String(req.params.deviceId),
        `${action}_sandbox`,
        {
          name: name.parse(req.params.name),
          workspace: ws(req),
        },
        330,
      ),
    );
  });
openshell.post('/:deviceId/sandboxes/:name/exec', requireAdmin, async (req, res) => {
  const body = z
    .object({
      argv: z.array(z.string().max(4000)).min(1).max(200),
      workdir: z.string().max(1024).optional(),
      timeout_seconds: z.number().int().min(1).max(600).default(60),
      workspace: workspaceQuery.shape.workspace,
    })
    .parse(req.body);
  res.json(
    await call(
      req.principal!.tenantId,
      String(req.params.deviceId),
      'exec_in_sandbox',
      { name: name.parse(req.params.name), ...body },
      body.timeout_seconds + 30,
    ),
  );
});
openshell.get('/:deviceId/sandboxes/:name/logs', async (req, res) => {
  const query = workspaceQuery
    .extend({
      since: z
        .string()
        .regex(/^\d{1,6}(s|m|h)$/)
        .optional(),
      source: z.enum(['sandbox', 'gateway', 'all']).optional(),
      lines: z.coerce.number().int().min(1).max(5000).optional(),
    })
    .parse(req.query);
  res.json(
    await call(req.principal!.tenantId, String(req.params.deviceId), 'sandbox_logs', {
      name: name.parse(req.params.name),
      ...query,
    }),
  );
});
openshell.get('/:deviceId/sandboxes/:name/policy', async (req, res) => {
  const query = workspaceQuery
    .extend({
      view: z.enum(['base', 'full']).default('base'),
      rev: z.coerce.number().int().min(1).optional(),
    })
    .parse(req.query);
  res.json(
    await call(req.principal!.tenantId, String(req.params.deviceId), 'get_policy', {
      name: name.parse(req.params.name),
      ...query,
    }),
  );
});
openshell.get('/:deviceId/sandboxes/:name/policy/revisions', async (req, res) => {
  res.json(
    await call(req.principal!.tenantId, String(req.params.deviceId), 'list_policy_revisions', {
      name: name.parse(req.params.name),
      workspace: ws(req),
    }),
  );
});
openshell.put('/:deviceId/sandboxes/:name/policy', requireAdmin, async (req, res) => {
  const body = z
    .object({
      policy: z.string().min(2).max(200_000),
      wait: z.boolean().default(true),
      timeout_seconds: z.number().int().min(5).max(600).default(60),
      workspace: workspaceQuery.shape.workspace,
    })
    .parse(req.body);
  res.json(
    await call(
      req.principal!.tenantId,
      String(req.params.deviceId),
      'set_policy',
      { name: name.parse(req.params.name), ...body },
      body.timeout_seconds + 45,
    ),
  );
});
openshell.post('/:deviceId/sandboxes/:name/policy/rules', requireAdmin, async (req, res) => {
  const body = z
    .object({
      add_endpoints: z.array(z.string().max(500)).max(50).optional(),
      remove_endpoints: z.array(z.string().max(500)).max(50).optional(),
      add_allow: z.array(z.string().max(500)).max(50).optional(),
      add_deny: z.array(z.string().max(500)).max(50).optional(),
      remove_rules: z.array(z.string().max(200)).max(50).optional(),
      binaries: z.array(z.string().max(1024)).max(50).optional(),
      rule_name: z.string().max(200).optional(),
      any_binary: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      wait: z.boolean().default(true),
      timeout_seconds: z.number().int().min(5).max(600).default(60),
      workspace: workspaceQuery.shape.workspace,
    })
    .parse(req.body);
  res.json(
    await call(
      req.principal!.tenantId,
      String(req.params.deviceId),
      'update_policy_rules',
      { name: name.parse(req.params.name), ...body },
      body.timeout_seconds + 45,
    ),
  );
});
openshell.get('/:deviceId/sandboxes/:name/proposals', async (req, res) => {
  const query = workspaceQuery
    .extend({ status: z.enum(['pending', 'approved', 'rejected']).optional() })
    .parse(req.query);
  res.json(
    await call(req.principal!.tenantId, String(req.params.deviceId), 'list_rule_proposals', {
      name: name.parse(req.params.name),
      ...query,
    }),
  );
});
for (const decision of ['approve', 'reject'] as const)
  openshell.post(
    `/:deviceId/sandboxes/:name/proposals/:chunkId/${decision}`,
    requireAdmin,
    async (req, res) => {
      const body = z
        .object({ reason: z.string().max(500).optional(), workspace: workspaceQuery.shape.workspace })
        .parse(req.body ?? {});
      res.json(
        await call(req.principal!.tenantId, String(req.params.deviceId), `${decision}_rule`, {
          name: name.parse(req.params.name),
          chunk_id: z
            .string()
            .regex(/^[A-Za-z0-9._:-]{1,200}$/)
            .parse(req.params.chunkId),
          ...(decision === 'reject' ? { reason: body.reason } : {}),
          workspace: body.workspace,
        }),
      );
    },
  );
openshell.get('/:deviceId/policy/global', async (req, res) => {
  const query = z.object({ view: z.enum(['base', 'full']).default('full') }).parse(req.query);
  res.json(await call(req.principal!.tenantId, String(req.params.deviceId), 'get_global_policy', query));
});
