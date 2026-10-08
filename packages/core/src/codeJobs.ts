import { config } from './config.js';
import { collection } from './db.js';
import { stableId } from './human.js';
import { effectiveLimit, unlimited } from './limits.js';
import { workspaceJobMongoUri } from './mongoMcp.js';
import { resolveSecrets } from './executorSecrets.js';
import { hash, randomToken, safeError, safeFetch } from './security.js';
import {
  createJob,
  deleteJob,
  getJob,
  jobPods,
  ownNamespace,
  ownPodContainerImage,
  podLogs,
  inCluster,
} from './kubernetes.js';

/**
 * Python jobs: code an agent or a harness step submits runs in a fresh container of the python-executor image.
 * The container fetches its job from the API with a one-time token, runs the code beside the `oh` helpers, and
 * posts the outcome back; the runner waits on the job record. Kubernetes runs each job as a Job; without a
 * cluster, the python-executor HTTP service runs it as a child process.
 */
export type CodeJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type CodeJobSpec = {
  code: string;
  params?: Record<string, unknown>;
  timeoutSeconds?: number;
  /** A few words on what the code does, for the trace and approvals. */
  purpose?: string;
  /** Names of Python secrets the job receives as environment variables. */
  secrets?: string[];
};
export type CodeJobOutcome = {
  id: string;
  status: CodeJobStatus;
  exitCode?: number;
  error?: string;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  result?: unknown;
  durationMs?: number;
};
export type CodeJobRecord = CodeJobSpec &
  Omit<CodeJobOutcome, 'status' | 'id'> & {
    _id: string;
    ownerId: string;
    runId: string;
    nodeId?: string;
    key: string;
    status: CodeJobStatus;
    timeoutSeconds: number;
    tokenHash: string;
    backend: 'kubernetes' | 'service';
    externalName?: string;
    createdAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
    updatedAt: Date;
  };
const jobs = () => collection<CodeJobRecord>('code_jobs');
/** Seconds a job may take to start and report back beyond its own timeout before the runner gives up on it. */
const LAUNCH_GRACE_SECONDS = 300;
const POLL_MS = 1500;
const OUTPUT_LIMIT = 200_000;
const RESULT_LIMIT = 1_000_000;

export const executorConfigured = () => config.EXECUTOR_BACKEND !== '';
export function executorUnavailableReason() {
  if (!executorConfigured()) return 'This installation has no Python executor (EXECUTOR_BACKEND is not set)';
  if (config.EXECUTOR_BACKEND === 'kubernetes' && !inCluster())
    return 'EXECUTOR_BACKEND is kubernetes but this process is not running in a cluster';
  if (config.EXECUTOR_BACKEND === 'service' && !(config.EXECUTOR_URL && config.EXECUTOR_TOKEN))
    return 'EXECUTOR_BACKEND is service but EXECUTOR_URL or EXECUTOR_TOKEN is not set';
  return undefined;
}
/** The timeout a job runs with: the request, capped by the installation maximum (0 = no maximum). */
export function jobTimeoutSeconds(requested: number | undefined) {
  const seconds =
    requested && requested > 0 ? Math.floor(requested) : config.EXECUTOR_DEFAULT_TIMEOUT_SECONDS;
  const max = effectiveLimit(config.EXECUTOR_MAX_TIMEOUT_SECONDS, 0);
  return unlimited(max) ? seconds : Math.min(seconds, max);
}
const jobName = (id: string) => `oh-py-${id.replace(/-/g, '').slice(0, 20)}`;
const callbackUrl = (id: string) =>
  `${config.EXECUTOR_CALLBACK_URL.replace(/\/$/, '')}/api/executor/jobs/${id}`;

