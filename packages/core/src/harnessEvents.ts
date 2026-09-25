import { createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { collection } from './db.js';
import { decrypt, safeError, safeFetch } from './security.js';

/**
 * The harness event feed (Open Harness `events`): execution, hook and skill events per workspace, kept for seven
 * days. Ids sort by time, so a stream resumes with `_id > Last-Event-ID`. Registered webhooks receive matching
 * events through a durable outbox with retries.
 */
export type HarnessEvent = {
  _id: string;
  ownerId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
};
export type WebhookRecord = {
  _id: string;
  ownerId: string;
  url: string;
  events: string[];
  secretEncrypted: string;
  enabled: boolean;
  createdAt: Date;
  createdBy?: string;
};
type Delivery = {
  _id: string;
  ownerId: string;
  webhookId: string;
  eventId: string;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  nextAttemptAt: Date;
  lastError?: string;
  createdAt: Date;
  deliveredAt?: Date;
};
const events = () => collection<HarnessEvent>('harness_events');
const webhooks = () => collection<WebhookRecord>('harness_webhooks');
const deliveries = () => collection<Delivery>('webhook_deliveries');
const eventId = () => `${Date.now().toString().padStart(14, '0')}-${randomBytes(6).toString('hex')}`;
/** Minutes to wait before attempts 2 to 5; the fifth failure marks the delivery failed. */
const backoffMinutes = [1, 5, 30, 120];
export const MAX_ATTEMPTS = backoffMinutes.length + 1;

export async function emitHarnessEvent(ownerId: string, type: string, data: Record<string, unknown>) {
  const event: HarnessEvent = { _id: eventId(), ownerId, type, data, createdAt: new Date() };
  try {
    await events().insertOne(event);
    const subscribed = await webhooks()
      .find({ ownerId, enabled: true, $or: [{ events: type }, { events: '*' }] })
      .project<{ _id: string }>({ _id: 1 })
      .toArray();
    if (subscribed.length)
      await deliveries().insertMany(
        subscribed.map((w) => ({
          _id: `${w._id}:${event._id}`,
          ownerId,
          webhookId: w._id,
          eventId: event._id,
          attempts: 0,
          status: 'pending' as const,
          nextAttemptAt: new Date(),
          createdAt: new Date(),
        })),
      );
  } catch (error) {
    // The feed is observability; it never fails the action that produced the event.
    console.warn('Could not record a harness event:', safeError(error));
  }
  return event;
}
export const webhookSignature = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
/** Delivers due webhook events. Called by the API's dispatcher tick; safe to run on several replicas. */
export async function deliverWebhooks(limit = 20) {
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    // Claim one due delivery by pushing its next attempt into the future.
    const claimed = await deliveries().findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: now } },
      { $set: { nextAttemptAt: new Date(now.getTime() + 60000) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
    if (!claimed) return;
    const [hook, event] = await Promise.all([
      webhooks().findOne({ _id: claimed.webhookId, ownerId: claimed.ownerId }),
      events().findOne({ _id: claimed.eventId, ownerId: claimed.ownerId }),
    ]);
    if (!hook || !hook.enabled || !event) {
      await deliveries().updateOne(
        { _id: claimed._id },
        { $set: { status: 'failed', lastError: 'Webhook or event removed' } },
      );
      continue;
    }
    const body = JSON.stringify({
      id: event._id,
      event: event.type,
      harness_id: config.OPENHARNESS_HARNESS_ID,
      ...event.data,
      timestamp: event.createdAt.toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await safeFetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'OpenHarness-Webhooks/1',
          'X-OpenHarness-Event': event.type,
          'X-OpenHarness-Delivery': claimed._id,
          'X-OpenHarness-Timestamp': timestamp,
          'X-OpenHarness-Signature': webhookSignature(decrypt(hook.secretEncrypted), timestamp, body),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await deliveries().updateOne(
        { _id: claimed._id },
        { $set: { status: 'delivered', deliveredAt: new Date() } },
      );
    } catch (error) {
      const failed = claimed.attempts >= MAX_ATTEMPTS;
      await deliveries().updateOne(
        { _id: claimed._id },
        {
          $set: {
            lastError: safeError(error),
            ...(failed
              ? { status: 'failed' as const }
              : { nextAttemptAt: new Date(Date.now() + backoffMinutes[claimed.attempts - 1] * 60000) }),
          },
        },
      );
    }
  }
}
