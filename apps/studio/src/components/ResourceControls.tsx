import { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Upload } from 'lucide-react';
import { api, defaultProviderId, errorMessage, send, type Data, type Entity } from '../api';
import { Button, ErrorNotice, Field } from './ui';
import { ConnectionEditor, KnowledgeEditor, ProviderEditor } from './editors';

type Base = { data: Data; refresh: () => Promise<void> };
export function ProviderControl({
  data,
  refresh,
  value,
  onChange,
}: Base & { value: string; onChange: (id: string) => void }) {
  const [adding, setAdding] = useState(false),
    [editing, setEditing] = useState(false);
  return (
    <>
      <Field label="Model provider">
        <select aria-label="Workflow model provider" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a model</option>
          {data.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model}
              {p.id === defaultProviderId(data) ? ' · default' : ''}
            </option>
          ))}
        </select>
      </Field>
      <button
        className="text-button"
        onClick={() => {
          setEditing(false);
          setAdding(true);
        }}
      >
        <Plus size={14} /> Add model provider
      </button>
      {value && (
        <button
          className="text-button"
          onClick={() => {
            setEditing(true);
            setAdding(true);
          }}
        >
          Edit selected provider
        </button>
      )}
      {adding && (
        <ProviderEditor
          value={editing ? data.providers.find((p) => p.id === value) : undefined}
          data={data}
          onClose={() => setAdding(false)}
          onSaved={async (p) => {
            await refresh();
            if (p) onChange(p.id);
          }}
        />
      )}
    </>
  );
}
export function McpControl({
  data,
  refresh,
  connectionId,
  tools,
  onChange,
}: Base & { connectionId: string; tools: string[]; onChange: (id: string, tools: string[]) => void }) {
  const [adding, setAdding] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState('');
  const connection = data.connections.find((c) => c.id === connectionId);
  // The OAuth popup posts back when the provider redirects to the callback; finish with discovery.
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== 'agentic-oauth' || !event.data.connection)
        return;
      void action(async () => {
        await send(`/connections/${event.data.connection}/discover`, {});
        await refresh();
      });
    };
    addEventListener('message', listener);
    return () => removeEventListener('message', listener);
  }, []);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Field label="MCP connection">
        <select
          aria-label="Resource MCP connection"
          value={connectionId}
          onChange={(e) => onChange(e.target.value, [])}
        >
          <option value="">Choose a server</option>
          {data.connections
            .filter((c) => c.enabled)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </Field>
      <div className="compact-actions">
        <button className="text-button" onClick={() => setAdding(true)}>
          <Plus size={14} /> Connect server
        </button>
        {connection && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await send(`/connections/${connection.id}/discover`, {});
                await refresh();
              })
            }
          >
            <RefreshCw size={14} /> Discover tools
          </button>
        )}
        {connection?.authType === 'oauth' && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              const popup = window.open('about:blank', 'agentic-mcp-authorization', 'width=620,height=740');
              void action(async () => {
                try {
                  const result = await send(`/connections/${connection.id}/oauth`);
                  if (result.authorizationUrl && popup) popup.location.href = result.authorizationUrl;
                  else {
                    popup?.close();
                    await refresh();
                  }
                } catch (e) {
                  popup?.close();
                  throw e;
                }
              });
            }}
          >
            <KeyRound size={14} /> Authorize
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      {connection && (
        <>
          <p className="field-help">Tools the agent may call.</p>
          {connection.tools?.length > 0 ? (
            <div className="resource-tool-picker">
              <input
                aria-label="Filter MCP tools"
                placeholder="Find a tool…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="compact-actions">
                <button
                  className="text-button"
                  onClick={() =>
                    onChange(
                      connectionId,
                      connection.tools.map((t: any) => t.name),
                    )
                  }
                >
                  Select all
                </button>
                <button className="text-button" onClick={() => onChange(connectionId, [])}>
                  Clear
                </button>
                <small>{tools.length} selected</small>
              </div>
              {connection.tools
                .filter((t: any) => `${t.name} ${t.description}`.toLowerCase().includes(search.toLowerCase()))
                .map((t: any) => (
                  <label className="tool-choice" key={t.name}>
                    <input
                      type="checkbox"
                      checked={tools.includes(t.name)}
                      onChange={(e) =>
                        onChange(
                          connectionId,
                          e.target.checked ? [...tools, t.name] : tools.filter((v) => v !== t.name),
                        )
                      }
                    />
                    <span>
                      <strong>{t.name}</strong>
                      <small>{t.description ?? 'MCP tool'}</small>
                    </span>
                  </label>
                ))}
            </div>
          ) : (
            <p className="notice">Discover tools to select them here.</p>
          )}
        </>
      )}
      {adding && (
        <ConnectionEditor
          data={data}
          onClose={() => setAdding(false)}
          onSaved={async (c) => {
            await refresh();
            if (c) onChange(c.id, []);
          }}
        />
      )}
    </>
  );
}
export function KnowledgeControl({
  data,
  refresh,
  value,
  onChange,
}: Base & { value: string; onChange: (id: string) => void }) {
  const [adding, setAdding] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [documents, setDocuments] = useState<Entity[]>([]);
  useEffect(() => {
    let done = false;
    const load = async () => {
      if (!value) {
        setDocuments([]);
        return;
      }
      try {
        const docs = await api(`/knowledge/${value}/documents`);
        if (!done) setDocuments(docs);
      } catch (e) {
        if (!done) setError(errorMessage(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      done = true;
      clearInterval(timer);
    };
  }, [value]);
  return (
    <>
      <Field label="Knowledge base">
        <select aria-label="Resource knowledge base" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a knowledge base</option>
          {data.knowledge.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </Field>
      <button className="text-button" onClick={() => setAdding(true)}>
        <Plus size={14} /> Create knowledge base
      </button>
      {value && (
        <>
          <label className="upload-inline">
            <Upload size={15} /> {busy ? 'Uploading…' : 'Upload reference files'}
            <input
              aria-label="Upload workflow knowledge"
              type="file"
              multiple
              disabled={busy}
              accept=".txt,.md,.csv,.json,.yaml,.yml,.pdf,.docx"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                setError('');
                setBusy(true);
                try {
                  for (const file of files) {
                    const form = new FormData();
                    form.append('file', file);
                    await api(`/knowledge/${value}/documents`, { method: 'POST', body: form });
                  }
                  setDocuments(await api(`/knowledge/${value}/documents`));
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          <div className="knowledge-readiness">
            {documents.length ? (
              documents.map((d) => (
                <div key={d.id}>
                  <span>{d.filename}</span>
                  <strong className={d.status === 'ready' ? 'ready' : ''}>{d.status}</strong>
                </div>
              ))
            ) : (
              <p>No documents yet.</p>
            )}
          </div>
        </>
      )}
      <ErrorNotice error={error} />
      {adding && (
        <KnowledgeEditor
          data={data}
          onClose={() => setAdding(false)}
          onSaved={async (k) => {
            await refresh();
            if (k) onChange(k.id);
          }}
        />
      )}
    </>
  );
}