export type CodeJobContext = {
  ownerId: string;
  runId: string;
  nodeId?: string;
  /** Stable per call within the run, so a resumed run finds the job it already started. */
  key: string;
  signal: AbortSignal;
};
/** Runs the code and waits for its outcome. A resumed run reattaches to the job it started earlier. */
export async function runCodeJob(ctx: CodeJobContext, spec: CodeJobSpec): Promise<CodeJobOutcome> {
  const unavailable = executorUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  const _id = stableId(`${ctx.runId}:code:${ctx.key}`);
  let record: CodeJobRecord | null = await jobs().findOne({ _id, ownerId: ctx.ownerId });
  if (record && ['succeeded', 'failed', 'cancelled'].includes(record.status)) return outcomeOf(record);
  if (!record) {
    // Fail early and clearly when a listed secret is missing, before anything is started.
    await resolveSecrets(ctx.ownerId, spec.secrets);
    await waitForCapacity(ctx);
    const token = randomToken();
    const now = new Date();
    record = {
      _id,
      ownerId: ctx.ownerId,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      key: ctx.key,
      status: 'queued',
      code: spec.code,
      params: spec.params ?? {},
      purpose: spec.purpose,
      secrets: spec.secrets ?? [],
      timeoutSeconds: jobTimeoutSeconds(spec.timeoutSeconds),
      tokenHash: hash(token),
      backend: config.EXECUTOR_BACKEND as 'kubernetes' | 'service',
      stdout: '',
      stderr: '',
      createdAt: now,
      updatedAt: now,
    };
    await jobs().insertOne(record);
    const created: CodeJobRecord = record;
    try {
      created.externalName = await launch(created, token);
      await jobs().updateOne(
        { _id },
        { $set: { externalName: created.externalName, updatedAt: new Date() } },
      );
    } catch (error) {
      const message = `The executor could not start this job: ${safeError(error)}`;
      await finish(_id, { status: 'failed', error: message });
      return outcomeOf((await jobs().findOne({ _id })) as CodeJobRecord);
    }
  }
  return await waitForJob(record as CodeJobRecord, ctx.signal);
}
/** Holds a new job until the workspace has fewer than EXECUTOR_MAX_PARALLEL jobs in flight (0 = no limit). */
async function waitForCapacity(ctx: CodeJobContext) {
  const limit = config.EXECUTOR_MAX_PARALLEL;
  if (!limit) return;
  for (;;) {
    ctx.signal.throwIfAborted();
    const active = await jobs().countDocuments({
      ownerId: ctx.ownerId,
      status: { $in: ['queued', 'running'] },
    });
    if (active < limit) return;
    await sleep(POLL_MS, ctx.signal);
  }
}
async function launch(record: CodeJobRecord, token: string) {
  const env = [
    { name: 'OH_JOB_URL', value: callbackUrl(record._id) },
    { name: 'OH_JOB_TOKEN', value: token },
  ];
  if (record.backend === 'service') {
    const response = await safeFetch(`${config.EXECUTOR_URL.replace(/\/$/, '')}/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.EXECUTOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: record._id, jobUrl: env[0].value, jobToken: token }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`python-executor answered ${response.status}: ${await response.text()}`);
    return record._id;
  }
  const namespace = config.EXECUTOR_NAMESPACE || (await ownNamespace());
  const image = await executorImage();
  const name = jobName(record._id);
  await createJob(namespace, {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      labels: {
        'app.kubernetes.io/name': 'python-job',
        'app.kubernetes.io/part-of': 'openharness',
        'openharness.io/workspace': record.ownerId,
        'openharness.io/run': record.runId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: config.EXECUTOR_JOB_TTL_SECONDS,
      activeDeadlineSeconds: record.timeoutSeconds + LAUNCH_GRACE_SECONDS,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'python-job',
            'app.kubernetes.io/part-of': 'openharness',
            'openharness.io/workspace': record.ownerId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'python',
              image,
              command: ['python', '/opt/executor/runner.py'],
              env,
              resources: {
                requests: { cpu: config.EXECUTOR_JOB_CPU, memory: config.EXECUTOR_JOB_MEMORY },
                limits: { memory: config.EXECUTOR_JOB_MEMORY },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
                readOnlyRootFilesystem: true,
              },
              volumeMounts: [
                { name: 'work', mountPath: '/work' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'work', emptyDir: { sizeLimit: config.EXECUTOR_JOB_DISK } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  });
  return name;
}
let cachedImage: string | undefined;
/** The executor image: EXECUTOR_IMAGE, or the digest-pinned `executor-image` init container of this pod. */
async function executorImage() {
  if (config.EXECUTOR_IMAGE) return config.EXECUTOR_IMAGE;
  cachedImage ??= await ownPodContainerImage('executor-image');
  if (!cachedImage)
    throw new Error('Set EXECUTOR_IMAGE, or give the app pod an init container named executor-image');
  return cachedImage;
}
async function waitForJob(record: CodeJobRecord, signal: AbortSignal): Promise<CodeJobOutcome> {
  const deadline = record.createdAt.getTime() + (record.timeoutSeconds + LAUNCH_GRACE_SECONDS) * 1000;
  try {
    for (;;) {
      signal.throwIfAborted();
      const current = (await jobs().findOne({ _id: record._id })) as CodeJobRecord;
      if (['succeeded', 'failed', 'cancelled'].includes(current.status)) return outcomeOf(current);
      if (Date.now() > deadline) {
        const detail = await diagnose(current).catch(() => undefined);
        await finish(record._id, {
          status: 'failed',
          error: `The job did not report back within ${record.timeoutSeconds} s plus the launch allowance${detail ? `: ${detail}` : ''}`,
        });
        await cancelBackend(current).catch(() => {});
        return outcomeOf((await jobs().findOne({ _id: record._id })) as CodeJobRecord);
      }
      await sleep(POLL_MS, signal);
    }
  } catch (error) {
    if (signal.aborted) {
      const current = await jobs().findOne({ _id: record._id });
      if (current && !['succeeded', 'failed', 'cancelled'].includes(current.status)) {
        await finish(record._id, { status: 'cancelled', error: 'The run was cancelled or interrupted' });
        await cancelBackend(current).catch(() => {});
      }
    }
    throw error;
  }
}
/** Why a Kubernetes job never reported: image pull failures, OOM kills, scheduling problems, pod logs. */
async function diagnose(record: CodeJobRecord) {
  if (record.backend !== 'kubernetes' || !record.externalName) return undefined;
  const namespace = config.EXECUTOR_NAMESPACE || (await ownNamespace());
  const [job, pods] = await Promise.all([
    getJob(namespace, record.externalName).catch(() => undefined),
    jobPods(namespace, record.externalName).catch(() => []),
  ]);
  const parts: string[] = [];
  const condition = job?.status?.conditions?.find((c) => c.status === 'True');
  if (condition) parts.push(`${condition.type}${condition.reason ? ` (${condition.reason})` : ''}`);
  for (const pod of pods) {
    parts.push(
      `pod ${pod.phase ?? 'unknown'}${pod.reason ? ` ${pod.reason}` : ''}${pod.message ? `: ${pod.message.slice(0, 200)}` : ''}`,
    );
    if (pod.phase === 'Failed' || pod.reason === 'OOMKilled') {
      const logs = await podLogs(namespace, pod.name, 20).catch(() => '');
      if (logs.trim()) parts.push(`last log lines: ${logs.trim().slice(-800)}`);
    }
  }
  return parts.join('; ') || undefined;
}
async function cancelBackend(record: CodeJobRecord) {
  if (record.backend === 'kubernetes' && record.externalName)
    await deleteJob(config.EXECUTOR_NAMESPACE || (await ownNamespace()), record.externalName);
}
export async function finish(id: string, update: Partial<CodeJobOutcome> & { status: CodeJobStatus }) {
  const now = new Date();
  const { status, ...rest } = update;
  await jobs().updateOne(
    { _id: id, status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status,
        ...rest,
        ...(rest.stdout !== undefined ? { stdout: rest.stdout.slice(-OUTPUT_LIMIT) } : {}),
        ...(rest.stderr !== undefined ? { stderr: rest.stderr.slice(-OUTPUT_LIMIT) } : {}),
        finishedAt: now,
        updatedAt: now,
      },
    },
  );
}
export function outcomeOf(record: CodeJobRecord): CodeJobOutcome {
  return {
    id: record._id,
    status: record.status,
    exitCode: record.exitCode,
    error: record.error,
    stdout: record.stdout ?? '',
    stderr: record.stderr ?? '',
    truncated: record.truncated,
    result: record.result,
    durationMs: record.durationMs,
  };
}

/** The executor's view of a job, served to the container that presents the job's token. */
export async function claimJob(id: string, token: string) {
  const record = await jobs().findOne({ _id: id });
  if (!record || record.tokenHash !== hash(token) || !['queued', 'running'].includes(record.status))
    return undefined;
  return {
    id: record._id,
    code: record.code,
    params: record.params ?? {},
    timeoutSeconds: record.timeoutSeconds,
    mongodbUri: await workspaceJobMongoUri(record.ownerId),
    env: await resolveSecrets(record.ownerId, record.secrets),
  };
}
/** A status report from the container: `running` when it starts, then the outcome. */
export async function reportJob(id: string, token: string, report: Record<string, unknown>) {
  const record = await jobs().findOne({ _id: id });
  if (!record || record.tokenHash !== hash(token)) return false;
  if (report.status === 'running') {
    await jobs().updateOne(
      { _id: id, status: 'queued' },
      { $set: { status: 'running', startedAt: new Date(), updatedAt: new Date() } },
    );
    return true;
  }
  if (report.status !== 'succeeded' && report.status !== 'failed') return false;
  const resultText = report.result === undefined ? '' : JSON.stringify(report.result);
  const oversized = resultText.length > RESULT_LIMIT;
  await finish(id, {
    status: oversized ? 'failed' : report.status,
    exitCode: typeof report.exitCode === 'number' ? report.exitCode : undefined,
    error: oversized
      ? `oh.result() value exceeds ${RESULT_LIMIT} bytes`
      : typeof report.error === 'string'
        ? report.error.slice(0, 2000)
        : undefined,
    stdout: typeof report.stdout === 'string' ? report.stdout : '',
    stderr: typeof report.stderr === 'string' ? report.stderr : '',
    truncated: Boolean(report.truncated),
    result: oversized ? undefined : report.result,
    durationMs: typeof report.durationMs === 'number' ? report.durationMs : undefined,
  });
  return true;
}
/** Jobs of a run, newest first, without their code: the trace shows what ran; this shows how it went. */
export const runJobs = (ownerId: string, runId: string) =>
  jobs()
    .find({ ownerId, runId }, { projection: { code: 0, tokenHash: 0 } })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
