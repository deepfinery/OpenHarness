import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../../../../packages/core/src/config.js';
import { HttpError, safeError } from '../../../../packages/core/src/security.js';

/** The spec's error envelope: `{ error: { code, message, domain?, operation?, details? } }`. */
export type ErrorBody = {
  error: {
    code: string;
    message: string;
    domain?: string;
    operation?: string;
    details?: Record<string, unknown>;
  };
};
type Extra = { domain?: string; operation?: string; details?: Record<string, unknown> };

export class OhError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Extra = {},
  ) {
    super(message);
  }
}
const codeForStatus: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  501: 'CAPABILITY_NOT_SUPPORTED',
  503: 'HARNESS_UNAVAILABLE',
};
export const notFound = (what: string, extra?: Extra) =>
  new OhError(404, 'NOT_FOUND', `${what} not found`, extra);
export const notSupported = (
  domain: string,
  operation: string,
  message?: string,
  details?: Record<string, unknown>,
) =>
  new OhError(
    501,
    'CAPABILITY_NOT_SUPPORTED',
    message ?? `This harness does not support ${domain} ${operation}`,
    {
      domain,
      operation,
      details: { harness_id: config.OPENHARNESS_HARNESS_ID, ...details },
    },
  );

/** Normalizes anything thrown by a handler (or by shared API code) into the spec's error model. */
export function toOhError(error: unknown): OhError {
  if (error instanceof OhError) return error;
  if (error instanceof z.ZodError)
    return new OhError(400, 'VALIDATION_ERROR', 'The request is invalid', {
      details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  const e = error as { code?: unknown; status?: number; type?: string };
  if (e.type === 'entity.parse.failed')
    return new OhError(400, 'INVALID_JSON', 'The request body is not valid JSON');
  if (e.type === 'entity.too.large')
    return new OhError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
  if (e.code === 11000) return new OhError(409, 'CONFLICT', 'This record already exists');
  if (e.code === 'LIMIT_FILE_SIZE')
    return new OhError(413, 'PAYLOAD_TOO_LARGE', `File exceeds the ${config.MAX_UPLOAD_MB} MB upload limit`);
  if (error instanceof HttpError)
    return new OhError(error.status, codeForStatus[error.status] ?? 'ERROR', safeError(error));
  return new OhError(500, 'INTERNAL_ERROR', 'The harness could not complete the request');
}
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
  const e = toOhError(error);
  if (e.status >= 500 && e.status !== 501 && e.status !== 503)
    console.error('Open Harness request failed:', safeError(error));
  const operation = res.locals.operation as { id: string; domain: string } | undefined;
  const body: ErrorBody = {
    error: {
      code: e.code,
      message: e.message,
      domain: e.extra.domain ?? operation?.domain,
      operation: e.extra.operation ?? operation?.id,
      ...(e.extra.details ? { details: e.extra.details } : {}),
    },
  };
  res.status(e.status).json(body);
};
