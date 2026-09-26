import { MongoClient, type Document } from 'mongodb';
import { config } from './config.js';
export const mongo = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
export const db = mongo.db(config.MONGODB_DATABASE);
export function collection<T extends Document & { _id: string }>(name: string) {
  return db.collection<T>(name);
}
export async function connectDatabase() {
  await mongo.connect();
  // Keep legacy private workspaces isolated. New members explicitly join a tenant.
  await db.collection('users').updateMany({ tenantId: { $exists: false } }, [{ $set: { tenantId: '$_id' } }]);
  await Promise.all([
    db
      .collection('connections')
      .createIndex(
        { ownerId: 1, deviceId: 1 },
        { unique: true, partialFilterExpression: { kind: 'device', deviceId: { $type: 'string' } } },
      ),
    db
      .collection('cluster_cycles')
      .createIndex({ clusterId: 1 }, { unique: true, partialFilterExpression: { status: 'running' } }),
    db.collection('cluster_cycles').createIndex({ ownerId: 1, clusterId: 1, createdAt: -1 }),
    db.collection('cluster_monitors').createIndex({ enabled: 1, nextAt: 1 }),
    db.collection('runs').createIndex({ ownerId: 1, 'monitoring.cycleId': 1, createdAt: -1 }),
    db.collection('guardrail_audit').createIndex({ ownerId: 1, createdAt: -1 }),
    db.collection('guardrail_audit').createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 }),
    db.collection('guardrail_budgets').createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
    db.collection('guardrail_evaluations').createIndex({ status: 1, leaseUntil: 1, createdAt: 1 }),
    db.collection('human_requests').createIndex({ ownerId: 1, status: 1, createdAt: -1 }),
    db.collection('human_requests').createIndex({ status: 1, expiresAt: 1 }),
    db.collection('human_requests').createIndex({ runId: 1, status: 1 }),
    db.collection('continuations').createIndex({ ownerId: 1, runId: 1 }),
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ tenantId: 1 }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('oauth_states').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection('runs')
      .createIndex(
        { ownerId: 1, idempotencyKey: 1 },
        { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
      ),
    db
      .collection('runs')
      .createIndex(
        { scheduleKey: 1 },
        { unique: true, partialFilterExpression: { scheduleKey: { $type: 'string' } } },
      ),
    db.collection('runs').createIndex({ status: 1, publishedAt: 1 }),
    db.collection('task_notes').createIndex({ ownerId: 1, taskId: 1, createdAt: -1, _id: -1 }),
    db.collection('task_notes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('documents').createIndex({ status: 1, publishedAt: 1 }),
    ...[
      'guardrails',
      'guardrail_evaluations',
      'agents',
      'providers',
      'connections',
      'knowledge',
      'documents',
      'workflows',
      'runs',
      'api_tokens',
      'embeds',
      'webhooks',
      'conversations',
    ].map((n) => db.collection(n).createIndex({ ownerId: 1, createdAt: -1 })),
    db.collection('hooks').createIndex({ ownerId: 1, enabled: 1, createdAt: 1 }),
    db.collection('harness_webhooks').createIndex({ ownerId: 1, enabled: 1 }),
    // The harness event feed keeps seven days; ids sort by time, so streams page with _id.
    db.collection('harness_events').createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 }),
    db.collection('harness_events').createIndex({ ownerId: 1, _id: 1 }),
    db.collection('webhook_deliveries').createIndex({ status: 1, nextAttemptAt: 1 }),
    db.collection('webhook_deliveries').createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
  ]);
}
