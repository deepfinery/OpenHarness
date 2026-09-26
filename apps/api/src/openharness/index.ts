import { diagnosticOperations } from './diagnostics.js';
import { openApiDocument } from './openapi.js';
import { subagentOperations } from './subagents.js';
import { planningOperations } from './planning.js';
import { memoryOperations } from './memory.js';
import { sessionOperations } from './sessions.js';
import { scopedAgentOperation } from './harnessAgents.js';
import { raw, Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../../../../packages/core/src/config.js';
import { optionalAuth, requireAuth } from './access.js';
import { errorHandler, notFound, OhError } from './errors.js';
import { agentOperations } from './agents.js';
import { executionOperations } from './execution.js';
import { harnessOperations } from './harness.js';
import { hookOperations } from './hooks.js';
import { OperationRegistry } from './operations.js';
import { fileOperations } from './files.js';
import { skillOperations } from './skills.js';
import { mcpOperations } from './mcp.js';
import { toolOperations } from './tools.js';

/**
 * The Open Harness API adapter (https://github.com/jeffrschneider/OpenHarness). It is mounted at
 * OPENHARNESS_BASE_PATH (default /openharness/v1) and translates the spec's routes onto the studio's own
 * workflows, runs, conversations and resources. The studio's /api routes are unchanged.
 */
export function openHarnessRegistry() {
  const registry = new OperationRegistry();
  registry.register(
    ...harnessOperations(registry),
    ...agentOperations(registry).map(scopedAgentOperation),
    ...toolOperations(registry),
    ...executionOperations(registry),
    ...hookOperations(registry),
    ...skillOperations(registry),
    ...fileOperations(registry),
    ...sessionOperations(registry),
    ...memoryOperations(registry),
    ...planningOperations(registry),
    ...subagentOperations(registry),
    ...diagnosticOperations(registry),
    ...mcpOperations(registry),
  );
  return registry;
}
export const registry = openHarnessRegistry();

function transport(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  const bearer = req.headers.authorization?.startsWith('Bearer ');
  const preflight =
    req.method === 'OPTIONS' &&
    req.headers['access-control-request-headers']?.toLowerCase().includes('authorization');
  // Cross-origin calls are allowed only with bearer keys, never with the studio cookie.
  if (origin && (bearer || preflight)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Accept, Idempotency-Key, Last-Event-ID',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !bearer) {
    if (origin && origin !== new URL(config.PUBLIC_URL).origin)
      return next(new OhError(403, 'FORBIDDEN', 'Request origin is not allowed'));
    if (req.cookies?.agentic_session && !origin)
      return next(new OhError(403, 'FORBIDDEN', 'A studio session write requires an Origin header'));
  }
  if (
    ['POST', 'PUT', 'PATCH'].includes(req.method) &&
    Number(req.headers['content-length'] ?? 0) > 0 &&
    !req.is('application/json') &&
    !req.is('multipart/form-data') &&
    !(req.method === 'PUT' && /\/files\//.test(req.path))
  )
    return next(new OhError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json'));
  next();
}
export function openHarnessApi() {
  const router = Router();
  router.use(transport);
  router.get('/openapi.json', requireAuth, (_req, res) => res.json(openApiDocument(registry)));
  router.use('/harnesses/:harnessId/files', (req, res, next) =>
    req.method === 'PUT' ? raw({ type: () => true, limit: '10mb' })(req, res, next) : next(),
  );
  router.use(registry.router({ required: requireAuth, optional: optionalAuth }));
  router.use((_req, _res, next) => next(notFound('Endpoint')));
  return router;
}
/** Mount after the body parser so parse failures use the spec's error envelope too. */
export const openHarnessErrors = errorHandler;
