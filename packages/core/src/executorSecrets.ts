import { z } from 'zod';
import { collection } from './db.js';
import { ownedConnection } from './mcp.js';
import { decrypt, encrypt, HttpError } from './security.js';

/**
 * Secrets for Python jobs: API keys and passwords the code needs (for example a market-data API key). Values are
 * stored encrypted and never returned. A job gets, as environment variables, only the secrets its harness step or
 * agent lists. A secret can be copied server-side from an MCP connection's credential, so a key already configured
 * for a connection never has to be typed or seen again.
 */
export const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Use upper-case letters, digits and _ (for example FMP_API_KEY)')
  .refine((n) => !/^(OH_|PYTHON|MONGODB_URI$|PATH$|HOME$|LD_|NUMBA_|MPLCONFIGDIR$)/.test(n), {
    message: 'This name is reserved for the executor',
  });
type SecretRecord = {
  _id: string;
  ownerId: string;
  name: string;
  valueEncrypted: string;
  /** Where the value was copied from, for people; the value itself is a snapshot. */
  source?: { connectionId: string; connectionName: string; queryParam?: string };
  createdAt: Date;
  updatedAt: Date;
  updatedBy?: string;
};
const secrets = () => collection<SecretRecord>('executor_secrets');
const key = (ownerId: string, name: string) => `${ownerId}:${name}`;

export async function listSecrets(ownerId: string) {
  return (await secrets().find({ ownerId }).sort({ name: 1 }).toArray()).map((s) => ({
    name: s.name,
    source: s.source,
    updatedAt: s.updatedAt,
  }));
}
async function save(
  ownerId: string,
  name: string,
  value: string,
  userId: string,
  source?: SecretRecord['source'],
) {
  if (!value) throw new HttpError(400, 'The secret is empty');
  if (value.length > 16384) throw new HttpError(400, 'Secrets are at most 16 KB');
  const now = new Date();
  await secrets().updateOne(
    { _id: key(ownerId, name), ownerId },
    {
      $set: {
        name,
        valueEncrypted: encrypt(value),
        updatedAt: now,
        updatedBy: userId,
        ...(source ? { source } : {}),
      },
      ...(source ? {} : { $unset: { source: '' } }),
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}
export const setSecret = (ownerId: string, name: string, value: string, userId: string) =>
  save(ownerId, secretName.parse(name), value, userId);
/** Copies an MCP connection's credential: its access token, or one query parameter of its URL (for example `apikey`). */
export async function importSecret(
  ownerId: string,
  name: string,
  connectionId: string,
  queryParam: string | undefined,
  userId: string,
) {
  const connection = await ownedConnection(ownerId, connectionId);
  let value: string | null | undefined;
  if (queryParam) value = new URL(connection.url).searchParams.get(queryParam);
  else if (connection.authType === 'token') value = decrypt(connection.tokenEncrypted);
  if (!value)
    throw new HttpError(
      400,
      queryParam
        ? `The connection URL has no ${queryParam} parameter`
        : 'The connection has no access token; name the URL parameter that holds the key',
    );
  await save(ownerId, secretName.parse(name), value, userId, {
    connectionId,
    connectionName: connection.name,
    ...(queryParam ? { queryParam } : {}),
  });
}
export async function deleteSecret(ownerId: string, name: string) {
  await secrets().deleteOne({ _id: key(ownerId, secretName.parse(name)), ownerId });
}
/** The values a job may see. A listed secret that does not exist fails the job before it starts. */
export async function resolveSecrets(ownerId: string, names: string[] | undefined) {
  if (!names?.length) return {};
  const found = await secrets()
    .find({ ownerId, name: { $in: names } })
    .toArray();
  const missing = names.filter((n) => !found.some((s) => s.name === n));
  if (missing.length)
    throw new HttpError(
      400,
      `Missing secrets: ${missing.join(', ')}. Add them under Settings → Python secrets.`,
    );
  return Object.fromEntries(found.map((s) => [s.name, decrypt(s.valueEncrypted)]));
}
