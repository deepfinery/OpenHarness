import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  Clock3,
  GitBranch,
  KeyRound,
  LoaderCircle,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Wrench,
} from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Entity } from '../api';
import { Button, Empty, ErrorNotice, Field, IconButton, Modal, PageTitle, Status } from './ui';
import { Markdown, Trace } from './Playground';
import { describeSchedule } from '../../../../packages/core/src/schedule.js';

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
        title="Workflows"
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
            <Plug size={20} />
          </div>
          <div>
            <span>MCP connections</span>
            <strong>{data.connections.length}</strong>
          </div>
          <small>{data.connections.reduce((n, c) => n + (c.tools?.length ?? 0), 0)} tools</small>
        </div>
        <div className="overview-card">
          <div className="overview-icon">
            <BookOpen size={20} />
          </div>
          <div>
            <span>Knowledge bases</span>
            <strong>{data.knowledge.length}</strong>
          </div>
          <small>{data.workflows.filter((w) => w.schedule?.enabled).length} scheduled workflows</small>
        </div>
      </div>
      <div className="section-toolbar">
        <div>
          <h2>
            All workflows <span>{data.workflows.length}</span>
          </h2>
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
          <h2>Create your first workflow</h2>
          <p>Start from a template, then adjust the agents, tools and steps on the canvas.</p>
          <Button onClick={() => edit('workflows')}>
            <Plus size={16} />
            Create workflow
          </Button>
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
              <p>{w.description || 'No description'}</p>
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
                  {(() => {
                    const agents = w.nodes.filter((n: any) => n.type === 'agent').length;
                    return `${agents} agent${agents === 1 ? '' : 's'} · ${w.nodes.length} steps`;
                  })()}
                </small>
              </div>
              <div className="card-footer">
                <small>
                  <Clock3 size={13} />
                  {w.schedule?.enabled
                    ? describeSchedule(w.schedule)
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
      if (event.origin === location.origin && event.data?.type === 'openharness-oauth')
        void finish(event.data.connection);
    };
    addEventListener('message', listener);
    return () => removeEventListener('message', listener);
  }, []);
  function authorize(c: Entity) {
    const popup = window.open('about:blank', 'openharness-mcp-authorization', 'width=640,height=760');
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
        title="MCP connections"
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
      {!data.connections.length ? (
        <Empty
          icon={<Plug size={30} />}
          title="No MCP servers yet"
          text="Connect a server with a URL and an API key or OAuth. Its tools appear here and in the workflow designer."
          action={
            <Button onClick={() => edit('connections')}>
              <Plus size={16} />
              Connect a server
            </Button>
          }
        />
      ) : (
        <div className="connection-list">
          {data.connections
            .filter((c) => c.kind !== 'device')
            .map((c) => {
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
            <p className="field-help">{inspect.tool.description || 'No description from the server.'}</p>
            <h3>Input schema</h3>
            <pre className="tool-schema">{JSON.stringify(inspect.tool.inputSchema, null, 2)}</pre>
          </div>
        </Modal>
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
      <PageTitle title="Executions" />
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
          title={runs.length ? 'No runs match this filter' : 'No runs yet'}
          text={
            runs.length
              ? 'Pick another status.'
              : 'Runs from the playground, API, webhooks and schedules show here.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workflow</th>
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
