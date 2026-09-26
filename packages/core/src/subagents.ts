import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import type { ToolDefinition } from './llm.js';
import { toolAlias } from './mcp.js';
import { effortPresets } from './patterns.js';
import { agentSchema, type Agent, type Run, type RunEvent } from './schema.js';
import { safeError } from './security.js';
import { writeTaskNote } from './memory.js';

/**
 * Budgeted sub-agents. An agent with delegation enabled can hand focused tasks to sub-agents with the spawn_agents
 * tool. Each sub-agent starts with a fresh context (its task and, optionally, one of the parent's skills), runs in
 * parallel with its siblings, gets a share of the parent's remaining token budget, and reports back a short summary
 * plus the ids of the notes it wrote to the knowledge workspace. Its tokens count against the parent. Sub-agents
 * cannot spawn sub-agents of their own, and each one is recorded as a run linked to its parent.
 */
export const SPAWN_TOOL = 'spawn_agents';
export const MAX_PARALLEL = 4;
/** Below this, a sub-agent could not do useful work, so the spawn is refused. */
export const MIN_CHILD_TOKENS = 4000;
/** Kept back from the parent's remaining budget so it can still write its own answer. */
export const PARENT_RESERVE = 0.2;

export type SpawnRequest = {
  task: string;
  skill?: string;
  effort?: 'light' | 'medium' | 'high';
  tools?: string[];
};
export type SubagentResult = {
  subagent_id: string;
  task: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary: string;
  notes: { note_id: string; path: string }[];
  tokens_used: number;
  error?: string;
};
export function spawnToolDefinition(skills: string[]): ToolDefinition {
  return {
    name: SPAWN_TOOL,
    description:
      'Hand focused, independent tasks to sub-agents that run in parallel, each with a fresh context and a share of your remaining budget. Each returns a short summary and the ids of notes it wrote. Give each a self-contained task; combine their results yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PARALLEL,
          items: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                minLength: 1,
                maxLength: 8000,
                description: 'Everything the sub-agent needs to know',
              },
              ...(skills.length
                ? { skill: { type: 'string', enum: skills, description: 'One of your skills to follow' } }
                : {}),
              effort: { type: 'string', enum: ['light', 'medium', 'high'], description: 'Defaults to light' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Names of your tools it may use; all of your tools when omitted',
              },
            },
            required: ['task'],
            additionalProperties: false,
          },
        },
      },
      required: ['agents'],
      additionalProperties: false,
    },
  };
}
/** Splits what the parent has left: equal shares of 80%, each capped by the requested effort's preset. */
export function childBudgets(remaining: number, requests: SpawnRequest[]) {
  const share = Math.floor((Math.max(0, remaining) * (1 - PARENT_RESERVE)) / Math.max(1, requests.length));
  return requests.map((r) => Math.min(effortPresets[r.effort ?? 'light'].tokenBudget, share));
}
export function childAgent(
  parent: Agent,
  request: SpawnRequest,
  tokenBudget: number,
  hasWorkspace: boolean,
): Agent {
  const skill = request.skill ? parent.skills?.find((s) => s.name === request.skill) : undefined;
  if (request.skill && !skill) throw new Error(`Unknown skill ${request.skill}`);
  const wanted = request.tools?.length ? new Set(request.tools) : undefined;
  const connections = parent.connections
    .map((c) => ({
      ...c,
      tools: c.tools.filter((t) => !wanted || wanted.has(t) || wanted.has(toolAlias(c.connectionId, t))),
    }))
    .filter((c) => c.tools.length);
  const effort = request.effort ?? 'light';
  const systemPrompt = [
    `You are a sub-agent working for "${parent.name}". Do only the task you are given, then stop.`,
    `Follow the parent's operating instructions and restrictions:\n<parent_instructions>\n${parent.systemPrompt}\n</parent_instructions>`,
    skill
      ? `Follow the instructions of the skill "${skill.name}":\n<skill>\n${skill.instructions}\n</skill>`
      : '',
    hasWorkspace
      ? 'Record what you find in the knowledge workspace with kb_write (findings with sources, decisions with reasons) and mention the note ids in your answer.'
      : '',
    'Finish with a short summary of what you found or did, in at most ten sentences.',
    'Use memory_write for intermediate findings and memory_search/memory_read for notes shared by this task. Your final report is saved automatically in the task notebook for the parent.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return agentSchema.parse({
    name: `${parent.name} › ${request.task.replace(/\s+/g, ' ').slice(0, 60)}`.slice(0, 100),
    description: 'Sub-agent',
    systemPrompt,
    providerId: parent.providerId,
    connections,
    knowledgeBaseIds: parent.knowledgeBaseIds,
    maxTurns: effortPresets[effort].maxTurns,
    timeoutSeconds: effortPresets[effort].timeoutSeconds,
    pattern: 'react',
    effort,
    tokenBudget: Math.max(1000, tokenBudget),
  });
}

