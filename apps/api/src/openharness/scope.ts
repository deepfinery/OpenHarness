import type { Request } from 'express';
import { config } from '../../../../packages/core/src/config.js';
import { collection } from '../../../../packages/core/src/db.js';
import type { Stored, Workflow } from '../../../../packages/core/src/schema.js';
import { notFound } from './errors.js';
declare global {
  namespace Express {
    interface Request {
      harness?: Stored<Workflow>;
    }
  }
}
export function harnessId(req: Request) {
  return String(req.params.harnessId ?? config.OPENHARNESS_HARNESS_ID);
}
export async function resolveHarness(req: Request) {
  const id = req.params.harnessId;
  if (id === undefined || id === config.OPENHARNESS_HARNESS_ID) return;
  const row = await collection<Stored<Workflow>>('workflows').findOne({
    _id: String(id),
    ownerId: req.principal?.tenantId,
  });
  if (!row) throw notFound('Harness');
  const token = req.principal?.token;
  if (token && !token.scopes.includes('harness') && !token.workflowIds.includes(row._id))
    throw notFound('Harness');
  req.harness = row;
}
