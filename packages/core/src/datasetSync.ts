// Config-driven FMP -> workspace-MongoDB sync. Runs entirely in the backend (no harness,
// no Python). dispatchDatasetSyncs() fires due syncs from the shared server tick loop.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mongo, collection } from './db.js';
import { workspaceDatabase } from './mongoMcp.js';
import { ownedConnection } from './mcp.js';
import { nextScheduledAt } from './schedule.js';
import { HttpError, safeError } from './security.js';
import { scheduleSchema, type Stored } from './schema.js';
import { catalogById, UNIVERSE_DATASET_ID, presetById, type DatasetDef } from './datasetCatalog.js';

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const MAX_RPM = Number(process.env.DATASET_SYNC_RPM) || 250;
const MIN_INTERVAL = 60000 / Math.max(1, MAX_RPM);
let lastCall = 0;

export const datasetSyncInput = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  connectionId: z.string().min(1),
  dataset: z.string().min(1),
  symbolsMode: z.enum(['universe', 'list', 'preset']).default('universe'),
  symbols: z.array(z.string().min(1).max(20)).max(5000).optional(),
  preset: z.string().min(1).max(64).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  targetCollection: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'Letters, digits and underscores')
    .optional(),
  retentionDays: z.number().int().min(1).max(36500).optional(),
  params: z.record(z.unknown()).optional(),
  schedule: scheduleSchema,
});
export type DatasetSyncInput = z.infer<typeof datasetSyncInput>;

export type DatasetSync = DatasetSyncInput & {
  _id: string;
  ownerId: string;
  cursor?: string; // last synced date for timeseries datasets
  nextRunAt?: Date;
  lastRunAt?: Date;
  lastError?: string;
  lastRows?: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
};
export type DatasetSyncRun = {
  _id: string;
  ownerId: string;
  syncId: string;
  scheduleKey?: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  rows?: number;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
};

