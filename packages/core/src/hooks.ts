import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { collection } from './db.js';
import { emitHarnessEvent, webhookSignature as sign } from './harnessEvents.js';
import { decrypt, safeError, safeFetch } from './security.js';

/**
 * Lifecycle hooks: workspace-registered webhooks called at fixed points of every run. `pre_tool` may allow, deny or
 * modify a tool call's input; `post_tool` may modify the tool's output; `stop` and `error` are notifications when a
 * run ends. Guardrails and approvals build on the same points. Command handlers are not supported: a harness server
 * never runs shell commands on behalf of API callers.
 */
export const hookEvents = ['pre_tool', 'post_tool', 'stop', 'error', 'custom'] as const;
export type HookEvent = (typeof hookEvents)[number];
export type HookRecord = {
  _id: string;
  ownerId: string;
  event: HookEvent;
  handler: { type: 'webhook'; url: string };
  secretEncrypted: string;
  enabled: boolean;
  /** closed: a failing hook blocks the call. open: a failing hook is skipped. */
  failMode: 'closed' | 'open';
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
};
export const defaultFailMode = (event: HookEvent) =>
  event === 'pre_tool' || event === 'post_tool' ? 'closed' : 'open';
export const newHookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

export async function loadHooks(ownerId: string) {
  return collection<HookRecord>('hooks').find({ ownerId, enabled: true }).sort({ createdAt: 1 }).toArray();
}
export type ToolRef = { id: string; name: string; input: Record<string, unknown> };
export type HookContext = {
  ownerId: string;
  runId: string;
  agentId?: string;
  nodeId?: string;
  /** Records each decision in the run trace. */
  event?: (e: { type: string; message: string; data?: unknown }) => Promise<void>;
};
type Reply = { decision?: 'allow' | 'deny' | 'modify'; reason?: string; input?: unknown; output?: unknown };

