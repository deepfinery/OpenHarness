import { useEffect, useState } from 'react';
import {
  Chrome,
  Container,
  KeyRound,
  Laptop,
  MonitorCog,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import {
  api,
  errorMessage,
  send,
  timestamp,
  type Data,
  type Entity,
  type Machine,
  type Platform,
} from '../api';
import { Button, CopyButton, Empty, ErrorNotice, Field, IconButton, Modal, PageTitle } from './ui';

type PageProps = {
  data: Data;
  refresh: () => Promise<void>;
  edit: (type: string, value?: Entity) => void;
  navigate: (page: string, target?: string) => void;
  act: (task: () => Promise<unknown>) => Promise<void>;
  onUseMachine: (deviceId: string) => void;
};
type Enrollment = { machine: Machine; token: string; connectUrl: string; install: Record<string, string> };
const platformLabel: Record<Platform, string> = { linux: 'Linux', windows: 'Windows', chrome: 'Chrome' };
const PlatformIcon = ({ platform, size = 20 }: { platform: Platform; size?: number }) =>
  platform === 'windows' ? (
    <MonitorCog size={size} />
  ) : platform === 'chrome' ? (
    <Chrome size={size} />
  ) : (
    <Laptop size={size} />
  );
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Machines: remote Linux hosts, containers, Windows hosts and Chrome browsers that agents can operate. */
export function MachinesPage({ data, refresh, act, onUseMachine }: PageProps) {
  const [adding, setAdding] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [editing, setEditing] = useState<Machine | null>(null);
  const [busy, setBusy] = useState('');
  const machines = data.machines;
  // While a new machine is expected to connect, poll until it shows up online.
  useEffect(() => {
    if (!enrollment) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [enrollment]);
  const enrolled = enrollment
    ? machines.find((m) => m.device_id === enrollment.machine.device_id)
    : undefined;
  return (
    <>
      <PageTitle
        title="Machines"
        action={
          data.gateway.configured ? (
            <div className="row-actions">
              <Button
                variant="secondary"
                disabled={busy === 'sync'}
                onClick={() => {
                  setBusy('sync');
                  void act(() => send('/devices/sync').then(() => refresh())).finally(() => setBusy(''));
                }}
              >
                <RefreshCw size={15} className={busy === 'sync' ? 'spin' : ''} />
                Sync
              </Button>
              <Button onClick={() => setAdding(true)}>
                <Plus size={17} />
                Add machine
              </Button>
            </div>
          ) : undefined
        }
      />
      <ErrorNotice error={data.gateway.error} />
      {!data.gateway.configured ? (
        <Empty
          icon={<Laptop size={30} />}
          title="No device gateway configured"
          text="Set GATEWAY_URL, GATEWAY_API_TOKEN and GATEWAY_ADMIN_TOKEN in .env (./start.sh adds them) and restart to register Linux, Windows, container and Chrome machines."
        />
      ) : !machines.length ? (
        <Empty
          icon={<Laptop size={30} />}
          title="No machines yet"
          text="Add a Linux host, a container, a Windows machine or a Chrome browser. It dials out to the gateway, so it needs no public IP."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add machine
            </Button>
          }
        />
      ) : (
        <div className="card-grid machine-grid">
          {machines.map((m) => (
            <article
              className={`resource-card machine-card ${m.online ? 'online' : 'offline'}`}
              key={m.device_id}
            >
              <div className="card-top">
                <div className="resource-icon">
                  <PlatformIcon platform={m.platform} size={22} />
                </div>
                <span className={`status ${m.disabled ? 'disabled' : m.online ? 'ready' : 'pending'}`}>
                  <i />
                  {m.disabled ? 'disabled' : m.online ? 'online' : 'offline'}
                </span>
                <IconButton
                  title={`Remove ${m.name}`}
                  onClick={() => {
                    if (confirm(`Remove “${m.name}”? Its connector will be refused from now on.`))
                      void act(async () => {
                        await api(`/devices/${m.device_id}`, { method: 'DELETE' });
                        await refresh();
                      });
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <button className="card-name" onClick={() => setEditing(m)}>
                {m.name}
              </button>
              <p className="machine-meta">
                {platformLabel[m.platform]}
                {m.hostname ? ` · ${m.hostname}` : ''}
                {m.connector_version ? ` · v${m.connector_version}` : ''}
                <br />
                <span className="mono">{m.device_id}</span>
                {!m.online && m.last_seen ? ` · last seen ${timestamp(m.last_seen)}` : ''}
              </p>
              <div className="tool-chips">
                {m.allowed_tools.length ? (
                  m.allowed_tools.slice(0, 6).map((t) => (
                    <span className="tool-chip" key={t}>
                      {t}
                    </span>
                  ))
                ) : (
                  <span className="tools-empty">No tools allowed yet</span>
                )}
                {m.allowed_tools.length > 6 && (
                  <span className="tool-chip more">+{m.allowed_tools.length - 6}</span>
                )}
              </div>
              <div className="card-footer">
                <small>
                  {m.tools.length
                    ? `${m.tools.length} tools ready`
                    : m.online
                      ? 'Syncing tools…'
                      : 'Waiting for the connector'}
                </small>
                <Button variant="secondary" onClick={() => setEditing(m)}>
                  <Settings2 size={14} />
                  Tools
                </Button>
                <Button
                  variant="ghost"
                  disabled={!m.connectionId || !m.tools.length}
                  title="Create a Machine operator workflow with this machine's tools, then chat with it in the Playground"
                  onClick={() => onUseMachine(m.device_id)}
                >
                  <Play size={14} />
                  New operator workflow
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {adding && (
        <AddMachineModal
          data={data}
          onClose={() => setAdding(false)}
          onEnrolled={async (result) => {
            setAdding(false);
            setEnrollment(result);
            await refresh();
          }}
        />
      )}
      {enrollment && (
        <ConnectModal enrollment={enrollment} live={enrolled} onClose={() => setEnrollment(null)} />
      )}
      {editing && (
        <MachineSettingsModal
          data={data}
          machine={machines.find((m) => m.device_id === editing.device_id) ?? editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          onRotated={(result) => {
            setEditing(null);
            setEnrollment(result);
          }}
        />
      )}
    </>
  );
}

function ToolChecklist({
  platform,
  catalog,
  value,
  onChange,
}: {
  platform: Platform;
  catalog: Data['gateway']['catalog'];
  value: string[];
  onChange: (tools: string[]) => void;
}) {
  const tools = catalog[platform] ?? [];
  return (
    <div className="tool-checklist">
      <div className="compact-actions">
        <button type="button" className="text-button" onClick={() => onChange(tools.map((t) => t.name))}>
          Allow all
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => onChange(tools.filter((t) => !t.risky).map((t) => t.name))}
        >
          Read-only tools
        </button>
        <button type="button" className="text-button" onClick={() => onChange([])}>
          None
        </button>
        <small>{value.length} allowed</small>
      </div>
      {tools.map((t) => (
        <label className="tool-choice" key={t.name}>
          <input
            type="checkbox"
            checked={value.includes(t.name)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, t.name] : value.filter((v) => v !== t.name))
            }
          />
          <span>
            <strong>
              {t.name}
              {t.risky && <em className="risky"> acts</em>}
            </strong>
            <small>{t.description}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
function AddMachineModal({
  data,
  onClose,
  onEnrolled,
}: {
  data: Data;
  onClose: () => void;
  onEnrolled: (result: Enrollment) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Platform>('linux');
  const [kind, setKind] = useState<'host' | 'container'>('host');
  const [deviceId, setDeviceId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [tools, setTools] = useState<string[]>(() => (data.gateway.catalog.linux ?? []).map((t) => t.name));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choosePlatform = (p: Platform) => {
    setPlatform(p);
    setTools((data.gateway.catalog[p] ?? []).map((t) => t.name));
  };
  return (
    <Modal title="Add a machine" onClose={onClose} wide>
      <form
        className="form-content"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void send('/devices', { name, deviceId: deviceId || undefined, platform, allowedTools: tools })
            .then((result: Enrollment) =>
              onEnrolled({
                ...result,
                install: { ...result.install, preferred: kind === 'container' ? 'docker' : platform },
              }),
            )
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="platform-picker" role="radiogroup" aria-label="Machine type">
          {(
            [
              ['linux', 'host', 'Linux host', 'systemd service', <Laptop size={20} key="l" />],
              ['linux', 'container', 'Container', 'Docker image', <Container size={20} key="c" />],
              ['windows', 'host', 'Windows', 'service or logon task', <MonitorCog size={20} key="w" />],
              ['chrome', 'host', 'Chrome', 'browser extension', <Chrome size={20} key="b" />],
            ] as const
          ).map(([p, k, label, hint, icon]) => (
            <button
              type="button"
              key={label}
              role="radio"
              aria-checked={platform === p && kind === k}
              className={`platform-option ${platform === p && kind === k ? 'selected' : ''}`}
              onClick={() => {
                choosePlatform(p);
                setKind(k);
              }}
            >
              {icon}
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>
        <div className="two-columns">
          <Field label="Name">
            <input
              aria-label="Machine name"
              required
              autoFocus
              placeholder={
                kind === 'container' ? 'Build box' : platform === 'chrome' ? 'Ben’s Chrome' : 'Office server'
              }
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!idTouched) setDeviceId(slug(e.target.value));
              }}
            />
          </Field>
          <Field
            label="Machine ID"
            hint="Lowercase letters, digits and dashes. Used in the connector settings."
          >
            <input
              aria-label="Machine ID"
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              value={deviceId}
              onChange={(e) => {
                setIdTouched(true);
                setDeviceId(e.target.value);
              }}
            />
          </Field>
        </div>
        <div className="form-section">
          <h3>Tools the agent may use</h3>
          <ToolChecklist
            platform={platform}
            catalog={data.gateway.catalog}
            value={tools}
            onChange={setTools}
          />
        </div>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            <KeyRound size={15} />
            Create token
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ConnectModal({
  enrollment,
  live,
  onClose,
}: {
  enrollment: Enrollment;
  live?: Machine;
  onClose: () => void;
}) {
  const tabs =
    enrollment.machine.platform === 'linux'
      ? (['linux', 'docker'] as const)
      : ([enrollment.machine.platform] as const);
  const [tab, setTab] = useState<string>(
    enrollment.install.preferred && tabs.includes(enrollment.install.preferred as never)
      ? enrollment.install.preferred
      : tabs[0],
  );
  const labels: Record<string, string> = {
    linux: 'Linux service',
    docker: 'Container',
    windows: 'Windows',
    chrome: 'Chrome',
  };
  return (
    <Modal title={`Connect ${enrollment.machine.name}`} onClose={onClose} wide>
      <div className="form-content">
        <div className={`connect-status ${live?.online ? 'ok' : ''}`}>
          {live?.online ? (
            <>
              <strong>Connected.</strong> {live.hostname ?? enrollment.machine.device_id} is online with{' '}
              {live.tools.length || live.tool_count || 0} tools. You can close this.
            </>
          ) : (
            <>
              <span className="spin-dot" />
              Waiting for the machine to connect… this updates on its own.
            </>
          )}
        </div>
        <Field
          label="Device token"
          hint="Shown once. Paste it into the connector; it is stored hashed on the gateway."
        >
          <div className="secret-row">
            <code>{enrollment.token}</code>
            <CopyButton value={enrollment.token} />
          </div>
        </Field>
        <div className="tabs compact">
          {tabs.map((t) => (
            <button type="button" key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {labels[t]}
            </button>
          ))}
        </div>
        <div className="code-card">
          <div>
            <span>{labels[tab]}</span>
            <CopyButton value={enrollment.install[tab] ?? ''} />
          </div>
          <pre>{enrollment.install[tab]}</pre>
        </div>
        <p className="field-help">
          Gateway address: <code>{enrollment.connectUrl}</code>. The machine only needs outbound access to it.
        </p>
        {['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(enrollment.connectUrl).hostname.toLowerCase(),
        ) && (
          <p role="alert" className="field-help">
            This gateway address points to localhost. Remote machines and containers cannot reach the gateway
            at this address. Set GATEWAY_PUBLIC_URL to a reachable gateway address and recreate the API
            service before copying a new install command.
          </p>
        )}
      </div>
      <div className="form-actions">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
function MachineSettingsModal({
  data,
  machine,
  onClose,
  onSaved,
  onRotated,
}: {
  data: Data;
  machine: Machine;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRotated: (result: Enrollment) => void;
}) {
  const [name, setName] = useState(machine.name);
  const [tools, setTools] = useState(machine.allowed_tools);
  const [disabled, setDisabled] = useState(machine.disabled);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  return (
    <Modal title={machine.name} onClose={onClose} wide>
      <form
        className="form-content"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy('save');
          setError('');
          void send(`/devices/${machine.device_id}`, { name, allowedTools: tools, disabled }, 'PUT')
            .then(() => onSaved())
            .then(onClose)
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(''));
        }}
      >
        <div className="two-columns">
          <Field label="Name">
            <input
              aria-label="Machine name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Status">
            <div className="machine-facts">
              <span className={`status ${machine.online ? 'ready' : 'pending'}`}>
                <i />
                {machine.online ? 'online' : 'offline'}
              </span>
              <small>
                {platformLabel[machine.platform]} · <span className="mono">{machine.device_id}</span>
                {machine.hostname ? ` · ${machine.hostname}` : ''}
              </small>
            </div>
          </Field>
        </div>
        <div className="form-section">
          <h3>Tools the agent may use</h3>
          <p className="field-help">
            Enforced by the gateway for this machine; the connector applies its own allow-list too.
          </p>
          <ToolChecklist
            platform={machine.platform}
            catalog={data.gateway.catalog}
            value={tools}
            onChange={setTools}
          />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          <span>
            <strong>Disabled</strong>
            <small>Refuses the connector and hides the machine from runs.</small>
          </span>
        </label>
        <ErrorNotice error={error} />
        <div className="form-actions between">
          <Button
            type="button"
            variant="secondary"
            disabled={busy === 'rotate'}
            onClick={() => {
              if (!confirm('Issue a new token? The connector must be reconfigured with it.')) return;
              setBusy('rotate');
              void send(`/devices/${machine.device_id}/rotate-token`)
                .then((r) =>
                  onRotated({ machine, token: r.token, connectUrl: r.connectUrl, install: r.install }),
                )
                .catch((err) => setError(errorMessage(err)))
                .finally(() => setBusy(''));
            }}
          >
            <KeyRound size={14} />
            New token
          </Button>
          <div className="row-actions">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy === 'save'}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
