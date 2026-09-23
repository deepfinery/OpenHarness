import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  Check,
  Code2,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Entity, type User } from '../api';
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

type SettingsProps = {
  user: User;
  setUser: (u: User) => void;
  data: Data;
  refresh: () => Promise<void>;
  edit: (type: string, value?: Entity) => void;
  act: (task: () => Promise<unknown>) => Promise<void>;
};
export function SettingsPage({ user, setUser, data, refresh, edit, act }: SettingsProps) {
  const [tab, setTab] = useState('models');
  const [profile, setProfile] = useState({
    name: user.name,
    email: user.email,
    currentPassword: '',
    newPassword: '',
  });
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'member' });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState('');
  async function loadUsers() {
    setUsers(await api('/users'));
  }
  useEffect(() => {
    if (tab === 'users') void act(loadUsers);
  }, [tab]);
  return (
    <>
      <PageTitle
        eyebrow="MAKE IT YOURS"
        title="Settings."
        text="Manage your model providers, local profile, and studio accounts."
      />
      <div className="tabs">
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
          <Cpu size={16} />
          Model providers
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
          <UserRound size={16} />
          My profile
        </button>
        {user.role === 'admin' && (
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            <Users size={16} />
            Local accounts
          </button>
        )}
      </div>
      {tab === 'models' && (
        <>
          <div className="section-toolbar">
            <div>
              <h2>Choose your intelligence.</h2>
              <p>Use hosted models, your own inference server, or local Ollama.</p>
            </div>
            <Button onClick={() => edit('providers')}>
              <Plus size={16} />
              Add provider
            </Button>
          </div>
          {!data.providers.length ? (
            <Empty
              icon={<Cpu size={30} />}
              title="Bring your preferred model."
              text="Add a provider and model ID. Credentials stay encrypted on your server."
              action={
                <Button onClick={() => edit('providers')}>
                  <Plus size={16} />
                  Add model provider
                </Button>
              }
            />
          ) : (
            <div className="connection-list">
              {data.providers.map((p) => (
                <article className="connection-row" key={p.id}>
                  <div className="resource-icon">
                    <Cpu size={23} />
                  </div>
                  <div className="connection-description">
                    <button className="card-name" onClick={() => edit('providers', p)}>
                      {p.name}
                    </button>
                    <span>
                      {p.model} · {p.kind}
                    </span>
                    <div className="tag-row">
                      <span>{p.hasApiKey ? 'Encrypted key' : 'No API key'}</span>
                      {p.embeddingModel && <span>Embeddings: {p.embeddingModel}</span>}
                    </div>
                  </div>
                  <div className="connection-actions">
                    <Button
                      variant="secondary"
                      disabled={busy === p.id}
                      onClick={() => {
                        setBusy(p.id);
                        void act(async () => {
                          const result = await send(`/providers/${p.id}/test`);
                          window.alert(`Provider response: ${result.text}`);
                        }).finally(() => setBusy(''));
                      }}
                    >
                      {busy === p.id ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Test
                      model
                    </Button>
                    <IconButton title={`Edit ${p.name}`} onClick={() => edit('providers', p)}>
                      <Settings2 size={17} />
                    </IconButton>
                    <IconButton
                      title={`Delete ${p.name}`}
                      onClick={() => {
                        if (confirm(`Delete model provider “${p.name}”?`))
                          void act(async () => {
                            await api(`/providers/${p.id}`, { method: 'DELETE' });
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
          <div className="notice provider-note">
            <ShieldCheck size={19} />
            <span>
              Models are selected per agent. Knowledge bases use a dedicated embedding model, so your chat
              model and retrieval model can be different.
            </span>
          </div>
        </>
      )}
      {tab === 'profile' && (
        <div className="settings-card">
          <div className="profile-heading">
            <div className="profile-avatar">{user.name[0]?.toUpperCase()}</div>
            <div>
              <h2>{user.name}</h2>
              <span>{user.role} · Local account</span>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const result = await send(
                  '/profile',
                  {
                    ...profile,
                    newPassword: profile.newPassword || undefined,
                    currentPassword: profile.currentPassword || undefined,
                  },
                  'PUT',
                );
                setUser(result);
                setProfile({ ...profile, currentPassword: '', newPassword: '' });
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
              });
            }}
          >
            <div className="two-columns">
              <Field label="Name">
                <input
                  aria-label="Profile name"
                  required
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <input
                  aria-label="Profile email"
                  type="email"
                  required
                  value={profile.email}
                  onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                />
              </Field>
            </div>
            <div className="form-section">
              <h3>Change password</h3>
              <p>Enter your current password to change your email or password.</p>
              <Field label="Current password">
                <input
                  aria-label="Current password"
                  type="password"
                  autoComplete="current-password"
                  value={profile.currentPassword}
                  onChange={(e) => setProfile({ ...profile, currentPassword: e.target.value })}
                />
              </Field>
              <Field
                label="New password"
                hint="At least 12 characters. Leave blank to keep your current password."
              >
                <input
                  aria-label="New password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={profile.newPassword}
                  onChange={(e) => setProfile({ ...profile, newPassword: e.target.value })}
                />
              </Field>
            </div>
            <Button type="submit">
              <Check size={16} />
              {saved ? 'Profile saved' : 'Save profile'}
            </Button>
          </form>
        </div>
      )}
      {tab === 'users' && (
        <>
          <div className="section-toolbar">
            <div>
              <h2>Studio accounts</h2>
              <p>Each account has its own agents, credentials, and knowledge.</p>
            </div>
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add account
            </Button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong>
                      {u.id === user.id && <small> (you)</small>}
                    </td>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                    <td>
                      <Status status={u.enabled ? 'enabled' : 'disabled'} />
                    </td>
                    <td>
                      {u.id !== user.id && (
                        <div className="row-actions">
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void act(async () => {
                                await send(`/users/${u.id}`, { enabled: !u.enabled }, 'PATCH');
                                await loadUsers();
                              })
                            }
                          >
                            {u.enabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const password = prompt('New password (at least 12 characters):');
                              if (password)
                                void act(async () => {
                                  await send(`/users/${u.id}`, { newPassword: password }, 'PATCH');
                                  await loadUsers();
                                });
                            }}
                          >
                            Reset password
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {adding && (
        <Modal title="Create local account" onClose={() => setAdding(false)}>
          <SaveForm
            onCancel={() => setAdding(false)}
            label="Create account"
            onSave={async () => {
              await send('/users', newUser);
              await loadUsers();
              setAdding(false);
              setNewUser({ name: '', email: '', password: '', role: 'member' });
            }}
          >
            <Field label="Name">
              <input
                aria-label="New account name"
                required
                value={newUser.name}
                onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <input
                aria-label="New account email"
                type="email"
                required
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              />
            </Field>
            <Field label="Password">
              <input
                aria-label="New account password"
                type="password"
                minLength={12}
                required
                autoComplete="new-password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <select
                aria-label="New account role"
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
              >
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
          </SaveForm>
        </Modal>
      )}
    </>
  );
}
export function IntegrationsPage({ data, act }: Pick<SettingsProps, 'data' | 'act'>) {
  const [tokens, setTokens] = useState<Entity[]>([]);
  const [embeds, setEmbeds] = useState<Entity[]>([]);
  const [tab, setTab] = useState('api');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', target: '', origins: '', expiresDays: 7 });
  const [secret, setSecret] = useState<{ type: string; value: string } | null>(null);
  const [publicUrl, setPublicUrl] = useState(location.origin);
  async function load() {
    const [t, e] = await Promise.all([api('/integrations/tokens'), api('/integrations/embeds')]);
    setTokens(t);
    setEmbeds(e);
  }
  useEffect(() => {
    void act(load);
    void api('/config')
      .then((c) => setPublicUrl(c.publicUrl))
      .catch(() => {});
  }, []);
  const targets = [
    ...data.agents.map((a) => ({ ...a, type: 'agent' })),
    ...data.workflows.map((w) => ({ ...w, type: 'workflow' })),
  ];
  const exampleTarget = data.agents[0]
    ? `"agentId": "${data.agents[0].id}"`
    : `"workflowId": "YOUR_WORKFLOW_ID"`;
  const curl = `curl -X POST '${publicUrl}/api/runs' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: unique-request-id' \\\n  -d '{${exampleTarget}, "input": "Hello"}'`;
  return (
    <>
      <PageTitle
        eyebrow="BUILT TO CONNECT"
        title="Take your agents anywhere."
        text="Run agents from your own applications or embed a conversation in your website."
      />
      <div className="tabs">
        <button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>
          <Code2 size={16} />
          API integrations
        </button>
        <button className={tab === 'embed' ? 'active' : ''} onClick={() => setTab('embed')}>
          <Bot size={16} />
          Iframe embeds
        </button>
      </div>
      <div className="section-toolbar">
        <div>
          <h2>{tab === 'api' ? 'Scoped API keys' : 'Embedded conversations'}</h2>
          <p>
            {tab === 'api'
              ? 'Keys can run and read executions for a selected agent or workflow.'
              : 'Each link grants access to one agent or workflow and can be revoked.'}
          </p>
        </div>
        <Button
          onClick={() => {
            setForm({
              name: '',
              target: targets[0] ? `${targets[0].type}:${targets[0].id}` : '',
              origins: '',
              expiresDays: 7,
            });
            setAdding(true);
          }}
        >
          <Plus size={16} />
          {tab === 'api' ? 'Create API key' : 'Create embed'}
        </Button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Target</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(tab === 'api' ? tokens : embeds).map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.name}</strong>
                </td>
                <td>
                  {targets.find(
                    (a) => a.id === (t.agentId ?? t.workflowId ?? t.agentIds?.[0] ?? t.workflowIds?.[0]),
                  )?.name ?? 'Target unavailable'}
                </td>
                <td>{timestamp(t.expiresAt)}</td>
                <td>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Revoke “${t.name}”? Existing clients will lose access.`))
                        void act(async () => {
                          await api(`/integrations/${tab === 'api' ? 'tokens' : 'embeds'}/${t.id}`, {
                            method: 'DELETE',
                          });
                          await load();
                        });
                    }}
                  >
                    <Trash2 size={14} />
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {!(tab === 'api' ? tokens : embeds).length && (
              <tr>
                <td colSpan={4} className="empty-table">
                  {tab === 'api' ? 'No API keys yet.' : 'No embed links yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {tab === 'api' ? (
        <div className="integration-guide">
          <div>
            <div className="eyebrow">A SIMPLE API</div>
            <h2>One request. A complete workflow.</h2>
            <p>
              Submit a run, then poll its status for the result. A stable idempotency key prevents duplicate
              submissions.
            </p>
            <ol>
              <li>
                Send <code>POST /api/runs</code> with a target and input.
              </li>
              <li>
                Read the returned run <code>id</code>.
              </li>
              <li>
                Poll <code>GET /api/runs/:id</code> until the status is terminal.
              </li>
            </ol>
            <p>
              Cancel with <code>POST /api/runs/:id/cancel</code>.
            </p>
          </div>
          <div className="code-card">
            <div>
              <span>cURL</span>
              <CopyButton value={curl} />
            </div>
            <pre>{curl}</pre>
          </div>
        </div>
      ) : (
        <div className="notice provider-note">
          <ShieldCheck size={22} />
          <div>
            <strong>Share a focused experience.</strong>
            <p>
              Embed visitors see the conversation, without access to your studio or internal traces. Choose
              exact allowed website origins. The link contains a bearer capability: anyone with it can use the
              selected agent until it expires or you revoke it.
            </p>
          </div>
        </div>
      )}
      {adding && (
        <Modal
          title={tab === 'api' ? 'Create an API key' : 'Create an iframe embed'}
          onClose={() => setAdding(false)}
        >
          <SaveForm
            onCancel={() => setAdding(false)}
            label={tab === 'api' ? 'Create API key' : 'Create embed link'}
            onSave={async () => {
              const [type, id] = form.target.split(':');
              if (!id) throw new Error('Choose a target');
              const body =
                tab === 'api'
                  ? {
                      name: form.name,
                      agentIds: type === 'agent' ? [id] : [],
                      workflowIds: type === 'workflow' ? [id] : [],
                      scopes: ['execute', 'read'],
                      expiresDays: form.expiresDays,
                    }
                  : {
                      name: form.name,
                      [type === 'agent' ? 'agentId' : 'workflowId']: id,
                      origins: form.origins
                        .split(',')
                        .map((o) => o.trim())
                        .filter(Boolean),
                      expiresDays: form.expiresDays,
                    };
              const result = await send(`/integrations/${tab === 'api' ? 'tokens' : 'embeds'}`, body);
              await load();
              setAdding(false);
              setSecret({
                type: tab,
                value:
                  tab === 'api'
                    ? result.token
                    : `<iframe src="${result.url}" title="Agent conversation" width="420" height="640" style="border:1px solid #dde4de;border-radius:16px" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`,
              });
            }}
          >
            <Field label="Name">
              <input
                aria-label="Integration name"
                required
                placeholder="My application"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Agent or workflow">
              <select
                aria-label="Integration target"
                required
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
              >
                <option value="" disabled>
                  Select a target
                </option>
                {targets.map((t) => (
                  <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                    {t.name} · {t.type}
                  </option>
                ))}
              </select>
            </Field>
            {tab === 'embed' && (
              <Field
                label="Allowed website origins"
                hint="Comma-separated origins, without a trailing slash or path."
              >
                <input
                  aria-label="Allowed embed origins"
                  required
                  placeholder="https://example.com, http://localhost:3000"
                  value={form.origins}
                  onChange={(e) => setForm({ ...form, origins: e.target.value })}
                />
              </Field>
            )}
            <Field label="Expires in (days)">
              <input
                aria-label="Integration expiration days"
                type="number"
                min={1}
                max={tab === 'api' ? 365 : 30}
                value={form.expiresDays}
                onChange={(e) => setForm({ ...form, expiresDays: Number(e.target.value) })}
              />
            </Field>
          </SaveForm>
        </Modal>
      )}
      {secret && (
        <Modal
          title={secret.type === 'api' ? 'Your API key is ready' : 'Your embed is ready'}
          onClose={() => setSecret(null)}
        >
          <div className="form-content">
            <div className="notice">Copy this now. The secret is only shown once.</div>
            <pre className="secret-value">{secret.value}</pre>
            <CopyButton value={secret.value} />
          </div>
        </Modal>
      )}
    </>
  );
}
