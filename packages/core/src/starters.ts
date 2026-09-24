import { agentSchema, workflowSchema, type Workflow } from './schema.js';
export const starterRecipes = [
  {
    id: 'research',
    name: 'Knowledge research',
    description: 'Answer questions from your documents, with source citations.',
    needsKnowledge: true,
    needsTools: false,
  },
  {
    id: 'mcp',
    name: 'MCP tool assistant',
    description: 'Give an agent the tools it needs to look up information or take action.',
    needsKnowledge: false,
    needsTools: true,
  },
  {
    id: 'review',
    name: 'Research and review',
    description: 'One agent researches your knowledge base; a second checks the result.',
    needsKnowledge: true,
    needsTools: false,
  },
  {
    id: 'blank',
    name: 'Blank canvas',
    description: 'Start with Start and Finish. Add agents, branches, and tools your way.',
    needsKnowledge: false,
    needsTools: false,
  },
] as const;
export type StarterKind = (typeof starterRecipes)[number]['id'];
export function makeStarter(options: {
  kind: StarterKind;
  name?: string;
  providerId?: string;
  knowledgeBaseId?: string;
  connectionId?: string;
  tools?: string[];
}): Workflow {
  const recipe = starterRecipes.find((r) => r.id === options.kind)!;
  const workflow: Workflow = {
    name: options.name || recipe.name,
    description: recipe.description,
    enabled: true,
    startAt: 'start',
    maxSteps: 100,
    resources: [],
    bindings: [],
    nodes: [
      {
        id: 'start',
        name: 'Start',
        type: 'start',
        next: options.kind === 'blank' ? 'finish' : 'assistant',
        position: { x: 50, y: 140 },
      },
      {
        id: 'finish',
        name: 'Finish',
        type: 'finish',
        template: '{{last}}',
        position: { x: options.kind === 'review' ? 1170 : 770, y: 140 },
      },
    ],
  };
  if (options.kind !== 'blank') {
    const config = agentSchema.parse({
      name: options.kind === 'mcp' ? 'Tool assistant' : 'Researcher',
      providerId: options.providerId,
      systemPrompt:
        options.kind === 'mcp'
          ? 'Use your attached MCP tools to handle the request. Inspect tool results before answering. Never claim an action succeeded unless its tool result confirms it. Ask for missing information when needed.'
          : 'Research the question using the attached knowledge. Separate evidence from uncertainty, cite source titles, and say when the documents do not contain the answer.',
    });
    workflow.nodes.splice(1, 0, {
      id: 'assistant',
      name: config.name,
      type: 'agent',
      config,
      prompt: '{{input}}',
      next: options.kind === 'review' ? 'reviewer' : 'finish',
      position: { x: 340, y: 110 },
    });
    if (recipe.needsKnowledge) {
      if (!options.knowledgeBaseId) throw new Error('Choose a knowledge base for this template');
      workflow.resources.push({
        id: 'knowledge',
        name: 'Knowledge base',
        type: 'knowledge',
        knowledgeBaseId: options.knowledgeBaseId,
        position: { x: 365, y: 425 },
      });
      workflow.bindings.push({ agentNodeId: 'assistant', resourceId: 'knowledge' });
    }
    if (recipe.needsTools) {
      if (!options.connectionId || !options.tools?.length)
        throw new Error('Choose an MCP connection and at least one discovered tool');
      workflow.resources.push({
        id: 'tools',
        name: 'MCP tools',
        type: 'mcp',
        connectionId: options.connectionId,
        tools: options.tools,
        position: { x: 365, y: 425 },
      });
      workflow.bindings.push({ agentNodeId: 'assistant', resourceId: 'tools' });
    }
    if (options.kind === 'review')
      workflow.nodes.splice(2, 0, {
        id: 'reviewer',
        name: 'Reviewer',
        type: 'agent',
        config: {
          ...config,
          name: 'Reviewer',
          systemPrompt:
            'Review the research draft for unsupported claims, clarity, and source citations. Return an improved final answer without inventing facts.',
        },
        prompt: 'Question: {{input}}\nResearch draft: {{last}}',
        next: 'finish',
        position: { x: 755, y: 110 },
      });
  }
  return workflowSchema.parse(workflow);
}
