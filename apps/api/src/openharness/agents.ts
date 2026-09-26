import { HttpError } from '../../../../packages/core/src/security.js';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Filter } from 'mongodb';
import { z } from 'zod';
import { config } from '../../../../packages/core/src/config.js';
import { collection } from '../../../../packages/core/src/db.js';
import {
  agentSchema,
  workflowSchema,
  type Agent,
  type AgentIdentity,
  type Workflow,
} from '../../../../packages/core/src/schema.js';
import { agentWithResources } from '../../../../packages/core/src/workflow.js';
import { emitHarnessEvent } from '../../../../packages/core/src/harnessEvents.js';
import { validateReferences } from '../resources.js';
import { defaultProviderId } from '../tenant.js';
import { requireAccess } from './access.js';
import { notFound, OhError } from './errors.js';
import {
  fromFiles,
  kebab,
  parseMarkdown,
  readZip,
  renderMarkdown,
  skillMarkdown,
  writeZip,
  type Bundle,
  type Frontmatter,
} from './oaf.js';
import { page, pageQuery, type Operation, type OperationRegistry } from './operations.js';

type Stored<T> = T & {
  _id: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  revision?: number;
  createdBy?: string;
};
type StoredWorkflow = Stored<Workflow>;
type Provider = Stored<{ name: string; kind: string; model: string }>;
type Connection = Stored<{
  name: string;
  url: string;
  transport?: string;
  authType?: string;
  enabled: boolean;
  kind?: string;
  tools?: { name: string }[];
}>;
type Skill = Stored<{ name: string; description: string; instructions: string; enabled: boolean }>;
type Knowledge = Stored<{ name: string }>;

const workflows = () => collection<StoredWorkflow>('workflows');
const FORMAT = 'openharness-workflow/1';

