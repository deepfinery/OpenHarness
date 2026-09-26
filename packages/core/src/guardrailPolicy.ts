import { z } from 'zod';
export const railStages = ['input', 'output', 'retrieval', 'tool_input', 'tool_output'] as const;
export type RailStage = (typeof railStages)[number];
export const guardrailPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
    provider: z.enum(['builtin', 'nemo']).default('nemo'),
    configId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .default('openharness'),
    stages: z
      .array(z.enum(railStages))
      .min(1)
      .default([...railStages]),
    failMode: z.enum(['closed', 'open']).default('closed'),
    timeoutMs: z.number().int().min(100).max(30000).default(5000),
    latencyBudgetMs: z.number().int().min(1000).max(600000).default(120000),
    pii: z.boolean().default(true),
    jailbreak: z.boolean().default(true),
    contentSafety: z.boolean().default(true),
    semanticChecks: z.boolean().default(false),
    templateId: z.enum(['bias', 'toxicity', 'hallucinations', 'opacity', 'pii', 'vulnerability']).optional(),
    safetyInstructions: z.string().trim().max(4000).default(''),
    deniedTerms: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    blockedTopics: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    deniedTools: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
    argumentRules: z
      .array(
        z.object({
          tool: z.string().min(1).max(250),
          path: z.string().regex(/^[a-zA-Z0-9_.]{1,200}$/),
          operator: z.enum(['contains', 'equals', 'missing']),
          value: z.string().max(200).default(''),
        }),
      )
      .max(100)
      .default([]),
    blockMessage: z
      .string()
      .min(1)
      .max(500)
      .default('This request was blocked by the configured safety policy.'),
    enabled: z.boolean().default(true),
  })
  .refine((p) => p.latencyBudgetMs >= p.timeoutMs, {
    message: 'Latency budget must cover at least one check timeout',
    path: ['latencyBudgetMs'],
  })
  .refine((p) => !p.semanticChecks || p.provider === 'nemo', {
    message: 'Semantic checks require NeMo',
    path: ['semanticChecks'],
  })
  .refine((p) => !p.safetyInstructions || (p.semanticChecks && p.provider === 'nemo'), {
    message: 'Safety instructions require NeMo semantic checks',
    path: ['safetyInstructions'],
  });
export type GuardrailPolicy = z.infer<typeof guardrailPolicySchema>;
export type GuardrailSnapshot = GuardrailPolicy & { id: string; revision?: number };
export type RailDecision = { decision: 'allow' | 'block' | 'modify'; content: string; reason?: string };
const injection =
  /ignore\s+(?:(?:all|any|the)\s+)?(?:previous|prior|system)(?:\s+and\s+following)?\s+instructions|reveal\s+(?:your\s+)?system\s+prompt|\bDAN\s+mode\b/i;
export function builtinRail(
  policy: GuardrailPolicy,
  stage: RailStage,
  content: string,
  tool?: string,
): RailDecision {
  const block = (reason: string): RailDecision => ({
    decision: 'block',
    content: policy.blockMessage,
    reason,
  });
  const lower = content.toLowerCase();
  if (policy.deniedTerms.some((word) => lower.includes(word.toLowerCase()))) return block('Denied term');
  if (policy.contentSafety && /\b(?:build a bomb|make a bomb|child sexual abuse material)\b/i.test(content))
    return block('Content safety');
  if (policy.jailbreak && injection.test(content)) return block('Prompt injection pattern');
  if (policy.blockedTopics.some((word) => lower.includes(word.toLowerCase()))) return block('Blocked topic');
  if (stage === 'tool_input' && tool) {
    if (policy.deniedTools.includes(tool) || policy.deniedTools.includes(tool.split('.').pop()!))
      return block('Denied tool');
    let args: any;
    try {
      args = JSON.parse(content);
    } catch {
      return block('Invalid tool arguments');
    }
    for (const rule of policy.argumentRules.filter(
      (r) => r.tool === tool || r.tool === tool.split('.').pop(),
    )) {
      const value = rule.path
        .split('.')
        .reduce((v, key) => (v && Object.hasOwn(v, key) ? v[key] : undefined), args);
      if (
        (rule.operator === 'missing' && value === undefined) ||
        (rule.operator === 'equals' && String(value) === rule.value) ||
        (rule.operator === 'contains' &&
          JSON.stringify(value ?? '')
            .toLowerCase()
            .includes(rule.value.toLowerCase()))
      )
        return block('Argument rule');
    }
  }
  // Deterministic baseline; semantic models are a separate, explicit NeMo option.
  const masked = policy.pii
    ? content
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]')
        .replace(/\b(?:\d[ -]*?){13,19}\b/g, (v) => {
          const digits = v.replace(/\D/g, '');
          let sum = 0;
          for (let i = digits.length - 1, n = 0; i >= 0; i--, n++) {
            let d = Number(digits[i]);
            if (n % 2 && (d *= 2) > 9) d -= 9;
            sum += d;
          }
          return sum % 10 === 0 ? '[CARD]' : v;
        })
    : content;
  if (stage === 'tool_input') {
    try {
      JSON.parse(masked);
    } catch {
      return block('Redaction would invalidate tool arguments');
    }
  }
  return {
    decision: masked === content ? 'allow' : 'modify',
    content: masked,
    ...(masked !== content ? { reason: 'PII masked' } : {}),
  };
}
