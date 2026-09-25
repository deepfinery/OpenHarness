import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../auth.js';
import { OhError } from './errors.js';

/**
 * Callers are studio sessions or bearer API keys. A key with the `harness` scope has full access to its workspace
 * through this API. Older keys are limited to their read/execute scopes and to the workflows they name.
 */
export type Need = 'read' | 'execute' | 'manage';

export const requireAuth = authenticate;
/** Authenticates when credentials are present; otherwise continues anonymously. */
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const hasCredentials =
    req.headers.authorization?.startsWith('Bearer ') || typeof req.cookies?.agentic_session === 'string';
  if (!hasCredentials) return next();
  // Invalid credentials on an optional-auth route are treated as anonymous rather than rejected.
  void authenticate(req, res, () => next());
}
export function requireAccess(req: Request, need: Need, target?: { workflowId?: string }) {
  const principal = req.principal;
  if (!principal) throw new OhError(401, 'UNAUTHORIZED', 'Authentication required');
  const token = principal.token;
  if (!token || token.scopes.includes('harness')) return principal;
  if (need === 'manage' || !token.scopes.includes(need))
    throw new OhError(
      403,
      'INSUFFICIENT_SCOPE',
      `This API key needs the ${need === 'manage' ? 'harness' : need} scope`,
      {
        details: { required_scope: need === 'manage' ? 'harness' : need },
      },
    );
  if (target?.workflowId && !token.workflowIds.includes(target.workflowId))
    throw new OhError(403, 'FORBIDDEN', 'This API key cannot access this agent');
  return principal;
}
