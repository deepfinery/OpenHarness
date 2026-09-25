import {
  agentSchema,
  workflowSchema,
  type Agent,
  type AgentPattern,
  type Workflow,
  type WorkflowNode,
} from './schema.js';

export const starterRecipes = [
  {
    id: 'research',
    name: 'Knowledge research',
    description: 'Answer questions from your documents, with source citations.',
    shape: 'Start → Researcher → Finish',
    needsKnowledge: true,
    needsTools: false,
    agents: 1,
  },
  {
    id: 'mcp',
    name: 'MCP tool assistant',
    description: 'Give an agent the tools it needs to look up information or take action.',
    shape: 'Start → Tool assistant → Finish',
    needsKnowledge: false,
    needsTools: true,
    agents: 1,
  },
  {
    id: 'review',
    name: 'Research and review',
    description: 'One agent researches your knowledge base; a second checks the result.',
    shape: 'Start → Researcher → Reviewer → Finish',
    needsKnowledge: true,
    needsTools: false,
    agents: 2,
  },
  {
    id: 'team',
    name: 'Plan, research, write',
    description:
      'A planner breaks the task down, a researcher works the tools, a writer produces the answer.',
    shape: 'Start → Planner → Researcher → Writer → Finish',
    needsKnowledge: false,
    needsTools: true,
    agents: 3,
  },
  {
    id: 'router',
    name: 'Route to a specialist',
    description: 'A triage agent classifies the request and a condition hands it to the right specialist.',
    shape: 'Start → Triage → Condition → Specialist A / B → Finish',
    needsKnowledge: false,
    needsTools: false,
    agents: 3,
  },
  {
    id: 'notify',
    name: 'Research and email',
    description: 'An analyst uses tools to research, then the result is emailed through your SMTP settings.',
    shape: 'Start → Analyst → Email → Finish',
    needsKnowledge: false,
    needsTools: true,
    agents: 1,
  },
  {
    id: 'blank',
    name: 'Blank canvas',
    description: 'Start with Start and Finish. Add agents, branches, and tools your way.',
    shape: 'Start → Finish',
    needsKnowledge: false,
    needsTools: false,
    agents: 0,
  },
] as const;
export type StarterKind = (typeof starterRecipes)[number]['id'];

/** Reusable agent templates. Each pairs a pattern with instructions written for it. */
export const agentRecipes: Array<{
  id: string;
  name: string;
  description: string;
  pattern: AgentPattern;
  systemPrompt: string;
  wantsTools?: boolean;
  wantsKnowledge?: boolean;
  patternConfig?: Partial<Agent['patternConfig']>;
}> = [
  {
    id: 'assistant',
    name: 'General assistant',
    description: 'Answers questions and completes tasks, calling tools when they help.',
    pattern: 'react',
    systemPrompt:
      'You are a helpful, precise assistant. Use your connected tools when they help. Inspect tool results before answering, never claim an action succeeded unless a tool result confirms it, and ask for missing information when needed.',
    wantsTools: true,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Grounds answers in your knowledge base and cites sources.',
    pattern: 'react',
    systemPrompt:
      'Research the question using the attached knowledge and tools. Separate evidence from uncertainty, cite source titles, and say plainly when the material does not contain the answer.',
    wantsKnowledge: true,
    wantsTools: true,
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Breaks a complex request into steps, executes each with tools, then synthesizes.',
    pattern: 'plan-execute',
    systemPrompt:
      'You solve multi-step tasks methodically. Plans are short, concrete and ordered. When executing a step, do exactly that step, verify results with tools where possible, and report what you found. Final answers are complete and organized.',
    wantsTools: true,
    patternConfig: { maxPlanSteps: 5 },
  },
  {
    id: 'writer',
    name: 'Reflective writer',
    description: 'Drafts, critiques its own work, and revises before answering.',
    pattern: 'reflection',
    systemPrompt:
      'You write clear, well-structured responses. When critiquing, be specific about unsupported claims, missing steps and unclear wording. When revising, fix every point raised without padding the text.',
    patternConfig: { reflections: 1 },
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Checks another agent’s output for gaps and unsupported claims.',
    pattern: 'react',
    systemPrompt:
      'Review the draft you are given for factual gaps, unsupported claims, missing steps and clarity. Return an improved final version without inventing facts. Keep citations that are supported and remove those that are not.',
  },
  {
    id: 'worker',
    name: 'Autonomous worker',
    description: 'Iterates on a long task until it can report that it is done.',
    pattern: 'loop',
    systemPrompt:
      'You complete multi-part tasks over several iterations. Each iteration, make concrete progress with your tools, then report what is done and what remains. Only declare completion when every part of the task is finished.',
    wantsTools: true,
    patternConfig: { iterations: 4, doneMarker: 'DONE' },
  },
  {
    id: 'support',
    name: 'Support agent',
    description: 'Resolves customer questions from your documentation, escalating when unsure.',
    pattern: 'react',
    systemPrompt:
      'You are a support agent. Answer from the attached knowledge base in a friendly, direct tone. If the documentation does not cover the question, say so and suggest contacting a human. Never guess at account-specific details.',
    wantsKnowledge: true,
  },
];

