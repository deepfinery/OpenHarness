import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ArrowUp, ArrowDown, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { IconButton } from './ui';

type Page = { documents: Record<string, unknown>[]; total: number; skip: number; limit: number };
const PAGE = 25;

/** Professional tabular viewer for a workspace MongoDB collection. Top-level fields become
 *  columns; nested objects/arrays render as collapsible embedded JSON. Sort + paginate server-side. */
export function DataGrid({ connectionId, collection }: { connectionId: string; collection: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [skip, setSkip] = useState(0);
  const [sort, setSort] = useState<{ field: string; dir: 1 | -1 } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const base = `/mongodb/${encodeURIComponent(connectionId)}/collections/${encodeURIComponent(collection)}`;
  const load = useCallback(async () => {
    if (!connectionId || !collection) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ skip: String(skip), limit: String(PAGE) });
      if (sort) params.set('sort', JSON.stringify({ [sort.field]: sort.dir }));
      setPage(await api<Page>(`${base}/documents?${params.toString()}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load documents');
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [base, connectionId, collection, skip, sort]);

  useEffect(() => {
    setSkip(0);
    setSort(null);
  }, [connectionId, collection]);
  useEffect(() => {
    void load();
  }, [load]);

  const docs = page?.documents ?? [];
  const columns = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const d of docs)
      for (const k of Object.keys(d))
        if (!seen.has(k)) {
          seen.add(k);
          order.push(k);
        }
    const rest = order.filter((k) => k !== '_id' && k !== '_syncedAt');
    return [...(seen.has('_id') ? ['_id'] : []), ...rest, ...(seen.has('_syncedAt') ? ['_syncedAt'] : [])];
  }, [docs]);

  const toggleSort = (field: string) =>
    setSort((s) => (s?.field === field ? { field, dir: s.dir === 1 ? -1 : 1 } : { field, dir: 1 }));

  const total = page?.total ?? 0;
  const from = total ? skip + 1 : 0;
  const to = Math.min(skip + PAGE, total);

  return (
    <div className="data-grid">
      <div className="data-grid-toolbar">
        <span className="data-grid-count">
          {loading ? 'Loading…' : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
        <div className="data-grid-pager">
          <IconButton title="Refresh" onClick={() => void load()}>
            <RefreshCw size={15} />
          </IconButton>
          <IconButton title="Previous" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton title="Next" disabled={to >= total} onClick={() => setSkip(skip + PAGE)}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
      </div>
      {error ? (
        <div className="notice error">{error}</div>
      ) : !docs.length ? (
        <div className="data-grid-empty">
          {loading ? <LoaderCircle className="spin" size={18} /> : 'No documents yet.'}
        </div>
      ) : (
        <div className="table-wrap data-grid-table">
          <table>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col}>
                    <button className="data-grid-sort" onClick={() => toggleSort(col)}>
                      {col}
                      {sort?.field === col &&
                        (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.map((doc, i) => (
                <tr key={(doc._id as string) ?? i}>
                  {columns.map((col) => (
                    <td key={col}>
                      <Cell value={doc[col]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="data-grid-null">—</span>;
  if (typeof value === 'object') {
    const arr = Array.isArray(value);
    return (
      <details className="json-cell">
        <summary>{arr ? `[ ${(value as unknown[]).length} ]` : '{ … }'}</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  }
  return <span className="data-grid-value">{String(value)}</span>;
}