async function call(hook: HookRecord, payload: Record<string, unknown>) {
  const body = JSON.stringify({
    hook_id: hook._id,
    event: hook.event,
    harness_id: config.OPENHARNESS_HARNESS_ID,
    timestamp: new Date().toISOString(),
    ...payload,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await safeFetch(hook.handler.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'OpenHarness-Hooks/1',
      'X-OpenHarness-Event': hook.event,
      'X-OpenHarness-Hook-Id': hook._id,
      'X-OpenHarness-Timestamp': timestamp,
      'X-OpenHarness-Signature': sign(decrypt(hook.secretEncrypted), timestamp, body),
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(hook.timeoutMs),
  });
  const text = (await response.text()).slice(0, 200000);
  if (!response.ok) throw new Error(`Hook answered HTTP ${response.status}`);
  if (!text.trim()) return {} as Reply;
  const reply = JSON.parse(text) as Reply;
  if (reply.decision && !['allow', 'deny', 'modify'].includes(reply.decision))
    throw new Error(`Hook answered an unknown decision ${String(reply.decision).slice(0, 40)}`);
  return reply;
}
async function record(hook: HookRecord, ctx: HookContext, decision: string, reason?: string) {
  const message = `Hook ${hook.event}: ${decision}${reason ? ` (${reason})` : ''}`.slice(0, 300);
  await ctx.event?.({
    type: 'hook',
    message,
    data: { hookId: hook._id, event: hook.event, decision, reason },
  });
  await emitHarnessEvent(ctx.ownerId, 'hook.triggered', {
    hook_id: hook._id,
    event: hook.event,
    decision,
    execution_id: ctx.runId,
    ...(reason ? { reason } : {}),
  });
}
export type PreToolResult =
  { allowed: true; input: Record<string, unknown> } | { allowed: false; reason: string };
/** Runs every pre_tool hook in order. A deny stops the chain; a modify replaces the input for the next hooks. */
export async function beforeTool(
  hooks: HookRecord[],
  ctx: HookContext,
  tool: ToolRef,
): Promise<PreToolResult> {
  let input = tool.input;
  for (const hook of hooks.filter((h) => h.event === 'pre_tool')) {
    let reply: Reply;
    try {
      reply = await call(hook, {
        execution_id: ctx.runId,
        agent_id: ctx.agentId,
        node_id: ctx.nodeId,
        tool: { ...tool, input },
      });
    } catch (error) {
      if (hook.failMode === 'open') {
        await record(hook, ctx, 'skipped', safeError(error));
        continue;
      }
      await record(hook, ctx, 'deny', `hook unavailable: ${safeError(error)}`);
      return { allowed: false, reason: 'A required hook could not be reached' };
    }
    if (reply.decision === 'deny') {
      const reason = String(reply.reason ?? 'Denied by a hook').slice(0, 500);
      await record(hook, ctx, 'deny', reason);
      return { allowed: false, reason };
    }
    if (reply.decision === 'modify') {
      if (!reply.input || typeof reply.input !== 'object' || Array.isArray(reply.input)) {
        await record(hook, ctx, 'deny', 'modify without an input object');
        return { allowed: false, reason: 'A hook returned an invalid modification' };
      }
      input = reply.input as Record<string, unknown>;
      await record(hook, ctx, 'modify', reply.reason ? String(reply.reason).slice(0, 500) : undefined);
    } else await record(hook, ctx, 'allow');
  }
  return { allowed: true, input };
}
/** Runs every post_tool hook in order; each may replace the output text the agent sees. */
export async function afterTool(
  hooks: HookRecord[],
  ctx: HookContext,
  tool: ToolRef,
  output: { text: string; isError: boolean },
) {
  let text = output.text;
  for (const hook of hooks.filter((h) => h.event === 'post_tool')) {
    try {
      const reply = await call(hook, {
        execution_id: ctx.runId,
        agent_id: ctx.agentId,
        node_id: ctx.nodeId,
        tool,
        output: { content: text, is_error: output.isError },
      });
      if (reply.decision === 'modify' && typeof reply.output === 'string') {
        text = reply.output.slice(0, 12000);
        await record(hook, ctx, 'modify', reply.reason ? String(reply.reason).slice(0, 500) : undefined);
      } else if (reply.decision === 'deny') {
        text = `The tool result was withheld by a hook${reply.reason ? `: ${String(reply.reason).slice(0, 500)}` : ''}`;
        await record(hook, ctx, 'deny', reply.reason ? String(reply.reason) : undefined);
      } else await record(hook, ctx, 'allow');
    } catch (error) {
      if (hook.failMode === 'open') await record(hook, ctx, 'skipped', safeError(error));
      else {
        text = 'The tool result was withheld because a required hook could not be reached';
        await record(hook, ctx, 'deny', `hook unavailable: ${safeError(error)}`);
      }
    }
  }
  return text;
}
/** Notifies stop (success) or error (any unsuccessful end) hooks. Failures are logged, never fatal. */
export async function runEnded(run: {
  _id: string;
  ownerId: string;
  status: string;
  output?: string;
  error?: string;
  workflowId?: string;
  agentId?: string;
}) {
  const event: HookEvent = run.status === 'succeeded' ? 'stop' : 'error';
  const hooks = (await loadHooks(run.ownerId)).filter((h) => h.event === event);
  for (const hook of hooks) {
    try {
      await call(hook, {
        execution_id: run._id,
        agent_id: run.workflowId ?? run.agentId,
        status: run.status,
        ...(run.status === 'succeeded'
          ? { output: (run.output ?? '').slice(0, 12000) }
          : { error: run.error }),
      });
      await emitHarnessEvent(run.ownerId, 'hook.triggered', {
        hook_id: hook._id,
        event,
        execution_id: run._id,
      });
    } catch (error) {
      console.warn(`Hook ${hook._id} (${event}) failed:`, safeError(error));
    }
  }
}
