import type { Agent, AgentPattern } from './schema.js';

export const effortLevels = ['light', 'medium', 'high', 'extra-high', 'max', 'auto'] as const;
export type EffortLevel = (typeof effortLevels)[number];
export type FixedEffort = Exclude<EffortLevel, 'auto'>;
export type EffortBudget = {
  label: string;
  summary: string;
  /** Model turns per pass (a loop iteration or plan step is one pass). */
  maxTurns: number;
  timeoutSeconds: number;
  /** Total prompt + completion tokens the agent may spend in one run before it must answer. */
  tokenBudget: number;
  patternConfig: Agent['patternConfig'];
};
/** Effort presets: the loop and token budgets an agent gets before it has to answer. */
export const effortPresets: Record<FixedEffort, EffortBudget> = {
  light: {
    label: 'Light',
    summary: '4 turns · 30k tokens · 90 s. Quick answers with a couple of tool calls.',
    maxTurns: 4,
    timeoutSeconds: 90,
    tokenBudget: 30_000,
    patternConfig: { maxPlanSteps: 3, reflections: 1, iterations: 2, doneMarker: 'DONE' },
  },
  medium: {
    label: 'Medium',
    summary: '12 turns · 120k tokens · 5 min. The default for assistants and workflow steps.',
    maxTurns: 12,
    timeoutSeconds: 300,
    tokenBudget: 120_000,
    patternConfig: { maxPlanSteps: 5, reflections: 1, iterations: 3, doneMarker: 'DONE' },
  },
  high: {
    label: 'High',
    summary: '24 turns · 400k tokens · 10 min. Longer plans, two critique rounds, six iterations.',
    maxTurns: 24,
    timeoutSeconds: 600,
    tokenBudget: 400_000,
    patternConfig: { maxPlanSteps: 8, reflections: 2, iterations: 6, doneMarker: 'DONE' },
  },
  'extra-high': {
    label: 'Extra high',
    summary: '36 turns · 1M tokens · 15 min. Deep research with three critique rounds and eight iterations.',
    maxTurns: 36,
    timeoutSeconds: 900,
    tokenBudget: 1_000_000,
    patternConfig: { maxPlanSteps: 8, reflections: 3, iterations: 8, doneMarker: 'DONE' },
  },
  max: {
    label: 'Max',
    summary: '40 turns · 5M tokens · 15 min. Everything the limits allow.',
    maxTurns: 40,
    timeoutSeconds: 900,
    tokenBudget: 5_000_000,
    patternConfig: { maxPlanSteps: 8, reflections: 3, iterations: 10, doneMarker: 'DONE' },
  },
};
export const autoEffort = {
  label: 'Auto',
  summary:
    'Picks light, medium or high per request from the tools attached, the message length and the pattern.',
};
export const effortLabel = (level: EffortLevel | undefined) =>
  !level ? effortPresets.medium.label : level === 'auto' ? autoEffort.label : effortPresets[level].label;
/** The level an auto-effort agent runs at for one request, with the reason for the trace. */
export function resolveEffort(
  agent: Pick<Agent, 'effort' | 'pattern' | 'connections'>,
  input: string,
): { level: FixedEffort; reason: string } {
  if (agent.effort && agent.effort !== 'auto') return { level: agent.effort, reason: 'chosen on the agent' };
  const hasTools = agent.connections.some((c) => c.tools.length);
  const long = input.trim().length > 1500;
  const multiPass = agent.pattern === 'plan-execute' || agent.pattern === 'loop';
  if (multiPass)
    return {
      level: long ? 'high' : 'medium',
      reason: `${agent.pattern} pattern${long ? ', long request' : ''}`,
    };
  if (!hasTools)
    return {
      level: long ? 'medium' : 'light',
      reason: long ? 'long request, no tools' : 'short request, no tools',
    };
  return {
    level: long ? 'high' : 'medium',
    reason: long ? 'tools attached, long request' : 'tools attached',
  };
}
/**
 * The budgets an agent runs with. A fixed level keeps the stored limits (the studio applied the preset when
 * the level was chosen, and Limits may override them); auto applies the resolved preset for this request.
 */
export function budgetedAgent(
  agent: Agent,
  input: string,
): Agent & { tokenBudget: number; resolvedEffort: FixedEffort } {
  const { level } = resolveEffort(agent, input);
  const preset = effortPresets[level];
  if (agent.effort === 'auto')
    return {
      ...agent,
      maxTurns: preset.maxTurns,
      timeoutSeconds: preset.timeoutSeconds,
      patternConfig: { ...agent.patternConfig, ...preset.patternConfig },
      tokenBudget: preset.tokenBudget,
      resolvedEffort: level,
    };
  return { ...agent, tokenBudget: agent.tokenBudget ?? preset.tokenBudget, resolvedEffort: level };
}

/** Browser-safe descriptions of the agentic patterns the runtime implements. */
export const patternDescriptions: Record<AgentPattern, { name: string; summary: string; detail: string }> = {
  react: {
    name: 'ReAct',
    summary: 'Reason, call tools, observe, answer.',
    detail:
      'The model decides each turn whether to call a tool or answer. Tool results feed back into the next turn. The default for assistants and most workflow steps.',
  },
  'plan-execute': {
    name: 'Plan and execute',
    summary: 'Plan first, run each step with tools, then synthesize.',
    detail:
      'A planning pass writes a short numbered plan without tools. Each step is then executed with tools and its result recorded, and a final pass writes one answer from the step results.',
  },
  reflection: {
    name: 'Reflection',
    summary: 'Draft, critique, revise.',
    detail:
      'The agent drafts an answer, reviews it as a strict critic, and revises with tools available for verification. Rounds are configurable. Best for writing, analysis and review.',
  },
  loop: {
    name: 'Autonomous loop',
    summary: 'Iterate until the agent says it is done.',
    detail:
      'The agent works in iterations, carrying progress forward, until it ends a message with the done marker or reaches the iteration limit. Suited to multi-part tasks with a clear completion condition.',
  },
};
