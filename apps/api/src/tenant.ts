import { collection } from '../../../packages/core/src/db.js';
import type { User } from './auth.js';

export type Tenant = { _id: string; name?: string; defaultProviderId?: string; createdAt?: Date };
/** The workspace default model provider: the chosen one if it still exists, otherwise the oldest provider. */
export async function defaultProviderId(tenantId: string) {
  const tenant = await collection<Tenant>('tenants').findOne({ _id: tenantId });
  const providers = collection<{ _id: string; ownerId: string; createdAt: Date }>('providers');
  let id = tenant?.defaultProviderId;
  if (!id || !(await providers.findOne({ _id: id, ownerId: tenantId })))
    id = (await providers.find({ ownerId: tenantId }).sort({ createdAt: 1 }).limit(1).next())?._id;
  return id;
}
export async function tenantView(tenantId: string) {
  const tenant = await collection<Tenant>('tenants').findOne({ _id: tenantId });
  return {
    id: tenantId,
    name: tenant?.name ?? 'Team workspace',
    members: await collection<User>('users').countDocuments({ tenantId }),
    defaultProviderId: await defaultProviderId(tenantId),
  };
}
