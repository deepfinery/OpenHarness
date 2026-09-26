import contract from './contract.json' with { type: 'json' };
import { config } from '../../../../packages/core/src/config.js';
import { specRoutes, specVersion } from './spec.js';
import type { OperationRegistry } from './operations.js';
export function openApiDocument(registry: OperationRegistry) {
  const paths: Record<string, any> = {};
  for (const r of specRoutes) {
    const c = (contract.operations as Record<string, any>)[r.id] ?? {};
    const input = (contract.schemas as Record<string, any>)[c.input] ?? {};
    const properties = { ...input.properties };
    const parameters: any[] = [];
    for (const [, name] of r.path.matchAll(/\{(\w+)\}/g)) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: name === 'harnessId' ? 'Harness ID from GET /harnesses' : '',
      });
      delete properties[name];
    }
    const query = ['get', 'delete'].includes(r.method);
    if (query)
      for (const [name, schema] of Object.entries(properties))
        parameters.push({ name, in: 'query', required: (input.required ?? []).includes(name), schema });
    const method = r.method === 'ws' ? 'get' : r.method;
    const successCode =
      r.method === 'ws'
        ? '101'
        : r.method === 'delete'
          ? '204'
          : ['execution.run', 'conformance.run'].includes(r.id)
            ? '202'
            : [
                  'harnesses.register',
                  'agents.create',
                  'agents.import',
                  'agents.clone',
                  'skills.register',
                  'sessions.create',
                  'sessions.fork',
                  'subagents.spawn',
                  'mcp.connect',
                  'memory.createBlock',
                  'memory.archive',
                  'hooks.register',
                  'hooks.createWebhook',
                ].includes(r.id)
              ? '201'
              : '200';
    (paths[r.path] ??= {})[method] = {
      operationId: r.id,
      tags: [r.id.split('.')[0]],
      summary: c.summary ?? r.id,
      description:
        (c.description ?? '') +
        (r.method === 'ws'
          ? ' WebSocket upgrade required.'
          : r.sse
            ? ' Returns a Server-Sent Events stream.'
            : ''),
      parameters,
      security:
        r.id === 'harnesses.health' ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }, { studioSession: [] }],
      ...(!query && r.method !== 'ws' && (Object.keys(properties).length || r.id === 'files.write')
        ? {
            requestBody: {
              required: true,
              content: {
                [c.multipart
                  ? 'multipart/form-data'
                  : r.id === 'files.write'
                    ? 'application/octet-stream'
                    : 'application/json']: {
                  schema:
                    r.id === 'files.write'
                      ? { type: 'string', format: 'binary' }
                      : {
                          type: 'object',
                          properties,
                          required: (input.required ?? []).filter((n: string) => n in properties),
                        },
                },
              },
            },
          }
        : {}),
      responses: {
        [successCode]: {
          description: successCode === '101' ? 'WebSocket upgrade' : 'Success',
          ...(['101', '204'].includes(successCode)
            ? {}
            : {
                content: {
                  [r.sse ? 'text/event-stream' : c.binary ? 'application/octet-stream' : 'application/json']:
                    {
                      schema: c.output ? { $ref: `#/components/schemas/${c.output}` } : {},
                    },
                },
              }),
        },
        '400': { description: 'Invalid request' },
        '401': { description: 'Authentication required' },
        '403': { description: 'Insufficient scope' },
        '404': { description: 'Resource not found' },
        '409': { description: 'Conflict' },
        '501': { description: 'Operation or requested capability not supported' },
      },
      'x-openharness-supported':
        (registry.has(r.id) && !['tools.register', 'tools.unregister'].includes(r.id)) || r.method === 'ws',
      ...(r.method === 'ws' ? { 'x-websocket': true } : {}),
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'OpenHarness API',
      version: specVersion,
      description:
        'Harnesses contain agents. Authenticate with a workspace API key or the studio session. Consult capability limitations before using an operation.',
    },
    servers: [{ url: config.OPENHARNESS_BASE_PATH }],
    tags: [...new Set(specRoutes.map((r) => r.id.split('.')[0]))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        studioSession: { type: 'apiKey', in: 'cookie', name: 'agentic_session' },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Workspace API key (oh_sk_…) from Integrations',
        },
      },
      schemas: contract.schemas,
    },
    'x-openharness-capabilities': registry.manifest(),
  };
}