export const datasetSyncs = () => collection<DatasetSync>('dataset_syncs');
export const datasetSyncRuns = () => collection<DatasetSyncRun>('dataset_sync_runs');

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number) =>
  new Date(new Date(iso + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
function chunkRanges(from: string, to: string, days: number): [string, string][] {
  const out: [string, string][] = [];
  let a = from;
  while (a <= to) {
    const b = addDays(a, days);
    out.push([a, b > to ? to : b]);
    a = addDays(b, 1);
  }
  return out;
}
const isTimeseries = (def: DatasetDef) => def.incremental === 'timeseries';

async function fmpApiKey(ownerId: string, connectionId: string) {
  const connection = await ownedConnection(ownerId, connectionId);
  let key: string | null = null;
  try {
    key = new URL(connection.url).searchParams.get('apikey');
  } catch {
    key = null;
  }
  if (!key) throw new HttpError(400, 'The selected FMP connection has no apikey in its URL');
  return key;
}

async function fmpGet(
  endpoint: string,
  params: Record<string, string | number>,
  apikey: string,
): Promise<unknown> {
  const query = new URLSearchParams({ ...objToStr(params), apikey });
  const url = `${FMP_BASE}/${endpoint}?${query.toString()}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'stockharness-dataset-sync' },
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) return await res.json();
      // 402 on some feeds is a transient throttle mislabeled "not in current plan".
      if ([402, 429, 500, 502, 503, 504].includes(res.status)) {
        if (res.status === 402 && attempt >= 5)
          throw new HttpError(402, `FMP endpoint ${endpoint} is not in the current plan`);
        await sleep(Math.min(60000, 2 ** attempt * 1000) + Math.random() * 1000);
        lastErr = new Error(`FMP ${res.status}`);
        continue;
      }
      throw new HttpError(res.status, `FMP ${endpoint} returned ${res.status}`);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      await sleep(Math.min(30000, 2 ** attempt * 1000) + Math.random() * 1000);
    }
  }
  throw new HttpError(502, `FMP ${endpoint} failed after retries: ${safeError(lastErr)}`);
}

const objToStr = (o: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveSymbols(sync: DatasetSync, wsDb: ReturnType<typeof mongo.db>, apikey: string) {
  if (sync.symbolsMode === 'list' && sync.symbols?.length) return sync.symbols;
  if (sync.symbolsMode === 'preset' && sync.preset) {
    const preset = presetById.get(sync.preset);
    if (!preset) throw new HttpError(400, `Unknown ticker preset: ${sync.preset}`);
    const data = await fmpGet(
      'company-screener',
      { ...preset.screener, isEtf: 'false', isFund: 'false', isActivelyTrading: 'true', limit: 5000 },
      apikey,
    );
    let list = (Array.isArray(data) ? data : []).filter(
      (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol,
    );
    list.sort((a, b) => Number(b.marketCap ?? 0) - Number(a.marketCap ?? 0));
    if (preset.take) list = list.slice(0, preset.take);
    return list.map((r) => String(r.symbol));
  }
  const rows = await wsDb
    .collection('universe')
    .find({}, { projection: { symbol: 1, _id: 0 } })
    .toArray();
  const symbols = rows.map((r) => r.symbol as string).filter(Boolean);
  if (!symbols.length)
    throw new HttpError(400, 'No universe yet: sync the Universe dataset first, or use an explicit symbol list');
  return symbols;
}

async function upsertRows(
  coll: ReturnType<ReturnType<typeof mongo.db>['collection']>,
  rows: unknown[],
  keyFields: string[],
) {
  const docs = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  if (!docs.length) return 0;
  const now = new Date();
  const ops = docs.map((doc) => {
    const clean = { ...doc, _syncedAt: now };
    delete (clean as Record<string, unknown>)._id;
    const filter = Object.fromEntries(keyFields.map((k) => [k, (doc as Record<string, unknown>)[k] ?? null]));
    return { updateOne: { filter, update: { $set: clean }, upsert: true } };
  });
  let written = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    written += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
  }
  return written;
}

/** Do the actual data pull for one sync and return the row count. */
async function pull(sync: DatasetSync, def: DatasetDef, apikey: string): Promise<number> {
  const wsDb = mongo.db(workspaceDatabase(sync.ownerId));
  const coll = wsDb.collection(sync.targetCollection || def.defaultCollection);
  await coll.createIndex(Object.fromEntries(def.keyFields.map((k) => [k, 1]))).catch(() => undefined);
  const now = today();
  const defaultFrom = sync.from || addDays(now, -365);
  let rows = 0;

  if (def.perSymbol) {
    const symbols = await resolveSymbols(sync, wsDb, apikey);
    let errors = 0;
    for (const symbol of symbols) {
      // One symbol's transient throttle (402/429) must never fail the whole dataset.
      try {
        const params: Record<string, string | number> = { ...(def.params ?? {}), symbol };
        if (isTimeseries(def)) {
          params.from = sync.cursor || defaultFrom;
          params.to = now;
        }
        const data = await fmpGet(def.endpoint, params, apikey);
        const list = Array.isArray(data) ? data : data ? [data] : [];
        for (const r of list)
          if (r && typeof r === 'object') {
            (r as Record<string, unknown>).symbol = symbol;
            if (def.params?.period) (r as Record<string, unknown>).period ??= def.params.period;
            // Append-only snapshots: stamp the sync date so each weekly pull adds rows.
            if (def.snapshotDated) (r as Record<string, unknown>).snapshot_date = now;
          }
        rows += await upsertRows(coll, list, def.keyFields);
      } catch (error) {
        errors++;
        if (errors <= 5) console.warn(`dataset ${def.id} ${symbol}: ${safeError(error)}`);
      }
    }
    if (errors) console.warn(`dataset ${def.id}: ${errors}/${symbols.length} symbols errored (kept the rest)`);
  } else if (def.fixedSymbols) {
    for (const symbol of def.fixedSymbols) {
      try {
        const data = await fmpGet(def.endpoint, { symbol, from: sync.cursor || defaultFrom, to: now }, apikey);
        const list = Array.isArray(data) ? data : [];
        for (const r of list) if (r && typeof r === 'object') (r as Record<string, unknown>).symbol = symbol;
        rows += await upsertRows(coll, list, def.keyFields);
      } catch (error) {
        console.warn(`dataset ${def.id} ${symbol}: ${safeError(error)}`);
      }
    }
  } else if (def.id === UNIVERSE_DATASET_ID) {
    // Survivorship-free SYNC universe (C1 #22): active screener names UNION all delisted companies,
    // so per-symbol flows also pull the history of names that later died. The market-cap / tradeable
    // filter is a point-in-time RESEARCH universe applied later in Layer 3 (universe_daily), never here.
    const p = (sync.params ?? {}) as Record<string, unknown>;
    const screener = await fmpGet(
      'company-screener',
      {
        exchange: String(p.exchange ?? 'NASDAQ,NYSE,AMEX'),
        isEtf: 'false',
        isFund: 'false',
        isActivelyTrading: 'true',
        marketCapMoreThan: Number(p.marketCapMoreThan ?? 2_000_000_000),
        limit: Number(p.limit ?? 5000),
      },
      apikey,
    );
    const active = (Array.isArray(screener) ? screener : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol)
      .map((r) => ({
        symbol: r.symbol,
        companyName: r.companyName,
        marketCap: r.marketCap,
        exchange: r.exchangeShortName,
        sector: r.sector,
        industry: r.industry,
        is_delisted: false,
      }));
    // Delisted companies (paginated). Non-fatal: the Premium plan only serves page 0 (page>=1 -> 402),
    // so we take what is available and never let it fail the universe build. Refreshes delisted_companies.
    const delisted: Record<string, unknown>[] = [];
    for (let page = 0; page < Number(p.delistedPages ?? 100); page++) {
      let d: unknown;
      try {
        d = await fmpGet('delisted-companies', { page, limit: 100 }, apikey);
      } catch {
        break; // plan caps delisted paging; use whatever earlier pages returned
      }
      const dl = (Array.isArray(d) ? d : []).filter(
        (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!r.symbol,
      );
      if (!dl.length) break;
      delisted.push(...dl);
    }
    if (delisted.length) {
      const dcoll = mongo.db(workspaceDatabase(sync.ownerId)).collection('delisted_companies');
      await dcoll.createIndex({ symbol: 1, delistedDate: 1 }).catch(() => undefined);
      await upsertRows(dcoll, delisted, ['symbol', 'delistedDate']);
    }
    // Merge: an active screener row overrides a delisted row for the same symbol.
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const r of delisted)
      bySymbol.set(String(r.symbol), {
        symbol: r.symbol,
        companyName: r.companyName,
        exchange: r.exchange,
        delisted_date: r.delistedDate,
        is_delisted: true,
      });
    for (const r of active) bySymbol.set(String(r.symbol), r);
    rows += await upsertRows(coll, [...bySymbol.values()], def.keyFields);
  } else if (def.scope === 'feed') {
    const maxPages = Number((sync.params as Record<string, unknown> | undefined)?.pages ?? 5);
    for (let page = 0; page < maxPages; page++) {
      const data = await fmpGet(def.endpoint, { page, limit: 100 }, apikey);
      const list = Array.isArray(data) ? data : [];
      if (!list.length) break;
      rows += await upsertRows(coll, list, def.keyFields);
    }
  } else if (def.incremental === 'window') {
    const from = sync.from || addDays(now, -7);
    const to = sync.to || addDays(now, 14);
    for (const [a, b] of chunkRanges(from, to, 60)) {
      const data = await fmpGet(def.endpoint, { from: a, to: b }, apikey);
      rows += await upsertRows(coll, Array.isArray(data) ? data : [], def.keyFields);
    }
  } else {
    const params: Record<string, string | number> = { ...(def.params ?? {}) };
    if (def.id === 'sector_performance') params.date = now;
    if (def.supportsDateRange) {
      params.from = sync.from || addDays(now, -365 * 5);
      params.to = sync.to || now;
    }
    const data = await fmpGet(def.endpoint, params, apikey);
    rows += await upsertRows(coll, Array.isArray(data) ? data : [], def.keyFields);
  }

  if (sync.retentionDays && def.dateField) {
    const cutoff = addDays(now, -sync.retentionDays);
    await coll.deleteMany({ [def.dateField]: { $lt: cutoff } });
  }
  return rows;
}

/** Run one sync end to end: records a run, pulls data, updates the sync's cursor/status. */
export async function runDatasetSync(
  sync: DatasetSync,
  opts: { trigger: 'schedule' | 'manual'; scheduleKey?: string } = { trigger: 'manual' },
) {
  if (opts.scheduleKey) {
    const existing = await datasetSyncRuns().findOne({ scheduleKey: opts.scheduleKey });
    if (existing) return existing;
  }
  const def = catalogById.get(sync.dataset);
  if (!def) throw new HttpError(400, `Unknown dataset: ${sync.dataset}`);
  const run: DatasetSyncRun = {
    _id: randomUUID(),
    ownerId: sync.ownerId,
    syncId: sync._id,
    scheduleKey: opts.scheduleKey,
    trigger: opts.trigger,
    status: 'running',
    startedAt: new Date(),
  };
  await datasetSyncRuns().insertOne(run);
  try {
    const apikey = await fmpApiKey(sync.ownerId, sync.connectionId);
    const rows = await pull(sync, def, apikey);
    await datasetSyncRuns().updateOne(
      { _id: run._id },
      { $set: { status: 'succeeded', rows, finishedAt: new Date() } },
    );
    await datasetSyncs().updateOne(
      { _id: sync._id },
      {
        $set: {
          lastRunAt: new Date(),
          lastRows: rows,
          ...(isTimeseries(def) ? { cursor: today() } : {}),
        },
        $unset: { lastError: '' },
      },
    );
    return { ...run, status: 'succeeded' as const, rows };
  } catch (error) {
    const message = safeError(error);
    await datasetSyncRuns().updateOne(
      { _id: run._id },
      { $set: { status: 'failed', error: message, finishedAt: new Date() } },
    );
    await datasetSyncs().updateOne({ _id: sync._id }, { $set: { lastRunAt: new Date(), lastError: message } });
    throw error;
  }
}

/** Fired every tick: run due, enabled syncs; advance nextRunAt. Mirrors dispatchSchedules(). */
export async function dispatchDatasetSyncs() {
  const due = await datasetSyncs()
    .find({
      enabled: true,
      'schedule.enabled': true,
      $or: [{ nextRunAt: { $lte: new Date() } }, { nextRunAt: { $exists: false } }],
    })
    .limit(10)
    .toArray();
  for (const sync of due) {
    const schedule = sync.schedule;
    if (!schedule?.enabled) continue;
    // Wall-clock schedules wait for their time rather than firing when first saved.
    if (!sync.nextRunAt && schedule.at && schedule.everyMinutes >= 1440) {
      await datasetSyncs().updateOne(
        { _id: sync._id, nextRunAt: { $exists: false } },
        { $set: { nextRunAt: nextScheduledAt(schedule) } },
      );
      continue;
    }
    const dueAt = sync.nextRunAt ?? sync.createdAt;
    const filter = {
      _id: sync._id,
      ...(sync.nextRunAt ? { nextRunAt: sync.nextRunAt } : { nextRunAt: { $exists: false } }),
    };
    // Claim this slot first so a long sync doesn't get re-fired by the next tick.
    const claimed = await datasetSyncs().updateOne(filter, {
      $set: { nextRunAt: nextScheduledAt(schedule) },
    });
    if (!claimed.matchedCount) continue;
    try {
      await runDatasetSync(sync, { trigger: 'schedule', scheduleKey: `${sync._id}:${dueAt.toISOString()}` });
    } catch (error) {
      // One failing sync must not starve the others; back off a minute.
      await datasetSyncs().updateOne(
        { _id: sync._id },
        { $set: { nextRunAt: new Date(Date.now() + 60000), lastError: safeError(error) } },
      );
    }
  }
}

export type { Stored };
