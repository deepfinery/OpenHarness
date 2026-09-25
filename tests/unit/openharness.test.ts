import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'unit-test-setup-token'.repeat(3);
const { OperationRegistry, expressPath, manifestDomains, pageOf, pageQuery } =
  await import('../../apps/api/src/openharness/operations.js');
const { specRoutes } = await import('../../apps/api/src/openharness/spec.js');
const { toOhError, notSupported } = await import('../../apps/api/src/openharness/errors.js');
const { z } = await import('zod');

test('the pinned spec table has unique operation ids and HTTP paths under /harnesses', () => {
  const ids = specRoutes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of specRoutes) assert.match(r.path, /^\/harnesses/);
  assert.ok(
    specRoutes.some(
      (r) => r.id === 'execution.run' && r.method === 'post' && r.path === '/harnesses/{harnessId}/execute',
    ),
  );
});

test('spec paths translate to Express paths, including the multi-segment file path', () => {
  assert.equal(
    expressPath('/harnesses/{harnessId}/agents/{agentId}'),
    '/harnesses/:harnessId/agents/:agentId',
  );
  assert.equal(
    expressPath('/harnesses/{harnessId}/files/{path}/download'),
    '/harnesses/:harnessId/files/*path/download',
  );
});

test('the registry refuses unknown or duplicate operations', () => {
  const registry = new OperationRegistry();
  assert.throws(() => registry.register({ id: 'agents.teleport', handler: () => null }), /Unknown/);
  registry.register({ id: 'agents.list', handler: () => null });
  assert.throws(() => registry.register({ id: 'agents.list', handler: () => null }), /twice/);
});

test('the manifest reports a domain as supported only when a route or declaration provides it', () => {
  const empty = new OperationRegistry().manifest();
  assert.deepEqual(Object.keys(empty), [...manifestDomains]);
  for (const domain of manifestDomains) {
    assert.equal(empty[domain].supported, false);
    assert.deepEqual(empty[domain].operations, []);
    assert.deepEqual(empty[domain].limitations, ['Not implemented yet']);
  }
  const registry = new OperationRegistry()
    .register(
      { id: 'execution.run', handler: () => null, provides: { domain: 'execution', operations: ['sync'] } },
      {
        id: 'execution.stream',
        handler: () => null,
        provides: { domain: 'execution', operations: ['stream'] },
      },
      { id: 'execution.list', handler: () => null },
    )
    .declare('models', { operations: ['multi-model'], limitations: ['No runtime switch'] })
    .declare('memory', { limitations: ['Planned'] });
  const manifest = registry.manifest();
  assert.deepEqual(manifest.execution, { supported: true, operations: ['sync', 'stream'], limitations: [] });
  assert.deepEqual(manifest.models, {
    supported: true,
    operations: ['multi-model'],
    limitations: ['No runtime switch'],
  });
  assert.deepEqual(manifest.memory, { supported: false, operations: [], limitations: ['Planned'] });
});

test('the router mounts every HTTP route of the spec, with wildcard file routes last', () => {
  const router = new OperationRegistry().router({
    required: (_q, _s, n) => n(),
    optional: (_q, _s, n) => n(),
  });
  const mounted = (router.stack as any[]).filter((layer) => layer.route);
  const http = specRoutes.filter((r) => r.method !== 'ws');
  assert.equal(mounted.length, http.length);
  const paths = mounted.map((layer) => layer.route.path as string);
  const firstWildcard = paths.findIndex((p) => p.includes('*path'));
  assert.ok(paths.slice(firstWildcard).every((p) => p.includes('*path')));
  assert.equal(paths[firstWildcard], '/harnesses/:harnessId/files/*path/download');
});

test('pagination follows the spec: limit 1-100 defaulting to 20, offset from 0', () => {
  assert.deepEqual(pageQuery.parse({}), { limit: 20, offset: 0 });
  assert.throws(() => pageQuery.parse({ limit: '0' }));
  assert.throws(() => pageQuery.parse({ limit: '101' }));
  const items = Array.from({ length: 5 }, (_, i) => i);
  assert.deepEqual(pageOf(items, { limit: 2, offset: 2 }), {
    data: [2, 3],
    total: 5,
    limit: 2,
    offset: 2,
    has_more: true,
  });
  assert.deepEqual(pageOf(items, { limit: 2, offset: 4 }), {
    data: [4],
    total: 5,
    limit: 2,
    offset: 4,
    has_more: false,
  });
});

test('errors map onto the spec envelope codes', () => {
  assert.equal(toOhError(z.object({ a: z.string() }).safeParse({}).error).code, 'VALIDATION_ERROR');
  assert.equal(
    toOhError(Object.assign(new Error('x'), { type: 'entity.parse.failed' })).code,
    'INVALID_JSON',
  );
  assert.equal(toOhError(Object.assign(new Error('dup'), { code: 11000 })).status, 409);
  const unsupported = notSupported('memory', 'memory.get');
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.extra.domain, 'memory');
  const internal = toOhError(new Error('database password is hunter2'));
  assert.equal(internal.status, 500);
  assert.doesNotMatch(internal.message, /hunter2/);
});

const { EventTranslator, closingEvents, executionStatus, runStatusesFor, unsentOutput } =
  await import('../../apps/api/src/openharness/events.js');
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const workflowRun = {
  snapshot: {
    agents: {},
    workflow: {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'agent', type: 'agent' },
        { id: 'finish', type: 'finish' },
      ],
    },
  },
} as any;

