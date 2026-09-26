import { ClustersPage } from './components/ClustersPage';
import { GuardrailsPage } from './components/GuardrailsPage';
import { HumanInbox } from './components/HumanInbox';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Bot,
  ChevronRight,
  CircleHelp,
  Code2,
  GitBranch,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  Laptop,
} from 'lucide-react';
import {
  api,
  collections,
  defaultProviderId,
  emptyData,
  errorMessage,
  send,
  type Data,
  type Entity,
  type User,
} from './api';
import { makeStarter } from '../../../packages/core/src/starters.js';
import { Button, ErrorNotice, UpdateNotice } from './components/ui';
import { ConnectionEditor, KnowledgeEditor, ProviderEditor } from './components/editors';
import { WorkflowStarter } from './components/WorkflowStarter';
import type { Workflow } from '../../../packages/core/src/schema.js';
import { WorkflowEditor } from './components/WorkflowEditor';
import { ConnectionsPage, RunsPage, WorkflowsPage } from './components/pages';
import { KnowledgePage } from './components/KnowledgePage';
import { MachinesPage } from './components/MachinesPage';
import { SkillsPage } from './components/SkillsPage';
import { EmbedChat, Playground, playgroundTargets } from './components/Playground';
import { IntegrationsPage, SettingsPage } from './components/Settings';
import './styles.css';
import './refresh.css';

const nav = [
  { id: 'workflows', label: 'Workflows', icon: GitBranch },
  { id: 'playground', label: 'Playground', icon: MessageSquare },
  { id: 'clusters', label: 'Clusters', icon: Laptop },
  { id: 'machines', label: 'Machines', icon: Laptop },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'connections', label: 'MCP connections', icon: Plug },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'guardrails', label: 'Guardrails', icon: ShieldCheck },
  { id: 'inbox', label: 'Inbox', icon: ShieldCheck },
  { id: 'executions', label: 'Executions', icon: Activity },
  { id: 'integrations', label: 'Integrations', icon: Code2 },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];
