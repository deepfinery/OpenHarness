import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Code2,
  Cpu,
  LoaderCircle,
  Mail,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Webhook,
  X,
} from 'lucide-react';
import { WebhooksPanel } from './WebhooksPanel';
import {
  api,
  defaultProviderId,
  errorMessage,
  send,
  timestamp,
  type Data,
  type Entity,
  type User,
} from '../api';
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
const kindLabel: Record<string, string> = {
  'openai-compatible': 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
};
export function SettingsPage({ user, setUser, data, refresh, edit, act }: SettingsProps) {
  const [tab, setTab] = useState(location.hash === '#email' ? 'email' : 'models');
  const [profile, setProfile] = useState({
    name: user.name,
    email: user.email,
    currentPassword: '',
    newPassword: '',
  });
  const [workspaceName, setWorkspaceName] = useState('Team workspace');
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'member' });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState('');
  const [testResult, setTestResult] = useState<{ id: string; text?: string; error?: string } | null>(null);
  async function loadUsers() {
    setUsers(await api('/users'));
    setWorkspaceName((await api('/tenant')).name);
  }
  useEffect(() => {
    if (tab === 'users') void act(loadUsers);
  }, [tab]);
  return (
    <>
      <PageTitle title="Settings" />
      <div className="tabs">
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
          <Cpu size={16} />
          Model providers
        </button>
        <button className={tab === 'email' ? 'active' : ''} onClick={() => setTab('email')}>
          <Mail size={16} />
          Email (SMTP)
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
          <UserRound size={16} />
          My profile
        </button>
        {user.role === 'admin' && (
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            <Users size={16} />
            Team & workspace
          </button>
        )}
      </div>
      {tab === 'models' && (
        <>
          <div className="section-toolbar">
            <div>
              <h2>Model providers</h2>
              <p>New agents start with the default provider. Each agent can pick another.</p>
            </div>
            <Button onClick={() => edit('providers')}>
              <Plus size={16} />
              Add provider
            </Button>
          </div>
          {!data.providers.length ? (
            <Empty
              icon={<Cpu size={30} />}
              title="No model providers yet"
              text="Add OpenAI, Anthropic, Gemini, Ollama or any OpenAI-compatible server. Keys are stored encrypted."
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
                    <span>{p.baseUrl}</span>
                    <div className="tag-row">
                      {p.id === defaultProviderId(data) && <span className="provider-default">Default</span>}
                      <span>{kindLabel[p.kind] ?? p.kind}</span>
                      <span>Chat · {p.model}</span>
                      <span className={p.embeddingModel ? '' : 'faint'}>
                        {p.embeddingModel ? `Embeddings · ${p.embeddingModel}` : 'No embedding model'}
                      </span>
                      <span>{p.hasApiKey ? 'Encrypted key' : 'No API key'}</span>
                      {p.streaming === false && <span>Streaming off</span>}
                    </div>
                    {testResult?.id === p.id && (
                      <div className={`test-result ${testResult.error ? 'bad' : 'ok'}`}>
                        {testResult.error ? <X size={14} /> : <Check size={14} />}
                        <span>
                          <strong>{testResult.error ? 'Test failed' : 'Connected'}</strong>
                          <small>{testResult.error ?? `Replied: “${testResult.text}”`}</small>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="connection-actions">
                    <Button
                      variant="secondary"
                      disabled={busy === p.id}
                      onClick={() => {
                        setBusy(p.id);
                        setTestResult(null);
                        void send(`/providers/${p.id}/test`)
                          .then((result) => setTestResult({ id: p.id, text: result.text }))
                          .catch((e) => setTestResult({ id: p.id, error: errorMessage(e) }))
                          .finally(() => setBusy(''));
                      }}
                    >
                      {busy === p.id ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                      Test
                    </Button>
                    {user.role === 'admin' && p.id !== defaultProviderId(data) && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void act(async () => {
                            await send('/tenant', { defaultProviderId: p.id }, 'PUT');
                            await refresh();
                          })
                        }
                      >
                        Make default
                      </Button>
                    )}
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
        </>
      )}
      {tab === 'email' && <EmailSettingsPanel isAdmin={user.role === 'admin'} />}
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
          <div className="settings-card workspace-settings">
            <h2>Workspace</h2>
            <p>Members share workflows, knowledge, providers and connections. Admins manage accounts.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await send('/tenant', { name: workspaceName }, 'PUT');
                  await refresh();
                });
              }}
            >
              <Field label="Workspace name">
                <input
                  aria-label="Workspace name"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="secondary">
                Save workspace name
              </Button>
            </form>
          </div>
          <div className="section-toolbar">
            <div>
              <h2>Accounts</h2>
            </div>
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add teammate
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
        <Modal title="Add a teammate" onClose={() => setAdding(false)}>
          <SaveForm
            onCancel={() => setAdding(false)}
            label="Create teammate"
            onSave={async () => {
              await send('/users', newUser);
              await loadUsers();
              await refresh();
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

const smtpPresets = [
  {
    id: 'ses',
    name: 'Amazon SES',
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    secure: false,
    hint: 'Use SMTP credentials from the SES console (not your AWS keys) and replace the region in the host.',
  },
  {
    id: 'gmail',
    name: 'Google Workspace',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    hint: 'Use an app password; regular account passwords are rejected.',
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
    hint: 'Username is the literal word apikey; the password is your API key.',
  },
  {
    id: 'mailgun',
    name: 'Mailgun',
    host: 'smtp.mailgun.org',
    port: 587,
    secure: false,
    hint: 'Use the SMTP credentials of your sending domain.',
  },
  {
    id: 'postmark',
    name: 'Postmark',
    host: 'smtp.postmarkapp.com',
    port: 587,
    secure: false,
    hint: 'Username and password are both the server token.',
  },
  {
    id: 'custom',
    name: 'Other SMTP server',
    host: '',
    port: 587,
    secure: false,
    hint: 'Any SMTP relay. Port 465 uses implicit TLS; 587 uses STARTTLS.',
  },
];
export function EmailSettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [settings, setSettings] = useState<any>(null);
  const [form, setForm] = useState<any>({
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    from: '',
    enabled: true,
  });
  const [preset, setPreset] = useState('custom');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  async function load() {
    const s = await api('/settings/email');
    setSettings(s);
    setForm({
      host: s.host,
      port: s.port,
      secure: s.secure,
      username: s.username,
      password: '',
      from: s.from,
      enabled: s.enabled,
    });
    setPreset(
      smtpPresets.find((p) => p.host && s.host === p.host)?.id ??
        (s.host?.includes('amazonaws.com') ? 'ses' : 'custom'),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, []);
  const chosen = smtpPresets.find((p) => p.id === preset)!;
  return (
    <>
      <div className="section-toolbar">
        <div>
          <h2>Outgoing email</h2>
          <p>Used by Email steps in workflows.</p>
        </div>
        {settings && (
          <span
            className={`status ${settings.source === 'none' ? 'disabled' : settings.enabled ? 'enabled' : 'disabled'}`}
          >
            {settings.source === 'workspace'
              ? 'workspace settings'
              : settings.source === 'env'
                ? 'from .env'
                : 'not configured'}
          </span>
        )}
      </div>
      <ErrorNotice error={error} />
      <div className="email-layout">
        <form
          className="settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy('save');
            setError('');
            void send('/settings/email', { ...form, password: form.password || undefined }, 'PUT')
              .then(async () => {
                await load();
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
              })
              .catch((err) => setError(errorMessage(err)))
              .finally(() => setBusy(''));
          }}
        >
          <h3>SMTP server</h3>
          <div className="preset-grid compact" role="radiogroup" aria-label="Email provider">
            {smtpPresets.map((p) => (
              <button
                type="button"
                key={p.id}
                role="radio"
                aria-checked={preset === p.id}
                className={`preset-card ${preset === p.id ? 'selected' : ''}`}
                disabled={!isAdmin}
                onClick={() => {
                  setPreset(p.id);
                  if (p.host) setForm((f: any) => ({ ...f, host: p.host, port: p.port, secure: p.secure }));
                }}
              >
                <strong>{p.name}</strong>
              </button>
            ))}
          </div>
          <p className="field-help">{chosen.hint}</p>
          <div className="two-columns">
            <Field label="SMTP host">
              <input
                aria-label="SMTP host"
                required
                disabled={!isAdmin}
                placeholder="email-smtp.eu-west-1.amazonaws.com"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
            </Field>
            <Field label="Port">
              <input
                aria-label="SMTP port"
                type="number"
                min={1}
                max={65535}
                disabled={!isAdmin}
                value={form.port}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="two-columns">
            <Field label="Username" hint="Leave empty for relays that do not authenticate.">
              <input
                aria-label="SMTP username"
                disabled={!isAdmin}
                autoComplete="off"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Field>
            <Field
              label="Password"
              hint={
                settings?.hasPassword
                  ? 'A password is saved. Leave blank to keep it.'
                  : 'Stored encrypted on the server.'
              }
            >
              <input
                aria-label="SMTP password"
                type="password"
                autoComplete="new-password"
                disabled={!isAdmin}
                placeholder={settings?.hasPassword ? '•••••••• (saved)' : ''}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="From address"
            hint="Must be a sender your provider has verified, for example reports@yourcompany.com or “OpenHarness <reports@yourcompany.com>”."
          >
            <input
              aria-label="From address"
              required
              disabled={!isAdmin}
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={form.secure}
              onChange={(e) => setForm({ ...form, secure: e.target.checked })}
            />
            <span>
              <strong>Implicit TLS (port 465)</strong>
              <small>Off for STARTTLS on port 587, which is what most providers use.</small>
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>
              <strong>Outgoing email enabled</strong>
              <small>When off, Email steps fail with a clear message instead of sending.</small>
            </span>
          </label>
          {isAdmin ? (
            <div className="row-actions">
              <Button type="submit" disabled={busy === 'save'}>
                {busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                {saved ? 'Saved' : 'Save email settings'}
              </Button>
              {settings?.source === 'workspace' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (!confirm('Remove the workspace SMTP settings and fall back to the .env defaults?'))
                      return;
                    void api('/settings/email', { method: 'DELETE' })
                      .then(load)
                      .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  Use .env defaults instead
                </Button>
              )}
            </div>
          ) : (
            <p className="field-help">Only administrators can change email settings.</p>
          )}
        </form>
        <div className="email-side">
          <div className="settings-card">
            <h3>
              <Send size={16} /> Send a test email
            </h3>
            <p className="field-help">Uses the saved settings, so save first.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setBusy('test');
                setTestResult(null);
                void send('/settings/email/test', { to: testTo })
                  .then((r) =>
                    setTestResult({ ok: true, message: `Accepted for ${r.accepted?.join(', ') || testTo}` }),
                  )
                  .catch((err) => setTestResult({ ok: false, message: errorMessage(err) }))
                  .finally(() => setBusy(''));
              }}
            >
              <Field label="Send to">
                <input
                  aria-label="Test email recipient"
                  type="email"
                  required
                  disabled={!isAdmin}
                  placeholder="you@yourcompany.com"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="secondary"
                disabled={!isAdmin || busy === 'test' || settings?.source === 'none'}
              >
                {busy === 'test' ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
                Send test
              </Button>
            </form>
            {testResult && (
              <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>
                {testResult.ok ? <Check size={14} /> : <X size={14} />}
                <span>
                  <strong>{testResult.ok ? 'Sent' : 'Not sent'}</strong>
                  <small>{testResult.message}</small>
                </span>
              </div>
            )}
          </div>
          <div className="settings-card">
            <h3>Defaults from .env</h3>
            <p className="field-help">
              <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>,{' '}
              <code>SMTP_PASSWORD</code> and <code>SMTP_FROM</code> preconfigure every workspace. Settings
              saved here win.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

export function IntegrationsPage({
  data,
  act,
  isAdmin = false,
}: Pick<SettingsProps, 'data' | 'act'> & { isAdmin?: boolean }) {
  const [tokens, setTokens] = useState<Entity[]>([]);
  const [embeds, setEmbeds] = useState<Entity[]>([]);
  const [tab, setTab] = useState('api');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', target: '', origins: '', expiresDays: 7 });
  const [secret, setSecret] = useState<{ type: string; value: string } | null>(null);
  const [publicUrl, setPublicUrl] = useState(location.origin);
  const [harness, setHarness] = useState({ basePath: '/openharness/v1', harnessId: 'openharness' });
  async function load() {
    const [t, e] = await Promise.all([api('/integrations/tokens'), api('/integrations/embeds')]);
    setTokens(t);
    setEmbeds(e);
  }
  useEffect(() => {
    void act(load);
    void api('/config')
      .then((c) => {
        setPublicUrl(c.publicUrl);
        if (c.openHarness) setHarness(c.openHarness);
      })
      .catch(() => {});
  }, []);
  const targets = [
    ...data.workflows.map((w) => ({ ...w, type: 'workflow' })),
    ...data.agents.map((a) => ({ ...a, type: 'agent' })),
  ];
  const exampleTarget = data.workflows[0]
    ? `"workflowId": "${data.workflows[0].id}"`
    : `"workflowId": "YOUR_WORKFLOW_ID"`;
  const curl = `curl -X POST '${publicUrl}/api/runs' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: unique-request-id' \\\n  -d '{${exampleTarget}, "input": "Hello"}'`;
  const harnessBase = `${publicUrl}${harness.basePath}/harnesses/${harness.harnessId}`;
  const openHarnessExample = `# Open Harness API: needs a workspace-wide key (oh_sk_…)\ncurl '${harnessBase}/capabilities' \\\n  -H 'Authorization: Bearer YOUR_OPEN_HARNESS_KEY'\n\ncurl '${harnessBase}/health'`;
  const chat = `curl -X POST '${publicUrl}/api/chat' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{${exampleTarget}, "message": "Research this topic"}'\n\n# stream status, trace and the answer as it is written\ncurl -N '${publicUrl}/api/runs/RUN_ID/stream' -H 'Authorization: Bearer YOUR_API_KEY'`;
  const ways = [
    {
      id: 'api',
      icon: <Code2 size={20} />,
      title: 'API key',
      text: 'Run a workflow from your own code.',
      steps: ['Create a key for one workflow', 'POST /api/runs', 'Poll or stream the run'],
    },
    {
      id: 'webhooks',
      icon: <Webhook size={20} />,
      title: 'Webhook',
      text: 'Another system posts JSON to start a workflow.',
      steps: ['Create a webhook', 'POST JSON with its secret', 'Poll the run with the same secret'],
    },
    {
      id: 'embed',
      icon: <Bot size={20} />,
      title: 'Embedded chat',
      text: 'A chat with one workflow on your website.',
      steps: ['Create an embed for your site’s origin', 'Paste the iframe', 'Revoke any time'],
    },
  ];
  return (
    <>
      <PageTitle title="Integrations" />
      <div className="ways-grid">
        {ways.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`way-card ${tab === w.id ? 'selected' : ''}`}
            aria-pressed={tab === w.id}
            onClick={() => setTab(w.id)}
          >
            <span className="resource-icon">{w.icon}</span>
            <strong>{w.title}</strong>
            <p>{w.text}</p>
            <ol>
              {w.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </button>
        ))}
      </div>
      {tab === 'webhooks' ? (
        <WebhooksPanel data={data} />
      ) : (
        <>
          <div className="section-toolbar">
            <div>
              <h2>{tab === 'api' ? 'API keys' : 'Embeds'}</h2>
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
                      {t.scopes?.includes('harness')
                        ? 'Whole workspace · Open Harness API'
                        : (targets.find(
                            (a) =>
                              a.id === (t.agentId ?? t.workflowId ?? t.agentIds?.[0] ?? t.workflowIds?.[0]),
                          )?.name ?? 'Target unavailable')}
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
                <h2>Run</h2>
                <p>
                  <code>POST /api/runs</code> returns a run <code>id</code>. Poll{' '}
                  <code>GET /api/runs/:id</code> or stream <code>GET /api/runs/:id/stream</code>. An{' '}
                  <code>Idempotency-Key</code> makes retries safe.
                </p>
                <h2>Chat</h2>
                <p>
                  <code>POST /api/chat</code> returns a <code>conversationId</code>; send it again for
                  follow-ups.
                </p>
              </div>
              <div className="code-stack">
                <div className="code-card">
                  <div>
                    <span>Run</span>
                    <CopyButton value={curl} />
                  </div>
                  <pre>{curl}</pre>
                </div>
                <div className="code-card">
                  <div>
                    <span>Chat and stream</span>
                    <CopyButton value={chat} />
                  </div>
                  <pre>{chat}</pre>
                </div>
                <div className="code-card">
                  <div>
                    <span>Open Harness API</span>
                    <CopyButton value={openHarnessExample} />
                  </div>
                  <pre>{openHarnessExample}</pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="notice provider-note">
              <ShieldCheck size={22} />
              <div>
                <strong>Visitors see only the conversation.</strong>
                <p>The link works from the origins you allow until it expires or you revoke it.</p>
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
                    tab === 'api' && type === 'harness'
                      ? { name: form.name, scopes: ['harness'], expiresDays: form.expiresDays }
                      : tab === 'api'
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
                        : `<iframe src="${result.url}" title="Agent conversation" width="420" height="640" style="border:1px solid #dee6ed;border-radius:16px" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`,
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
                <Field label="Workflow">
                  <select
                    aria-label="Integration target"
                    required
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: e.target.value })}
                  >
                    <option value="" disabled>
                      Select a workflow
                    </option>
                    {tab === 'api' && isAdmin && (
                      <option value="harness:workspace">Whole workspace · Open Harness API</option>
                    )}
                    {targets.map((t) => (
                      <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                        {t.name}
                        {t.type === 'agent' ? ' · saved agent' : ''}
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
      )}
    </>
  );
}
