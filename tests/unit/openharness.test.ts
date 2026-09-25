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
