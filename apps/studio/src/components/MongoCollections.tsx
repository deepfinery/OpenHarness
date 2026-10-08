import { useEffect, useRef, useState } from 'react';
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  Database,
  FileJson,
  ListTree,
  LoaderCircle,
  PanelLeftClose,
  Pencil,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, errorMessage, send, type Data, type Entity } from '../api';
import { Button, Empty, ErrorNotice, IconButton } from './ui';

type Props = {
  data: Data;
  edit: (type: string, value?: Entity) => void;
};
type Collection = { name: string; count: number };
type Page = { documents: Record<string, unknown>[]; total: number; skip: number; limit: number };
type Index = { name: string; key: Record<string, unknown> };
type Pane = 'document' | 'insert' | 'indexes';
const PAGE = 25;
const enc = encodeURIComponent;
/** Extended JSON ids ({ $oid }) are shown and addressed as their hex string. */
const documentId = (d: Record<string, unknown>) => {
  const id = d._id as unknown;
  return id && typeof id === 'object' && '$oid' in id
    ? String((id as { $oid: string }).$oid)
    : JSON.stringify(id);
};
const summary = (d: Record<string, unknown>) =>
  Object.entries(d)
    .filter(([k]) => k !== '_id')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
    .slice(0, 140);
const indexLabel = (key: Record<string, unknown>) =>
  '_fts' in key
    ? 'text'
    : Object.entries(key)
        .map(([k, v]) => `${k} ${v === -1 ? '↓' : v === 1 ? '↑' : String(v)}`)
        .join(', ');

