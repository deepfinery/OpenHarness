import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { config } from './config.js';
import { HttpError } from './security.js';
import { emitHarnessEvent } from './harnessEvents.js';
import {
  builtinRail,
  guardrailPolicySchema,
  type GuardrailSnapshot,
  type RailStage,
  type RailDecision,
} from './guardrailPolicy.js';
export { guardrailPolicySchema } from './guardrailPolicy.js';
export class GuardrailBlocked extends Error {}
export type GuardContext = {
  ownerId: string;
  runId: string;
  signal?: AbortSignal;
  guardrails?: GuardrailSnapshot[];
  event?: (e: { type: string; message: string; data?: unknown }) => Promise<void>;
};
export async function snapshotGuardrails(ownerId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const found = await collection<any>('guardrails')
    .find({ ownerId, _id: { $in: unique } })
    .toArray();
  return unique.map((id): GuardrailSnapshot => {
    const record = found.find((r) => r._id === id);
    if (!record || !record.enabled)
      throw new HttpError(400, 'An attached guardrail policy is missing or disabled');
    return { ...guardrailPolicySchema.parse(record), id, revision: record.revision };
  });
}
export async function evaluateRail(
  policy: GuardrailSnapshot,
  stage: RailStage,
  content: string,
  tool?: string,
  signal?: AbortSignal,
): Promise<RailDecision> {
  if (content.length > 250000) throw new Error('Guardrail payload exceeds its inspection limit');
  const local = builtinRail(policy, stage, content, tool);
  if (local.decision === 'block' || policy.provider === 'builtin') return local;
  const response = await fetch(`${config.NEMO_GUARDRAILS_URL.replace(/\/$/, '')}/v1/checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)])
      : AbortSignal.timeout(policy.timeoutMs),
    body: JSON.stringify({
      model: 'openharness',
      messages: [{ role: 'user', content: local.content }],
      guardrails: {
        config_id: policy.configId,
        rail_types: ['input'],
        context: { oh_policy: policy, oh_stage: stage, oh_tool: tool ?? '' },
      },
    }),
  });
  if (!response.ok) throw new Error(`NeMo check returned HTTP ${response.status}`);
  const result = (await response.json()) as { status?: string; content?: string };
  if (!['passed', 'blocked', 'modified'].includes(result.status ?? ''))
    throw new Error('Invalid NeMo decision');
  if (result.status === 'blocked')
    return { decision: 'block', content: policy.blockMessage, reason: 'NeMo rail blocked content' };
  if (result.status === 'modified' && typeof result.content !== 'string')
    throw new Error('NeMo modification omitted content');
  const checked = result.status === 'modified' ? result.content! : local.content;
  return { decision: checked === content ? 'allow' : 'modify', content: checked };
}
/** Decisions never copy inspected content or arguments into audit records. Budget reservations are durable. */
export async function checkRail(ctx: GuardContext, stage: RailStage, content: string, tool?: string) {
  let text = content;
  for (const policy of ctx.guardrails ?? []) {
    if (!policy.stages.includes(stage)) continue;
    const started = Date.now();
    let decision: RailDecision;
    let reserved = false;
    const budgetId = `${ctx.runId}:${policy.id}`;
    try {
      await collection<any>('guardrail_budgets').updateOne(
        { _id: budgetId },
        { $setOnInsert: { ownerId: ctx.ownerId, runId: ctx.runId, usedMs: 0, createdAt: new Date() } },
        { upsert: true },
      );
      reserved = Boolean(
        (
          await collection<any>('guardrail_budgets').updateOne(
            { _id: budgetId, usedMs: { $lte: policy.latencyBudgetMs - policy.timeoutMs } },
            { $inc: { usedMs: policy.timeoutMs } },
          )
        ).modifiedCount,
      );
      if (!reserved) throw new Error('Guardrail latency budget exhausted');
      decision = await evaluateRail(policy, stage, text, tool, ctx.signal);
    } catch (error) {
      ctx.signal?.throwIfAborted();
      decision = {
        decision: policy.failMode === 'open' ? 'allow' : 'block',
        content: policy.failMode === 'open' ? text : policy.blockMessage,
        reason: `Guardrail unavailable (${policy.failMode === 'open' ? 'failed open' : 'failed closed'})`,
      };
    } finally {
      if (reserved)
        await collection<any>('guardrail_budgets').updateOne(
          { _id: budgetId },
          { $inc: { usedMs: -Math.max(0, policy.timeoutMs - (Date.now() - started)) } },
        );
    }
    const audit = {
      policyId: policy.id,
      revision: policy.revision,
      stage,
      decision: decision.decision,
      reason: decision.reason,
      latencyMs: Date.now() - started,
      tool,
    };
    await collection<any>('guardrail_audit').insertOne({
      _id: randomUUID(),
      ownerId: ctx.ownerId,
      runId: ctx.runId,
      ...audit,
      createdAt: new Date(),
    });
    await ctx.event?.({
      type: 'guardrail',
      message: `${policy.name}: ${stage} ${decision.decision}`,
      data: audit,
    });
    await emitHarnessEvent(ctx.ownerId, 'guardrail.decided', { execution_id: ctx.runId, ...audit });
    if (decision.decision === 'block') throw new GuardrailBlocked(policy.blockMessage);
    text = decision.content;
  }
  return text;
}
