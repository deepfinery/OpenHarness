import { z } from 'zod';
import { vectorStoreKinds } from './vectorstores/types.js';

export const id = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const url = z
  .string()
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  }, 'Use an HTTP(S) URL without credentials or a fragment');
export const providerSchema = z.object({
  name,
  kind: z.enum(['openai-compatible', 'anthropic', 'gemini', 'ollama']),
  baseUrl: url,
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().max(8192).optional(),
  embeddingModel: z.string().trim().max(150).default(''),
  outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
  streaming: z.boolean().default(true),
  // Prompt + output budget in tokens. Learned automatically from the provider's first context-length error.
  contextWindow: z.number().int().min(2048).max(4000000).default(128000),
});
export const devicePlatforms = ['linux', 'windows', 'chrome'] as const;
export const deviceIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const connectionSchema = z.object({
  name,
  url,
  transport: z.enum(['http', 'sse']).default('http'),
  authType: z.enum(['none', 'token', 'oauth']).default('none'),
  /** `device` connections are managed by the Machines page through the gateway; `mcp` are ordinary servers. */
  kind: z.enum(['mcp', 'device']).default('mcp'),
  deviceId: z.string().regex(deviceIdPattern).optional(),
  platform: z.enum(devicePlatforms).optional(),
  token: z.string().max(8192).optional(),
  tokenHeader: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,99}$/)
    .refine(
      (s) =>
        ![
          'host',
          'cookie',
          'content-length',
          'connection',
          'transfer-encoding',
          'proxy-authorization',
        ].includes(s.toLowerCase()),
      'Use an authentication header',
    )
    .default('Authorization'),
  oauthClientId: z.string().max(1024).optional(),
  oauthClientSecret: z.string().max(8192).optional(),
  oauthScope: z.string().max(2048).default(''),
  enabled: z.boolean().default(true),
});
export const toolBindingSchema = z.object({
  connectionId: id,
  tools: z.array(z.string().min(1).max(200)).max(100),
});
export const agentPatterns = ['react', 'plan-execute', 'reflection', 'loop'] as const;
export type AgentPattern = (typeof agentPatterns)[number];
export const patternConfigSchema = z.object({
  reflections: z.number().int().min(1).max(3).default(1),
  iterations: z.number().int().min(1).max(10).default(3),
  doneMarker: z.string().trim().min(1).max(50).default('DONE'),
  maxPlanSteps: z.number().int().min(1).max(8).default(5),
});
/** A reusable skill: the agent sees name + description and loads the instructions when a request matches. */
export const skillSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().min(1).max(32000),
  enabled: z.boolean().default(true),
});
export type Skill = z.infer<typeof skillSchema>;
export const agentSchema = z.object({
  name,
  description: z.string().max(1000).default(''),
  systemPrompt: z.string().min(1).max(32000),
  providerId: id,
  connections: z.array(toolBindingSchema).max(30).default([]),
  knowledgeBaseIds: z.array(id).max(20).default([]),
  /** Workspace skills this agent may load. Resolved into `skills` when a run is created. */
  skillIds: z.array(id).max(20).default([]),
  /** Snapshot of the skills at run creation; set by the server, not by clients. */
  skills: z.array(skillSchema.extend({ id })).max(20).optional(),
  maxTurns: z.number().int().min(1).max(40).default(12),
  timeoutSeconds: z.number().int().min(10).max(900).default(300),
  pattern: z.enum(agentPatterns).default('react'),
  patternConfig: patternConfigSchema.default({}),
  /** Loop and token budget preset; `auto` picks a level per request. `low` is the pre-release name of `light`. */
  effort: z.preprocess(
    (v) => (v === 'low' ? 'light' : v),
    z.enum(['light', 'medium', 'high', 'extra-high', 'max', 'auto']).default('medium'),
  ),
  /** Total tokens (prompt + completion) per run; defaults to the effort preset. */
  tokenBudget: z.number().int().min(1000).max(50_000_000).optional(),
  /**
   * Lets the agent hand focused tasks to sub-agents it spins up itself (the spawn_agents tool). Each sub-agent
   * gets a fresh context, a share of this agent's remaining budget, and reports back a summary and note ids.
   */
  delegation: z
    .object({
      enabled: z.boolean().default(false),
      /** Sub-agents this agent may start in one run. */
      maxAgents: z.number().int().min(1).max(12).default(4),
    })
    .optional(),
  enabled: z.boolean().default(true),
});
export const emailSettingsSchema = z.object({
  host: z.string().trim().max(253).default(''),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().max(320).default(''),
  password: z.string().max(4096).optional(),
  from: z.string().trim().max(320).default(''),
  enabled: z.boolean().default(true),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;
const baseNode = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  name,
  position: z.object({ x: z.number(), y: z.number() }).optional(),
};
const next = z.string().min(1).max(64).optional();
export const resourceSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseNode,
    type: z.literal('mcp'),
    connectionId: id,
    tools: z.array(z.string().min(1).max(200)).min(1).max(100),
  }),
  z.object({ ...baseNode, type: z.literal('knowledge'), knowledgeBaseId: id }),
]);
export const nodeSchema = z.discriminatedUnion('type', [
  z.object({ ...baseNode, type: z.literal('start'), next }),
  z.object({ ...baseNode, type: z.literal('finish'), template: z.string().max(32000).default('{{last}}') }),
  z.object({
    ...baseNode,
    type: z.literal('agent'),
    agentId: id.optional(),
    config: agentSchema.optional(),
    prompt: z.string().max(32000).default('{{input}}'),
    next,
  }),
  z.object({
    ...baseNode,
    type: z.literal('tool'),
    connectionId: id,
    tool: z.string().min(1).max(200),
    arguments: z.record(z.unknown()).default({}),
    next,
  }),
  z.object({
    ...baseNode,
    type: z.literal('condition'),
    value: z.string().max(1000),
    operator: z.enum(['equals', 'notEquals', 'contains', 'truthy', 'greaterThan']),
    compare: z.string().max(1000).default(''),
    onTrue: z.string(),
    onFalse: z.string(),
  }),
  z.object({
    ...baseNode,
    type: z.literal('parallel'),
    /** Agent cards from this workflow that run together. */
    agentNodeIds: z.array(z.string().min(1).max(64)).max(8).default([]),
    /** Saved agents (legacy); new workflows reference agent cards instead. */
    agentIds: z.array(id).max(8).default([]),
    prompt: z.string().max(32000).default('{{input}}'),
    next,
  }),
  z.object({
    ...baseNode,
    type: z.literal('email'),
    to: z.string().trim().min(1).max(2000),
    subject: z.string().max(998).default('{{input}}'),
    body: z.string().max(64000).default('{{last}}'),
    next,
  }),
  z.object({ ...baseNode, type: z.literal('output'), template: z.string().max(32000).default('{{last}}') }),
]);
export const resumePolicies = ['safe', 'always', 'never'] as const;
const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** Periodic runs: every N minutes, or daily/weekly at a wall-clock time in the chosen time zone. */
export const scheduleSchema = z.object({
  enabled: z.boolean().default(false),
  everyMinutes: z.number().int().min(1).max(525600),
  input: z.string().max(32000).default('Run the scheduled task.'),
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
    .optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  timezone: z.string().max(64).refine(validTimeZone, 'Unknown time zone').optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;
const kebabKey = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, digits and dashes')
  .max(100);
/**
 * Open Agent Format identity for a workflow published as an agent (Open Harness API). Absent fields are derived
 * from the workspace and workflow names when the agent is listed or exported.
 */
export const agentIdentitySchema = z.object({
  vendorKey: kebabKey.optional(),
  agentKey: kebabKey.optional(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, 'Use a semantic version such as 1.0.0')
    .optional(),
  author: z.string().trim().max(100).optional(),
  license: z.string().trim().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export const workflowSchema = z
  .object({
    name,
    description: z.string().max(1000).default(''),
    identity: agentIdentitySchema.optional(),
    enabled: z.boolean().default(true),
    startAt: z.string(),
    nodes: z.array(nodeSchema).min(1).max(100),
    resources: z.array(resourceSchema).max(100).default([]),
    bindings: z
      .array(z.object({ agentNodeId: z.string(), resourceId: z.string() }))
      .max(200)
      .default([]),
    maxSteps: z.number().int().min(1).max(500).default(100),
    resumePolicy: z.enum(resumePolicies).default('safe'),
    /**
     * The knowledge base agents use as shared working memory: they search and read it selectively and write
     * findings, decisions and feedback into folders there instead of carrying everything in their context.
     */
    workspace: z
      .object({
        knowledgeBaseId: id,
        /** Large tool results are saved as notes and replaced in the context by a summary and a reference. */
        offloadToolResults: z.boolean().default(true),
      })
      .optional(),
    /**
     * Learning from experience: feedback and failures become lessons in the workspace's experience/ folder, and the
     * most relevant lessons are recalled into later runs. Needs a workspace.
     */
    experience: z
      .object({
        enabled: z.boolean().default(false),
        recallLimit: z.number().int().min(1).max(10).default(3),
        learnFromFailures: z.boolean().default(true),
      })
      .optional(),
    schedule: scheduleSchema.optional(),
  })
  .superRefine((w, ctx) => {
    const nodes = new Map(w.nodes.map((n) => [n.id, n]));
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (w.experience?.enabled && !w.workspace) issue('Learning from experience needs a knowledge workspace');
    if (nodes.size !== w.nodes.length) issue('Node IDs must be unique');
    // Agent cards that a Parallel step runs may sit beside the execution path.
    const members = new Set<string>();
    for (const n of w.nodes)
      if (n.type === 'parallel') {
        if (!n.agentNodeIds.length && !n.agentIds.length)
          issue(`Choose the agents that ${n.name} runs together`);
        for (const m of n.agentNodeIds) {
          if (nodes.get(m)?.type !== 'agent' || m === n.id)
            issue(`${n.name} must run agent cards from this workflow`);
          members.add(m);
        }
      }
    const resources = new Map(w.resources.map((r) => [r.id, r]));
    if (resources.size !== w.resources.length || w.resources.some((r) => nodes.has(r.id)))
      issue('Resource IDs must be unique');
    const bindingKeys = new Set<string>();
    for (const b of w.bindings) {
      if (nodes.get(b.agentNodeId)?.type !== 'agent' || !resources.has(b.resourceId))
        issue('Connect resources to an agent, not to the execution path');
      const key = `${b.agentNodeId}:${b.resourceId}`;
      if (bindingKeys.has(key)) issue('Duplicate resource connection');
      bindingKeys.add(key);
    }
    for (const r of w.resources)
      if (!w.bindings.some((b) => b.resourceId === r.id)) issue(`Connect ${r.name} to an agent or remove it`);
    for (const n of w.nodes)
      if (n.type === 'agent' && Boolean(n.agentId) === Boolean(n.config))
        issue(`Choose an existing agent or configure ${n.name} inline`);
    const explicitStart = w.nodes.filter((n) => n.type === 'start');
    if (explicitStart.length && (explicitStart.length !== 1 || explicitStart[0].id !== w.startAt))
      issue('Use exactly one Start node as the entry point');
    if (!nodes.has(w.startAt)) issue('Start node does not exist');
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (nodeId: string) => {
      if (visiting.has(nodeId)) {
        if (!explicitStart.length)
          issue('Workflow cycles require an explicit Start and Finish with a step budget');
        return;
      }
      if (visited.has(nodeId)) return;
      const n = nodes.get(nodeId);
      if (!n) {
        issue(`Missing target node: ${nodeId}`);
        return;
      }
      visiting.add(nodeId);
      if (n.type === 'condition') {
        walk(n.onTrue);
        walk(n.onFalse);
      } else if ('next' in n && n.next) walk(n.next);
      if (n.type === 'parallel') for (const m of n.agentNodeIds) if (nodes.has(m)) visited.add(m);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    walk(w.startAt);
    if (visited.size !== nodes.size) issue('Every node must be reachable from the start node');
    if (explicitStart.length) {
      const finishes = new Set(w.nodes.filter((n) => ['output', 'finish'].includes(n.type)).map((n) => n.id));
      if (!finishes.size) issue('Add a Finish node');
      const canFinish = new Set(finishes);
      for (let i = 0; i < w.nodes.length; i++)
        for (const n of w.nodes) {
          const targets =
            n.type === 'condition' ? [n.onTrue, n.onFalse] : 'next' in n && n.next ? [n.next] : [];
          if (targets.some((t) => canFinish.has(t))) canFinish.add(n.id);
          if (i === 0 && targets.includes(w.startAt)) issue('Execution cannot return to Start');
        }
      if (w.nodes.some((n) => !canFinish.has(n.id) && !(members.has(n.id) && !('next' in n && n.next))))
        issue('Every execution step needs a path to Finish');
    }
  });
export const knowledgeSchema = z.object({
  name,
  description: z.string().max(1000).default(''),
  providerId: id,
  /** Where the base's vectors live; set once when the base is created. */
  vectorStore: z.enum(vectorStoreKinds).optional(),
});
export const runSchema = z
  .object({
    agentId: id.optional(),
    workflowId: id.optional(),
    input: z.string().min(1).max(32000),
    payload: z.record(z.unknown()).optional(),
    /** A registered machine whose tools every agent in the run receives. */
    deviceId: z.string().regex(deviceIdPattern).optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(32000) }))
      .max(20)
      .default([]),
  })
  .refine((r) => Boolean(r.agentId) !== Boolean(r.workflowId), 'Choose exactly one agent or workflow');
export type Provider = z.infer<typeof providerSchema>;
export type McpConnection = z.infer<typeof connectionSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowResource = z.infer<typeof resourceSchema>;
export type KnowledgeBase = z.infer<typeof knowledgeSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type Stored<T> = T & { _id: string; ownerId: string; createdAt: Date; updatedAt: Date };
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type RunEvent = { at: string; type: string; nodeId?: string; message: string; data?: unknown };
/** Per-run agent changes requested by an API caller (for example the Open Harness execute request). */
export type RunOverrides = { systemPrompt?: string; providerId?: string; skillIds?: string[] };
/** Durable progress marker written at every node boundary so a replacement runner can resume. */
export type RunCheckpoint = {
  cursor?: string;
  last: unknown;
  steps: number;
  nodeAttempts: Record<string, number>;
};
export type RunDevice = {
  id: string;
  name: string;
  platform: (typeof devicePlatforms)[number];
  connectionId: string;
  hostname?: string;
};
export type Run = Stored<RunInput> & {
  status: RunStatus;
  label: string;
  device?: RunDevice;
  snapshot: { workflow?: Workflow; agents: Record<string, Agent>; nodeAgents?: Record<string, Agent> };
  output?: string;
  error?: string;
  partial?: string;
  events: RunEvent[];
  outputs: Record<string, unknown>;
  checkpoint?: RunCheckpoint;
  resumeCount?: number;
  startedAt?: Date;
  finishedAt?: Date;
  leaseUntil?: Date;
  leaseId?: string;
  publishedAt?: Date;
  cancelRequested?: boolean;
  idempotencyKey?: string;
  requestHash?: string;
  tokenId?: string;
  embedId?: string;
  scheduleKey?: string;
  initiatedBy?: string;
  trigger?: 'studio' | 'api' | 'chat' | 'webhook' | 'embed' | 'schedule' | 'subagent';
  /** Set on sub-agent runs: the run and step of the agent that spawned them. */
  parentRunId?: string;
  parentNodeId?: string;
  /** Tokens a sub-agent run used; they also count against its parent. */
  tokensUsed?: number;
  /** The latest human feedback on the result. */
  feedback?: { rating: 'up' | 'down'; comment?: string; at: Date; by?: string };
  /** Turning the run and its feedback into a lesson for the workflow's experience folder. */
  reflection?: {
    status: 'pending' | 'done' | 'failed' | 'skipped';
    requestedAt: Date;
    reason?: 'feedback' | 'failure';
    noteId?: string;
    lesson?: string;
    error?: string;
  };
  webhookId?: string;
  conversationId?: string;
  overrides?: RunOverrides;
};
export type KnowledgeDocument = Stored<{
  knowledgeBaseId: string;
  filename: string;
  storageKey: string;
  size: number;
  /** Notes are written in the studio and stay editable; uploads are files. */
  kind?: 'upload' | 'note';
  /** Workspace folder such as research, decisions, feedback or experience; empty for the base's root. */
  folder?: string;
  /** Provenance of notes that agents write: run, agent, kind, sources, confidence. */
  meta?: Record<string, unknown>;
  status: 'queued' | 'indexing' | 'ready' | 'failed' | 'deleting';
  chunks?: number;
  error?: string;
  publishedAt?: Date;
  leaseUntil?: Date;
  leaseId?: string;
}>;
