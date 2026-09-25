import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  GitBranch,
  KeyRound,
  LoaderCircle,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Entity } from '../api';
import { Button, Empty, ErrorNotice, Field, IconButton, Modal, PageTitle, Status } from './ui';
import { Markdown, Trace } from './Playground';
import { patternDescriptions } from '../../../../packages/core/src/patterns.js';

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
        eyebrow="Your orchestration workspace"
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
            Start from a template: a single tool assistant, a research-and-review pair, a planner with
            specialists, or a router that hands requests to the right agent.
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
                {w.nodes.slice(0, 6).map((n: any, index: number) => (
                  <span key={n.id} title={n.name}>
                    {index > 0 && <i />}
                    {n.type === 'agent' ? (
                      <Bot size={15} />
                    ) : n.type === 'tool' ? (
                      <Plug size={15} />
                    ) : n.type === 'output' || n.type === 'finish' ? (
                      <Check size={15} />
                    ) : n.type === 'start' ? (
                      <Play size={15} />
                    ) : (
                      <GitBranch size={15} />
                    )}
                  </span>
                ))}
                <small>
                  {w.nodes.filter((n: any) => n.type === 'agent').length} agents · {w.nodes.length} steps
                </small>
              </div>
              <div className="card-footer">
                <small>
                  <Clock3 size={13} />
                  {w.schedule?.enabled
                    ? `Every ${w.schedule.everyMinutes} min`
                    : new Date(w.updatedAt).toLocaleDateString()}
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
        eyebrow="Purpose-built intelligence"
        title="Your agents."
        text="Give each agent a role, a model, a reasoning pattern, and the right tools for the job."
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
          text="Start from a template: assistant, researcher, planner, reflective writer, autonomous worker, reviewer or support agent."
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
                <span className="status next">
                  {patternDescriptions[(a.pattern ?? 'react') as keyof typeof patternDescriptions]?.name ??
                    a.pattern}
                </span>
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