function inlineAgent(
  providerId: string | undefined,
  name: string,
  systemPrompt: string,
  pattern: AgentPattern = 'react',
): Agent {
  return agentSchema.parse({ name, providerId, systemPrompt, pattern });
}

export function makeStarter(options: {
  kind: StarterKind;
  name?: string;
  providerId?: string;
  knowledgeBaseId?: string;
  connectionId?: string;
  tools?: string[];
}): Workflow {
  const recipe = starterRecipes.find((r) => r.id === options.kind)!;
  const { kind, providerId } = options;
  const workflow: Workflow = {
    name: options.name || recipe.name,
    description: recipe.description,
    enabled: true,
    startAt: 'start',
    maxSteps: 100,
    resumePolicy: 'safe',
    resources: [],
    bindings: [],
    nodes: [],
  };
  const nodes: WorkflowNode[] = [];
  const agentNode = (
    id: string,
    agent: Agent,
    next: string,
    prompt: string,
    position: { x: number; y: number },
  ): WorkflowNode => ({ id, name: agent.name, type: 'agent', config: agent, prompt, next, position });
  const attach = (agentNodeId: string) => {
    if (recipe.needsKnowledge) {
      if (!options.knowledgeBaseId) throw new Error('Choose a knowledge base for this template');
      if (!workflow.resources.some((r) => r.id === 'knowledge'))
        workflow.resources.push({
          id: 'knowledge',
          name: 'Knowledge base',
          type: 'knowledge',
          knowledgeBaseId: options.knowledgeBaseId,
          position: { x: 365, y: 425 },
        });
      workflow.bindings.push({ agentNodeId, resourceId: 'knowledge' });
    }
    if (recipe.needsTools) {
      if (!options.connectionId || !options.tools?.length)
        throw new Error('Choose an MCP connection and at least one discovered tool');
      if (!workflow.resources.some((r) => r.id === 'tools'))
        workflow.resources.push({
          id: 'tools',
          name: 'MCP tools',
          type: 'mcp',
          connectionId: options.connectionId,
          tools: options.tools,
          position: { x: 365, y: 425 },
        });
      workflow.bindings.push({ agentNodeId, resourceId: 'tools' });
    }
  };
  const start = (next: string): WorkflowNode => ({
    id: 'start',
    name: 'Start',
    type: 'start',
    next,
    position: { x: 50, y: 140 },
  });
  const finish = (x: number): WorkflowNode => ({
    id: 'finish',
    name: 'Finish',
    type: 'finish',
    template: '{{last}}',
    position: { x, y: 140 },
  });
  switch (kind) {
    case 'blank':
      nodes.push(start('finish'), finish(770));
      break;
    case 'research':
    case 'mcp': {
      const agent = inlineAgent(
        providerId,
        kind === 'mcp' ? 'Tool assistant' : 'Researcher',
        kind === 'mcp'
          ? 'Use your attached MCP tools to handle the request. Inspect tool results before answering. Never claim an action succeeded unless its tool result confirms it. Ask for missing information when needed.'
          : 'Research the question using the attached knowledge. Separate evidence from uncertainty, cite source titles, and say when the documents do not contain the answer.',
      );
      nodes.push(
        start('assistant'),
        agentNode('assistant', agent, 'finish', '{{input}}', { x: 340, y: 110 }),
        finish(770),
      );
      attach('assistant');
      break;
    }
    case 'review': {
      const researcher = inlineAgent(
        providerId,
        'Researcher',
        'Research the question using the attached knowledge. Separate evidence from uncertainty, cite source titles, and say when the documents do not contain the answer.',
      );
      const reviewer = inlineAgent(
        providerId,
        'Reviewer',
        'Review the research draft for unsupported claims, clarity, and source citations. Return an improved final answer without inventing facts.',
      );
      nodes.push(
        start('assistant'),
        agentNode('assistant', researcher, 'reviewer', '{{input}}', { x: 340, y: 110 }),
        agentNode('reviewer', reviewer, 'finish', 'Question: {{input}}\nResearch draft: {{last}}', {
          x: 755,
          y: 110,
        }),
        finish(1170),
      );
      attach('assistant');
      break;
    }
    case 'team': {
      const planner = inlineAgent(
        providerId,
        'Planner',
        'Break the request into a short, ordered research plan. List what must be found out and in what order. Output only the plan.',
      );
      const researcher = inlineAgent(
        providerId,
        'Researcher',
        'Follow the plan you are given. Use your MCP tools to gather each fact, note the source of each finding, and report findings step by step. Do not write the final answer.',
        'plan-execute',
      );
      const writer = inlineAgent(
        providerId,
        'Writer',
        'Turn the research findings into a clear, complete answer to the original request. Keep every claim tied to a finding. Draft, critique, and revise before answering.',
        'reflection',
      );
      nodes.push(
        start('planner'),
        agentNode('planner', planner, 'researcher', '{{input}}', { x: 340, y: 110 }),
        agentNode('researcher', researcher, 'writer', 'Request: {{input}}\nPlan:\n{{steps.planner}}', {
          x: 755,
          y: 110,
        }),
        agentNode('writer', writer, 'finish', 'Request: {{input}}\nFindings:\n{{steps.researcher}}', {
          x: 1170,
          y: 110,
        }),
        finish(1585),
      );
      attach('researcher');
      break;
    }
    case 'router': {
      const triage = inlineAgent(
        providerId,
        'Triage',
        'Classify the request. Reply with exactly one word: SUPPORT for help with an existing product or account, or SALES for pricing, purchasing, or new-customer questions. Output only that word.',
      );
      const support = inlineAgent(
        providerId,
        'Support specialist',
        'You handle support requests. Give practical troubleshooting steps and say when a human should take over.',
      );
      const sales = inlineAgent(
        providerId,
        'Sales specialist',
        'You handle sales questions. Explain options clearly, avoid inventing prices or commitments, and offer a next step.',
      );
      nodes.push(
        start('triage'),
        agentNode('triage', triage, 'route', '{{input}}', { x: 340, y: 110 }),
        {
          id: 'route',
          name: 'Support or sales?',
          type: 'condition',
          value: '{{last}}',
          operator: 'contains',
          compare: 'SUPPORT',
          onTrue: 'support',
          onFalse: 'sales',
          position: { x: 755, y: 110 },
        },
        agentNode('support', support, 'finish', '{{input}}', { x: 1170, y: 0 }),
        agentNode('sales', sales, 'finish', '{{input}}', { x: 1170, y: 260 }),
        finish(1585),
      );
      break;
    }
    case 'notify': {
      const analyst = inlineAgent(
        providerId,
        'Analyst',
        'Use your MCP tools to research the request thoroughly. Write a concise report with a summary first, then the supporting findings and their sources. The report will be emailed as-is.',
      );
      nodes.push(
        start('analyst'),
        agentNode('analyst', analyst, 'email', '{{input}}', { x: 340, y: 110 }),
        {
          id: 'email',
          name: 'Email the report',
          type: 'email',
          to: 'you@example.com',
          subject: 'Report: {{input}}',
          body: '{{last}}',
          next: 'finish',
          position: { x: 755, y: 110 },
        },
        finish(1170),
      );
      attach('analyst');
      break;
    }
  }
  workflow.nodes = nodes;
  return workflowSchema.parse(workflow);
}
