import { useEffect, useState } from 'react';
import { api, errorMessage, send } from '../api';
import { Button, ErrorNotice } from './ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Evidence stays attached to its query; promoted notes are managed in the Knowledge page. */
export function TaskMemory({ runId }: { runId?: string }) {
  const [notes, setNotes] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [next, setNext] = useState<number>();
  const [selected, setSelected] = useState<any>();
  const [longTerm, setLongTerm] = useState(false);
  const [error, setError] = useState('');
  const [promoted, setPromoted] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    setSelected(undefined);
    setNotes([]);
    setNext(undefined);
    setError('');
    setPromoted('');
    if (runId)
      void api(`/runs/${runId}/memory`)
        .then((data) => {
          if (!stopped) {
            setNotes(data.notes);
            setNext(data.next_offset);
            setLongTerm(data.longTermAvailable);
          }
        })
        .catch((e) => {
          if (!stopped) setError(errorMessage(e));
        });
    return () => {
      stopped = true;
    };
  }, [runId]);
  async function search(offset = 0) {
    if (!runId) return;
    setError('');
    try {
      const data = await api(`/runs/${runId}/memory?query=${encodeURIComponent(query)}&offset=${offset}`);
      setNotes((prior) => (offset ? [...prior, ...data.notes] : data.notes));
      setNext(data.next_offset);
      setLongTerm(data.longTermAvailable);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function read(noteId: string, offset = 0) {
    setError('');
    setPromoted('');
    try {
      setSelected(await api(`/runs/${runId}/memory/${noteId}?offset=${offset}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function promote() {
    setBusy(true);
    setError('');
    try {
      const saved = await send(`/runs/${runId}/memory/${selected.note_id}/promote`);
      setPromoted(`Saved to long-term memory: ${saved.path}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!runId) return <p className="field-help">Run a query to open its task notebook.</p>;
  return (
    <div className="task-memory">
      <p className="field-help">
        Notes shared by this query’s agents. Temporary notes expire after seven days; promote useful findings
        to retain them across queries.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Search task memory"
          value={query}
          placeholder="Search notes"
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit">Search / refresh</Button>
      </form>
      <ErrorNotice error={error} />
      {!notes.length && <p className="field-help">No matching task notes yet.</p>}
      {notes.map((note) => (
        <button
          type="button"
          className="history-item"
          key={note.note_id}
          onClick={() => void read(note.note_id)}
        >
          <strong>{note.title}</strong>
          <small>
            {note.kind} · {note.agent}
          </small>
          <small>{note.snippet.slice(0, 180)}</small>
        </button>
      ))}
      {next !== undefined && <Button onClick={() => void search(next)}>More notes</Button>}
      {selected && (
        <section className="trace-output">
          <h3>{selected.title}</h3>
          <small>
            Characters {selected.offset + 1}–{selected.offset + selected.content.length} of{' '}
            {selected.total_chars}
          </small>
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown>
          </div>
          {selected.offset > 0 && (
            <Button onClick={() => void read(selected.note_id, Math.max(0, selected.offset - 4000))}>
              Previous page
            </Button>
          )}
          {selected.next_offset !== undefined && (
            <Button onClick={() => void read(selected.note_id, selected.next_offset)}>Next page</Button>
          )}
          {longTerm ? (
            <Button disabled={busy || Boolean(promoted)} onClick={() => void promote()}>
              Keep in long-term memory
            </Button>
          ) : (
            <p className="field-help">
              Select a long-term knowledge workspace in workflow settings to retain notes across queries.
            </p>
          )}
          {promoted && <p role="status">{promoted}</p>}
        </section>
      )}
    </div>
  );
}