test('run states map onto spec execution states and back', () => {
  assert.equal(executionStatus('queued'), 'pending');
  assert.equal(executionStatus('succeeded'), 'completed');
  assert.equal(executionStatus('interrupted'), 'failed');
  assert.deepEqual(runStatusesFor('failed').sort(), ['failed', 'interrupted']);
});

test('the translator pairs tool calls with results, sums usage and tracks step progress', () => {
  const t = new EventTranslator(workflowRun);
  const events = [
    { at: at(0), type: 'node_started', nodeId: 'start', message: 'Start' },
    { at: at(0), type: 'node_completed', nodeId: 'start', message: 'Start' },
    { at: at(1), type: 'node_started', nodeId: 'agent', message: 'Assistant' },
    { at: at(2), type: 'model', nodeId: 'agent', message: 'turn', data: { usage: { input: 10, output: 5 } } },
    {
      at: at(2),
      type: 'tool_started',
      nodeId: 'agent',
      message: 'Tools / lookup',
      data: { callId: 'c1', tool: 'lookup', arguments: '{"query":"x"}' },
    },
    {
      at: at(4),
      type: 'tool_completed',
      nodeId: 'agent',
      message: 'Tools / lookup',
      data: { callId: 'c1', result: 'found' },
    },
    { at: at(5), type: 'model', nodeId: 'agent', message: 'turn', data: { usage: { input: 20, output: 7 } } },
    { at: at(6), type: 'node_completed', nodeId: 'agent', message: 'Assistant' },
  ];
  const out = events.flatMap((e, i) => t.translate(e, i));
  assert.deepEqual(
    out.map((e) => e.type),
    ['progress', 'tool_call_start', 'tool_call_end', 'tool_result', 'progress'],
  );
  assert.deepEqual(out[1], { type: 'tool_call_start', id: 'c1', name: 'lookup', input: { query: 'x' } });
  assert.deepEqual(out[3], { type: 'tool_result', id: 'c1', success: true, output: { content: 'found' } });
  assert.equal(out[0].total_steps, 2);
  assert.equal(out[4].percentage, 50);
  assert.deepEqual(t.usage, { input_tokens: 30, output_tokens: 12, total_tokens: 42 });
  const call = t.calls.get('c1')!;
  assert.equal(call.status, 'completed');
  assert.equal(call.duration_ms, 2000);
});

test('older tool events without call ids are paired in order', () => {
  const t = new EventTranslator({ snapshot: { agents: {} } } as any);
  const out = [
    { at: at(0), type: 'tool_started', message: 'A', data: { arguments: 'not json' } },
    { at: at(1), type: 'tool_error', message: 'A', data: { result: 'boom' } },
  ].flatMap((e, i) => t.translate(e, i));
  assert.equal(out[0].id, 'call_0');
  assert.deepEqual(out[0].input, { value: 'not json' });
  assert.deepEqual(out[2], {
    type: 'tool_result',
    id: 'call_0',
    success: false,
    output: { content: 'boom' },
  });
  assert.equal(t.calls.get('call_0')!.error, 'boom');
});

test('replaying the same log yields the same events, so streams can resume', () => {
  const log = [
    { at: at(0), type: 'node_started', nodeId: 'agent', message: 'Assistant' },
    {
      at: at(1),
      type: 'tool_started',
      nodeId: 'agent',
      message: 'x',
      data: { callId: 'c', tool: 't', arguments: '{}' },
    },
    { at: at(2), type: 'tool_completed', nodeId: 'agent', message: 'x', data: { callId: 'c', result: 'r' } },
  ];
  const a = new EventTranslator(workflowRun);
  const b = new EventTranslator(workflowRun);
  assert.deepEqual(
    log.flatMap((e, i) => a.translate(e, i)),
    log.flatMap((e, i) => b.translate(e, i)),
  );
});

test('streams close with an error for unsuccessful runs and always exactly one done', () => {
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  assert.deepEqual(
    closingEvents({ _id: 'r', status: 'succeeded' } as any, usage).map((e) => e.type),
    ['done'],
  );
  const failed = closingEvents({ _id: 'r', status: 'failed', error: 'Provider down' } as any, usage);
  assert.deepEqual(
    failed.map((e) => e.type),
    ['error', 'done'],
  );
  assert.equal(failed[0].code, 'EXECUTION_FAILED');
  assert.equal(failed[0].message, 'Provider down');
  assert.equal(closingEvents({ _id: 'r', status: 'cancelled' } as any, usage)[0].code, 'EXECUTION_CANCELLED');
});

test('the rest of the final answer is sent once, whatever was already streamed', () => {
  assert.equal(unsentOutput('Hello world', '', 0), 'Hello world');
  assert.equal(unsentOutput('Hello world', 'Hello ', 6), 'world');
  assert.equal(unsentOutput('Hello world', 'Hello world', 11), '');
  // A workflow template can differ from the streamed agent text: the answer is sent whole.
  assert.equal(unsentOutput('Total: 12', 'thinking about sums', 19), 'Total: 12');
  // After a resume only the streamed length is known.
  assert.equal(unsentOutput('Hello world', undefined, 6), 'world');
});