async function vendorKey(tenantId: string) {
  const tenant = await collection<{ _id: string; name?: string }>('tenants').findOne({ _id: tenantId });
  return kebab(tenant?.name ?? 'openharness');
}
/** The agent node an execution starts with: the first agent reached from Start, else the first agent node. */
export function entryAgentNode(w: Workflow) {
  const byId = new Map(w.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let current = byId.get(w.startAt);
  while (current && !seen.has(current.id)) {
    if (current.type === 'agent') return current;
    seen.add(current.id);
    const next: string | undefined =
      'next' in current ? current.next : current.type === 'condition' ? current.onTrue : undefined;
    current = next ? byId.get(next) : undefined;
  }
  return w.nodes.find((n) => n.type === 'agent');
}
const agentConfigs = (w: Workflow) =>
  w.nodes.flatMap((n) => (n.type === 'agent' && n.config ? [n.config] : []));

function agentView(w: StoredWorkflow, vendor: string, providers: Map<string, Provider>) {
  const identity = w.identity ?? {};
  const vendorKey = identity.vendorKey ?? vendor;
  const agentKey = identity.agentKey ?? kebab(w.name);
  const entry = entryAgentNode(w);
  const entryAgent =
    entry?.type === 'agent' && entry.config ? agentWithResources(w, entry.id, entry.config) : undefined;
  const provider = entryAgent ? providers.get(entryAgent.providerId) : undefined;
  const skillIds = [...new Set(agentConfigs(w).flatMap((a) => a.skillIds ?? []))];
  const servers = new Map<string, string[]>();
  for (const r of w.resources)
    if (r.type === 'mcp') servers.set(r.connectionId, [...(servers.get(r.connectionId) ?? []), ...r.tools]);
  for (const n of w.nodes)
    if (n.type === 'tool') servers.set(n.connectionId, [...(servers.get(n.connectionId) ?? []), n.tool]);
  return {
    id: w._id,
    name: w.name,
    vendorKey,
    agentKey,
    version: identity.version ?? '1.0.0',
    slug: `${vendorKey}/${agentKey}`,
    description: w.description,
    ...(identity.author ? { author: identity.author } : {}),
    ...(identity.license ? { license: identity.license } : {}),
    tags: identity.tags ?? [],
    skills: skillIds.map((skill_id) => ({ skill_id, required: false })),
    mcp_servers: [...servers].map(([server_id, tools]) => ({
      server_id,
      tools: [...new Set(tools)],
      required: true,
    })),
    config: {
      ...(provider ? { model: { provider: provider.kind, name: provider.model } } : {}),
      ...(entryAgent ? { system_prompt: entryAgent.systemPrompt } : {}),
      ...(entryAgent?.connections.length
        ? { tools_access: { allow: [...new Set(entryAgent.connections.flatMap((c) => c.tools))] } }
        : {}),
    },
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
    'x-openharness': {
      enabled: w.enabled,
      revision: w.revision ?? 1,
      agents: w.nodes.filter((n) => n.type === 'agent').length,
      steps: w.nodes.length,
      ...(entry ? { entry_agent_node: entry.id } : {}),
      ...(w.schedule?.enabled ? { schedule: w.schedule } : {}),
    },
  };
}
async function lookups(tenantId: string) {
  const [providers, vendor] = await Promise.all([
    collection<Provider>('providers').find({ ownerId: tenantId }).toArray(),
    vendorKey(tenantId),
  ]);
  return { providers: new Map(providers.map((p) => [p._id, p])), vendor };
}
async function ownedWorkflow(req: Request, need: 'read' | 'manage' = 'read') {
  const principal = requireAccess(req, need === 'manage' ? 'manage' : 'read');
  const id = String(req.params.agentId);
  if (!z.string().uuid().safeParse(id).success) throw notFound('Agent');
  const w = await workflows().findOne({ _id: id, ownerId: principal.tenantId });
  if (!w) throw notFound('Agent');
  if (need === 'read') requireAccess(req, 'read', { workflowId: id });
  return w;
}
/** Parses, checks references and stores a workflow exactly like the studio's own PUT/POST. */
async function saveWorkflow(req: Request, definition: unknown, previous?: StoredWorkflow) {
  const principal = req.principal!;
  const body = workflowSchema.parse(definition);
  await validateReferences('workflows', principal.tenantId, body);
  const now = new Date();
  if (previous) {
    await workflows().updateOne(
      { _id: previous._id, ownerId: principal.tenantId },
      { $set: { ...body, updatedAt: now, updatedBy: principal.user._id }, $inc: { revision: 1 } },
    );
    return (await workflows().findOne({ _id: previous._id, ownerId: principal.tenantId }))!;
  }
  const record = {
    ...body,
    _id: randomUUID(),
    ownerId: principal.tenantId,
    createdBy: principal.user._id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  } as StoredWorkflow;
  await workflows().insertOne(record);
  return record;
}
async function assertUniqueName(tenantId: string, name: string, except?: string) {
  if (await workflows().findOne({ ownerId: tenantId, name, ...(except ? { _id: { $ne: except } } : {}) }))
    throw new OhError(409, 'CONFLICT', `An agent named ${name} already exists on this harness`);
}

// ---- Building workflows from OAF manifests -------------------------------------------------------------

type ImportContext = { tenantId: string; req: Request; warnings: string[]; bundle: Bundle };
async function resolveModel(ctx: ImportContext, model: unknown) {
  const providers = await collection<Provider>('providers').find({ ownerId: ctx.tenantId }).toArray();
  const wanted =
    typeof model === 'string'
      ? { name: model }
      : model && typeof model === 'object'
        ? (model as { provider?: string; name?: string })
        : undefined;
  if (wanted?.name) {
    const name = wanted.name.toLowerCase();
    const match =
      providers.find((p) => p.model.toLowerCase() === name) ??
      providers.find((p) => p.name.toLowerCase() === name) ??
      providers.find(
        (p) => p.model.toLowerCase().includes(name) && (!wanted.provider || p.kind.includes(wanted.provider)),
      );
    if (match) return match._id;
    ctx.warnings.push(`Model ${wanted.name} is not configured here; the workspace default provider is used`);
  }
  const fallback = await defaultProviderId(ctx.tenantId);
  if (!fallback) throw new OhError(422, 'NO_MODEL_PROVIDER', 'Add a model provider before creating agents');
  return fallback;
}
/** Finds workspace skills by name, creating the ones the bundle carries as skills/<name>/SKILL.md. */
async function resolveSkills(ctx: ImportContext, names: string[]) {
  const ids: string[] = [];
  const skills = collection<Skill>('skills');
  for (const name of [...new Set(names)]) {
    const existing = await skills.findOne({ ownerId: ctx.tenantId, name });
    if (existing) {
      ids.push(existing._id);
      continue;
    }
    const file = [...ctx.bundle.files].find(
      ([p]) =>
        /^skills\/[^/]+\/SKILL\.md$/i.test(p) &&
        (p.split('/')[1] === kebab(name) ||
          parseMarkdown(ctx.bundle.files.get(p)!).frontmatter.name === name),
    );
    if (!file) {
      ctx.warnings.push(`Skill ${name} is not in the bundle or this workspace; it was left out`);
      continue;
    }
    const { frontmatter, body } = parseMarkdown(file[1]);
    const now = new Date();
    const record = {
      _id: randomUUID(),
      ownerId: ctx.tenantId,
      name: String(frontmatter.name ?? name).slice(0, 64),
      description: String(frontmatter.description ?? `Imported skill ${name}`).slice(0, 500),
      instructions: body.slice(0, 32000) || String(frontmatter.description ?? name),
      enabled: true,
      createdBy: ctx.req.principal!.user._id,
      createdAt: now,
      updatedAt: now,
    };
    await skills.insertOne(record);
    await emitHarnessEvent(ctx.tenantId, 'skill.installed', { skill_id: record._id, name: record.name });
    ids.push(record._id);
  }
  return ids;
}
async function connectionByName(tenantId: string, name: string) {
  const all = await collection<Connection>('connections')
    .find({ ownerId: tenantId, enabled: true })
    .toArray();
  return all.find((c) => c.name.toLowerCase() === name.toLowerCase() || kebab(c.name) === kebab(name));
}
function listOf(value: unknown): Frontmatter[] {
  return Array.isArray(value)
    ? value.filter((v): v is Frontmatter => Boolean(v) && typeof v === 'object')
    : [];
}
const identityFrom = (fm: Frontmatter, name: string): AgentIdentity => {
  const clean = <T>(value: T | undefined, schema: z.ZodType<T>) =>
    schema.safeParse(value).success ? value : undefined;
  return Object.fromEntries(
    Object.entries({
      vendorKey: clean(typeof fm.vendorKey === 'string' ? kebab(fm.vendorKey) : undefined, z.string()),
      agentKey: typeof fm.agentKey === 'string' ? kebab(fm.agentKey) : kebab(name),
      version: clean(fm.version as string, z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/)),
      author: typeof fm.author === 'string' ? fm.author.slice(0, 100) : undefined,
      license: typeof fm.license === 'string' ? fm.license.slice(0, 100) : undefined,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String).filter(Boolean).slice(0, 20) : undefined,
    }).filter(([, v]) => v !== undefined),
  ) as AgentIdentity;
};
/** A single-agent workflow from an AGENTS.md manifest without OpenHarness-specific configuration. */
async function workflowFromManifest(
  ctx: ImportContext,
  fm: Frontmatter,
  body: string,
  meta: { name?: string; description?: string },
) {
  const name = String(meta.name ?? fm.name ?? '')
    .trim()
    .slice(0, 100);
  if (!name)
    throw new OhError(400, 'VALIDATION_ERROR', 'The agent needs a name (metadata.name or frontmatter name)');
  const description = String(meta.description ?? fm.description ?? '').slice(0, 1000);
  const providerId = await resolveModel(ctx, fm.model);
  const skillNames = listOf(fm.skills)
    .map((s) => String(s.name ?? ''))
    .filter(Boolean);
  const bundledSkills = [...ctx.bundle.files.keys()]
    .filter((p) => /^skills\/[^/]+\/SKILL\.md$/i.test(p))
    .map((p) => String(parseMarkdown(ctx.bundle.files.get(p)!).frontmatter.name ?? p.split('/')[1]));
  const skillIds = await resolveSkills(ctx, [...skillNames, ...bundledSkills]);
  const resources = [];
  const allowed = Array.isArray(
    (fm.config as Frontmatter)?.tools && ((fm.config as Frontmatter).tools as Frontmatter).allowed,
  )
    ? (((fm.config as Frontmatter).tools as Frontmatter).allowed as unknown[]).map(String)
    : undefined;
  for (const [index, server] of listOf(fm.mcpServers).entries()) {
    const serverName = String(server.server ?? '');
    const connection = serverName ? await connectionByName(ctx.tenantId, serverName) : undefined;
    const tools = (connection?.tools ?? []).map((t) => t.name).filter((t) => !allowed || allowed.includes(t));
    if (!connection || !tools.length) {
      ctx.warnings.push(
        `MCP server ${serverName || index + 1} is not connected in this workspace; connect it and add it to the agent`,
      );
      continue;
    }
    resources.push({
      id: `mcp${index + 1}`,
      name: connection.name,
      type: 'mcp' as const,
      connectionId: connection._id,
      tools,
    });
  }
  for (const ignored of ['packs', 'weblets', 'agents', 'orchestration', 'memory'])
    if (fm[ignored] !== undefined)
      ctx.warnings.push(`The ${ignored} section is not supported yet and was ignored`);
  const cfg = fm.config as Frontmatter | undefined;
  if (cfg?.temperature !== undefined || cfg?.max_tokens !== undefined)
    ctx.warnings.push('temperature and max_tokens are not applied by this harness');
  const agent = agentSchema.parse({
    name,
    description,
    systemPrompt: (body || description || `You are ${name}.`).slice(0, 32000),
    providerId,
    skillIds,
  });
  return {
    name,
    description,
    identity: identityFrom(fm, name),
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      { id: 'agent', name, type: 'agent', prompt: '{{input}}', config: agent, next: 'finish' },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    resources,
    bindings: resources.map((r) => ({ agentNodeId: 'agent', resourceId: r.id })),
  };
}

