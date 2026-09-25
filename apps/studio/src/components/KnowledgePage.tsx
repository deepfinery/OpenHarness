import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Download,
  FileText,
  LoaderCircle,
  MessageSquareText,
  PenLine,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Entity } from '../api';
import { Button, Empty, ErrorNotice, IconButton, Modal, PageTitle, Status } from './ui';

type PageProps = {
  data: Data;
  refresh: () => Promise<void>;
  edit: (type: string, value?: Entity) => void;
  act: (task: () => Promise<unknown>) => Promise<void>;
};
type Note = { id?: string; title: string; content: string; dirty: boolean };
const editable = (name: string) => /\.(txt|md|csv|json|yaml|yml)$/i.test(name);
const displayName = (d: Entity) => (d.kind === 'note' ? d.filename.replace(/\.md$/i, '') : d.filename);

/** Knowledge bases work like a notebook: pick a base, pick a file, write or read it in place. */
export function KnowledgePage({ data, edit, act, refresh }: PageProps) {
  const [selected, setSelected] = useState(data.knowledge[0]?.id ?? '');
  const [documents, setDocuments] = useState<Entity[]>([]);
  const [openId, setOpenId] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  const [preview, setPreview] = useState<{ id: string; content?: string; error?: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [asking, setAsking] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const kb = data.knowledge.find((k) => k.id === selected);
  const provider = data.providers.find((p) => p.id === kb?.providerId);
  const current = documents.find((d) => d.id === openId);
  useEffect(() => {
    if (!data.knowledge.some((k) => k.id === selected)) setSelected(data.knowledge[0]?.id ?? '');
  }, [data.knowledge]);
  async function load() {
    if (!selected) return setDocuments([]);
    setDocuments(await api(`/knowledge/${selected}/documents`));
  }
  useEffect(() => {
    setOpenId('');
    setNote(null);
    setPreview(null);
    setResults(null);
    if (!selected) return setDocuments([]);
    let cancelled = false;
    // The poll only clears errors it raised itself, so a failed save stays visible until the next action.
    let pollFailed = false;
    const update = () =>
      api(`/knowledge/${selected}/documents`)
        .then((d) => {
          if (cancelled) return;
          setDocuments(d);
          if (pollFailed) {
            pollFailed = false;
            setError('');
          }
        })
        .catch((e) => {
          if (cancelled) return;
          pollFailed = true;
          setError(errorMessage(e));
        });
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected]);
  async function upload(files: FileList | null) {
    if (!files?.length || !kb) return;
    setBusy('upload');
    setError('');
    try {
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.append('file', f);
        await api(`/knowledge/${kb.id}/documents`, { method: 'POST', body: form });
      }
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
      if (file.current) file.current.value = '';
    }
  }
  async function openDocument(d: Entity) {
    if (note?.dirty && !confirm('Discard unsaved changes to this note?')) return;
    setOpenId(d.id);
    setNote(null);
    setPreview(null);
    if (!editable(d.filename)) return setPreview({ id: d.id });
    try {
      const body = await api(`/documents/${d.id}/content`);
      if (d.kind === 'note' || /\.(md|txt)$/i.test(d.filename))
        setNote({ id: d.id, title: displayName(d), content: body.content, dirty: false });
      else setPreview({ id: d.id, content: body.content });
    } catch (e) {
      setPreview({ id: d.id, error: errorMessage(e) });
    }
  }
  function newNote() {
    if (note?.dirty && !confirm('Discard unsaved changes to this note?')) return;
    setOpenId('');
    setPreview(null);
    setNote({ title: '', content: '', dirty: true });
  }
  async function saveNote() {
    if (!note || !kb) return;
    const title = note.title.trim() || 'Untitled note';
    setBusy('save');
    setError('');
    try {
      if (note.id) await send(`/documents/${note.id}`, { title, content: note.content }, 'PUT');
      else {
        const created = await send(`/knowledge/${kb.id}/notes`, { title, content: note.content });
        setOpenId(created.id);
        setNote({ ...note, id: created.id, title, dirty: false });
      }
      setNote((n) => (n ? { ...n, title, dirty: false } : n));
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function removeDocument(d: Entity) {
    if (!confirm(`Delete “${displayName(d)}”?`)) return;
    await act(async () => {
      await api(`/documents/${d.id}`, { method: 'DELETE' });
      if (openId === d.id) {
        setOpenId('');
        setNote(null);
        setPreview(null);
      }
      await load();
    });
  }
  const shown = documents.filter((d) => displayName(d).toLowerCase().includes(filter.toLowerCase()));
  const ready = documents.filter((d) => d.status === 'ready').length;
  const indexing = documents.filter((d) => ['queued', 'indexing'].includes(d.status)).length;
  return (
    <>
      <PageTitle
        title="Knowledge"
        action={
          <Button onClick={() => edit('knowledge')}>
            <Plus size={17} />
            New knowledge base
          </Button>
        }
      />
      <ErrorNotice error={error} />
      {!data.knowledge.length ? (
        <Empty
          icon={<BookOpen size={30} />}
          title="No knowledge bases yet"
          text="Create one, then write notes or upload files. Agents search it while they work."
          action={
            <Button onClick={() => edit('knowledge')}>
              <Plus size={16} />
              Create knowledge base
            </Button>
          }
        />
      ) : (
        <div
          className={`kb-shell ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <aside className="kb-list" aria-label="Knowledge bases">
            {data.knowledge.map((k) => (
              <button
                type="button"
                key={k.id}
                className={selected === k.id ? 'active' : ''}
                onClick={() => setSelected(k.id)}
              >
                <BookOpen size={16} />
                <span>{k.name}</span>
              </button>
            ))}
            <button type="button" className="kb-list-add" onClick={() => edit('knowledge')}>
              <Plus size={15} />
              <span>New knowledge base</span>
            </button>
          </aside>
          <section className="kb-files" aria-label="Documents">
            <div className="kb-files-head">
              <div className="kb-files-title">
                <div>
                  <h3>{kb?.name}</h3>
                  <small>
                    {documents.length} {documents.length === 1 ? 'file' : 'files'}
                    {indexing ? ` · ${indexing} indexing` : ''}
                    {provider ? ` · ${provider.embeddingModel}` : ' · embedding provider missing'}
                  </small>
                </div>
                <div className="row-actions">
                  <IconButton title="Knowledge base settings" onClick={() => kb && edit('knowledge', kb)}>
                    <Settings2 size={16} />
                  </IconButton>
                  <IconButton
                    title="Delete knowledge base"
                    onClick={() => {
                      if (kb && confirm(`Delete “${kb.name}” and all of its files?`))
                        void act(async () => {
                          await api(`/knowledge/${kb.id}`, { method: 'DELETE' });
                          await refresh();
                        });
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </div>
              <div className="kb-files-actions">
                <Button onClick={newNote}>
                  <PenLine size={14} />
                  New note
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy === 'upload'}
                  onClick={() => file.current?.click()}
                >
                  {busy === 'upload' ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                  Upload
                </Button>
                <Button variant="secondary" disabled={!ready} onClick={() => setAsking(true)}>
                  <MessageSquareText size={14} />
                  Ask
                </Button>
              </div>
              <input
                aria-label="Filter documents"
                className="kb-filter"
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <input
                ref={file}
                type="file"
                hidden
                multiple
                accept=".txt,.md,.csv,.json,.yaml,.yml,.pdf,.docx"
                onChange={(e) => void upload(e.target.files)}
              />
            </div>
            <div className="kb-file-list">
              {!documents.length && (
                <p className="kb-files-empty">
                  Nothing here yet. Write a note or drop files anywhere on this panel.
                </p>
              )}
              {shown.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  className={`kb-file ${openId === d.id ? 'active' : ''}`}
                  onClick={() => void openDocument(d)}
                >
                  {d.kind === 'note' ? <PenLine size={15} /> : <FileText size={15} />}
                  <span>
                    <strong>{displayName(d)}</strong>
                    <small>
                      {d.status === 'ready'
                        ? `${d.chunks ?? 0} passages`
                        : d.status === 'failed'
                          ? 'Indexing failed'
                          : d.status}
                      {' · '}
                      {timestamp(d.updatedAt ?? d.createdAt)}
                    </small>
                  </span>
                  <i className={`dot ${d.status}`} />
                </button>
              ))}
            </div>
          </section>
          <section className="kb-editor" aria-label="Editor">
            {note ? (
              <>
                <div className="kb-editor-head">
                  <input
                    ref={titleInput}
                    // A new note opens with the title focused; no delayed focus that could steal typing.
                    autoFocus={!note.id}
                    aria-label="Note title"
                    className="kb-title"
                    placeholder="Untitled note"
                    value={note.title}
                    onChange={(e) => setNote({ ...note, title: e.target.value, dirty: true })}
                  />
                  {current && <Status status={current.status} />}
                  <Button disabled={busy === 'save' || !note.dirty} onClick={() => void saveNote()}>
                    {busy === 'save' ? <LoaderCircle className="spin" size={14} /> : null}
                    {note.dirty ? 'Save' : 'Saved'}
                  </Button>
                  {current && (
                    <>
                      <IconButton
                        title="Reindex"
                        disabled={!['ready', 'failed'].includes(current.status)}
                        onClick={() =>
                          void act(async () => send(`/documents/${current.id}/reindex`).then(load))
                        }
                      >
                        <RefreshCw size={15} />
                      </IconButton>
                      <IconButton title="Delete note" onClick={() => void removeDocument(current)}>
                        <Trash2 size={15} />
                      </IconButton>
                    </>
                  )}
                </div>
                <textarea
                  aria-label="Note content"
                  className="kb-note"
                  placeholder="Write in Markdown. Saving re-indexes the note so agents can find it."
                  value={note.content}
                  spellCheck
                  onChange={(e) => setNote({ ...note, content: e.target.value, dirty: true })}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                      e.preventDefault();
                      void saveNote();
                    }
                  }}
                />
                <div className="kb-editor-foot">
                  <span>
                    {note.content.trim() ? `${note.content.trim().split(/\s+/).length} words` : 'Empty'}
                  </span>
                  {current?.error && <span className="error-text">{current.error}</span>}
                  <span className="grow" />
                  <span>{note.dirty ? 'Unsaved changes · ⌘S to save' : 'Indexed on save'}</span>
                </div>
              </>
            ) : preview && current ? (
              <>
                <div className="kb-editor-head">
                  <FileText size={18} />
                  <h3 className="kb-title-static">{current.filename}</h3>
                  <Status status={current.status} />
                  <a className="icon-button" href={`/api/documents/${current.id}/download`} title="Download">
                    <Download size={15} />
                  </a>
                  <IconButton
                    title="Reindex"
                    disabled={!['ready', 'failed'].includes(current.status)}
                    onClick={() => void act(async () => send(`/documents/${current.id}/reindex`).then(load))}
                  >
                    <RefreshCw size={15} />
                  </IconButton>
                  <IconButton title="Delete document" onClick={() => void removeDocument(current)}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
                <div className="kb-preview">
                  <ErrorNotice error={preview.error ?? current.error} />
                  <p className="kb-meta">
                    {Math.max(1, Math.round(current.size / 1024))} KB · {current.chunks ?? 0} passages · added{' '}
                    {timestamp(current.createdAt)}
                  </p>
                  {preview.content ? (
                    <pre>{preview.content.slice(0, 20000)}</pre>
                  ) : (
                    <p className="field-help">
                      Preview is not available for this file type. Download to view.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="kb-empty">
                <PenLine size={26} />
                <h3>{documents.length ? 'Pick a file' : 'Start writing'}</h3>
                <p>
                  Notes and uploads are indexed with {provider?.embeddingModel ?? 'your embedding model'}.
                </p>
                <div className="row-actions">
                  <Button onClick={newNote}>
                    <PenLine size={14} />
                    New note
                  </Button>
                  <Button variant="secondary" onClick={() => file.current?.click()}>
                    <Upload size={14} />
                    Upload files
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      {asking && kb && (
        <Modal title={`Ask ${kb.name}`} onClose={() => setAsking(false)} wide>
          <div className="form-content">
            <form
              className="kb-ask"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy('ask');
                void act(async () => setResults(await send(`/knowledge/${kb.id}/search`, { query }))).finally(
                  () => setBusy(''),
                );
              }}
            >
              <input
                aria-label="Search knowledge"
                placeholder="What would an agent find for…"
                required
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button disabled={busy === 'ask'}>
                {busy === 'ask' ? <LoaderCircle className="spin" size={15} /> : 'Search'}
              </Button>
            </form>
            {results && (
              <div className="knowledge-results">
                {!results.length ? (
                  <p className="field-help">No passages matched.</p>
                ) : (
                  results.map((r, i) => (
                    <article key={i}>
                      <strong>
                        {r.title} <small>Passage {r.chunkIndex + 1}</small>
                      </strong>
                      <p>{r.content}</p>
                    </article>
                  ))
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
