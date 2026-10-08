import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { connectMcp, ownedConnection } from '../../../packages/core/src/mcp.js';
import { mongoPins } from '../../../packages/core/src/mongoMcp.js';
import { HttpError } from '../../../packages/core/src/security.js';

/**
 * MongoDB collections for the Knowledge page. Every operation is a MongoDB MCP tool call through the workspace's
 * connection, so the studio reaches exactly what its agents reach: one database, pinned by OpenHarness.
 */
export const mongodb = Router();

/** No `$`, no `system.` prefix, and short enough for any MongoDB namespace. */
const collectionName = z
  .string()
  .regex(
    /^(?!system\.)[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/,
    'Use letters, digits, _, - or . in the collection name (not starting with system.)',
  );
const field = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/, 'Use letters, digits, _, - or . in the field path');
const json = (label: string) =>
  z
    .string()
    .max(20000)
    .optional()
    .transform((text, ctx) => {
      if (!text?.trim()) return undefined;
      try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        // Reported below.
      }
      ctx.addIssue({ code: 'custom', message: `${label} must be a JSON object` });
      return z.NEVER;
    });
const browseQuery = z.object({
  filter: json('The filter'),
  sort: json('The sort'),
  skip: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
/** Insert payload: one JSON object, or an array of anything (non-objects are stored as `{ value }`). */
const insertBody = z.object({ documents: z.unknown() });
const indexBody = z.object({
  field,
  type: z.enum(['ascending', 'descending', 'text']).default('ascending'),
  name: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,120}$/)
    .optional(),
});
/** Documents per insert-many call and serialized bytes per call, below the server's request body limit. */
const INSERT_BATCH = 1000;
const INSERT_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_INSERT = 50_000;

type Call = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
function errorText(result: CallToolResult) {
  return (
    result.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join(' ')
      .trim()
      .slice(0, 500) || 'The MongoDB MCP server reported an error'
  );
}
async function withMongo<T>(req: Request, work: (call: Call, database: string) => Promise<T>) {
  const connection = await ownedConnection(req.principal!.tenantId, String(req.params.connectionId));
  const pins = mongoPins(connection);
  if (!pins) throw new HttpError(404, 'Not a MongoDB connection');
  const session = await connectMcp(connection, AbortSignal.timeout(120000));
  try {
    return await work(async (name, args = {}) => {
      const result = (await session.client.callTool({ name, arguments: args })) as CallToolResult;
      if (result.isError) throw new HttpError(400, errorText(result));
      return (result.structuredContent ?? {}) as Record<string, unknown>;
    }, pins.database);
  } finally {
    await session.close();
  }
}
const param = (req: Request, key: string) => collectionName.parse(String(req.params[key]));

mongodb.get('/:connectionId/collections', async (req, res) => {
  res.json(
    await withMongo(req, async (call, database) => {
      const listed = (await call('list-collections')).collections as { name: string }[] | undefined;
      const names = (listed ?? []).map((c) => c.name).filter((n) => !n.startsWith('system.'));
      names.sort((a, b) => a.localeCompare(b));
      const collections = await Promise.all(
        names.map(async (name) => ({
          name,
          count: Number(
            (await call('count', { collection: name }).catch((): Record<string, unknown> => ({}))).count ?? 0,
          ),
        })),
      );
      return { database, collections };
    }),
  );
});
mongodb.post('/:connectionId/collections', async (req, res) => {
  const name = collectionName.parse(req.body?.name);
  await withMongo(req, (call) => call('create-collection', { collection: name }));
  res.status(201).json({ name });
});
mongodb.delete('/:connectionId/collections/:collection', async (req, res) => {
  const name = param(req, 'collection');
  await withMongo(req, (call) => call('drop-collection', { collection: name }));
  res.status(204).end();
});
mongodb.get('/:connectionId/collections/:collection/documents', async (req, res) => {
  const name = param(req, 'collection');
  const query = browseQuery.parse(req.query);
  res.json(
    await withMongo(req, async (call) => {
      const pipeline: Record<string, unknown>[] = [
        ...(query.filter ? [{ $match: query.filter }] : []),
        ...(query.sort ? [{ $sort: query.sort }] : []),
        { $skip: query.skip },
        { $limit: query.limit },
      ];
      const [page, counted] = await Promise.all([
        call('aggregate', { collection: name, pipeline }),
        call('count', { collection: name, ...(query.filter ? { query: query.filter } : {}) }),
      ]);
      return {
        documents: (page.documents as unknown[]) ?? [],
        total: Number(counted.count ?? 0),
        skip: query.skip,
        limit: query.limit,
      };
    }),
  );
});
mongodb.post('/:connectionId/collections/:collection/documents', async (req, res) => {
  const name = param(req, 'collection');
  const { documents } = insertBody.parse(req.body);
  const list = (Array.isArray(documents) ? documents : [documents]).map((d) =>
    d && typeof d === 'object' && !Array.isArray(d) ? d : { value: d },
  );
  if (!list.length || documents === undefined) throw new HttpError(400, 'Add at least one JSON document');
  if (list.length > MAX_INSERT) throw new HttpError(400, `Insert at most ${MAX_INSERT} documents at a time`);
  const inserted = await withMongo(req, async (call) => {
    let count = 0;
    for (let start = 0; start < list.length;) {
      const batch: unknown[] = [];
      let bytes = 0;
      while (start < list.length && batch.length < INSERT_BATCH) {
        const size = JSON.stringify(list[start]).length;
        if (batch.length && bytes + size > INSERT_BATCH_BYTES) break;
        batch.push(list[start++]);
        bytes += size;
      }
      const result = await call('insert-many', { collection: name, documents: batch });
      count += Number(result.insertedCount ?? batch.length);
    }
    return count;
  });
  res.status(201).json({ inserted });
});
/** ObjectIds arrive as 24 hex characters; other ids are matched as strings. */
const idFilter = (id: string) => (/^[a-f0-9]{24}$/i.test(id) ? { _id: { $oid: id } } : { _id: id });
/** A replacement document: top-level fields only, never operators or dotted paths. */
const replacement = z
  .record(z.unknown())
  .refine((d) => Object.keys(d).every((k) => !k.startsWith('$') && !k.includes('.')), {
    message: 'Field names cannot start with $ or contain a dot',
  });
