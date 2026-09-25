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
    db.collection('documents').createIndex({ status: 1, publishedAt: 1 }),
    ...[
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
