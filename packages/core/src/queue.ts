import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { config } from './config.js';
export const JOB_QUEUE = 'agentic.jobs';
export const DEAD_QUEUE = 'agentic.jobs.dead';
export type Job = { kind: 'run' | 'index' | 'delete'; id: string };
let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let pending: Promise<ConfirmChannel> | undefined;
export async function queueChannel(): Promise<ConfirmChannel> {
  if (channel) return channel;
  if (pending) return pending;
  pending = (async () => {
    const next = await amqp.connect(
      config.RABBITMQ_URL + (config.RABBITMQ_URL.includes('?') ? '&' : '?') + 'heartbeat=20',
      { timeout: 10000 },
    );
    next.on('error', () => {});
    next.on('close', () => {
      if (connection === next) {
        channel = undefined;
        connection = undefined;
      }
    });
    connection = next;
    const c = await next.createConfirmChannel();
    c.on('error', () => {});
    c.on('close', () => {
      if (channel === c) channel = undefined;
    });
    await c.assertQueue(DEAD_QUEUE, { durable: true });
    await c.assertQueue(JOB_QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': DEAD_QUEUE },
    });
    channel = c;
    return c;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
export async function publish(job: Job) {
  const c = await queueChannel();
  await new Promise<void>((resolve, reject) =>
    c.sendToQueue(
      JOB_QUEUE,
      Buffer.from(JSON.stringify(job)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: `${job.kind}:${job.id}`,
        correlationId: job.id,
        type: `agentic.${job.kind}`,
        timestamp: Math.floor(Date.now() / 1000),
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
export async function closeQueue() {
  await channel?.close().catch(() => {});
  await connection?.close().catch(() => {});
  channel = undefined;
  connection = undefined;
}
