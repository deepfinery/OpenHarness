import type { AgentPattern } from './schema.js';

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
