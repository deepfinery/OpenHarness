import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { config } from '../../../packages/core/src/config.js';
import { collection, connectDatabase, mongo } from '../../../packages/core/src/db.js';
import { closeQueue, JOB_QUEUE, queueChannel, type Job } from '../../../packages/core/src/queue.js';
import { executeRun, type DeltaWriter } from '../../../packages/core/src/runtime.js';
import { deleteDocument, indexDocument } from '../../../packages/core/src/knowledge.js';
import { safeError } from '../../../packages/core/src/security.js';
import type { KnowledgeDocument, Run } from '../../../packages/core/src/schema.js';
import { settleConversation } from '../../../packages/core/src/conversations.js';

await connectDatabase();
const channel = await queueChannel();
await channel.prefetch(config.WORKER_CONCURRENCY);
let stopping = false;
const active = new Set<AbortController>();
const tasks = new Set<Promise<void>>();
channel.on('close', () => {
  if (!stopping) {
    active.forEach((c) => c.abort(new Error('Queue connection lost')));
    setTimeout(() => process.exit(1), 2000).unref();
  }
});
async function processJob(job: Job, controller: AbortController) {
  const leaseId = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(Date.now() + 30000);
  if (job.kind === 'run') {
    const runs = collection<Run>('runs');
    const run = await runs.findOneAndUpdate(
      { _id: job.id, status: 'queued', cancelRequested: { $ne: true } },
      { $set: { status: 'running', leaseId, leaseUntil, startedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!run) return;
    const filter = { _id: run._id, status: 'running' as const, leaseId };
    let beating = false;
    const timer = setInterval(async () => {
      if (beating) return;
      beating = true;
      try {
        const current = await runs.findOneAndUpdate(
          { ...filter, cancelRequested: { $ne: true } },
          { $set: { leaseUntil: new Date(Date.now() + 30000) } },
          { returnDocument: 'after' },
        );
        if (!current) controller.abort(new Error('Run cancelled or lease lost'));
      } catch {
        controller.abort(new Error('Database connection lost'));
      } finally {
        beating = false;
      }
    }, 5000);
    // Streamed model text is buffered and flushed to the run document a few times a second.
    let partial = '';
    let dirty = false;
    let flushing = false;
    const onDelta: DeltaWriter = (text, reset) => {
      partial = reset ? '' : partial + text;
      dirty = true;
    };
    const flush = setInterval(async () => {
      if (!dirty || flushing) return;
      flushing = true;
      dirty = false;
      try {
        await runs.updateOne(filter, { $set: { partial: partial.slice(-32000) } });
      } catch {
      } finally {
        flushing = false;
      }
    }, 300);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)]);
      const output = await executeRun(run, signal, onDelta);
      signal.throwIfAborted();
      clearInterval(flush);
      await runs.updateOne(
        { ...filter, cancelRequested: { $ne: true } },
        {
          $set: { status: 'succeeded', output, finishedAt: new Date(), updatedAt: new Date() },
          $unset: { partial: '', 'checkpoint.cursor': '' },
        },
      );
    } catch (error) {
      clearInterval(flush);
      const current = await runs.findOne({ _id: run._id });
      const status = current?.cancelRequested
        ? 'cancelled'
        : stopping || controller.signal.aborted
          ? 'interrupted'
          : 'failed';
      await runs.updateOne(filter, {
        $set: { status, error: safeError(error), finishedAt: new Date(), updatedAt: new Date() },
        $unset: { partial: '' },
      });
    } finally {
      clearInterval(timer);
      clearInterval(flush);
    }
    await runs.updateOne(
      { ...filter, cancelRequested: true },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
    );
    const finished = await runs.findOne({ _id: run._id });
    if (finished) await settleConversation(finished);
  } else {
    const docs = collection<KnowledgeDocument>('documents');
    const doc = await docs.findOneAndUpdate(
      {
        _id: job.id,
        status: job.kind === 'delete' ? 'deleting' : 'queued',
        ...(job.kind === 'delete'
          ? { $or: [{ leaseUntil: { $lt: now } }, { leaseUntil: { $exists: false } }] }
          : {}),
      },
      {
        $set: {
          status: job.kind === 'delete' ? 'deleting' : 'indexing',
          leaseId,
          leaseUntil,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    if (!doc) return;
    const filter = { _id: doc._id, leaseId, status: doc.status };
    const timer = setInterval(async () => {
      try {
        const r = await docs.updateOne(filter, { $set: { leaseUntil: new Date(Date.now() + 30000) } });
        if (!r.matchedCount) controller.abort();
      } catch {
        controller.abort();
      }
    }, 5000);
    try {
      if (job.kind === 'delete') await deleteDocument(doc);
      else {
        const chunks = await indexDocument(doc, controller.signal);
        await docs.updateOne(filter, {
          $set: { status: 'ready', chunks, updatedAt: new Date() },
          $unset: { error: '', leaseId: '', leaseUntil: '' },
        });
      }
    } catch (error) {
      await docs.updateOne(filter, {
        $set: {
          status: job.kind === 'delete' ? 'deleting' : 'failed',
          error: safeError(error),
          updatedAt: new Date(),
        },
        $unset: { leaseId: '', leaseUntil: '' },
      });
    } finally {
      clearInterval(timer);
    }
  }
}
const consumer = await channel.consume(JOB_QUEUE, (msg) => {
  if (!msg) return;
  const controller = new AbortController();
  active.add(controller);
  const task = (async () => {
    try {
      const job = JSON.parse(msg.content.toString()) as Job;
      if (!['run', 'index', 'delete'].includes(job.kind) || !/^[a-f0-9-]{36}$/.test(job.id))
        throw new Error('Malformed queue message');
      await processJob(job, controller);
      channel.ack(msg);
    } catch (error) {
      console.error('Job failed:', safeError(error));
      try {
        channel.nack(msg, false, false);
      } catch {}
    } finally {
      active.delete(controller);
    }
  })();
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
});
const health = setInterval(
  () => void writeFile('/tmp/agentic-worker-heartbeat', String(Date.now())).catch(() => {}),
  5000,
);
await writeFile('/tmp/agentic-worker-heartbeat', String(Date.now()));
console.log('Agentic runner is ready');
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(health);
  await channel.cancel(consumer.consumerTag).catch(() => {});
  active.forEach((c) => c.abort(new Error('Runner is shutting down; review side effects before retrying')));
  await Promise.allSettled([...tasks]);
  await closeQueue();
  await mongo.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