type EventWriter = (event: Omit<RunEvent, 'at'>) => Promise<void>;
type ChildContext = {
  ownerId: string;
  runId: string;
  event: EventWriter;
  signal: AbortSignal;
  notes: { note_id: string; path: string }[];
  usage: { tokens: number };
  depth: number;
  taskId: string;
};
export type SpawnOptions = {
  parent: Agent;
  ownerId: string;
  runId: string;
  taskId?: string;
  nodeId?: string;
  signal: AbortSignal;
  remainingTokens: number;
  hasWorkspace: boolean;
  event: EventWriter;
  /** Runs one agent to completion; the runtime passes its own runAgent, extended with the child's context. */
  run: (agent: Agent, input: string, ctx: ChildContext) => Promise<string>;
};
/** Starts the requested sub-agents in parallel and returns their reports and the tokens they used. */
export async function runSubagents(options: SpawnOptions, requests: SpawnRequest[]) {
  const budgets = childBudgets(options.remainingTokens, requests);
  if (budgets.some((b) => b < MIN_CHILD_TOKENS))
    throw new Error(
      `Not enough budget left for ${requests.length} sub-agent${requests.length === 1 ? '' : 's'} (about ${Math.max(0, options.remainingTokens).toLocaleString()} tokens remain). Do the work yourself or spawn fewer.`,
    );
  const runs = collection<Run>('runs');
  const results = await Promise.all(
    requests.map(async (request, index): Promise<SubagentResult> => {
      const id = randomUUID();
      const now = new Date();
      let agent: Agent;
      try {
        agent = childAgent(options.parent, request, budgets[index], options.hasWorkspace);
      } catch (error) {
        return {
          subagent_id: id,
          task: request.task,
          status: 'failed',
          summary: '',
          notes: [],
          tokens_used: 0,
          error: safeError(error),
        };
      }
      await runs.insertOne({
        _id: id,
        ownerId: options.ownerId,
        parentRunId: options.runId,
        taskId: options.taskId ?? options.runId,
        ...(options.nodeId ? { parentNodeId: options.nodeId } : {}),
        label: agent.name,
        trigger: 'subagent',
        status: 'running',
        input: request.task,
        history: [],
        events: [],
        outputs: {},
        snapshot: { agents: { [id]: agent } },
        requestHash: 'subagent',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      } as Run);
      await options.event({
        type: 'subagent_started',
        message: `Sub-agent: ${request.task.replace(/\s+/g, ' ').slice(0, 200)}`,
        data: {
          subagentId: id,
          task: request.task.slice(0, 2000),
          skill: request.skill,
          effort: agent.effort,
          tokenBudget: agent.tokenBudget,
        },
      });
      const write: EventWriter = async (event) => {
        options.signal.throwIfAborted();
        await runs.updateOne(
          { _id: id, status: 'running' },
          {
            $push: { events: { $each: [{ ...event, at: new Date().toISOString() }], $slice: -500 } },
            $set: { updatedAt: new Date() },
          },
        );
      };
      const ctx: ChildContext = {
        ownerId: options.ownerId,
        runId: id,
        event: write,
        signal: options.signal,
        notes: [],
        usage: { tokens: 0 },
        depth: 1,
        taskId: options.taskId ?? options.runId,
      };
      let result: SubagentResult;
      try {
        const output = await options.run(agent, request.task, ctx);
        const report = await writeTaskNote(
          { ownerId: options.ownerId, taskId: ctx.taskId },
          {
            runId: id,
            agent: agent.name,
            title: request.task,
            kind: 'report',
            folder: 'reports',
            content: output,
          },
        );
        ctx.notes.push(report);
        await write({
          type: 'memory_written',
          message: `Saved sub-agent report ${report.path}`,
          data: report,
        });
        result = {
          subagent_id: id,
          task: request.task,
          status: 'succeeded',
          summary: output.slice(0, 1500),
          notes: ctx.notes,
          tokens_used: ctx.usage.tokens,
        };
      } catch (error) {
        result = {
          subagent_id: id,
          task: request.task,
          status: options.signal.aborted ? 'cancelled' : 'failed',
          summary: '',
          notes: ctx.notes,
          tokens_used: ctx.usage.tokens,
          error: safeError(error),
        };
      }
      await runs.updateOne(
        { _id: id },
        {
          $set: {
            status: result.status,
            ...(result.status === 'succeeded' ? { output: result.summary } : { error: result.error }),
            tokensUsed: result.tokens_used,
            finishedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
      await options
        .event({
          type: 'subagent_completed',
          message: `Sub-agent ${result.status}: ${request.task.replace(/\s+/g, ' ').slice(0, 160)}`,
          data: {
            subagentId: id,
            status: result.status,
            tokensUsed: result.tokens_used,
            notes: result.notes,
            summary: result.summary.slice(0, 600),
          },
        })
        .catch(() => {});
      return result;
    }),
  );
  return { results, tokens: results.reduce((n, r) => n + r.tokens_used, 0) };
}
