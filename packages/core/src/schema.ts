import { z } from 'zod';

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
});
export const connectionSchema = z.object({
  name,
  url,
  transport: z.enum(['http', 'sse']).default('http'),
  authType: z.enum(['none', 'token', 'oauth']).default('none'),
  token: z.string().max(8192).optional(),
  tokenHeader: z.enum(['Authorization', 'X-API-Key', 'api-key']).default('Authorization'),
  oauthClientId: z.string().max(1024).optional(),
  oauthClientSecret: z.string().max(8192).optional(),
  oauthScope: z.string().max(2048).default(''),
  enabled: z.boolean().default(true),
});
export const toolBindingSchema = z.object({
  connectionId: id,
  tools: z.array(z.string().min(1).max(200)).max(100),
});
export const agentSchema = z.object({
  name,
  description: z.string().max(1000).default(''),
  systemPrompt: z.string().min(1).max(32000),
  providerId: id,
  connections: z.array(toolBindingSchema).max(30).default([]),
  knowledgeBaseIds: z.array(id).max(20).default([]),
  maxTurns: z.number().int().min(1).max(40).default(12),
  timeoutSeconds: z.number().int().min(10).max(900).default(300),
  enabled: z.boolean().default(true),
});
const baseNode = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  name,
  position: z.object({ x: z.number(), y: z.number() }).optional(),
};
const next = z.string().min(1).max(64).optional();
export const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseNode,
    type: z.literal('agent'),
    agentId: id,
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
    agentIds: z.array(id).min(1).max(8),
    prompt: z.string().max(32000).default('{{input}}'),
    next,
  }),
  z.object({ ...baseNode, type: z.literal('output'), template: z.string().max(32000).default('{{last}}') }),
]);
export const workflowSchema = z
  .object({
    name,
    description: z.string().max(1000).default(''),
    enabled: z.boolean().default(true),
    startAt: z.string(),
    nodes: z.array(nodeSchema).min(1).max(100),
    schedule: z
      .object({
        enabled: z.boolean().default(false),
        everyMinutes: z.number().int().min(1).max(525600),
        input: z.string().max(32000).default('Run the scheduled task.'),
      })
      .optional(),
  })
  .superRefine((w, ctx) => {
    const nodes = new Map(w.nodes.map((n) => [n.id, n]));
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (nodes.size !== w.nodes.length) issue('Node IDs must be unique');
    if (!nodes.has(w.startAt)) issue('Start node does not exist');
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (nodeId: string) => {
      if (visiting.has(nodeId)) {
        issue('Workflow cycles are not supported');
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
      } else if (n.type !== 'output' && n.next) walk(n.next);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    walk(w.startAt);
    if (visited.size !== nodes.size) issue('Every node must be reachable from the start node');
  });
export const knowledgeSchema = z.object({
  name,
  description: z.string().max(1000).default(''),
  providerId: id,
});
export const runSchema = z
  .object({
    agentId: id.optional(),
    workflowId: id.optional(),
    input: z.string().min(1).max(32000),
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
export type KnowledgeBase = z.infer<typeof knowledgeSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type Stored<T> = T & { _id: string; ownerId: string; createdAt: Date; updatedAt: Date };
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type RunEvent = { at: string; type: string; nodeId?: string; message: string; data?: unknown };
export type Run = Stored<RunInput> & {
  status: RunStatus;
  label: string;
  snapshot: { workflow?: Workflow; agents: Record<string, Agent> };
  output?: string;
  error?: string;
  events: RunEvent[];
  outputs: Record<string, unknown>;
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
};
export type KnowledgeDocument = Stored<{
  knowledgeBaseId: string;
  filename: string;
  storageKey: string;
  size: number;
  status: 'queued' | 'indexing' | 'ready' | 'failed' | 'deleting';
  chunks?: number;
  error?: string;
  publishedAt?: Date;
  leaseUntil?: Date;
  leaseId?: string;
}>;
