import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  CircleCheck,
  Clock3,
  Code2,
  Download,
  FileText,
  GitBranch,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Entity } from '../api';
import {
  Button,
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  IconButton,
  Modal,
  PageTitle,
  SaveForm,
  Status,
} from './ui';
import { Markdown, Trace } from './Playground';

type PageProps = {
  data: Data;
  refresh: () => Promise<void>;
  edit: (type: string, value?: Entity) => void;
  navigate: (page: string, target?: string) => void;
  act: (task: () => Promise<unknown>) => Promise<void>;
};
export function WorkflowsPage({ data, edit, navigate, act, refresh }: PageProps) {
  const [query, setQuery] = useState('');
  const workflows = data.workflows.filter((w) => w.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <PageTitle
        eyebrow="YOUR ORCHESTRATION WORKSPACE"
        title="From intent to action."
        text="Build focused agents. Connect their tools. Bring it all together."
        action={
          <Button onClick={() => edit('workflows')}>
            <Plus size={17} />
            Create workflow
          </Button>
        }
      />
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-icon">
            <GitBranch size={20} />
          </div>
          <div>
            <span>Workflows</span>
            <strong>{data.workflows.length}</strong>
          </div>
          <small>{data.workflows.filter((w) => w.enabled).length} enabled</small>
        </div>
        <div className="overview-card">
          <div className="overview-icon">
            <Bot size={20} />
          </div>
          <div>
            <span>Agents</span>
            <strong>{data.agents.length}</strong>
          </div>
          <small>{data.agents.filter((a) => a.enabled).length} ready to run</small>
        </div>
        <div className="overview-card">
          <div className="overview-icon">
            <Plug size={20} />
          </div>
          <div>
            <span>MCP connections</span>
            <strong>{data.connections.length}</strong>
          </div>
          <small>{data.connections.reduce((n, c) => n + (c.tools?.length ?? 0), 0)} discovered tools</small>
        </div>
      </div>
      <div className="section-toolbar">
        <div>
          <h2>
            Your workflows <span>{data.workflows.length}</span>
          </h2>
          <p>A clear path from a prompt to a useful result.</p>
        </div>
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="Search workflows"
            placeholder="Search workflows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {!data.workflows.length ? (
        <div className="workflow-empty">
          <div className="empty-flow-art">
            <div>
              <span className="art-icon">
                <Play size={18} />
              </span>
              <small>Input</small>
            </div>
            <i />
            <div className="art-agent">
              <Bot size={25} />
              <strong>Your agent</strong>
              <span>Reason · Connect · Act</span>
            </div>
            <i />
            <div>
              <span className="art-icon">
                <Check size={18} />
              </span>
              <small>Result</small>
            </div>
            <span className="art-tool">
              <Plug size={14} /> MCP tools
            </span>
          </div>
          <h2>Your first workflow starts here.</h2>
          <p>
            Bring agents, tools, and knowledge into one clear flow.
            <br />
            Start simple and build as your ideas grow.
          </p>
          <Button onClick={() => edit('workflows')}>
            <Plus size={16} />
            Create your first workflow
          </Button>
          <button className="text-button" onClick={() => navigate('agents')}>
            Browse reusable agents <ArrowRight size={14} />
          </button>
        </div>
      ) : (
        <div className="card-grid">
          {workflows.map((w) => (
            <article className="resource-card workflow-card" key={w.id}>
              <div className="card-top">
                <div className="resource-icon">
                  <GitBranch size={23} />
                </div>
                <Status status={w.enabled ? 'enabled' : 'disabled'} />
                <IconButton
                  title={`Delete ${w.name}`}
                  onClick={() => {
                    if (confirm(`Delete workflow “${w.name}”?`))
                      void act(async () => {
                        await api(`/workflows/${w.id}`, { method: 'DELETE' });
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <button className="card-name" onClick={() => edit('workflows', w)}>
                {w.name}
              </button>
              <p>{w.description || 'Agent orchestration workflow'}</p>
              <div className="flow-mini">
                {w.nodes.slice(0, 5).map((n: any, index: number) => (
                  <span key={n.id}>
                    {index > 0 && <i />}
                    {n.type === 'agent' ? (
                      <Bot size={15} />
                    ) : n.type === 'tool' ? (
                      <Plug size={15} />
                    ) : n.type === 'output' || n.type === 'finish' ? (
                      <Check size={15} />
                    ) : (
                      <GitBranch size={15} />
                    )}
                  </span>
                ))}
                <small>{w.nodes.length} steps</small>
              </div>
              <div className="card-footer">
                <small>
                  {w.schedule?.enabled ? (
                    <>
                      <Clock3 size={13} />
                      Every {w.schedule.everyMinutes} min
                    </>
                  ) : (
                    <>
                      <Clock3 size={13} />
                      {new Date(w.updatedAt).toLocaleDateString()}
                    </>
                  )}
                </small>
                <Button
                  variant="ghost"
                  onClick={() => navigate('playground', `workflow:${w.id}`)}
                  disabled={!w.enabled}
                >
                  <Play size={14} />
                  Run
                </Button>
                <Button variant="secondary" onClick={() => edit('workflows', w)}>
                  Open <ArrowUpRight size={14} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="workspace-note">
        <ShieldCheck size={17} />
        <span>Your workspace, your infrastructure. Agents run with the models and MCP tools you choose.</span>
      </div>
    </>
  );
}
export function AgentsPage({ data, edit, navigate, act, refresh }: PageProps) {
  return (
    <>
      <PageTitle
        eyebrow="PURPOSE-BUILT INTELLIGENCE"
        title="Your agents."
        text="Give each agent a role, a model, and the right tools for the job."
        action={
          <Button onClick={() => edit('agents')}>
            <Plus size={17} />
            Create agent
          </Button>
        }
      />
      {!data.agents.length ? (
        <Empty
          icon={<Bot size={30} />}
          title="A little focus goes a long way."
          text="Create your first agent, write its instructions, and connect the tools it can use."
          action={
            <Button onClick={() => edit('agents')}>
              <Plus size={16} />
              Create an agent
            </Button>
          }
        />
      ) : (
        <div className="card-grid">
          {data.agents.map((a, index) => (
            <article className="resource-card agent-card" key={a.id}>
              <div className="card-top">
                <div className={`agent-avatar tone-${index % 4}`}>
                  <Bot size={24} />
                </div>
                <Status status={a.enabled ? 'enabled' : 'disabled'} />
                <IconButton
                  title={`Delete ${a.name}`}
                  onClick={() => {
                    if (confirm(`Delete agent “${a.name}”?`))
                      void act(async () => {
                        await api(`/agents/${a.id}`, { method: 'DELETE' });
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <button className="card-name" onClick={() => edit('agents', a)}>
                {a.name}
              </button>
              <p>{a.description || a.systemPrompt.slice(0, 140)}</p>
              <div className="agent-model">
                <span className="model-dot" />
                {data.providers.find((p) => p.id === a.providerId)?.model ?? 'Provider unavailable'}
              </div>
              <div className="agent-bindings">
                <span>
                  <Plug size={14} />
                  {a.connections.reduce((n: number, b: any) => n + b.tools.length, 0)} tools
                </span>
                <span>
                  <BookOpen size={14} />
                  {a.knowledgeBaseIds.length} knowledge bases
                </span>
              </div>
              <div className="card-footer">
                <Button variant="secondary" onClick={() => edit('agents', a)}>
                  <Settings2 size={14} />
                  Configure
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => navigate('playground', `agent:${a.id}`)}
                  disabled={!a.enabled}
                >
                  Try in playground <ArrowRight size={14} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
export function ConnectionsPage({ data, edit, act, refresh }: PageProps) {
  const [busy, setBusy] = useState('');
  const [tools, setTools] = useState<Entity | null>(null);
  const perform = (id: string, task: () => Promise<unknown>) => {
    setBusy(id);
    void act(task).finally(() => setBusy(''));
  };
  return (
    <>
      <PageTitle
        eyebrow="ONE PROTOCOL. EVERY POSSIBILITY."
        title="MCP connections."
        text="Connect any MCP server, discover its tools, and make them available to your agents."
        action={
          <Button onClick={() => edit('connections')}>
            <Plus size={17} />
            Connect a server
          </Button>
        }
      />
      <div className="connection-banner">
        <div className="connection-banner-icon">
          <Plug size={28} />
        </div>
        <div>
          <strong>An open door to your tools.</strong>
          <p>
            Streamable HTTP and SSE, with token or OAuth authentication. Every external tool connects through
            MCP.
          </p>
        </div>
        <span className="protocol-badge">MODEL CONTEXT PROTOCOL</span>
      </div>
      {!data.connections.length ? (
        <Empty
          icon={<Plug size={30} />}
          title="Connect your first MCP server."
          text="Bring search, data, internal services, and other tools into your agents through a single protocol."
          action={
            <Button onClick={() => edit('connections')}>
              <Plus size={16} />
              Connect a server
            </Button>
          }
        />
      ) : (
        <div className="connection-list">
          {data.connections.map((c) => (
            <article className="connection-row" key={c.id}>
              <div className="resource-icon">
                <Plug size={23} />
              </div>
              <div className="connection-description">
                <button className="card-name" onClick={() => edit('connections', c)}>
                  {c.name}
                </button>
                <span>{c.url}</span>
                <div className="tag-row">
                  <span>{c.transport === 'http' ? 'Streamable HTTP' : 'SSE'}</span>
                  <span>
                    <KeyRound size={11} />
                    {c.authType === 'oauth'
                      ? c.authorized
                        ? 'OAuth connected'
                        : 'OAuth required'
                      : c.authType === 'token'
                        ? 'Access token'
                        : 'No auth'}
                  </span>
                  <button onClick={() => setTools(c)}>{c.tools?.length ?? 0} tools</button>
                </div>
              </div>
              <div className="connection-actions">
                {c.authType === 'oauth' && (
                  <Button
                    variant="secondary"
                    disabled={busy === c.id}
                    onClick={() =>
                      perform(c.id, async () => {
                        const r = await send(`/connections/${c.id}/oauth`);
                        if (r.authorizationUrl) location.assign(r.authorizationUrl);
                        else await refresh();
                      })
                    }
                  >
                    <KeyRound size={14} />
                    {c.authorized ? 'Reauthorize' : 'Authorize'}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy === c.id}
                  onClick={() =>
                    perform(c.id, async () => {
                      await send(`/connections/${c.id}/discover`);
                      await refresh();
                    })
                  }
                >
                  {busy === c.id ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
                  Discover tools
                </Button>
                <IconButton title={`Edit ${c.name}`} onClick={() => edit('connections', c)}>
                  <Settings2 size={17} />
                </IconButton>
                <IconButton
                  title={`Delete ${c.name}`}
                  onClick={() => {
                    if (confirm(`Delete MCP connection “${c.name}”?`))
                      void act(async () => {
                        await api(`/connections/${c.id}`, { method: 'DELETE' });
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </article>
          ))}
        </div>
      )}
      {tools && (
        <Modal title={`${tools.name} · discovered tools`} onClose={() => setTools(null)} wide>
          <div className="form-content">
            {!tools.tools?.length ? (
              <p>No tools discovered yet.</p>
            ) : (
              tools.tools.map((t: any) => (
                <details className="tool-group" key={t.name}>
                  <summary>{t.name}</summary>
                  <p>{t.description}</p>
                  <pre>{JSON.stringify(t.inputSchema, null, 2)}</pre>
                </details>
              ))
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
export function KnowledgePage({ data, edit, act, refresh }: PageProps) {
  const [selected, setSelected] = useState(data.knowledge[0]?.id ?? '');
  const [documents, setDocuments] = useState<Entity[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const kb = data.knowledge.find((k) => k.id === selected);
  useEffect(() => {
    if (!data.knowledge.some((k) => k.id === selected)) setSelected(data.knowledge[0]?.id ?? '');
  }, [data.knowledge]);
  async function load() {
    if (selected) setDocuments(await api(`/knowledge/${selected}/documents`));
  }
  useEffect(() => {
    if (!selected) {
      setDocuments([]);
      return;
    }
    let cancelled = false;
    const update = async () => {
      try {
        const d = await api(`/knowledge/${selected}/documents`);
        if (!cancelled) {
          setDocuments(d);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    };
    setResults(null);
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected]);
  async function upload(files: FileList | null) {
    if (!files?.length || !kb) return;
    setLoading(true);
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
      setLoading(false);
      if (file.current) file.current.value = '';
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="GROUNDED IN YOUR KNOWLEDGE"
        title="A library for your agents."
        text="Turn documents into searchable context, stored on your own infrastructure."
        action={
          <Button onClick={() => edit('knowledge')}>
            <Plus size={17} />
            New knowledge base
          </Button>
        }
      />
      {!data.knowledge.length ? (
        <Empty
          icon={<BookOpen size={30} />}
          title="Give your agents something to build on."
          text="Create a knowledge base, choose an embedding model, and upload your source documents."
          action={
            <Button onClick={() => edit('knowledge')}>
              <Plus size={16} />
              Create knowledge base
            </Button>
          }
        />
      ) : (
        <div className="knowledge-layout">
          <aside className="knowledge-nav">
            <div className="eyebrow">KNOWLEDGE BASES</div>
            {data.knowledge.map((k) => (
              <button
                className={selected === k.id ? 'active' : ''}
                key={k.id}
                onClick={() => setSelected(k.id)}
              >
                <BookOpen size={17} />
                <span>{k.name}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </aside>
          <div className="knowledge-content">
            <div className="section-toolbar">
              <div>
                <h2>{kb?.name}</h2>
                <p>
                  {kb?.description || 'Documents are indexed in the background and available when ready.'}
                </p>
              </div>
              <div className="row-actions">
                <IconButton title="Edit knowledge base" onClick={() => kb && edit('knowledge', kb)}>
                  <Settings2 size={17} />
                </IconButton>
                <IconButton
                  title="Delete knowledge base"
                  onClick={() => {
                    if (kb && confirm(`Delete “${kb.name}”? Remove its documents and agent bindings first.`))
                      void act(async () => {
                        await api(`/knowledge/${kb.id}`, { method: 'DELETE' });
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={17} />
                </IconButton>
                <Button variant="secondary" disabled={loading} onClick={() => file.current?.click()}>
                  {loading ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}Upload files
                </Button>
              </div>
            </div>
            <input
              ref={file}
              type="file"
              hidden
              multiple
              accept=".txt,.md,.csv,.json,.yaml,.yml,.pdf,.docx"
              onChange={(e) => void upload(e.target.files)}
            />
            <ErrorNotice error={error} />
            {!documents.length ? (
              <button
                className="upload-dropzone"
                onClick={() => file.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void upload(e.dataTransfer.files);
                }}
              >
                <Upload size={30} />
                <strong>Drop your files here</strong>
                <span>or click to browse</span>
                <small>TXT, Markdown, CSV, JSON, YAML, PDF and DOCX</small>
              </button>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Status</th>
                      <th>Size</th>
                      <th>Chunks</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <div className="document-name">
                            <FileText size={17} />
                            <div>
                              <strong>{d.filename}</strong>
                              {d.error && <small className="error-text">{d.error}</small>}
                            </div>
                          </div>
                        </td>
                        <td>
                          <Status status={d.status} />
                        </td>
                        <td>{Math.max(1, Math.round(d.size / 1024))} KB</td>
                        <td>{d.chunks ?? '—'}</td>
                        <td>
                          <div className="row-actions">
                            <a
                              className="icon-button"
                              href={`/api/documents/${d.id}/download`}
                              title="Download document"
                            >
                              <Download size={15} />
                            </a>
                            <IconButton
                              title="Reindex document"
                              disabled={!['ready', 'failed'].includes(d.status)}
                              onClick={() =>
                                void act(async () => {
                                  await send(`/documents/${d.id}/reindex`);
                                  await load();
                                })
                              }
                            >
                              <RefreshCw size={15} />
                            </IconButton>
                            <IconButton
                              title="Delete document"
                              onClick={() => {
                                if (confirm(`Delete “${d.filename}”?`))
                                  void act(async () => {
                                    await api(`/documents/${d.id}`, { method: 'DELETE' });
                                    await load();
                                  });
                              }}
                            >
                              <Trash2 size={15} />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="knowledge-search">
              <h3>
                <Search size={17} />
                Test retrieval
              </h3>
              <p>See which passages your agents will find for a question.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setLoading(true);
                  void act(async () =>
                    setResults(await send(`/knowledge/${selected}/search`, { query })),
                  ).finally(() => setLoading(false));
                }}
              >
                <input
                  aria-label="Search knowledge"
                  placeholder="Ask a question about your documents…"
                  required
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button disabled={loading}>Search</Button>
              </form>
              {results && (
                <div className="knowledge-results">
                  {!results.length ? (
                    <p>No passages found. Ensure your documents have finished indexing.</p>
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
          </div>
        </div>
      )}
    </>
  );
}
export function RunsPage() {
  const [runs, setRuns] = useState<any[]>([]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const r = await api(`/runs?page=${page}`);
        if (!stopped) setRuns(r);
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [page]);
  useEffect(() => {
    if (!selected?.id) return;
    let stopped = false;
    const load = async () => {
      try {
        const r = await api(`/runs/${selected.id}`);
        if (!stopped) setSelected(r);
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selected?.id]);
  return (
    <>
      <PageTitle
        eyebrow="A CLEAR VIEW OF THE WORK"
        title="Executions."
        text="Inspect inputs, outputs, tool calls, and the steps behind each result."
      />
      <ErrorNotice error={error} />
      {!runs.length ? (
        <Empty
          icon={<Activity size={30} />}
          title="Your runs will appear here."
          text="Start an agent in the playground or call the API to see its execution history."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent / workflow</th>
                <th>Status</th>
                <th>Input</th>
                <th>Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <strong>{run.label}</strong>
                    <small className="table-subtitle mono">{run.id.slice(0, 8)}</small>
                  </td>
                  <td>
                    <Status status={run.status} />
                  </td>
                  <td className="truncate-cell">{run.input}</td>
                  <td>{timestamp(run.createdAt)}</td>
                  <td>
                    <Button variant="ghost" onClick={() => setSelected(run)}>
                      Inspect <ArrowUpRight size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <span>Page {page + 1}</span>
        <Button variant="secondary" disabled={runs.length < 50} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </div>
      {selected && (
        <Modal title={selected.label} onClose={() => setSelected(null)} wide>
          <div className="form-content">
            <div className="run-detail-head">
              <Status status={selected.status} />
              <code>{selected.id}</code>
              {['queued', 'running'].includes(selected.status) && (
                <Button
                  variant="danger"
                  onClick={() =>
                    void send(`/runs/${selected.id}/cancel`).catch((e) => setError(errorMessage(e)))
                  }
                >
                  Cancel run
                </Button>
              )}
            </div>
            <Field label="Input">
              <pre>{selected.input}</pre>
            </Field>
            {selected.output && (
              <Field label="Output">
                <Markdown text={selected.output} />
              </Field>
            )}
            <ErrorNotice error={selected.error} />
            <h3>Execution trace</h3>
            <Trace events={selected.events ?? []} />
          </div>
        </Modal>
      )}
    </>
  );
}