mongodb.put('/:connectionId/collections/:collection/documents/:id', async (req, res) => {
  const name = param(req, 'collection');
  const filter = idFilter(String(req.params.id));
  const { _id: _ignored, ...fields } = replacement.parse(req.body?.document);
  const modified = await withMongo(req, async (call) => {
    const found = await call('find', { collection: name, filter, limit: 1 });
    const current = (found.documents as Record<string, unknown>[] | undefined)?.[0];
    if (!current) throw new HttpError(404, 'Document not found');
    // Saving replaces the document: fields left out of the edit are removed.
    const removed = Object.keys(current).filter((k) => k !== '_id' && !(k in fields));
    const update = {
      ...(Object.keys(fields).length ? { $set: fields } : {}),
      ...(removed.length ? { $unset: Object.fromEntries(removed.map((k) => [k, ''])) } : {}),
    };
    if (!Object.keys(update).length) return 0;
    const result = await call('update-many', { collection: name, filter, update });
    return Number(result.modifiedCount ?? 0);
  });
  res.json({ modified });
});
mongodb.delete('/:connectionId/collections/:collection/documents/:id', async (req, res) => {
  const name = param(req, 'collection');
  const filter = idFilter(String(req.params.id));
  const deleted = await withMongo(req, (call) => call('delete-many', { collection: name, filter }));
  res.json({ deleted: Number(deleted.deletedCount ?? 0) });
});
mongodb.get('/:connectionId/collections/:collection/indexes', async (req, res) => {
  const name = param(req, 'collection');
  res.json(
    await withMongo(req, async (call) => {
      try {
        const listed = await call('collection-indexes', { collection: name });
        return { indexes: (listed.classicIndexes as { name: string; key: unknown }[]) ?? [] };
      } catch {
        // Self-managed MongoDB without Atlas Search: collection-indexes fails while probing search indexes.
        const stats = await call('aggregate', {
          collection: name,
          pipeline: [{ $indexStats: {} }, { $project: { _id: 0, name: 1, key: 1 } }],
        });
        return { indexes: (stats.documents as { name: string; key: unknown }[]) ?? [] };
      }
    }),
  );
});
mongodb.post('/:connectionId/collections/:collection/indexes', async (req, res) => {
  const name = param(req, 'collection');
  const body = indexBody.parse(req.body);
  const key = body.type === 'text' ? 'text' : body.type === 'descending' ? -1 : 1;
  const created = await withMongo(req, (call) =>
    call('create-index', {
      collection: name,
      ...(body.name ? { name: body.name } : {}),
      definition: [{ type: 'classic', keys: { [body.field]: key } }],
    }),
  );
  res.status(201).json({ name: created.indexName });
});
mongodb.delete('/:connectionId/collections/:collection/indexes/:index', async (req, res) => {
  const name = param(req, 'collection');
  const index = z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,200}$/)
    .parse(String(req.params.index));
  if (index === '_id_') throw new HttpError(400, 'The _id index cannot be removed');
  await withMongo(req, (call) => call('drop-index', { collection: name, indexName: index, type: 'classic' }));
  res.status(204).end();
});