// ---- Portable OpenHarness workflows inside harnessConfig ----------------------------------------------------

type References = {
  guardrails?: Record<string, { name: string }>;
  providers: Record<string, { name: string; kind: string; model: string }>;
  connections: Record<string, { name: string; url: string; transport?: string }>;
  knowledge: Record<string, { name: string }>;
  skills: Record<string, { name: string }>;
};
/** Every workspace ID a workflow points at, with a portable descriptor for each. */
async function referencesOf(tenantId: string, w: Workflow): Promise<References> {
  const ids = {
    guardrails: new Set<string>(w.guardrailIds ?? []),
    providers: new Set<string>(),
    connections: new Set<string>(),
    knowledge: new Set<string>(),
    skills: new Set<string>(),
  };
  for (const a of agentConfigs(w)) {
    (a.guardrailIds ?? []).forEach((id) => ids.guardrails.add(id));
    ids.providers.add(a.providerId);
    a.connections.forEach((c) => ids.connections.add(c.connectionId));
    a.knowledgeBaseIds.forEach((k) => ids.knowledge.add(k));
    (a.skillIds ?? []).forEach((s) => ids.skills.add(s));
  }
  for (const r of w.resources) {
    if (r.type === 'mcp') ids.connections.add(r.connectionId);
    else if (r.type === 'knowledge') ids.knowledge.add(r.knowledgeBaseId);
    else if (r.type === 'guardrail') ids.guardrails.add(r.policyId);
  }
  for (const n of w.nodes) if (n.type === 'tool') ids.connections.add(n.connectionId);
  const load = async <T extends Stored<object>>(name: string, set: Set<string>) =>
    collection<T>(name)
      .find({ ownerId: tenantId, _id: { $in: [...set] } } as Filter<T>)
      .toArray();
  const [providers, connections, knowledge, skills, guardrails] = await Promise.all([
    load<Provider>('providers', ids.providers),
    load<Connection>('connections', ids.connections),
    load<Knowledge>('knowledge', ids.knowledge),
    load<Skill>('skills', ids.skills),
    load<Stored<{ name: string }>>('guardrails', ids.guardrails),
  ]);
  return {
    guardrails: Object.fromEntries(guardrails.map((p) => [p._id, { name: p.name }])),
    providers: Object.fromEntries(
      providers.map((p) => [p._id, { name: p.name, kind: p.kind, model: p.model }]),
    ),
    connections: Object.fromEntries(
      connections.map((c) => [
        c._id,
        { name: c.name, url: c.url, ...(c.transport ? { transport: c.transport } : {}) },
      ]),
    ),
    knowledge: Object.fromEntries(knowledge.map((k) => [k._id, { name: k.name }])),
    skills: Object.fromEntries(skills.map((s) => [s._id, { name: s.name }])),
  };
}
/** Replaces every string equal to a mapped ID, anywhere in the definition. IDs are UUIDs, so this is exact. */
function remap(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remap(v, ids));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, ids)]));
  return value;
}
/** Drops references that could not be resolved in this workspace, so the workflow still validates. */
function prune(definition: any, missing: { connections: Set<string>; knowledge: Set<string> }) {
  const droppedResources = new Set<string>();
  definition.resources = (definition.resources ?? []).filter((r: any) => {
    const gone =
      r.type === 'mcp' ? missing.connections.has(r.connectionId) : missing.knowledge.has(r.knowledgeBaseId);
    if (gone) droppedResources.add(r.id);
    return !gone;
  });
  definition.bindings = (definition.bindings ?? []).filter((b: any) => !droppedResources.has(b.resourceId));
  for (const n of definition.nodes ?? [])
    if (n.type === 'agent' && n.config) {
      n.config.connections = (n.config.connections ?? []).filter(
        (c: any) => !missing.connections.has(c.connectionId),
      );
      n.config.knowledgeBaseIds = (n.config.knowledgeBaseIds ?? []).filter(
        (k: string) => !missing.knowledge.has(k),
      );
    }
  return definition;
}
async function workflowFromPortable(ctx: ImportContext, fm: Frontmatter, portable: Frontmatter) {
  const definition = portable.workflow as Frontmatter | undefined;
  if (!definition || typeof definition !== 'object')
    throw new OhError(400, 'INVALID_MANIFEST', 'harnessConfig.openharness.workflow is missing');
  const refs = (portable.references ?? {}) as Partial<References>;
  const ids = new Map<string, string>();
  const missing = { connections: new Set<string>(), knowledge: new Set<string>() };
  for (const [oldId, p] of Object.entries(refs.providers ?? {}))
    ids.set(oldId, await resolveModel(ctx, { name: p.model, provider: p.kind }));
  for (const [oldId, c] of Object.entries(refs.connections ?? {})) {
    const found = await connectionByName(ctx.tenantId, c.name);
    if (found?.tools?.length) ids.set(oldId, found._id);
    else {
      missing.connections.add(oldId);
      ctx.warnings.push(
        `MCP server ${c.name} (${c.url}) is not connected in this workspace; its tools were left out`,
      );
    }
  }
  for (const [oldId, k] of Object.entries(refs.knowledge ?? {})) {
    const found = await collection<Knowledge>('knowledge').findOne({ ownerId: ctx.tenantId, name: k.name });
    if (found) ids.set(oldId, found._id);
    else {
      missing.knowledge.add(oldId);
      ctx.warnings.push(`Knowledge base ${k.name} does not exist in this workspace; it was left out`);
    }
  }
  for (const [oldId, s] of Object.entries(refs.skills ?? {})) {
    const [resolved] = await resolveSkills(ctx, [s.name]);
    if (resolved) ids.set(oldId, resolved);
  }
  for (const [oldId, policy] of Object.entries(refs.guardrails ?? {})) {
    const found = await collection<Stored<{ name: string; enabled: boolean }>>('guardrails').findOne({
      ownerId: ctx.tenantId,
      name: policy.name,
      enabled: true,
    });
    if (!found)
      throw new HttpError(
        400,
        `Create the required safety policy ${policy.name} before importing this workflow`,
      );
    ids.set(oldId, found._id);
  }
  const pruned = prune(structuredClone(definition), missing);
  // Skills that could not be resolved are removed from the agents that listed them.
  for (const n of pruned.nodes ?? [])
    if (n.type === 'agent' && n.config?.skillIds)
      n.config.skillIds = n.config.skillIds.filter((s: string) => !refs.skills?.[s] || ids.has(s));
  const mapped = remap(pruned, ids) as Frontmatter;
  return { ...mapped, identity: identityFrom(fm, String(mapped.name ?? fm.name ?? 'Agent')) };
}
async function workflowFromBundle(
  ctx: ImportContext,
  meta: { name?: string; description?: string } = {},
  rekey = false,
) {
  const { frontmatter, body } = parseMarkdown(ctx.bundle.agentsMd);
  const portable = ((frontmatter.harnessConfig as Frontmatter | undefined)?.openharness ?? undefined) as
    Frontmatter | undefined;
  const definition: Frontmatter =
    portable?.format === FORMAT
      ? await workflowFromPortable(ctx, frontmatter, portable)
      : await workflowFromManifest(ctx, frontmatter, body, meta);
  if (meta.name) definition.name = meta.name;
  if (meta.name && rekey) {
    // An import renamed with rename_to is a different agent: its key follows the new name.
    definition.identity = {
      ...((definition.identity as AgentIdentity | undefined) ?? {}),
      agentKey: kebab(meta.name),
    };
  }
  if (meta.description !== undefined) definition.description = meta.description;
  return definition;
}
async function exportBundle(req: Request, w: StoredWorkflow) {
  const { vendor, providers } = await lookups(req.principal!.tenantId);
  const view = agentView(w, vendor, providers);
  const refs = await referencesOf(req.principal!.tenantId, w);
  const files = new Map<string, string>();
  const skills = await collection<Skill>('skills')
    .find({ ownerId: w.ownerId, _id: { $in: Object.keys(refs.skills) } })
    .toArray();
  for (const s of skills) files.set(`skills/${kebab(s.name)}/SKILL.md`, skillMarkdown(s));
  for (const c of Object.values(refs.connections))
    files.set(
      `mcp-configs/${kebab(c.name)}/config.yaml`,
      `# No credentials are exported; connect and authorize this server after import.\nname: ${JSON.stringify(c.name)}\nurl: ${JSON.stringify(c.url)}\ntransport: ${c.transport ?? 'streamable-http'}\n`,
    );
  const { _id, ownerId, createdAt, updatedAt, revision, createdBy, identity, ...definition } =
    w as StoredWorkflow & { updatedBy?: string };
  delete (definition as { updatedBy?: string }).updatedBy;
  delete (definition as { nextRunAt?: string }).nextRunAt;
  const entry = entryAgentNode(w);
  const frontmatter: Frontmatter = {
    name: view.name,
    vendorKey: view.vendorKey,
    agentKey: view.agentKey,
    version: view.version,
    slug: view.slug,
    description: view.description,
    author: view.author ?? `@${view.vendorKey}`,
    license: view.license ?? 'UNLICENSED',
    tags: view.tags,
    ...(skills.length
      ? { skills: skills.map((s) => ({ name: s.name, source: 'local', version: '1.0.0', required: false })) }
      : {}),
    ...(Object.keys(refs.connections).length
      ? {
          mcpServers: Object.values(refs.connections).map((c) => ({
            vendor: view.vendorKey,
            server: c.name,
            version: '1.0.0',
            configDir: `mcp-configs/${kebab(c.name)}`,
            required: true,
          })),
        }
      : {}),
    ...(view.config.tools_access ? { tools: view.config.tools_access.allow } : {}),
    ...(view.config.model ? { model: view.config.model } : {}),
    harnessConfig: { openharness: { format: FORMAT, workflow: definition, references: refs } },
  };
  const instructions =
    entry?.type === 'agent' && entry.config ? entry.config.systemPrompt : view.description || view.name;
  files.set('AGENTS.md', renderMarkdown(frontmatter, instructions));
  files.set(
    'PACKAGE.yaml',
    `format: oaf-package\nformatVersion: 1.0.0\nname: ${view.agentKey}\nversion: ${view.version}\ncontents:\n  mode: bundled\nagents:\n  - path: .\n    name: ${view.agentKey}\n    version: ${view.version}\n`,
  );
  return { buffer: await writeZip(files), filename: `${view.agentKey}.zip` };
}

