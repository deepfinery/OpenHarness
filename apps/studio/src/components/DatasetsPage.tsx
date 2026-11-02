import React, { useEffect, useMemo, useState } from 'react';
import { Database, Plus, Play, Pencil, Trash2 } from 'lucide-react';
import {
  type Data,
  type DatasetCatalogItem,
  type TickerPreset,
  fetchDatasetCatalog,
  saveDatasetSync,
  deleteDatasetSync,
  runDatasetSyncNow,
  timestamp,
} from '../api';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';
import type { Schedule } from '../../../../packages/core/src/schema.js';
import { Button, IconButton, Field, Modal, SaveForm, Empty, PageTitle, Status } from './ui';
import { ScheduleFields } from './agentFields';
import { DataGrid } from './DataGrid';

type Props = {
  data: Data;
  refresh: () => Promise<void>;
  act: (task: () => Promise<void>) => Promise<void>;
  isAdmin: boolean;
};

type SyncForm = {
  id?: string;
  name: string;
  connectionId: string;
  dataset: string;
  symbolsMode: 'universe' | 'list' | 'preset';
  preset: string;
  symbols: string;
  from: string;
  to: string;
  targetCollection: string;
  retentionDays: string;
  enabled: boolean;
  schedule: Schedule;
};

export function DatasetsPage({ data, refresh, act, isAdmin }: Props) {
  const [catalog, setCatalog] = useState<DatasetCatalogItem[]>([]);
  const [presets, setPresets] = useState<TickerPreset[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [editing, setEditing] = useState<SyncForm | null>(null);

  useEffect(() => {
    fetchDatasetCatalog()
      .then((r) => {
        setCatalog(r.datasets);
        setPresets(r.presets ?? []);
      })
      .catch(() => undefined);
  }, []);

  const syncs = data.datasetSyncs ?? [];
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const presetById = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  const mongo = data.connections.find((c) => c.kind === 'mongodb' && c.enabled);
  const fmpConnections = data.connections.filter((c) => c.kind === 'mcp' && c.enabled);
  const defaultFmp =
    fmpConnections.find((c) => /financialmodelingprep|fmp/i.test(`${c.name} ${c.url ?? ''}`))?.id ??
    fmpConnections[0]?.id ??
    '';

  const current = syncs.find((s) => s.id === selected) ?? syncs[0];
  const currentCollection = current
    ? (current.targetCollection as string) || catalogById.get(current.dataset as string)?.defaultCollection || ''
    : '';

  const blankForm = (): SyncForm => ({
    name: '',
    connectionId: defaultFmp,
    dataset: catalog[0]?.id ?? '',
    symbolsMode: 'universe',
    preset: presets[0]?.id ?? '',
    symbols: '',
    from: '',
    to: '',
    targetCollection: '',
    retentionDays: '',
    enabled: true,
    schedule: {
      enabled: true,
      everyMinutes: catalog[0]?.recommendedEveryMinutes ?? 1440,
      at: '18:30',
      input: 'Scheduled dataset sync',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
  });
  const editForm = (s: Record<string, any>): SyncForm => ({
    id: s.id,
    name: s.name ?? '',
    connectionId: s.connectionId ?? defaultFmp,
    dataset: s.dataset ?? catalog[0]?.id ?? '',
    symbolsMode: s.symbolsMode ?? 'universe',
    preset: s.preset ?? presets[0]?.id ?? '',
    symbols: Array.isArray(s.symbols) ? s.symbols.join(', ') : '',
    from: s.from ?? '',
    to: s.to ?? '',
    targetCollection: s.targetCollection ?? '',
    retentionDays: s.retentionDays ? String(s.retentionDays) : '',
    enabled: s.enabled ?? true,
    schedule: s.schedule ?? blankForm().schedule,
  });

  async function save() {
    if (!editing) return;
    const item = catalogById.get(editing.dataset);
    const body: Record<string, unknown> = {
      name: editing.name.trim(),
      connectionId: editing.connectionId,
      dataset: editing.dataset,
      enabled: editing.enabled,
      schedule: editing.schedule,
      symbolsMode: editing.symbolsMode,
    };
    if (item?.perSymbol) {
      if (editing.symbolsMode === 'list')
        body.symbols = editing.symbols.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (editing.symbolsMode === 'preset') body.preset = editing.preset;
    }
    if (item?.supportsDateRange) {
      if (editing.from) body.from = editing.from;
      if (editing.to) body.to = editing.to;
    }
    if (editing.targetCollection.trim()) body.targetCollection = editing.targetCollection.trim();
    if (editing.retentionDays) body.retentionDays = Number(editing.retentionDays);
    await saveDatasetSync(body, editing.id);
    await refresh();
    setEditing(null);
  }

  const symbolsLabel = (s: Record<string, any>) => {
    const item = catalogById.get(s.dataset);
    if (!item?.perSymbol) return 'Market';
    if (s.symbolsMode === 'list') return `${(s.symbols ?? []).length} tickers`;
    if (s.symbolsMode === 'preset') return presetById.get(s.preset)?.label ?? 'Preset';
    return 'Universe';
  };

  const selectedItem = editing ? catalogById.get(editing.dataset) : undefined;
  const addBtn = isAdmin && (
    <Button onClick={() => setEditing(blankForm())} disabled={!catalog.length}>
      <Plus size={16} /> Add dataset sync
    </Button>
  );

  return (
    <>
      <PageTitle
        eyebrow="Data"
        title="Dataset"
        text="Sync raw market data from FMP into MongoDB collections you can browse here and reuse in harnesses (as a MongoDB tool or via oh.read in Python nodes)."
        action={addBtn}
      />
      {!syncs.length ? (
        <Empty
          icon={<Database size={28} />}
          title="No datasets yet"
          text="Add a dataset sync to pull raw data from FMP on a schedule into a reusable collection."
          action={addBtn}
        />
      ) : (
        <div className="dataset-v2">
          <div className="table-wrap dataset-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Dataset</th>
                  <th>Symbols</th>
                  <th>Schedule</th>
                  <th>Last run</th>
                  <th>Rows</th>
                  <th>Status</th>
                  {isAdmin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {syncs.map((s) => (
                  <tr
                    key={s.id}
                    className={current?.id === s.id ? 'active' : ''}
                    onClick={() => setSelected(s.id)}
                  >
                    <td>
                      <strong>{s.name}</strong>
                    </td>
                    <td>{catalogById.get(s.dataset as string)?.label ?? s.dataset}</td>
                    <td>{symbolsLabel(s)}</td>
                    <td>{describeSchedule(s.schedule as Schedule | undefined)}</td>
                    <td>{s.lastRunAt ? timestamp(s.lastRunAt) : '—'}</td>
                    <td>{typeof s.lastRows === 'number' ? s.lastRows.toLocaleString() : '—'}</td>
                    <td>
                      <Status status={s.enabled ? (s.lastError ? 'failed' : 'ready') : 'disabled'} />
                    </td>
                    {isAdmin && (
                      <td className="dataset-row-actions" onClick={(e) => e.stopPropagation()}>
                        <IconButton
                          title="Run now"
                          onClick={() =>
                            act(async () => {
                              await runDatasetSyncNow(s.id);
                              setTimeout(() => void refresh(), 4000);
                            })
                          }
                        >
                          <Play size={15} />
                        </IconButton>
                        <IconButton title="Edit" onClick={() => setEditing(editForm(s))}>
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          title="Delete"
                          onClick={() =>
                            act(async () => {
                              if (!confirm(`Delete sync "${s.name}"? The collection is kept.`)) return;
                              await deleteDatasetSync(s.id);
                              setSelected('');
                              await refresh();
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {current && (
            <section className="dataset-grid-section">
              <div className="dataset-grid-head">
                <div>
                  <h2>{current.name}</h2>
                  <div className="dataset-grid-meta">
                    <code>{currentCollection}</code>
                    {current.lastError ? <span className="dataset-error">· {String(current.lastError)}</span> : null}
                  </div>
                </div>
              </div>
              {mongo && currentCollection ? (
                <DataGrid connectionId={mongo.id} collection={currentCollection} />
              ) : (
                <div className="notice">Connect the built-in MongoDB to browse this collection.</div>
              )}
            </section>
          )}
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? 'Edit dataset sync' : 'Add dataset sync'} onClose={() => setEditing(null)} wide>
          <SaveForm onSave={save} onCancel={() => setEditing(null)} label={editing.id ? 'Save' : 'Create'}>
            <Field label="Name">
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Daily EOD prices"
              />
            </Field>
            <div className="two-columns">
              <Field label="Source connection" hint="FMP MCP connection; its API key is used for sync.">
                <select
                  value={editing.connectionId}
                  onChange={(e) => setEditing({ ...editing, connectionId: e.target.value })}
                >
                  {fmpConnections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Dataset">
                <select
                  value={editing.dataset}
                  onChange={(e) => {
                    const item = catalogById.get(e.target.value);
                    setEditing({
                      ...editing,
                      dataset: e.target.value,
                      schedule: {
                        ...editing.schedule,
                        everyMinutes: item?.recommendedEveryMinutes ?? editing.schedule.everyMinutes,
                      },
                    });
                  }}
                >
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.category} · {c.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {selectedItem?.description && <p className="field-help">{selectedItem.description}</p>}

            {selectedItem?.perSymbol && (
              <Field label="Symbols" hint="Per-symbol dataset: choose which tickers to pull.">
                <select
                  value={editing.symbolsMode}
                  onChange={(e) =>
                    setEditing({ ...editing, symbolsMode: e.target.value as SyncForm['symbolsMode'] })
                  }
                >
                  <option value="universe">Reuse the Universe collection</option>
                  <option value="preset">Screener preset</option>
                  <option value="list">Explicit ticker list</option>
                </select>
              </Field>
            )}
            {selectedItem?.perSymbol && editing.symbolsMode === 'preset' && (
              <Field label="Preset" hint={presetById.get(editing.preset)?.description}>
                <select
                  value={editing.preset}
                  onChange={(e) => setEditing({ ...editing, preset: e.target.value })}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {selectedItem?.perSymbol && editing.symbolsMode === 'list' && (
              <Field label="Tickers" hint="Comma or space separated, e.g. AAPL, MSFT, NVDA">
                <textarea
                  rows={2}
                  value={editing.symbols}
                  onChange={(e) => setEditing({ ...editing, symbols: e.target.value })}
                />
              </Field>
            )}

            {selectedItem?.supportsDateRange && (
              <div className="two-columns">
                <Field label="From" hint="First pull starts here (e.g. 5 years ago).">
                  <input
                    type="date"
                    value={editing.from}
                    onChange={(e) => setEditing({ ...editing, from: e.target.value })}
                  />
                </Field>
                <Field label="To" hint="Leave blank for today.">
                  <input
                    type="date"
                    value={editing.to}
                    onChange={(e) => setEditing({ ...editing, to: e.target.value })}
                  />
                </Field>
              </div>
            )}

            <div className="two-columns">
              <Field label="Collection" hint={`Default: ${selectedItem?.defaultCollection ?? '—'}`}>
                <input
                  value={editing.targetCollection}
                  onChange={(e) => setEditing({ ...editing, targetCollection: e.target.value })}
                  placeholder={selectedItem?.defaultCollection ?? ''}
                />
              </Field>
              <Field label="Retention (days)" hint="Optional: prune rows older than this.">
                <input
                  type="number"
                  min={1}
                  value={editing.retentionDays}
                  onChange={(e) => setEditing({ ...editing, retentionDays: e.target.value })}
                  placeholder="Keep everything"
                />
              </Field>
            </div>

            <ScheduleFields
              value={editing.schedule}
              onChange={(schedule) => setEditing({ ...editing, schedule })}
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              Sync enabled
            </label>
          </SaveForm>
        </Modal>
      )}
    </>
  );
}
