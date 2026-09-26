import type { Connection, Edge } from '@xyflow/react';
import {
  agentSchema,
  type Agent,
  type Workflow,
  type WorkflowNode,
  type WorkflowResource,
} from '../../../packages/core/src/schema.js';
import { defaultProviderId, type Data, type Entity } from './api';
import { makeStarter } from '../../../packages/core/src/starters.js';
import { effortPresets } from '../../../packages/core/src/patterns.js';

export const isFinish = (n: WorkflowNode) => n.type === 'output' || n.type === 'finish';
export function executionLinks(n: WorkflowNode): { target: string; port: string }[] {
  if (n.type === 'review')
    return [
      { target: n.onApprove, port: 'true' },
      { target: n.onReject, port: 'false' },
    ];
  if (n.type === 'condition')
    return [
      { target: n.onTrue, port: 'true' },
      { target: n.onFalse, port: 'false' },
    ];
  return 'next' in n && n.next ? [{ target: n.next, port: 'out' }] : [];
}
export function graphEdges(form: Workflow): Edge[] {
  return [
    ...form.nodes.flatMap((n) =>
      executionLinks(n)
        .filter((l) => form.nodes.some((t) => t.id === l.target))
        .map((l) => ({
          id: `flow:${n.id}:${l.port}`,
          source: n.id,
          target: l.target,
          sourceHandle: l.port,
          targetHandle: 'in',
          type: 'smoothstep',
          label: l.port === 'out' ? undefined : l.port === 'true' ? 'Yes' : 'No',
          data: { kind: 'flow', port: l.port },
        })),
    ),
    // A Parallel step runs the agent cards it points at; those cards need no place in the execution path.
    ...form.nodes.flatMap((n) =>
      n.type === 'parallel'
        ? (n.agentNodeIds ?? [])
            .filter((id) => form.nodes.some((t) => t.id === id))
            .map((id) => ({
              id: `member:${n.id}:${id}`,
              source: n.id,
              target: id,
              sourceHandle: 'members',
              targetHandle: 'in',
              type: 'bezier',
              label: 'Runs',
              data: { kind: 'member' },
            }))
        : [],
    ),
    ...(form.bindings ?? []).map((b) => ({
      id: `resource:${b.resourceId}:${b.agentNodeId}`,
      source: b.resourceId,
      target: b.agentNodeId,
      sourceHandle: 'resource',
      targetHandle:
        form.resources.find((r) => r.id === b.resourceId)?.type === 'knowledge' ? 'knowledge' : 'tools',
      type: 'bezier',
      data: { kind: 'resource' },
      label: form.resources.find((r) => r.id === b.resourceId)?.type === 'knowledge' ? 'Context' : 'Tools',
    })),
  ];
}
export function connectGraph(form: Workflow, c: Connection): Workflow {
  if (c.sourceHandle === 'members' || c.targetHandle === 'members') {
    const parallelId = c.sourceHandle === 'members' ? c.source : c.target;
    const agentId = c.sourceHandle === 'members' ? c.target : c.source;
    const parallel = form.nodes.find((n) => n.id === parallelId);
    const agent = form.nodes.find((n) => n.id === agentId);
    if (parallel?.type !== 'parallel' || agent?.type !== 'agent')
      throw new Error('Connect the Runs port to an agent card.');
    if (parallel.agentNodeIds.includes(agentId)) return form;
    return {
      ...form,
      nodes: form.nodes.map((n) =>
        n.id === parallel.id ? { ...parallel, agentNodeIds: [...parallel.agentNodeIds, agentId] } : n,
      ),
    };
  }
  const resource = form.resources.find((r) => r.id === c.source || r.id === c.target);
  if (resource) {
    const agentId = resource.id === c.source ? c.target : c.source;
    const agentPort = resource.id === c.source ? c.targetHandle : c.sourceHandle;
    const agent = form.nodes.find((n) => n.id === agentId);
    const expected = resource.type === 'mcp' ? 'tools' : 'knowledge';
    if (agent?.type !== 'agent' || agentPort !== expected)
      throw new Error(
        `Connect this resource to an agent’s ${expected === 'tools' ? 'Tools' : 'Knowledge'} port.`,
      );
    if (form.bindings.some((b) => b.agentNodeId === agentId && b.resourceId === resource.id)) return form;
    return { ...form, bindings: [...form.bindings, { agentNodeId: agentId, resourceId: resource.id }] };
  }
  const reverse = c.sourceHandle === 'in';
  const from = reverse ? c.target : c.source,
    to = reverse ? c.source : c.target;
  const port = reverse ? c.targetHandle : c.sourceHandle,
    inPort = reverse ? c.sourceHandle : c.targetHandle;
  const source = form.nodes.find((n) => n.id === from),
    target = form.nodes.find((n) => n.id === to);
  if (
    !source ||
    !target ||
    (from === to && source.type !== 'condition') ||
    isFinish(source) ||
    target.type === 'start' ||
    inPort !== 'in' ||
    !['out', 'true', 'false'].includes(port ?? '')
  )
    throw new Error(
      'Connect a step’s Next port to the next step’s input. Tools and knowledge use the agent’s bottom ports.',
    );
  if ((source.type === 'condition' || source.type === 'review') !== (port === 'true' || port === 'false'))
    throw new Error('Choose the matching execution port.');
  return {
    ...form,
    nodes: form.nodes.map((n) =>
      n.id !== from
        ? n
        : ({
            ...n,
            [source.type === 'review'
              ? port === 'false'
                ? 'onReject'
                : 'onApprove'
              : source.type === 'condition'
                ? port === 'false'
                  ? 'onFalse'
                  : 'onTrue'
                : 'next']: to,
          } as WorkflowNode),
    ),
  };
}
export function disconnectGraph(form: Workflow, edge: Edge): Workflow {
  if (edge.id.startsWith('member:'))
    return {
      ...form,
      nodes: form.nodes.map((n) =>
        n.id === edge.source && n.type === 'parallel'
          ? { ...n, agentNodeIds: n.agentNodeIds.filter((id) => id !== edge.target) }
          : n,
      ),
    };
  if (edge.id.startsWith('resource:'))
    return {
      ...form,
      bindings: form.bindings.filter((b) => !(b.resourceId === edge.source && b.agentNodeId === edge.target)),
    };
  return {
    ...form,
    nodes: form.nodes.map((n) =>
      n.id !== edge.source
        ? n
        : ({
            ...n,
            [n.type === 'review'
              ? edge.sourceHandle === 'false'
                ? 'onReject'
                : 'onApprove'
              : n.type === 'condition'
                ? edge.sourceHandle === 'false'
                  ? 'onFalse'
                  : 'onTrue'
                : 'next']: undefined,
          } as WorkflowNode),
    ),
  };
}
export function defaultAgent(data: Data): Agent {
  const preset = effortPresets.medium;
  return {
    name: 'AI agent',
    description: '',
    providerId: defaultProviderId(data),
    systemPrompt:
      'Handle the user’s request using your attached tools and knowledge. Check results, cite sources, and be clear about uncertainty.',
    connections: [],
    knowledgeBaseIds: [],
    skillIds: [],
    enabled: true,
    contextCompaction: true,
    maxTurns: preset.maxTurns,
    timeoutSeconds: preset.timeoutSeconds,
    pattern: 'react',
    patternConfig: { ...preset.patternConfig },
    effort: 'medium',
  };
}
/** Upgrade the editable graph without rewriting saved workflows until the user saves. */
export function editableWorkflow(value: Entity | Workflow | undefined, data: Data): Workflow {
  const f: Workflow = value
    ? (structuredClone(value) as Workflow)
    : makeStarter({ kind: 'blank', name: 'Untitled workflow' });
  f.resources ??= [];
  f.bindings ??= [];
  f.maxSteps ??= 100;
  for (const n of f.nodes) if (n.type === 'output') (n as { type: string }).type = 'finish';
  for (const n of f.nodes)
    if (n.type === 'parallel') {
      n.agentNodeIds ??= [];
      n.agentIds ??= [];
    }
  if (!f.nodes.some((n) => n.type === 'start')) {
    let startId = 'start';
    while (f.nodes.some((n) => n.id === startId)) startId += '_';
    f.nodes.unshift({
      id: startId,
      name: 'Start',
      type: 'start',
      next: f.startAt,
      position: { x: -220, y: 140 },
    });
    f.startAt = startId;
  }
  if (!f.nodes.some(isFinish)) {
    let finishId = 'finish';
    while (f.nodes.some((n) => n.id === finishId)) finishId += '_';
    f.nodes.push({
      id: finishId,
      name: 'Finish',
      type: 'finish',
      template: '{{last}}',
      position: { x: 900, y: 140 },
    });
    for (const n of f.nodes)
      if (!isFinish(n) && n.type !== 'condition' && n.type !== 'review' && !n.next) n.next = finishId;
  }
  for (const n of f.nodes)
    if (n.type === 'agent') {
      const saved = n.config ?? data.agents.find((a) => a.id === n.agentId);
      if (!saved) continue;
      const config = agentSchema.parse(saved);
      // Display every granted resource on the canvas, including inherited bindings.
      for (const c of config.connections) {
        const id = `mcp_${n.id.slice(0, 32)}_${f.resources.length}`;
        f.resources.push({
          id,
          name: data.connections.find((v) => v.id === c.connectionId)?.name ?? 'MCP tools',
          type: 'mcp',
          connectionId: c.connectionId,
          tools: c.tools,
          position: { x: n.position?.x ?? 300, y: (n.position?.y ?? 140) + 300 },
        });
        f.bindings.push({ agentNodeId: n.id, resourceId: id });
      }
      for (const kb of config.knowledgeBaseIds) {
        const id = `kb_${n.id.slice(0, 32)}_${f.resources.length}`;
        f.resources.push({
          id,
          name: data.knowledge.find((v) => v.id === kb)?.name ?? 'Knowledge',
          type: 'knowledge',
          knowledgeBaseId: kb,
          position: { x: (n.position?.x ?? 300) + 260, y: (n.position?.y ?? 140) + 300 },
        });
        f.bindings.push({ agentNodeId: n.id, resourceId: id });
      }
      n.config = { ...config, connections: [], knowledgeBaseIds: [] };
      delete n.agentId;
    }
  return f;
}
export function removeGraphNode(form: Workflow, id: string): Workflow {
  const n = form.nodes.find((node) => node.id === id);
  if (n?.type === 'start' || (n && isFinish(n) && form.nodes.filter(isFinish).length === 1))
    throw new Error('Keep one Start and Finish in the workflow.');
  const replacement = n && 'next' in n ? n.next : undefined;
  const removedResources = new Set(
    form.resources
      .filter(
        (r) =>
          r.id === id ||
          (n &&
            form.bindings.some((b) => b.resourceId === r.id && b.agentNodeId === id) &&
            !form.bindings.some((b) => b.resourceId === r.id && b.agentNodeId !== id)),
      )
      .map((r) => r.id),
  );
  return {
    ...form,
    nodes: form.nodes
      .filter((v) => v.id !== id)
      .map((v) => {
        if (v.type === 'review')
          return {
            ...v,
            onApprove: v.onApprove === id ? (replacement ?? '') : v.onApprove,
            onReject: v.onReject === id ? (replacement ?? '') : v.onReject,
          };
        if (v.type === 'condition')
          return {
            ...v,
            onTrue: v.onTrue === id ? (replacement ?? '') : v.onTrue,
            onFalse: v.onFalse === id ? (replacement ?? '') : v.onFalse,
          };
        if (v.type === 'parallel' && v.agentNodeIds.includes(id))
          v = { ...v, agentNodeIds: v.agentNodeIds.filter((m) => m !== id) };
        if ('next' in v && v.next === id) return { ...v, next: replacement } as WorkflowNode;
        return v;
      }),
    resources: form.resources.filter((r) => !removedResources.has(r.id)),
    bindings: form.bindings.filter((b) => b.agentNodeId !== id && !removedResources.has(b.resourceId)),
  };
}
export function insertStep(form: Workflow, node: WorkflowNode, selected?: string): Workflow {
  const finish = form.nodes.find(isFinish);
  const after =
    form.nodes.find(
      (n) => n.id === selected && !isFinish(n) && n.type !== 'condition' && n.type !== 'review',
    ) ??
    form.nodes.find((n) => 'next' in n && n.next === finish?.id) ??
    form.nodes.find((n) => n.type === 'start');
  const target = after && 'next' in after ? (after.next ?? finish?.id) : finish?.id;
  const nextNode: WorkflowNode =
    node.type === 'review'
      ? { ...node, onApprove: target ?? '', onReject: target ?? '' }
      : node.type === 'condition'
        ? { ...node, onTrue: target ?? '', onFalse: target ?? '' }
        : isFinish(node)
          ? node
          : ({ ...node, next: target } as WorkflowNode);
  return {
    ...form,
    nodes: [
      ...form.nodes.map((n) => (n.id === after?.id ? ({ ...n, next: node.id } as WorkflowNode) : n)),
      nextNode,
    ],
  };
}
