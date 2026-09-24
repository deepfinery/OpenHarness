import type { Agent, Workflow } from './schema.js';

/** Resource edges grant tools/context to an agent; they are never execution edges. */
export function agentWithResources(workflow: Workflow, nodeId: string, base: Agent): Agent {
  const connections = new Map(base.connections.map((c) => [c.connectionId, new Set(c.tools)]));
  const knowledge = new Set(base.knowledgeBaseIds);
  for (const binding of workflow.bindings ?? []) {
    if (binding.agentNodeId !== nodeId) continue;
    const resource = workflow.resources?.find((r) => r.id === binding.resourceId);
    if (!resource) throw new Error('An attached workflow resource is missing');
    if (resource.type === 'knowledge') knowledge.add(resource.knowledgeBaseId);
    else {
      const tools = connections.get(resource.connectionId) ?? new Set<string>();
      resource.tools.forEach((t) => tools.add(t));
      connections.set(resource.connectionId, tools);
    }
  }
  return {
    ...base,
    connections: [...connections].map(([connectionId, tools]) => ({ connectionId, tools: [...tools] })),
    knowledgeBaseIds: [...knowledge],
  };
}
