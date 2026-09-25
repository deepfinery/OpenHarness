// Device tokens are random, shown once and stored as argon2id hashes. Orchestrator tokens are compared in constant time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const generateDeviceToken = () => `dv_${randomBytes(32).toString('base64url')}`;
export const hashDeviceToken = (token: string) =>
  hash(token, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyDeviceToken = (tokenHash: string, token: string) =>
  verify(tokenHash, token).catch(() => false);

export type Identity = { name: string };
/** Parses `name:token,name:token`; tokens are kept only as SHA-256 digests in memory. */
export function orchestratorAuthenticator(spec: string) {
  const entries = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(':');
      const name = i > 0 ? entry.slice(0, i) : 'orchestrator';
      const token = i > 0 ? entry.slice(i + 1) : entry;
      return { name, digest: createHash('sha256').update(token).digest() };
    });
  return (authorization: string | undefined): Identity | undefined => {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const digest = createHash('sha256').update(authorization.slice(7).trim()).digest();
    for (const e of entries) if (timingSafeEqual(e.digest, digest)) return { name: e.name };
    return undefined;
  };
}
export function constantEquals(a: string, b: string) {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