function ToolChips({ connection, onInspect }: { connection: Entity; onInspect: (tool: any) => void }) {
  const [expanded, setExpanded] = useState(false);
  const tools: any[] = connection.tools ?? [];
  if (!tools.length)
    return (
      <p className="tools-empty">
        No tools discovered yet.{' '}
        {connection.authType === 'oauth' && !connection.authorized
          ? 'Authorize, then discover.'
          : 'Click Discover tools.'}
      </p>
    );
  const shown = expanded ? tools : tools.slice(0, 8);
  return (
    <div className="tool-chips">
      {shown.map((t) => (
        <button
          type="button"
          className="tool-chip"
          key={t.name}
          title={t.description}
          onClick={() => onInspect(t)}
        >
          <Wrench size={11} />
          {t.name}
        </button>
      ))}
      {tools.length > 8 && (
        <button type="button" className="tool-chip more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `+${tools.length - 8} more`}
        </button>
      )}
    </div>
  );
}
export function ConnectionsPage({ data, edit, act, refresh }: PageProps) {
  const [busy, setBusy] = useState('');
  const [inspect, setInspect] = useState<{ connection: Entity; tool: any } | null>(null);
  const [notice, setNotice] = useState('');
  const perform = (id: string, task: () => Promise<unknown>) => {
    setBusy(id);
    void act(task).finally(() => setBusy(''));
  };
  async function discover(id: string) {
    const tools = await send(`/connections/${id}/discover`);
    await refresh();
    return tools as any[];
  }
  // The OAuth callback lands here (directly, or via a popup that posts a message); finish the job automatically.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const finish = async (connection?: string | null) => {
      if (!connection) return;
      setNotice('Authorized. Discovering tools…');
      try {
        const tools = await discover(connection);
        setNotice(`Authorized and discovered ${tools.length} tools.`);
      } catch (e) {
        setNotice(`Authorized, but discovery failed: ${errorMessage(e)}`);
      }
    };
    if (params.get('authorized') === '1') {
      history.replaceState({}, '', '/connections');
      void finish(params.get('connection'));
    }
    const listener = (event: MessageEvent) => {
      if (event.origin === location.origin && event.data?.type === 'agentic-oauth')
        void finish(event.data.connection);
    };
    addEventListener('message', listener);
    return () => removeEventListener('message', listener);
  }, []);
  function authorize(c: Entity) {
    const popup = window.open('about:blank', 'agentic-mcp-authorization', 'width=640,height=760');
    perform(c.id, async () => {
      try {
        const result = await send(`/connections/${c.id}/oauth`);
        if (result.authorizationUrl && popup) popup.location.href = result.authorizationUrl;
        else {
          popup?.close();
          await discover(c.id);
        }
      } catch (e) {
        popup?.close();
        throw e;
      }
    });
  }
  return (
    <>
      <PageTitle
        eyebrow="One protocol. Every possibility."
        title="MCP connections."
        text="Connect any MCP server, discover its tools, and decide exactly which ones each agent may call."
        action={
          <Button onClick={() => edit('connections')}>
            <Plus size={17} />
            Connect a server
          </Button>
        }
      />
      {notice && (
        <div className="notice">
          <Check size={16} />
          <span>{notice}</span>
        </div>
      )}
      <div className="explainer-grid">
        <div className="explainer">
          <span className="eyebrow">1 · Connect</span>
          <strong>Paste the server URL</strong>
          <p>
            Streamable HTTP or SSE. Add an API key, or sign in with OAuth for servers like Finnhub or GitHub.
          </p>
        </div>
        <div className="explainer">
          <span className="eyebrow">2 · Discover</span>
          <strong>See every tool it offers</strong>
          <p>Tools and their input schemas are read from the server and shown right here on the card.</p>
        </div>
        <div className="explainer">
          <span className="eyebrow">3 · Grant</span>
          <strong>Pick tools per agent</strong>
          <p>
            In an agent or on the workflow canvas, choose the exact tools that agent may call. Nothing else is
            exposed.
          </p>
        </div>
      </div>
      {!data.connections.length ? (
        <Empty
          icon={<Plug size={30} />}
          title="Connect your first MCP server."
          text="Bring search, market data, internal services, and other tools into your agents through a single protocol."
          action={
            <Button onClick={() => edit('connections')}>
              <Plus size={16} />
              Connect a server
            </Button>
          }
        />
      ) : (
        <div className="connection-list">
          {data.connections.map((c) => {
            const authState =
              c.authType === 'oauth'
                ? c.authorized
                  ? { label: 'OAuth connected', status: 'enabled' }
                  : { label: 'Authorization needed', status: 'pending' }
                : c.authType === 'token'
                  ? { label: 'API key', status: 'enabled' }
                  : { label: 'No auth', status: 'enabled' };
            return (
              <article
                className={`connection-row connection-card ${c.enabled ? '' : 'is-disabled'}`}
                key={c.id}
              >
                <div className="resource-icon">
                  <Plug size={23} />
                </div>
                <div className="connection-description">
                  <div className="connection-title">
                    <button className="card-name" onClick={() => edit('connections', c)}>
                      {c.name}
                    </button>
                    <span className={`status ${authState.status}`}>{authState.label}</span>
                    <span className={`status ${c.tools?.length ? 'next' : 'disabled'}`}>
                      {c.tools?.length ?? 0} tools
                    </span>
                    {!c.enabled && <Status status="disabled" />}
                  </div>
                  <span>{c.url}</span>
                  <div className="tag-row">
                    <span>{c.transport === 'http' ? 'Streamable HTTP' : 'Legacy SSE'}</span>
                    {c.lastCheckedAt && <span>Discovered {timestamp(c.lastCheckedAt)}</span>}
                  </div>
                  <ToolChips connection={c} onInspect={(tool) => setInspect({ connection: c, tool })} />
                </div>
                <div className="connection-actions">
                  {c.authType === 'oauth' && (
                    <Button
                      variant={c.authorized ? 'secondary' : 'primary'}
                      disabled={busy === c.id}
                      onClick={() => authorize(c)}
                    >
                      <KeyRound size={14} />
                      {c.authorized ? 'Reauthorize' : 'Authorize'}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={busy === c.id}
                    onClick={() => perform(c.id, () => discover(c.id))}
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
            );
          })}
        </div>
      )}
      {inspect && (
        <Modal
          title={`${inspect.connection.name} / ${inspect.tool.name}`}
          onClose={() => setInspect(null)}
          wide
        >
          <div className="form-content">
            <p className="field-help">
              {inspect.tool.description || 'No description provided by the server.'}
            </p>
            <h3>Input schema</h3>
            <pre className="tool-schema">{JSON.stringify(inspect.tool.inputSchema, null, 2)}</pre>
            <p className="field-help">
              Agents receive this schema with the tool. Every call is checked against it before it leaves the
              runner.
            </p>
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
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const kb = data.knowledge.find((k) => k.id === selected);
  const provider = data.providers.find((p) => p.id === kb?.providerId);
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
  const ready = documents.filter((d) => d.status === 'ready').length;
  const indexing = documents.filter((d) => ['queued', 'indexing'].includes(d.status)).length;
  const chunks = documents.reduce((n, d) => n + (d.chunks ?? 0), 0);
  return (
    <>
      <PageTitle
        eyebrow="Grounded in your knowledge"
        title="Knowledge bases."
        text="Upload documents, index them on your own infrastructure, and let agents cite them."
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
          text="Create a knowledge base, choose an embedding model, and upload your source documents. TXT, Markdown, CSV, JSON, YAML, PDF and DOCX are supported."
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
            <div className="eyebrow">Knowledge bases</div>
            {data.knowledge.map((k) => (
              <button
                className={selected === k.id ? 'active' : ''}
                key={k.id}
                onClick={() => setSelected(k.id)}
              >
                <BookOpen size={17} />
                <span>{k.name}</span>
                <ChevronRight size={14} />
              </button>
            ))}
            <button className="knowledge-nav-add" onClick={() => edit('knowledge')}>
              <Plus size={15} />
              <span>New knowledge base</span>
            </button>
          </aside>
          <div className="knowledge-content">
            <div className="section-toolbar">
              <div>
                <h2>{kb?.name}</h2>
                <p>
                  {kb?.description ||
                    'Documents are indexed in the background and used as soon as they are ready.'}
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
                  {loading ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
                  Upload files
                </Button>
              </div>
            </div>
            <div className="kb-stats">
              <div>
                <span className="eyebrow">Documents</span>
                <strong>{documents.length}</strong>
              </div>
              <div>
                <span className="eyebrow">Ready</span>
                <strong>{ready}</strong>
                {indexing > 0 && <small>{indexing} indexing</small>}
              </div>
              <div>
                <span className="eyebrow">Passages</span>
                <strong>{chunks}</strong>
              </div>
              <div>
                <span className="eyebrow">Embedding model</span>
                <strong className="kb-provider">{provider ? provider.embeddingModel : 'Unavailable'}</strong>
                {provider && <small>{provider.name}</small>}
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
            <button
              className={`upload-dropzone ${documents.length ? 'compact' : ''} ${dragging ? 'dragging' : ''}`}
              onClick={() => file.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void upload(e.dataTransfer.files);
              }}
            >
              <Upload size={documents.length ? 18 : 30} />
              <strong>
                {documents.length ? 'Drop more files here, or click to browse' : 'Drop your files here'}
              </strong>
              {!documents.length && <span>or click to browse</span>}
              <small>TXT, Markdown, CSV, JSON, YAML, PDF and DOCX · up to the configured upload limit</small>
            </button>
            {documents.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Status</th>
                      <th>Size</th>
                      <th>Passages</th>
                      <th>Added</th>
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
                        <td>{timestamp(d.createdAt)}</td>
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
          </div>
          <aside className="knowledge-search">
            <h3>
              <Search size={17} />
              Test retrieval
            </h3>
            <p>Ask a question and see the exact passages an agent would receive.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearching(true);
                void act(async () =>
                  setResults(await send(`/knowledge/${selected}/search`, { query })),
                ).finally(() => setSearching(false));
              }}
            >
              <input
                aria-label="Search knowledge"
                placeholder="Ask a question about your documents…"
                required
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button disabled={searching || !ready}>
                {searching ? <LoaderCircle className="spin" size={15} /> : 'Search'}
              </Button>
            </form>
            {!ready && (
              <p className="field-help">Upload a document and wait for it to be ready to test retrieval.</p>
            )}
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
          </aside>
        </div>
      )}
    </>
  );
}
export function RunsPage() {
  const [runs, setRuns] = useState<any[]>([]);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('all');
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
  const visible = runs.filter((r) => filter === 'all' || r.status === filter);
  const counts = runs.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {},
  );
  return (
    <>
      <PageTitle
        eyebrow="A clear view of the work"
        title="Executions."
        text="Every run from the playground, the API, webhooks, schedules and embeds, with its full trace."
      />
      <ErrorNotice error={error} />
      <div className="filter-row">
        {['all', 'running', 'queued', 'succeeded', 'failed', 'interrupted', 'cancelled'].map((s) => (
          <button
            key={s}
            className={`filter-chip ${filter === s ? 'active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s}
            {s !== 'all' && counts[s] ? <small>{counts[s]}</small> : null}
          </button>
        ))}
      </div>
      {!visible.length ? (
        <Empty
          icon={<Activity size={30} />}
          title={runs.length ? 'No runs match this filter.' : 'Your runs will appear here.'}
          text={
            runs.length
              ? 'Pick another status.'
              : 'Start an agent in the playground or call the API to see its execution history.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent / workflow</th>
                <th>Status</th>
                <th>Input</th>
                <th>Trigger</th>
                <th>Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => (
                <tr key={run.id}>
                  <td>
                    <strong>{run.label}</strong>
                    <small className="table-subtitle mono">{run.id.slice(0, 8)}</small>
                  </td>
                  <td>
                    <Status status={run.status} />
                    {run.resumeCount ? (
                      <small className="table-subtitle">resumed {run.resumeCount}×</small>
                    ) : null}
                  </td>
                  <td className="truncate-cell">{run.input}</td>
                  <td>{run.trigger ?? 'studio'}</td>
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
            {selected.partial && !selected.output && (
              <Field label="Streaming">
                <Markdown text={selected.partial} />
              </Field>
            )}
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
