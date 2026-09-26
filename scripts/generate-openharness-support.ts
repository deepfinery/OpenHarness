import { format } from 'prettier';
import { writeFile } from 'node:fs/promises';
// Generating the route registry needs configuration, but opens no network connections.
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.SETUP_TOKEN ??= 'documentation-only-token-never-used';
const { registry } = await import('../apps/api/src/openharness/index.js');
const { specRoutes } = await import('../apps/api/src/openharness/spec.js');
const { openApiDocument } = await import('../apps/api/src/openharness/openapi.js');
const document = openApiDocument(registry);
const lines = [
  '# Open Harness API support',
  '',
  'Generated from the mounted registry and pinned 0.2.0 contract with `npm run generate:openharness-support`. See [API guide](openharness-api.md) and [test evidence](conformance.md). Support means the listed operations are available, subject to these limits; it is not certification.',
  '',
  '| Domain | Operations | Limits |',
  '| --- | --- | --- |',
];
for (const [name, entry] of Object.entries(registry.manifest()))
  lines.push(
    `| ${name} | ${entry.operations.join(', ')} | ${entry.limitations.join('; ') || 'See API guide'} |`,
  );
lines.push(
  '',
  '## Transport coverage',
  '',
  '| Operation | Method and path | Availability |',
  '| --- | --- | --- |',
);
for (const route of specRoutes) {
  const operation = document.paths[route.path][route.method === 'ws' ? 'get' : route.method];
  lines.push(
    `| ${route.id} | \`${route.method.toUpperCase()} ${route.path}\` | ${operation['x-openharness-supported'] ? 'Available' : 'MCP required; direct custom-code registration is unavailable'} |`,
  );
}
lines.push(
  '',
  'Conformance endpoints run read-only protocol diagnostics and report partial status. The pinned behavioral suite and real-stack domain tests run in CI; see the linked test evidence for exclusions.',
  '',
);
await writeFile('docs/openharness-support.md', await format(lines.join('\n'), { parser: 'markdown' }));
