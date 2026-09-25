import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStarter, starterRecipes } from '../../packages/core/src/starters.js';
import { agentSchema, workflowSchema, type Workflow } from '../../packages/core/src/schema.js';
import { agentWithResources } from '../../packages/core/src/workflow.js';
import {
  connectGraph,
  disconnectGraph,
  graphEdges,
  insertStep,
  removeGraphNode,
  editableWorkflow,
} from '../../apps/studio/src/workflowGraph.js';
import type { Data } from '../../apps/studio/src/api.js';
const providerId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const options = { providerId, connectionId, knowledgeBaseId, tools: ['lookup'] };
const mcp = () => makeStarter({ kind: 'mcp', ...options });

test('every starter has an explicit Start and Finish and usable resource bindings', () => {
  for (const recipe of starterRecipes) {
    const w = makeStarter({ kind: recipe.id, ...options });
    assert.equal(workflowSchema.safeParse(w).success, true, recipe.id);
    assert.equal(w.nodes.find((n) => n.id === w.startAt)?.type, 'start');
    assert.ok(w.nodes.some((n) => n.type === 'finish'));
    assert.equal(w.nodes.filter((n) => n.type === 'agent').length, recipe.agents);
    const expectedBindings = (recipe.needsKnowledge ? 1 : 0) + (recipe.needsTools ? 1 : 0);
    assert.equal(w.bindings.length, expectedBindings, recipe.id);
    for (const r of w.resources)
      assert.ok(
        w.bindings.some((b) => b.resourceId === r.id),
        `${recipe.id} binds ${r.id}`,
      );
  }
  assert.throws(() => makeStarter({ kind: 'mcp', providerId }));
  assert.throws(() => makeStarter({ kind: 'research', providerId }));
  assert.throws(() => makeStarter({ kind: 'notify', providerId }));
  const operator = makeStarter({
    kind: 'machine',
    providerId,
    machine: { connectionId, name: 'Build box', tools: ['run_command', 'list_dir'] },
  });
  assert.deepEqual(operator.bindings, [{ agentNodeId: 'operator', resourceId: 'machine' }]);
  assert.deepEqual(operator.resources[0], {
    id: 'machine',
    name: 'Build box',
    type: 'mcp',
    connectionId,
    tools: ['run_command', 'list_dir'],
    position: { x: 365, y: 425 },
  });
  assert.match(
    operator.nodes.find((n) => n.id === 'operator')!.config!.systemPrompt,
    /run_command with argv/,
  );
  assert.throws(() =>
    makeStarter({ kind: 'machine', providerId, machine: { connectionId, name: 'Offline', tools: [] } }),
  );
  const team = makeStarter({ kind: 'team', ...options });
  assert.deepEqual(
    team.nodes.filter((n) => n.type === 'agent').map((n) => n.config?.pattern),
    ['react', 'plan-execute', 'reflection'],
  );
  assert.equal(
    makeStarter({ kind: 'notify', ...options }).nodes.some((n) => n.type === 'email'),
    true,
  );
});
test('canvas connects controls and resources in either drag direction without conflating their edges', () => {
  let w = mcp();
  const toolEdge = graphEdges(w).find((e) => e.id.startsWith('resource:'))!;
  w = disconnectGraph(w, toolEdge);
  assert.equal(w.bindings.length, 0);
  w = connectGraph(w, {
    source: 'assistant',
    target: 'tools',
    sourceHandle: 'tools',
    targetHandle: 'resource',
  });
  assert.equal(w.bindings.length, 1);
  w = connectGraph(w, {
    source: 'tools',
    target: 'assistant',
    sourceHandle: 'resource',
    targetHandle: 'tools',
  });
  assert.equal(w.bindings.length, 1, 'duplicate attachments do not grant additional permissions');
  const flowEdge = graphEdges(w).find((e) => e.source === 'start')!;
  w = disconnectGraph(w, flowEdge);
  w = connectGraph(w, { source: 'assistant', target: 'start', sourceHandle: 'in', targetHandle: 'out' });
  assert.equal(graphEdges(w).find((e) => e.source === 'start')?.target, 'assistant');
  assert.equal(workflowSchema.safeParse(w).success, true);
  assert.throws(() =>
    connectGraph(w, { source: 'tools', target: 'assistant', sourceHandle: 'resource', targetHandle: 'in' }),
  );
  assert.throws(() =>
    connectGraph(w, {
      source: 'tools',
      target: 'assistant',
      sourceHandle: 'resource',
      targetHandle: 'knowledge',
    }),
  );
  assert.throws(() =>
    connectGraph(w, { source: 'finish', target: 'start', sourceHandle: 'out', targetHandle: 'in' }),
  );
});
test('removing an agent rewires execution and removes only unshared resource attachments', () => {
  let w = insertStep(
    mcp(),
    {
      id: 'second',
      type: 'agent',
      name: 'Second',
      config: agentSchema.parse({ systemPrompt: 'Use the available evidence.', name: 'Second', providerId }),
      prompt: '{{last}}',
    },
    'assistant',
  );
  w = connectGraph(w, { source: 'tools', target: 'second', sourceHandle: 'resource', targetHandle: 'tools' });
  const removed = removeGraphNode(w, 'assistant');
  assert.equal(removed.bindings.length, 1);
  assert.equal(removed.resources.length, 1);
  assert.equal(graphEdges(removed).find((e) => e.source === 'start')?.target, 'second');
  assert.equal(workflowSchema.safeParse(removed).success, true);
  assert.equal(removeGraphNode(removed, 'second').resources.length, 0);
  assert.throws(() => removeGraphNode(w, 'start'));
  assert.throws(() => removeGraphNode(w, 'finish'));
});
test('resource permissions are explicit, deduplicated and scoped to their connected agent', () => {
  const w = mcp();
  w.resources.push({ id: 'kb', name: 'Knowledge', type: 'knowledge', knowledgeBaseId });
  w.bindings.push({ agentNodeId: 'assistant', resourceId: 'kb' });
  const base = agentSchema.parse({
    systemPrompt: 'Use the available evidence.',
    name: 'A',
    providerId,
    connections: [{ connectionId, tools: ['lookup'] }],
  });
  const resolved = agentWithResources(w, 'assistant', base);
  assert.deepEqual(resolved.connections, [{ connectionId, tools: ['lookup'] }]);
  assert.deepEqual(resolved.knowledgeBaseIds, [knowledgeBaseId]);
  assert.deepEqual(agentWithResources(w, 'unconnected', base).knowledgeBaseIds, []);
  assert.deepEqual(base.knowledgeBaseIds, [], 'compilation must not mutate the reusable agent');
  assert.equal(workflowSchema.safeParse({ ...w, bindings: [] }).success, false);
  assert.equal(
    workflowSchema.safeParse({ ...w, bindings: [{ agentNodeId: 'finish', resourceId: 'tools' }] }).success,
    false,
  );
});
test('bounded harness cycles need a possible exit and may not return to Start', () => {
  const w = makeStarter({ kind: 'blank' });
  (w.nodes[0] as any).next = 'check';
  w.nodes.push({
    id: 'check',
    type: 'condition',
    name: 'Check',
    value: '{{input}}',
    operator: 'truthy',
    compare: '',
    onTrue: 'check',
    onFalse: 'finish',
  });
  assert.equal(workflowSchema.safeParse(w).success, true);
  assert.equal(workflowSchema.safeParse({ ...w, maxSteps: 501 }).success, false);
  const check = w.nodes.find((n) => n.id === 'check') as any;
  check.onFalse = 'check';
  assert.equal(workflowSchema.safeParse(w).success, false);
  check.onFalse = 'finish';
  check.onTrue = 'start';
  assert.equal(workflowSchema.safeParse(w).success, false);
});
test('opening a legacy agent graph exposes its tools and knowledge without changing the saved source', () => {
  const agentId = '44444444-4444-4444-8444-444444444444';
  const source = {
    name: 'Legacy',
    startAt: 'a'.repeat(64),
    nodes: [{ id: 'a'.repeat(64), type: 'agent', name: 'Legacy agent', agentId, prompt: '{{input}}' }],
  };
  const data = {
    providers: [],
    connections: [],
    knowledge: [],
    agents: [
      {
        id: agentId,
        ...agentSchema.parse({
          systemPrompt: 'Use the available evidence.',
          name: 'Reusable',
          providerId,
          connections: [{ connectionId, tools: ['lookup'] }],
          knowledgeBaseIds: [knowledgeBaseId],
        }),
      },
    ],
  } as unknown as Data;
  const upgraded = editableWorkflow(source as unknown as Workflow, data);
  assert.equal(workflowSchema.safeParse(upgraded).success, true);
  assert.equal(upgraded.resources.length, 2);
  assert.equal(upgraded.bindings.length, 2);
  assert.equal(source.nodes.length, 1);
  assert.equal(
    editableWorkflow(upgraded, data).resources.length,
    2,
    'reopening must not duplicate resources',
  );
});
