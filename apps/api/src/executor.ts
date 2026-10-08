import { Router } from 'express';
import { z } from 'zod';
import { claimJob, reportJob, runJobs } from '../../../packages/core/src/codeJobs.js';
import {
  deleteSecret,
  importSecret,
  listSecrets,
  setSecret,
} from '../../../packages/core/src/executorSecrets.js';
import { HttpError } from '../../../packages/core/src/security.js';

/**
 * The Python executor's side of a job. A container presents the job's one-time bearer token: it fetches the code,
 * parameters and its workspace-scoped MongoDB connection string, then posts `running` and finally the outcome. No
 * session is involved, and the token is only ever valid for that one job.
 */
export const executorJobs = Router();
const jobId = z.string().uuid();
const report = z.object({
  status: z.enum(['running', 'succeeded', 'failed']),
  exitCode: z.number().int().optional(),
  error: z.string().max(4000).nullish(),
  stdout: z.string().max(400_000).optional(),
  stderr: z.string().max(400_000).optional(),
  truncated: z.boolean().optional(),
  result: z.unknown().optional(),
  durationMs: z.number().int().min(0).optional(),
});
function token(header: string | undefined) {
  const match = /^Bearer\s+(\S+)$/.exec(header ?? '');
  if (!match) throw new HttpError(401, 'A job token is required');
  return match[1];
}
executorJobs.get('/:id', async (req, res) => {
  const job = await claimJob(jobId.parse(req.params.id), token(req.headers.authorization));
  if (!job) throw new HttpError(404, 'Unknown job or token');
  res.json(job);
});
executorJobs.post('/:id', async (req, res) => {
  const body = report.parse(req.body);
  const accepted = await reportJob(jobId.parse(req.params.id), token(req.headers.authorization), {
    ...body,
    error: body.error ?? undefined,
  });
  if (!accepted) throw new HttpError(404, 'Unknown job or token');
  res.status(204).end();
});

/** Studio: the Python jobs of a run, without their code. */
export const codeJobsApi = Router();
codeJobsApi.get('/runs/:id/jobs', async (req, res) => {
  res.json(
    (await runJobs(req.principal!.tenantId, String(req.params.id))).map(({ _id, ...job }) => ({
      id: _id,
      ...job,
    })),
  );
});

/** Python secrets: names are listed; values are written (typed, or copied from an MCP connection), never read. */
const secretBody = z.union([
  z.object({ value: z.string().min(1).max(16384) }),
  z.object({
    connectionId: z.string().uuid(),
    queryParam: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .optional(),
  }),
]);
codeJobsApi.get('/executor/secrets', async (req, res) => {
  res.json(await listSecrets(req.principal!.tenantId));
});
codeJobsApi.put('/executor/secrets/:name', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can change secrets');
  const body = secretBody.parse(req.body);
  const name = String(req.params.name);
  if ('value' in body) await setSecret(req.principal!.tenantId, name, body.value, req.principal!.user._id);
  else
    await importSecret(
      req.principal!.tenantId,
      name,
      body.connectionId,
      body.queryParam,
      req.principal!.user._id,
    );
  res.json((await listSecrets(req.principal!.tenantId)).find((s) => s.name === name));
});
codeJobsApi.delete('/executor/secrets/:name', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can change secrets');
  await deleteSecret(req.principal!.tenantId, String(req.params.name));
  res.status(204).end();
});