function Auth({ needsSetup, onLogin }: { needsSetup: boolean; onLogin: (u: User) => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', setupToken: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <div className="brand">
          <div className="brand-mark">
            <GitBranch size={23} />
          </div>
          <span>
            openharness<span className="brand-period">.</span>
          </span>
        </div>
        <div className="auth-story-content">
          <h1>
            Agents that
            <br />
            get things done.
          </h1>
          <p>Models, MCP tools and your knowledge, orchestrated on your own infrastructure.</p>
          <div className="auth-flow">
            <div>
              <Bot size={30} />
              <strong>Reason</strong>
            </div>
            <i />
            <div>
              <Plug size={30} />
              <strong>Connect</strong>
            </div>
            <i />
            <div>
              <Sparkles size={30} />
              <strong>Act</strong>
            </div>
          </div>
        </div>
        <div className="auth-footer">
          <ShieldCheck size={16} />
          Open source · Self hosted · MCP native
        </div>
      </aside>
      <main className="auth-form-side">
        <div className="auth-form">
          <span className="eyebrow">OPENHARNESS</span>
          <h2>{needsSetup ? 'Make yourself at home.' : 'Welcome back.'}</h2>
          <p>
            {needsSetup
              ? 'Create the first local administrator account for your studio.'
              : 'Sign in to your agent studio.'}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                onLogin(await send(`/auth/${needsSetup ? 'setup' : 'login'}`, form));
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {needsSetup && (
              <>
                <label>
                  Your name
                  <input
                    aria-label="Your name"
                    required
                    autoComplete="name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <label>
                  Setup token
                  <input
                    aria-label="Setup token"
                    type="password"
                    required
                    value={form.setupToken}
                    onChange={(e) => setForm({ ...form, setupToken: e.target.value })}
                  />
                  <small>
                    Use the setup token generated by <code>./start.sh</code>, stored in your local{' '}
                    <code>.env</code>.
                  </small>
                </label>
              </>
            )}
            <label>
              Email address
              <input
                aria-label="Email address"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label>
              Password
              <input
                aria-label="Password"
                type="password"
                required
                minLength={12}
                maxLength={256}
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                placeholder={needsSetup ? 'At least 12 characters' : 'Your password'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <ErrorNotice error={error} />
            <Button disabled={busy} type="submit">
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <>
                  {needsSetup ? 'Create your studio' : 'Sign in'}
                  <ArrowRight size={17} />
                </>
              )}
            </Button>
          </form>
          <div className="auth-local">
            <ShieldCheck size={14} />
            Your account is stored securely in this installation.
          </div>
        </div>
      </main>
    </div>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [page, setPage] = useState(location.pathname.split('/')[1] || 'workflows');
  const [target, setTargetState] = useState('');
  function setTarget(value: string) {
    setTargetState(value);
    if (user)
      try {
        sessionStorage.setItem(`playground-target:${user.tenantId}:${user.id}`, value);
      } catch {}
  }
  useEffect(() => {
    if (user)
      try {
        setTargetState(sessionStorage.getItem(`playground-target:${user.tenantId}:${user.id}`) ?? '');
      } catch {}
  }, [user?.id, user?.tenantId]);
  const [data, setData] = useState<Data>(emptyData);
  const [editor, setEditor] = useState<{ type: string; value?: Entity; draft?: Workflow } | null>(null);
  const [error, setError] = useState('');
  const [tenant, setTenant] = useState({ name: 'Team workspace', members: 1 });
  const [healthy, setHealthy] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  useEffect(() => {
    if (!user) return;
    let live = true;
    const check = () =>
      void api('/inbox')
        .then((r) => {
          if (live) setInboxCount(r.requests.length);
        })
        .catch(() => {});
    check();
    const timer = setInterval(check, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [user?.id]);
  const [playgroundActions, setPlaygroundActions] = useState<HTMLDivElement | null>(null);
  const refresh = useCallback(async () => {
    const [values, workspace, devices] = await Promise.all([
      Promise.all(collections.map((key) => api<Entity[]>(`/${key}`))),
      api('/tenant'),
      // A gateway outage must not take the rest of the studio down with it.
      api('/devices').catch((e) => ({
        configured: true,
        publicUrl: '',
        machines: [],
        catalog: {},
        error: errorMessage(e),
      })),
    ]);
    setTenant(workspace);
    setData({
      ...(Object.fromEntries(collections.map((key, i) => [key, values[i]])) as Pick<
        Data,
        (typeof collections)[number]
      >),
      defaults: { providerId: workspace.defaultProviderId ?? '' },
      machines: devices.machines ?? [],
      gateway: {
        configured: Boolean(devices.configured),
        publicUrl: devices.publicUrl ?? '',
        catalog: devices.catalog ?? {},
        error: devices.error,
      },
    });
  }, []);
  const act = useCallback(async (task: () => Promise<unknown>) => {
    setError('');
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const status = await api('/auth/status');
        setNeedsSetup(status.needsSetup);
        if (!status.needsSetup) {
          try {
            setUser(await api('/auth/me'));
          } catch {}
        }
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setChecking(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (user) void act(refresh);
  }, [user?.id]);
  useEffect(() => {
    const check = () =>
      void api('/health')
        .then(() => setHealthy(true))
        .catch(() => setHealthy(false));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const handler = () => setPage(location.pathname.split('/')[1] || 'workflows');
    addEventListener('popstate', handler);
    return () => removeEventListener('popstate', handler);
  }, []);
  const navigate = (next: string, newTarget = '') => {
    setPage(next);
    if (newTarget) setTarget(newTarget);
    setSidebar(false);
    history.pushState({}, '', `/${next}`);
  };
  const edit = (type: string, value?: Entity) =>
    setEditor({ type: type === 'workflows' && !value ? 'starter' : type, value });
  if (checking)
    return (
      <div className="loading-screen">
        <div className="brand-mark">
          <GitBranch size={25} />
        </div>
        <LoaderCircle className="spin" size={22} />
        <p>Opening your studio…</p>
      </div>
    );
  if (!user)
    return (
      <>
        <Auth
          needsSetup={needsSetup}
          onLogin={(u) => {
            setUser(u);
            setNeedsSetup(false);
          }}
        />
        {error && (
          <div className="floating-error">
            <ErrorNotice error={error} />
          </div>
        )}
      </>
    );
  const props = { data, refresh, edit, navigate, act };
  const editors: Record<string, React.ComponentType<any>> = {
    providers: ProviderEditor,
    connections: ConnectionEditor,
    knowledge: KnowledgeEditor,
  };
  const Editor = editor ? editors[editor.type] : undefined;
  return (
    <div className="app-shell">
      <UpdateNotice />
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <button className="brand" onClick={() => navigate('workflows')}>
          <div className="brand-mark">
            <GitBranch size={23} />
          </div>
          <span>
            openharness<span className="brand-period">.</span>
          </span>
        </button>
        <div className="workspace-switch">
          <span>{user.name[0]?.toUpperCase()}</span>
          <div>
            <strong>{tenant.name}</strong>
            <small>Shared workspace</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <div className="nav-label">Build</div>
        <nav>
          {nav.map((item, i) => (
            <React.Fragment key={item.id}>
              {i === 7 && <div className="nav-label lower">Workspace</div>}
              <button
                aria-label={item.label}
                className={page === item.id ? 'active' : ''}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} />
                <span>
                  {item.label}
                  {item.id === 'inbox' && inboxCount > 0 ? ` (${inboxCount})` : ''}
                </span>
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="sidebar-profile" onClick={() => navigate('settings')}>
            <span className="user-initial">{user.name[0]?.toUpperCase()}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
          </button>
          <button
            className="logout"
            onClick={() =>
              void act(async () => {
                await send('/auth/logout');
                setUser(null);
                setData(emptyData);
              })
            }
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className={`topbar ${page === 'playground' ? 'playground-header' : ''}`}>
          <button className="mobile-menu" aria-label="Toggle navigation" onClick={() => setSidebar(!sidebar)}>
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>{tenant.name}</span>
            <ChevronRight size={13} />
            {page === 'playground' ? (
              // The playground's workflow selector lives here so the chat column starts at the very top.
              <>
                <select
                  className="topbar-select"
                  aria-label="Playground agent or workflow"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="" disabled>
                    Choose a workflow
                  </option>
                  {playgroundTargets(data).map((t) => (
                    <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                      {t.name}
                      {t.type === 'agent' ? ' · saved agent' : ''}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <strong>{nav.find((n) => n.id === page)?.label ?? 'Workflows'}</strong>
            )}
          </div>
          <div className="topbar-right">
            {page === 'playground' && <div ref={setPlaygroundActions} />}
            {page === 'knowledge' && (
              <Button
                className="topbar-action"
                aria-label="New knowledge base"
                onClick={() => edit('knowledge')}
              >
                <Plus size={15} />
                <span>New knowledge base</span>
              </Button>
            )}
            <span className={`system-status ${healthy ? '' : 'unhealthy'}`}>
              <i />
              {healthy ? 'Online' : 'Connecting…'}
            </span>
          </div>
        </header>
        {error && (
          <div className="global-error">
            <ErrorNotice error={error} />
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={17} />
            </button>
          </div>
        )}
        {page === 'playground' ? (
          <Playground
            key={`${user.id}:${target}`}
            storageScope={`${user.tenantId}:${user.id}`}
            data={data}
            target={target}
            onTargetChange={setTarget}
            actionsContainer={playgroundActions}
          />
        ) : page === 'knowledge' ? (
          <KnowledgePage {...props} />
        ) : (
          <main className="page-content">
            {page === 'skills' ? (
              <SkillsPage data={data} refresh={refresh} act={act} />
            ) : page === 'clusters' ? (
              <ClustersPage data={data} isAdmin={user.role === 'admin'} />
            ) : page === 'machines' ? (
              <MachinesPage
                {...props}
                onUseMachine={(deviceId) => {
                  // Machines are workflow tools: start a Machine operator workflow bound to this one.
                  const m = data.machines.find((x) => x.device_id === deviceId);
                  if (!m?.connectionId) return;
                  setEditor({
                    type: 'workflows',
                    draft: makeStarter({
                      kind: 'machine',
                      name: `${m.name} operator`,
                      providerId: defaultProviderId(data),
                      machine: {
                        connectionId: m.connectionId,
                        name: m.name,
                        tools: m.tools.map((t) => t.name),
                      },
                    }),
                  });
                }}
              />
            ) : page === 'connections' ? (
              <ConnectionsPage {...props} />
            ) : page === 'guardrails' ? (
              <GuardrailsPage data={data} refresh={refresh} isAdmin={user.role === 'admin'} />
            ) : page === 'inbox' ? (
              <HumanInbox />
            ) : page === 'executions' ? (
              <RunsPage />
            ) : page === 'integrations' ? (
              <IntegrationsPage data={data} act={act} isAdmin={user.role === 'admin'} />
            ) : page === 'settings' ? (
              <SettingsPage {...props} user={user} setUser={setUser} />
            ) : (
              <WorkflowsPage {...props} />
            )}
          </main>
        )}
      </div>
      {Editor && editor && (
        <Editor value={editor.value} data={data} onClose={() => setEditor(null)} onSaved={refresh} />
      )}{' '}
      {editor?.type === 'starter' && (
        <WorkflowStarter
          data={data}
          refresh={refresh}
          onClose={() => setEditor(null)}
          onChoose={(draft) => setEditor({ type: 'workflows', draft })}
        />
      )}
      {editor?.type === 'workflows' && (
        <WorkflowEditor
          value={editor.value}
          draft={editor.draft}
          data={data}
          onClose={() => setEditor(null)}
          onSaved={refresh}
          onRun={(id) => navigate('playground', `workflow:${id}`)}
          onNavigate={(next) => navigate(next)}
        />
      )}
    </div>
  );
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="loading-screen">
        <h2>The studio could not render this page.</h2>
        <p>Your saved data is still on the server.</p>
        <Button onClick={() => location.assign('/')}>Reload studio</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const embedId = /^\/embed\/([a-f0-9-]{36})$/.exec(location.pathname)?.[1];
// An OAuth popup lands back here after authorizing an MCP server: hand the result to the opener and close.
const oauthReturn = new URLSearchParams(location.search);
if (oauthReturn.get('authorized') === '1' && window.opener && window.opener !== window) {
  try {
    window.opener.postMessage(
      { type: 'openharness-oauth', connection: oauthReturn.get('connection') },
      location.origin,
    );
  } finally {
    window.close();
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>{embedId ? <EmbedChat id={embedId} /> : <App />}</ErrorBoundary>,
);