// ---- Routes ------------------------------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(50, config.MAX_UPLOAD_MB) * 1024 * 1024, files: 500 },
});
const runMulter = (handler: ReturnType<typeof upload.any>, req: Request, res: Response) =>
  new Promise<void>((resolve, reject) =>
    handler(req, res, (error?: unknown) => (error ? reject(error) : resolve())),
  );
const createJson = z.object({
  metadata: z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
  }),
  files: z
    .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(2_000_000) }))
    .max(500)
    .default([]),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  config: z
    .object({
      model: z
        .union([z.string().min(1), z.object({ provider: z.string().optional(), name: z.string().min(1) })])
        .optional(),
      system_prompt: z.string().min(1).max(32000).optional(),
      temperature: z.number().min(0).max(1).optional(),
      max_tokens: z.number().int().min(1).optional(),
      tools_access: z
        .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
        .optional(),
    })
    .optional(),
});
const matches = (patterns: string[], tool: string) =>
  patterns.some((p) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : p === tool));

export function agentOperations(registry: OperationRegistry): Operation[] {
  registry.declare('agents', {
    limitations: [
      'An agent is a workflow; config changes apply to its entry agent',
      'Clone and export ignore include_memory until the memory domain is supported',
      'temperature and max_tokens are accepted but not applied',
    ],
  });
  return [
    {
      id: 'agents.list',
      handler: async (req) => {
        const principal = requireAccess(req, 'read');
        const query = pageQuery.parse(req.query);
        const token = principal.token;
        const filter = {
          ownerId: principal.tenantId,
          ...(token && !token.scopes.includes('harness') ? { _id: { $in: token.workflowIds } } : {}),
        };
        const [total, items, ctx] = await Promise.all([
          workflows().countDocuments(filter),
          workflows().find(filter).sort({ createdAt: -1 }).skip(query.offset).limit(query.limit).toArray(),
          lookups(principal.tenantId),
        ]);
        return page(
          items.map((w) => agentView(w, ctx.vendor, ctx.providers)),
          query,
          total,
        );
      },
    },
    {
      id: 'agents.get',
      handler: async (req) => {
        const w = await ownedWorkflow(req);
        const ctx = await lookups(w.ownerId);
        return { agent: agentView(w, ctx.vendor, ctx.providers) };
      },
    },
    {
      id: 'agents.create',
      provides: { domain: 'agents', operations: ['create'] },
      handler: async (req, res) => {
        const principal = requireAccess(req, 'manage');
        let meta: { name?: string; description?: string };
        const files = new Map<string, string>();
        if (req.is('multipart/form-data')) {
          await runMulter(upload.any(), req, res);
          const raw = (req.body as Record<string, unknown>).metadata;
          meta = createJson.shape.metadata.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
          for (const file of (req.files as Express.Multer.File[] | undefined) ?? [])
            files.set(file.originalname, file.buffer.toString('utf8'));
        } else {
          const body = createJson.parse(req.body);
          meta = body.metadata;
          for (const f of body.files) files.set(f.path, f.content);
        }
        if (!files.has('AGENTS.md') && ![...files.keys()].some((p) => /(^|\/)AGENTS\.md$/.test(p)))
          files.set(
            'AGENTS.md',
            `---\nname: ${JSON.stringify(meta.name)}\n---\n\n${meta.description || `You are ${meta.name}.`}\n`,
          );
        const ctx: ImportContext = {
          tenantId: principal.tenantId,
          req,
          warnings: [],
          bundle: fromFiles(files),
        };
        await assertUniqueName(principal.tenantId, meta.name!);
        const saved = await saveWorkflow(req, await workflowFromBundle(ctx, meta));
        const lookup = await lookups(principal.tenantId);
        res
          .status(201)
          .json({ agent: agentView(saved, lookup.vendor, lookup.providers), warnings: ctx.warnings });
      },
    },
    {
      id: 'agents.update',
      provides: { domain: 'agents', operations: ['update'] },
      handler: async (req) => {
        const w = await ownedWorkflow(req, 'manage');
        const body = updateSchema.parse(req.body);
        const definition = structuredClone(workflowSchema.parse(w)) as Workflow;
        if (body.name && body.name !== w.name) {
          await assertUniqueName(w.ownerId, body.name, w._id);
          definition.name = body.name;
        }
        if (body.description !== undefined) definition.description = body.description;
        if (body.config) {
          const entry = entryAgentNode(definition);
          if (!entry || entry.type !== 'agent' || !entry.config)
            throw new OhError(422, 'UNPROCESSABLE_ENTITY', 'This agent has no configurable entry agent');
          const ctx: ImportContext = {
            tenantId: w.ownerId,
            req,
            warnings: [],
            bundle: { agentsMd: '', files: new Map() },
          };
          if (body.config.system_prompt) entry.config.systemPrompt = body.config.system_prompt;
          if (body.config.model) {
            entry.config.providerId = await resolveModel(ctx, body.config.model);
            if (ctx.warnings.length)
              throw new OhError(400, 'model_not_available', 'This model is not configured on this harness');
          }
          const access = body.config.tools_access;
          if (access) {
            const bound = new Set(
              definition.bindings.filter((b) => b.agentNodeId === entry.id).map((b) => b.resourceId),
            );
            for (const r of definition.resources)
              if (r.type === 'mcp' && bound.has(r.id))
                r.tools = r.tools.filter(
                  (t) =>
                    (!access.allow || matches(access.allow, t)) && !(access.deny && matches(access.deny, t)),
                );
            const emptied = new Set(
              definition.resources.filter((r) => r.type === 'mcp' && !r.tools.length).map((r) => r.id),
            );
            definition.resources = definition.resources.filter((r) => !emptied.has(r.id));
            definition.bindings = definition.bindings.filter((b) => !emptied.has(b.resourceId));
            entry.config.connections = entry.config.connections
              .map((c) => ({
                ...c,
                tools: c.tools.filter(
                  (t) =>
                    (!access.allow || matches(access.allow, t)) && !(access.deny && matches(access.deny, t)),
                ),
              }))
              .filter((c) => c.tools.length);
          }
        }
        const saved = await saveWorkflow(req, definition, w);
        const ctx = await lookups(w.ownerId);
        return { agent: agentView(saved, ctx.vendor, ctx.providers) };
      },
    },
    {
      id: 'agents.delete',
      provides: { domain: 'agents', operations: ['delete'] },
      handler: async (req, res) => {
        const w = await ownedWorkflow(req, 'manage');
        if (
          await collection('runs').findOne({
            ownerId: w.ownerId,
            workflowId: w._id,
            status: { $in: ['queued', 'running'] },
          })
        )
          throw new OhError(409, 'CONFLICT', 'This agent has running executions; cancel them first');
        await workflows().deleteOne({ _id: w._id, ownerId: w.ownerId });
        res.status(204).end();
      },
    },
    {
      id: 'agents.clone',
      provides: { domain: 'agents', operations: ['clone'] },
      handler: async (req, res) => {
        const w = await ownedWorkflow(req, 'manage');
        const body = z
          .object({ new_name: z.string().trim().min(1).max(100), include_memory: z.boolean().default(false) })
          .parse(req.body);
        await assertUniqueName(w.ownerId, body.new_name);
        const definition = structuredClone(workflowSchema.parse(w)) as Workflow;
        definition.name = body.new_name;
        definition.identity = { ...definition.identity, agentKey: kebab(body.new_name) };
        // A copy never inherits an active schedule; it would double the scheduled runs.
        if (definition.schedule) definition.schedule = { ...definition.schedule, enabled: false };
        const saved = await saveWorkflow(req, definition);
        const ctx = await lookups(w.ownerId);
        res.status(201).json({ agent: agentView(saved, ctx.vendor, ctx.providers) });
      },
    },
    {
      id: 'agents.export',
      provides: { domain: 'agents', operations: ['export'] },
      handler: async (req, res) => {
        const w = await ownedWorkflow(req);
        const { buffer, filename } = await exportBundle(req, w);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.end(buffer);
      },
    },
    {
      id: 'agents.import',
      provides: { domain: 'agents', operations: ['import'] },
      handler: async (req, res) => {
        const principal = requireAccess(req, 'manage');
        if (!req.is('multipart/form-data'))
          throw new OhError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Send the OAF package as multipart/form-data field "bundle"',
          );
        await runMulter(upload.any(), req, res);
        const file = ((req.files as Express.Multer.File[] | undefined) ?? []).find(
          (f) => f.fieldname === 'bundle',
        );
        if (!file) throw new OhError(400, 'VALIDATION_ERROR', 'Attach the OAF package as the "bundle" field');
        const options = z
          .object({
            rename_to: z.string().trim().min(1).max(100).optional(),
            merge_strategy: z.enum(['fail', 'overwrite', 'skip']).default('fail'),
          })
          .parse(req.body);
        const ctx: ImportContext = {
          tenantId: principal.tenantId,
          req,
          warnings: [],
          bundle: await readZip(file.buffer),
        };
        const definition = await workflowFromBundle(
          ctx,
          options.rename_to ? { name: options.rename_to } : {},
          Boolean(options.rename_to),
        );
        const identity = (definition.identity ?? {}) as AgentIdentity;
        const agentKey = identity.agentKey ?? kebab(String(definition.name));
        const vendor = identity.vendorKey ?? (await vendorKey(principal.tenantId));
        const candidates = await workflows().find({ ownerId: principal.tenantId }).toArray();
        const existing =
          candidates.find(
            (w) =>
              (w.identity?.agentKey ?? kebab(w.name)) === agentKey &&
              (w.identity?.vendorKey ?? vendor) === vendor,
          ) ?? candidates.find((w) => w.name === definition.name);
        const lookup = await lookups(principal.tenantId);
        if (existing && options.merge_strategy === 'fail')
          throw new OhError(409, 'CONFLICT', `An agent ${vendor}/${agentKey} already exists`, {
            details: {
              agent_id: existing._id,
              suggestion: 'Use merge_strategy overwrite or skip, or rename_to',
            },
          });
        if (existing && options.merge_strategy === 'skip')
          return res.status(200).json({
            agent: agentView(existing, lookup.vendor, lookup.providers),
            warnings: [...ctx.warnings, 'An agent with this identity exists; nothing was imported'],
          });
        const saved = await saveWorkflow(req, definition, existing ?? undefined);
        res
          .status(existing ? 200 : 201)
          .json({ agent: agentView(saved, lookup.vendor, lookup.providers), warnings: ctx.warnings });
      },
    },
  ];
}
