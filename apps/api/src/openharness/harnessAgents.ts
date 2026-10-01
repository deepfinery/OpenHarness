import { agentWithResources } from '../../../../packages/core/src/workflow.js';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { collection } from '../../../../packages/core/src/db.js';
import {
  agentSchema,
  workflowSchema,
  type Workflow,
  type Stored,
} from '../../../../packages/core/src/schema.js';
import { validateReferences } from '../resources.js';
import { workflowFromBundle, exportBundle, entryAgentNode } from './agents.js';
import { defaultProviderId } from '../tenant.js';
import { requireAccess } from './access.js';
import { pageOf, pageQuery, type Operation } from './operations.js';
import { parseMarkdown, renderMarkdown, readZip, writeZip, fromFiles } from './oaf.js';
import { multipart } from './resources.js';
import { notFound, OhError } from './errors.js';
function nodes(req: Request) {
  return req.harness!.nodes.filter((n) => n.type === 'agent');
}
function node(req: Request) {
  const n = nodes(req).find((n) => n.id === String(req.params.agentId));
  if (!n || !n.config) throw notFound('Agent');
  return n;
}
function view(n: ReturnType<typeof node>, req: Request) {
  const a = agentWithResources(req.harness!, n.id, n.config!);
  return {
    id: n.id,
    name: a.name,
    vendorKey: 'openharness',
    agentKey: n.id,
    version: '1.0.0',
    slug: `openharness/${n.id}`,
    description: a.description,
    tags: [],
    skills: a.skillIds.map((skill_id) => ({ skill_id, required: false })),
    mcp_servers: a.connections.map((c) => ({ server_id: c.connectionId, required: true })),
    config: { system_prompt: a.systemPrompt, model: { provider: 'configured', name: a.providerId } },
    created_at: req.harness!.createdAt.toISOString(),
    updated_at: req.harness!.updatedAt.toISOString(),
  };
}
async function save(req: Request, w: Workflow) {
  await validateReferences('workflows', req.principal!.tenantId, w);
  const old = req.harness!,
    updatedAt = new Date();
  const r = await collection<Stored<Workflow>>('workflows').updateOne(
    { _id: old._id, ownerId: old.ownerId, updatedAt: old.updatedAt },
    { $set: { ...workflowSchema.parse(w), updatedAt }, $inc: { revision: 1 } },
  );
  if (!r.matchedCount) throw new OhError(409, 'CONFLICT', 'Harness changed; reload');
  req.harness = { ...old, ...w, updatedAt };
}
export function scopedAgentOperation(original: Operation): Operation {
  if (!original.id.startsWith('agents.')) return original;
  return {
    ...original,
    handler: async (req, res) => {
      if (!req.harness) return original.handler(req, res);
      for (const n of req.harness.nodes)
        if (n.type === 'agent' && !n.config && n.agentId) {
          const stored = await collection('agents').findOne({
            _id: n.agentId,
            ownerId: req.principal!.tenantId,
          });
          if (stored) n.config = agentSchema.parse(stored);
        }
      const action = original.id.slice(7),
        p = requireAccess(req, ['list', 'get', 'export'].includes(action) ? 'read' : 'manage', {
          workflowId: req.harness._id,
        });
      if (action === 'list')
        return pageOf(
          nodes(req)
            .filter((n) => n.config)
            .map((n) => view(n, req)),
          pageQuery.parse(req.query),
        );
      if (action === 'get') return { agent: view(node(req), req) };
      const w = structuredClone(workflowSchema.parse(req.harness));
      if (action === 'delete') {
        const n = node(req);
        if (
          await collection('runs').findOne({
            ownerId: p.tenantId,
            workflowId: req.harness._id,
            status: { $in: ['queued', 'running', 'waiting_for_human'] },
          })
        )
          throw new OhError(409, 'CONFLICT', 'Harness has active executions');
        w.nodes = w.nodes.filter((x) => x.id !== n.id);
        for (const x of w.nodes) {
          if ('next' in x && x.next === n.id) x.next = n.next;
          if (x.type === 'condition') {
            if (x.onTrue === n.id) x.onTrue = n.next!;
            if (x.onFalse === n.id) x.onFalse = n.next!;
          }
          if (x.type === 'parallel') x.agentNodeIds = x.agentNodeIds.filter((id) => id !== n.id);
        }
        w.bindings = w.bindings.filter((b) => b.agentNodeId !== n.id);
        await save(req, w);
        return res.status(204).end();
      }
      if (action === 'export') {
        const n = node(req);
        const selected: Stored<Workflow> = {
          ...req.harness,
          name: n.config!.name,
          description: n.config!.description,
          startAt: 'export_start',
          nodes: [
            { id: 'export_start', type: 'start', name: 'Start', next: n.id },
            { ...n, next: 'export_finish' },
            { id: 'export_finish', type: 'finish', name: 'Finish', template: '{{last}}' },
          ],
          bindings: req.harness.bindings.filter((b) => b.agentNodeId === n.id),
        };
        const { buffer, filename } = await exportBundle(req, selected);
        res.type('application/zip').attachment(filename).send(buffer);
        return;
      }
      let name: string, description: string, instructions: string, providerId: string | undefined;
      if (action === 'create' || action === 'import') {
        let files = new Map<string, string>(),
          metadata: any = {};
        if (req.is('multipart/form-data')) {
          const uploaded = await multipart(req, res);
          if (action === 'import') {
            const f = uploaded.find((x) => x.fieldname === 'bundle');
            if (!f) throw new OhError(400, 'VALIDATION_ERROR', 'Attach bundle');
            files = (await readZip(f.buffer)).files;
          } else for (const f of uploaded) files.set(f.originalname, f.buffer.toString('utf8'));
          metadata =
            typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : (req.body.metadata ?? {});
        } else {
          const b = z
            .object({
              metadata: z.object({
                name: z.string().min(1).max(100),
                description: z.string().max(1000).default(''),
              }),
              files: z
                .array(z.object({ path: z.string(), content: z.string().max(2_000_000) }))
                .max(100)
                .default([]),
            })
            .parse(req.body);
          metadata = b.metadata;
          files = new Map(b.files.map((f) => [f.path, f.content]));
        }
        if (!files.has('AGENTS.md'))
          files.set(
            'AGENTS.md',
            renderMarkdown(
              { name: metadata.name, description: metadata.description },
              metadata.description || `You are ${metadata.name}.`,
            ),
          );
        const warnings: string[] = [];
        const definition = workflowSchema.parse(
          await workflowFromBundle(
            { tenantId: p.tenantId, req, warnings, bundle: fromFiles(files) },
            req.body.rename_to ? { ...metadata, name: String(req.body.rename_to) } : metadata,
          ),
        );
        if (definition.nodes.filter((n) => n.type === 'agent').length !== 1)
          throw new OhError(400, 'VALIDATION_ERROR', 'Import one agent at a time into a harness');
        const imported = entryAgentNode(definition);
        if (!imported?.config)
          throw new OhError(400, 'VALIDATION_ERROR', 'Bundle has no configurable entry agent');
        const config = imported.config;
        name = definition.name;
        config.name = name;
        config.description = definition.description;
        const existing = nodes(req).find((n) => n.config?.name === name);
        const strategy = z.enum(['fail', 'skip', 'overwrite']).default('fail').parse(req.body.merge_strategy);
        if (existing) {
          if (strategy === 'fail') throw new OhError(409, 'CONFLICT', 'An agent with this name exists');
          if (strategy === 'skip') return { agent: view(existing, req), warnings: ['Existing agent kept'] };
        }
        const id = existing?.id ?? `agent_${randomUUID()}`;
        const finish = w.nodes.find((n) => n.type === 'finish');
        if (!finish) throw new OhError(409, 'CONFLICT', 'Harness has no finish node');
        if (existing) {
          w.nodes = w.nodes.filter((n) => n.id !== id);
          w.bindings = w.bindings.filter((b) => b.agentNodeId !== id);
        }
        for (const resource of definition.resources) {
          const newId = `resource_${randomUUID()}`;
          w.resources.push({ ...resource, id: newId });
          if (definition.bindings.some((b) => b.resourceId === resource.id && b.agentNodeId === imported.id))
            w.bindings.push({ agentNodeId: id, resourceId: newId });
        }
        const predecessor = !existing && w.nodes.find((n) => 'next' in n && n.next === finish.id);
        if (predecessor && 'next' in predecessor) predecessor.next = id;
        w.nodes.push({
          id,
          name,
          type: 'agent',
          config,
          prompt: '{{input}}',
          next: existing?.next ?? finish.id,
        });
        await save(req, w);
        const n = w.nodes.find((n) => n.id === id)! as ReturnType<typeof node>;
        return res.status(201).json({ agent: view(n, req), warnings });
      }
      const n = node(req),
        target = w.nodes.find((x) => x.id === n.id)! as ReturnType<typeof node>;
      if (action === 'clone') {
        const b = z.object({ new_name: z.string().min(1).max(100) }).parse(req.body);
        const clone = {
          ...structuredClone(n),
          id: `agent_${randomUUID()}`,
          name: b.new_name,
          config: { ...n.config!, name: b.new_name },
        };
        if (target.next) target.next = clone.id;
        else {
          const finish = w.nodes.find((n) => n.type === 'finish');
          const predecessor = finish && w.nodes.find((n) => 'next' in n && n.next === finish.id);
          if (!predecessor || !('next' in predecessor))
            throw new OhError(409, 'CONFLICT', 'Connect the cloned agent on the canvas first');
          predecessor.next = clone.id;
          clone.next = finish!.id;
        }
        w.nodes.push(clone);
        w.bindings.push(
          ...w.bindings.filter((b) => b.agentNodeId === n.id).map((b) => ({ ...b, agentNodeId: clone.id })),
        );
        await save(req, w);
        return res.status(201).json({ agent: view(clone, req) });
      }
      if (action === 'update') {
        const b = z
          .object({
            name: z.string().min(1).max(100).optional(),
            description: z.string().max(1000).optional(),
            config: z
              .object({
                tools_access: z
                  .object({
                    allow: z.array(z.string()).max(100).optional(),
                    deny: z.array(z.string()).max(100).optional(),
                  })
                  .optional(),
                system_prompt: z.string().min(1).max(32000).optional(),
                model: z
                  .union([z.string(), z.object({ name: z.string(), provider: z.string().optional() })])
                  .optional(),
              })
              .optional(),
          })
          .parse(req.body);
        if (b.name) {
          target.name = b.name;
          target.config!.name = b.name;
        }
        if (b.description !== undefined) target.config!.description = b.description;
        if (b.config?.system_prompt) target.config!.systemPrompt = b.config.system_prompt;
        if (b.config?.model) {
          const m = typeof b.config.model === 'string' ? b.config.model : b.config.model.name;
          const provider = await collection('providers').findOne({
            ownerId: p.tenantId,
            $or: [{ _id: m }, { name: m }, { model: m }],
          });
          if (!provider) throw new OhError(400, 'model_not_available', 'Model is not configured');
          target.config!.providerId = provider._id;
        }
        const access = b.config?.tools_access;
        if (access) {
          const matches = (patterns: string[], name: string) =>
            patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
          const allowed = (t: string) =>
            (!access.allow || matches(access.allow, t)) && !(access.deny && matches(access.deny, t));
          target.config!.connections = target
            .config!.connections.map((c) => ({ ...c, tools: c.tools.filter(allowed) }))
            .filter((c) => c.tools.length);
          // Copy shared resource bindings before narrowing; other agents retain their own permissions.
          for (const binding of w.bindings.filter((b) => b.agentNodeId === target.id)) {
            const resource = w.resources.find((r) => r.id === binding.resourceId);
            if (resource?.type !== 'mcp') continue;
            const tools = resource.tools.filter(allowed);
            w.bindings = w.bindings.filter((b) => b !== binding);
            if (tools.length) {
              const id = `resource_${randomUUID()}`;
              w.resources.push({ ...resource, id, tools });
              w.bindings.push({ agentNodeId: target.id, resourceId: id });
            }
          }
        }
        await save(req, w);
        return { agent: view(target, req) };
      }
      throw new OhError(400, 'VALIDATION_ERROR', 'Unknown agent operation');
    },
  };
}
