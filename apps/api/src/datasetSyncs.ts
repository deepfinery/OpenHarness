import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../../packages/core/src/security.js';
import { catalogView, catalogById, TICKER_PRESETS } from '../../../packages/core/src/datasetCatalog.js';
import {
  datasetSyncs as syncsCol,
  datasetSyncRuns,
  datasetSyncInput,
  runDatasetSync,
  type DatasetSync,
} from '../../../packages/core/src/datasetSync.js';

/** Backend FMP -> workspace-MongoDB dataset syncs. Mounted under /api with requireSession. */
export const datasetSyncRouter = Router();

const publicSync = ({ _id, ...rest }: DatasetSync) => ({ id: _id, ...rest });
const assertAdmin = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change dataset syncs');
};

datasetSyncRouter.get('/datasets/catalog', (_req, res) => {
  res.json({
    datasets: catalogView(),
    presets: TICKER_PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
  });
});

async function listSyncs(ownerId: string) {
  const items = await syncsCol().find({ ownerId }).sort({ createdAt: -1 }).toArray();
  return items.map(publicSync);
}
// The studio auto-loads `/datasetSyncs` (collections key); `/dataset-syncs` is the REST alias.
datasetSyncRouter.get('/datasetSyncs', async (req, res) => res.json(await listSyncs(req.principal!.tenantId)));
datasetSyncRouter.get('/dataset-syncs', async (req, res) => res.json(await listSyncs(req.principal!.tenantId)));

datasetSyncRouter.get('/dataset-syncs/:id', async (req, res) => {
  const doc = await syncsCol().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!doc) throw new HttpError(404, 'Dataset sync not found');
  res.json(publicSync(doc));
});

datasetSyncRouter.post('/dataset-syncs', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const body = datasetSyncInput.parse(req.body);
  if (!catalogById.has(body.dataset)) throw new HttpError(400, `Unknown dataset: ${body.dataset}`);
  const now = new Date();
  const doc: DatasetSync = {
    ...body,
    _id: randomUUID(),
    ownerId: req.principal!.tenantId,
    createdAt: now,
    updatedAt: now,
    createdBy: req.principal!.user._id,
  };
  await syncsCol().insertOne(doc);
  res.status(201).json(publicSync(doc));
});

datasetSyncRouter.put('/dataset-syncs/:id', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const body = datasetSyncInput.parse(req.body);
  if (!catalogById.has(body.dataset)) throw new HttpError(400, `Unknown dataset: ${body.dataset}`);
  const id = String(req.params.id);
  const ownerId = req.principal!.tenantId;
  // Editing a sync clears nextRunAt so the (possibly new) schedule re-seeds on the next tick.
  const updated = await syncsCol().updateOne(
    { _id: id, ownerId },
    { $set: { ...body, updatedAt: new Date() }, $unset: { nextRunAt: '' } },
  );
  if (!updated.matchedCount) throw new HttpError(404, 'Dataset sync not found');
  res.json(publicSync((await syncsCol().findOne({ _id: id, ownerId }))!));
});

datasetSyncRouter.delete('/dataset-syncs/:id', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  await syncsCol().deleteOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  res.status(204).end();
});

// Trigger an immediate one-off sync (runs in the background; poll /runs for status).
datasetSyncRouter.post('/dataset-syncs/:id/run', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const doc = await syncsCol().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!doc) throw new HttpError(404, 'Dataset sync not found');
  void runDatasetSync(doc, { trigger: 'manual' }).catch(() => undefined);
  res.status(202).json({ started: true });
});

datasetSyncRouter.get('/dataset-syncs/:id/runs', async (req, res) => {
  const runs = await datasetSyncRuns()
    .find({ ownerId: req.principal!.tenantId, syncId: String(req.params.id) })
    .sort({ startedAt: -1 })
    .limit(20)
    .toArray();
  res.json(runs.map(({ _id, ...r }) => ({ id: _id, ...r })));
});