/** MongoDB collections reached through a MongoDB MCP connection: the same tools agents use. */
export function MongoCollections({ data, edit }: Props) {
  const connections = data.connections.filter((c) => c.kind === 'mongodb' && c.enabled);
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  const [database, setDatabase] = useState('');
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [skip, setSkip] = useState(0);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('');
  const [applied, setApplied] = useState({ filter: '', sort: '' });
  const [openId, setOpenId] = useState('');
  const [pane, setPane] = useState<Pane>('document');
  const [indexes, setIndexes] = useState<Index[] | null>(null);
  const [newName, setNewName] = useState('');
  const [payload, setPayload] = useState('');
  /** The JSON being edited for the open document, or null when it is only shown. */
  const [draft, setDraft] = useState<string | null>(null);
  const [indexField, setIndexField] = useState('');
  const [indexType, setIndexType] = useState('ascending');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showList, setShowList] = useState(() => typeof window === 'undefined' || window.innerWidth > 900);
  const file = useRef<HTMLInputElement>(null);
  const connection = connections.find((c) => c.id === connectionId);
  const base = `/mongodb/${enc(connectionId)}/collections`;
  const current = page?.documents.find((d) => documentId(d) === openId);
  useEffect(() => {
    if (!connections.some((c) => c.id === connectionId)) setConnectionId(connections[0]?.id ?? '');
  }, [data.connections]);

  async function run<T>(label: string, task: () => Promise<T>) {
    setBusy(label);
    setError('');
    try {
      return await task();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy('');
    }
  }
  async function loadCollections(keep = selected) {
    if (!connectionId) return;
    const listed = await run('collections', () => api<{ database: string; collections: Collection[] }>(base));
    if (!listed) return setCollections((c) => c ?? []);
    setDatabase(listed.database);
    setCollections(listed.collections);
    const next = listed.collections.some((c) => c.name === keep) ? keep : (listed.collections[0]?.name ?? '');
    setSelected(next);
  }
  async function loadDocuments(name = selected, from = skip, query = applied) {
    if (!name) return setPage(null);
    const params = new URLSearchParams({ skip: String(from), limit: String(PAGE) });
    if (query.filter.trim()) params.set('filter', query.filter);
    if (query.sort.trim()) params.set('sort', query.sort);
    const result = await run('documents', () => api<Page>(`${base}/${enc(name)}/documents?${params}`));
    if (result) setPage(result);
  }
  async function loadIndexes(name = selected) {
    if (!name) return;
    const result = await run('indexes', () => api<{ indexes: Index[] }>(`${base}/${enc(name)}/indexes`));
    if (result) setIndexes(result.indexes);
  }
  useEffect(() => {
    setCollections(null);
    setSelected('');
    setPage(null);
    void loadCollections('');
  }, [connectionId]);
  useEffect(() => {
    setSkip(0);
    setOpenId('');
    setIndexes(null);
    setFilter('');
    setSort('');
    setApplied({ filter: '', sort: '' });
    setPane('document');
    void loadDocuments(selected, 0, { filter: '', sort: '' });
  }, [selected]);

  async function createCollection() {
    const name = newName.trim();
    if (!name) return;
    if (await run('create', () => send(base, { name }))) {
      setNewName('');
      await loadCollections(name);
    }
  }
  async function dropCollection(name: string) {
    if (!confirm(`Delete the collection “${name}” and all of its documents? This cannot be undone.`)) return;
    const dropped = await run('drop', () =>
      api(`${base}/${enc(name)}`, { method: 'DELETE' }).then(() => true),
    );
    if (dropped) await loadCollections(selected === name ? '' : selected);
  }
  async function insert() {
    let documents: unknown;
    try {
      documents = JSON.parse(payload);
    } catch {
      return setError('Insert takes JSON: one object, or an array of objects or values.');
    }
    const result = await run('insert', () =>
      send<{ inserted: number }>(`${base}/${enc(selected)}/documents`, { documents }),
    );
    if (!result) return;
    setPayload('');
    setPane('document');
    await Promise.all([loadDocuments(selected, 0), loadCollections()]);
    setSkip(0);
  }
  async function saveDocument() {
    let document: unknown;
    try {
      document = JSON.parse(draft ?? '');
    } catch {
      return setError('The document must be valid JSON.');
    }
    if (!document || typeof document !== 'object' || Array.isArray(document))
      return setError('The document must be one JSON object.');
    const result = await run('save', () =>
      send(`${base}/${enc(selected)}/documents/${enc(openId)}`, { document }, 'PUT'),
    );
    if (!result) return;
    setDraft(null);
    await loadDocuments();
  }
  async function removeDocument(id: string) {
    if (!confirm('Delete this document?')) return;
    const result = await run('delete', () =>
      api(`${base}/${enc(selected)}/documents/${enc(id)}`, { method: 'DELETE' }),
    );
    if (!result) return;
    setOpenId('');
    await Promise.all([loadDocuments(), loadCollections()]);
  }
  async function createIndex() {
    const field = indexField.trim();
    if (!field) return;
    const result = await run('index', () =>
      send(`${base}/${enc(selected)}/indexes`, { field, type: indexType }),
    );
    if (!result) return;
    setIndexField('');
    await loadIndexes();
  }
  async function dropIndex(name: string) {
    if (!confirm(`Remove the index “${name}”?`)) return;
    await run('index', () => api(`${base}/${enc(selected)}/indexes/${enc(name)}`, { method: 'DELETE' }));
    await loadIndexes();
  }
  function apply() {
    const query = { filter, sort };
    setApplied(query);
    setSkip(0);
    void loadDocuments(selected, 0, query);
  }
  function go(to: number) {
    setSkip(to);
    void loadDocuments(selected, to);
  }

  if (!connections.length)
    return (
      <main className="page-content">
        <Empty
          icon={<Database size={30} />}
          title="Connect MongoDB"
          text="Collections live in MongoDB and are reached through the MongoDB MCP server. Create collections, browse and add JSON documents, and index fields. Agents read and write the same collections with the connection's tools."
          action={
            <Button onClick={() => edit('connections', { id: '', kind: 'mongodb', name: 'MongoDB' })}>
              <Plus size={16} />
              Connect MongoDB
            </Button>
          }
        />
      </main>
    );
  const from = page && page.total ? page.skip + 1 : 0;
  const to = page ? Math.min(page.skip + page.documents.length, page.total) : 0;
  return (
    <div className={`playground kb-workspace trace-hidden ${showList ? '' : 'conversations-hidden'}`}>
      <aside className="conversation-list kb-panel" aria-label="MongoDB collections">
        <div className="conversation-list-head">
          <span className="eyebrow">Collections</span>
          <IconButton title="Hide collections" onClick={() => setShowList(false)}>
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
        <div className="mongo-connection">
          {connections.length > 1 ? (
            <select
              aria-label="MongoDB connection"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{connection?.name}</strong>
          )}
          <IconButton
            title="Connection settings"
            onClick={() => connection && edit('connections', connection)}
          >
            <Settings2 size={14} />
          </IconButton>
          <IconButton title="Reload collections" onClick={() => void loadCollections()}>
            <RefreshCw size={14} className={busy === 'collections' ? 'spin' : ''} />
          </IconButton>
        </div>
        {database && (
          <small className="mongo-database" title={database}>
            {connection?.builtIn ? 'Workspace database' : `Database ${database}`}
          </small>
        )}
        <form
          className="mongo-new"
          onSubmit={(e) => {
            e.preventDefault();
            void createCollection();
          }}
        >
          <input
            aria-label="New collection name"
            placeholder="New collection…"
            value={newName}
            pattern="[A-Za-z0-9_][A-Za-z0-9_.\-]*"
            title="Letters, digits, _, - or ."
            onChange={(e) => setNewName(e.target.value)}
          />
          <IconButton type="submit" title="Create collection" disabled={!newName.trim() || busy === 'create'}>
            <Plus size={15} />
          </IconButton>
        </form>
        <div className="kb-cards">
          {collections === null ? (
            <p className="kb-files-empty">Loading…</p>
          ) : !collections.length ? (
            <p className="kb-files-empty">No collections yet. Name one above to create it.</p>
          ) : (
            collections.map((c) => (
              <div
                key={c.name}
                role="button"
                tabIndex={0}
                aria-pressed={selected === c.name}
                className={`kb-card ${selected === c.name ? 'active' : ''}`}
                onClick={() => {
                  setSelected(c.name);
                  if (window.innerWidth <= 900) setShowList(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(c.name);
                  }
                }}
              >
                <div className="kb-card-top">
                  <span className="kb-card-icon">
                    <Database size={15} />
                  </span>
                  <strong>{c.name}</strong>
                </div>
                <small>
                  {c.count} {c.count === 1 ? 'document' : 'documents'}
                </small>
                <div className="kb-card-actions" onClick={(e) => e.stopPropagation()}>
                  <IconButton title={`Delete ${c.name}`} onClick={() => void dropCollection(c.name)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
      <div className="kb-main">
        <section className="kb-files" aria-label="Documents">
          <div className="kb-files-head">
            <ErrorNotice error={error} />
            <div className="kb-files-title">
              {!showList && (
                <IconButton title="Show collections" onClick={() => setShowList(true)}>
                  <PanelLeftOpen size={16} />
                </IconButton>
              )}
              <div>
                <h3>{selected || 'No collection selected'}</h3>
                {page && (
                  <small>
                    {page.total} {page.total === 1 ? 'document' : 'documents'}
                    {applied.filter.trim() ? ' match the filter' : ''}
                  </small>
                )}
              </div>
            </div>
            {selected && (
              <>
                <div className="kb-files-actions">
                  <Button onClick={() => setPane('insert')}>
                    <Upload size={14} />
                    Insert JSON
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPane('indexes');
                      void loadIndexes();
                    }}
                  >
                    <ListTree size={14} />
                    Indexes
                  </Button>
                </div>
                <form
                  className="mongo-query"
                  onSubmit={(e) => {
                    e.preventDefault();
                    apply();
                  }}
                >
                  <input
                    aria-label="Filter"
                    className="kb-filter"
                    placeholder='Filter, e.g. { "status": "open" }'
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <input
                    aria-label="Sort"
                    className="kb-filter"
                    placeholder='Sort, e.g. { "createdAt": -1 }'
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  />
                  <Button variant="secondary" disabled={busy === 'documents'}>
                    {busy === 'documents' ? <LoaderCircle className="spin" size={14} /> : 'Apply'}
                  </Button>
                </form>
              </>
            )}
          </div>
          <div className="kb-file-list">
            {page && !page.documents.length && (
              <p className="kb-files-empty">
                {applied.filter.trim() ? 'No documents match.' : 'Empty. Insert JSON documents to start.'}
              </p>
            )}
            {page?.documents.map((d) => {
              const id = documentId(d);
              return (
                <button
                  type="button"
                  key={id}
                  className={`kb-file ${openId === id && pane === 'document' ? 'active' : ''}`}
                  onClick={() => {
                    setOpenId(id);
                    setDraft(null);
                    setPane('document');
                  }}
                >
                  <Braces size={15} />
                  <span>
                    <strong>{id}</strong>
                    <small>{summary(d) || 'No other fields'}</small>
                  </span>
                  <i />
                </button>
              );
            })}
          </div>
          {page && page.total > PAGE && (
            <div className="mongo-pager">
              <IconButton title="Previous page" disabled={!skip} onClick={() => go(Math.max(0, skip - PAGE))}>
                <ChevronLeft size={15} />
              </IconButton>
              <span>
                {from}–{to} of {page.total}
              </span>
              <IconButton title="Next page" disabled={to >= page.total} onClick={() => go(skip + PAGE)}>
                <ChevronRight size={15} />
              </IconButton>
            </div>
          )}
        </section>
        <section className="kb-editor" aria-label="Collection detail">
          {pane === 'insert' && selected ? (
            <>
              <div className="kb-editor-head">
                <FileJson size={18} />
                <h3 className="kb-title-static">Insert into {selected}</h3>
                <Button variant="secondary" onClick={() => file.current?.click()}>
                  <Upload size={14} />
                  Load .json file
                </Button>
                <Button disabled={busy === 'insert' || !payload.trim()} onClick={() => void insert()}>
                  {busy === 'insert' ? <LoaderCircle className="spin" size={14} /> : null}
                  Insert
                </Button>
              </div>
              <textarea
                aria-label="JSON documents"
                className="kb-note mongo-json"
                spellCheck={false}
                placeholder={
                  '[\n  { "name": "Ada", "role": "engineer" },\n  { "name": "Grace", "tags": ["navy", "cobol"] }\n]'
                }
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
              <div className="kb-editor-foot">
                <span>
                  One object or an array. Values that are not objects are stored as {'{ "value": … }'}.
                  Extended JSON such as {'{ "$date": "2026-01-01T00:00:00Z" }'} is understood.
                </span>
              </div>
              <input
                ref={file}
                type="file"
                hidden
                accept=".json,application/json"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  e.target.value = '';
                  if (chosen) void chosen.text().then(setPayload);
                }}
              />
            </>
          ) : pane === 'indexes' && selected ? (
            <>
              <div className="kb-editor-head">
                <ListTree size={18} />
                <h3 className="kb-title-static">Indexes on {selected}</h3>
              </div>
              <div className="kb-preview">
                <form
                  className="mongo-index-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void createIndex();
                  }}
                >
                  <input
                    aria-label="Field to index"
                    placeholder="Field, e.g. customer.email"
                    value={indexField}
                    onChange={(e) => setIndexField(e.target.value)}
                  />
                  <select
                    aria-label="Index type"
                    value={indexType}
                    onChange={(e) => setIndexType(e.target.value)}
                  >
                    <option value="ascending">Ascending</option>
                    <option value="descending">Descending</option>
                    <option value="text">Text search</option>
                  </select>
                  <Button disabled={busy === 'index' || !indexField.trim()}>Add index</Button>
                </form>
                <p className="field-help">
                  Indexed fields make lookups by that field fast. A text index lets agents search words with{' '}
                  <code>{'{ "$text": { "$search": "…" } }'}</code>; a collection has at most one.
                </p>
                {indexes === null ? (
                  <p className="field-help">Loading…</p>
                ) : (
                  <ul className="mongo-indexes">
                    {indexes.map((i) => (
                      <li key={i.name}>
                        <span>
                          <strong>{i.name}</strong>
                          <small>{indexLabel(i.key)}</small>
                        </span>
                        {i.name !== '_id_' && (
                          <IconButton title={`Remove ${i.name}`} onClick={() => void dropIndex(i.name)}>
                            <Trash2 size={14} />
                          </IconButton>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : current ? (
            <>
              <div className="kb-editor-head">
                <Braces size={18} />
                <h3 className="kb-title-static">{openId}</h3>
                {draft === null ? (
                  <IconButton
                    title="Edit document"
                    onClick={() => setDraft(JSON.stringify(current, null, 2))}
                  >
                    <Pencil size={15} />
                  </IconButton>
                ) : (
                  <>
                    <Button variant="secondary" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                    <Button disabled={busy === 'save'} onClick={() => void saveDocument()}>
                      {busy === 'save' ? <LoaderCircle className="spin" size={14} /> : null}
                      Save
                    </Button>
                  </>
                )}
                <IconButton title="Delete document" onClick={() => void removeDocument(openId)}>
                  <Trash2 size={15} />
                </IconButton>
              </div>
              {draft === null ? (
                <div className="kb-preview">
                  <pre>{JSON.stringify(current, null, 2)}</pre>
                </div>
              ) : (
                <>
                  <textarea
                    aria-label="Edit document JSON"
                    className="kb-note mongo-json"
                    spellCheck={false}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="kb-editor-foot">
                    <span>Saving replaces the document: fields you remove are deleted. The _id stays.</span>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="kb-empty">
              <Database size={26} />
              <h3>{selected ? 'Pick a document' : 'Create a collection'}</h3>
              <p>
                Agents read and write these collections with the {connection?.name ?? 'MongoDB'} tools. Add
                the tools to an agent under its MCP tools.
              </p>
              {selected && (
                <div className="row-actions">
                  <Button onClick={() => setPane('insert')}>
                    <Upload size={14} />
                    Insert JSON
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
