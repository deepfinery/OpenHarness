import { machineInstallSnippets } from '../../../../packages/core/src/machineInstall.js';
import { useEffect, useState } from 'react';
import type { FleetCluster } from './InfrastructurePage';
import {
  Boxes,
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
  platformLabels,
  send,
  timestamp,
  type Data,
  type Machine,
  type Platform,
} from '../api';
import { Button, CopyButton, Empty, ErrorNotice, Field, IconButton, Modal } from './ui';

type PageProps = {
  isAdmin: boolean;
  data: Data;
  refresh: () => Promise<void>;
  act: (task: () => Promise<unknown>) => Promise<void>;
  onUseMachine: (machine: Machine) => void;
  clusters: FleetCluster[];
  clusterId: string;
  onClusterChange: (id: string) => void;
};
type Enrollment = { machine: Machine; token: string; connectUrl: string; install: Record<string, string> };
const platformLabel: Record<Platform, string> = {
  linux: 'Linux',
  windows: 'Windows',
  chrome: 'Chrome',
  openshell: 'OpenShell',
};
export const PlatformIcon = ({ platform, size = 20 }: { platform: Platform; size?: number }) =>
  platform === 'windows' ? (
    <MonitorCog size={size} />
  ) : platform === 'chrome' ? (
    <Chrome size={size} />
  ) : platform === 'openshell' ? (
    <Boxes size={size} />
  ) : (
    <Laptop size={size} />
  );
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** The unified inventory: standalone resources of every type and cluster-enrolled nodes. */
export function MachinesPage({
  isAdmin,
  data,
  refresh,
  act,
  onUseMachine,
  clusters,
  clusterId,
  onClusterChange,
}: PageProps) {
  const [adding, setAdding] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [editing, setEditing] = useState<Machine | null>(null);
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [platform, setPlatform] = useState('all');
  const [page, setPage] = useState(0);
  const filtered = data.machines.filter((m) => {
    const cluster = clusters.find((c) => c._id === m.cluster_id);
    return (
      `${m.name} ${m.device_id} ${m.hostname ?? ''} ${cluster?.name ?? m.cluster_id ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!clusterId || (clusterId === 'standalone' ? !m.cluster_id : m.cluster_id === clusterId)) &&
      (platform === 'all' || m.platform === platform) &&
      (status === 'all' ||
        (status === 'disabled' ? m.disabled : !m.disabled && (status === 'online' ? m.online : !m.online)))
    );
  });
  const pageSize = 25;
  const activePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const machines = filtered.slice(activePage * pageSize, (activePage + 1) * pageSize);
  useEffect(() => {
    setPage(0);
  }, [query, status, platform, clusterId]);
  useEffect(() => {
    if (!enrollment) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [enrollment, refresh]);
  const enrolled = enrollment
    ? data.machines.find((m) => m.device_id === enrollment.machine.device_id)
    : undefined;
  const filteredView = Boolean(query || clusterId || status !== 'all' || platform !== 'all');
  const reset = () => {
    setQuery('');
    setStatus('all');
    setPlatform('all');
    onClusterChange('');
  };
  return (
    <>
      <div className="fleet-section-heading">
        <div>
          <h2>Resources</h2>
          <p>
            Linux machines, OpenShell managed machines, Chrome browsers and Windows hosts, plus the nodes
            enrolled in your clusters.
          </p>
        </div>
        {data.gateway.configured && (
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
              Sync tools
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add resource
            </Button>
          </div>
        )}
      </div>
      <div className="fleet-filters">
        <input
          aria-label="Filter resources"
          placeholder="Search name, hostname, or ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter by cluster"
          value={clusterId}
          onChange={(e) => onClusterChange(e.target.value)}
        >
          <option value="">All clusters & standalone</option>
          <option value="standalone">Standalone resources</option>
          {clusters.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}
            </option>
          ))}
          {clusterId && clusterId !== 'standalone' && !clusters.some((c) => c._id === clusterId) && (
            <option value={clusterId}>Unavailable cluster</option>
          )}
        </select>
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="disabled">Disabled</option>
        </select>
        <select aria-label="Filter by type" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="all">All types</option>
          <option value="linux">Linux machines</option>
          <option value="openshell">OpenShell managed machines</option>
          <option value="chrome">Chrome</option>
          <option value="windows">Windows</option>
        </select>
        {filteredView && (
          <Button variant="ghost" onClick={reset}>
            Clear filters
          </Button>
        )}
      </div>
      {!data.gateway.configured ? (
        <Empty
          icon={<Laptop size={30} />}
          title="Connect your infrastructure"
          text="Configure the device gateway in your installation to connect resources and enroll cluster nodes."
        />
      ) : !machines.length ? (
        <Empty
          icon={<Laptop size={30} />}
          title={filteredView ? 'No resources match these filters' : 'Connect your first resource'}
          text={
            filteredView
              ? 'Try another search or clear the filters. Cluster nodes appear automatically when their connectors register.'
              : 'Add a Linux machine, an OpenShell managed machine, a Chrome browser or a Windows host. For a fleet of nodes, create a cluster and reuse its shared enrollment configuration.'
          }
          action={
            filteredView ? (
              <Button variant="secondary" onClick={reset}>
                Clear filters
              </Button>
            ) : (
              <Button onClick={() => setAdding(true)}>
                <Plus size={16} />
                Add resource
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="fleet-table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Cluster</th>
                  <th>Status</th>
                  <th>Tools</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.device_id}>
                    <td data-label="Resource">
                      <div className="fleet-machine-name">
                        <span className="fleet-platform-icon">
                          <PlatformIcon platform={m.platform} />
                        </span>
                        <div>
                          <button className="text-button" onClick={() => setEditing(m)}>
                            {m.name}
                          </button>
                          <small title={m.hostname ?? m.device_id}>
                            {platformLabel[m.platform]} · {m.hostname ?? m.device_id}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td data-label="Cluster">
                      {m.cluster_id ? (
                        <span className="fleet-cluster-tag">
                          {clusters.find((c) => c._id === m.cluster_id)?.name ?? m.cluster_id}
                        </span>
                      ) : (
                        <span className="fleet-subtle">Standalone</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`status ${m.disabled ? 'disabled' : m.online ? 'ready' : 'pending'}`}>
                        <i />
                        {m.disabled ? 'disabled' : m.online ? 'online' : 'offline'}
                      </span>
                      {!m.online && m.last_seen && (
                        <small className="fleet-last-seen">Seen {timestamp(m.last_seen)}</small>
                      )}
                    </td>
                    <td data-label="Tools">
                      <strong className="fleet-tool-count">{m.tools.length}</strong>
                      <small className="fleet-last-seen">
                        {m.online ? 'available' : `${m.allowed_tools.length} allowed`}
                      </small>
                    </td>
                    <td data-label="Actions">
                      <div className="fleet-row-actions">
                        <Button
                          variant="secondary"
                          onClick={() => setEditing(m)}
                          aria-label={`Configure ${m.name}`}
                        >
                          <Settings2 size={14} />
                          Manage
                        </Button>
                        <IconButton
                          title={`Create operator harness for ${m.name}`}
                          disabled={!m.connectionId || !m.tools.length || !m.online || m.disabled}
                          onClick={() => onUseMachine(m)}
                        >
                          <Play size={15} />
                        </IconButton>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fleet-pagination">
            <span>
              {activePage * pageSize + 1}–{Math.min((activePage + 1) * pageSize, filtered.length)} of{' '}
              {filtered.length} resources
            </span>
            <div className="row-actions">
              <Button variant="secondary" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>
                Previous
              </Button>
              <span>
                Page {activePage + 1} of {Math.ceil(filtered.length / pageSize)}
              </span>
              <Button
                variant="secondary"
                disabled={(activePage + 1) * pageSize >= filtered.length}
                onClick={() => setPage(activePage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
      {adding && (
        <AddMachineModal
          isAdmin={isAdmin}
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
          isAdmin={isAdmin}
          data={data}
          machine={data.machines.find((m) => m.device_id === editing.device_id) ?? editing}
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
  isAdmin,
  data,
  onClose,
  onEnrolled,
}: {
  isAdmin: boolean;
  data: Data;
  onClose: () => void;
  onEnrolled: (result: Enrollment) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Platform>('linux');
  const [accessMode, setAccessMode] = useState<'restricted' | 'host'>('restricted');
  const [kind, setKind] = useState<'host' | 'container'>('host');
  const [deviceId, setDeviceId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [tools, setTools] = useState<string[]>(() => (data.gateway.catalog.linux ?? []).map((t) => t.name));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choosePlatform = (p: Platform) => {
    setPlatform(p);
    setTools((data.gateway.catalog[p] ?? []).map((t) => t.name));
    if (p !== 'linux') {
      setKind('host');
      setAccessMode('restricted');
    }
  };
  return (
    <Modal title="Add a resource" onClose={onClose} wide>
      <form
        className="form-content"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void send('/devices', {
            name,
            deviceId: deviceId || undefined,
            platform,
            allowedTools: tools,
            accessMode: platform === 'linux' && isAdmin ? accessMode : 'restricted',
          })
            .then((result: Enrollment) =>
              onEnrolled({
                ...result,
                install: {
                  ...result.install,
                  preferred: platform === 'linux' && kind === 'container' ? 'docker' : platform,
                },
              }),
            )
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="platform-picker" role="radiogroup" aria-label="Resource type">
          {(
            [
              ['linux', 'Linux machine', 'systemd service or container', <Laptop size={20} key="l" />],
              [
                'openshell',
                'OpenShell managed machine',
                'sandboxes confined by NVIDIA OpenShell',
                <Boxes size={20} key="o" />,
              ],
              ['chrome', 'Chrome', 'browser extension', <Chrome size={20} key="b" />],
              ['windows', 'Windows', 'service or logon task', <MonitorCog size={20} key="w" />],
            ] as const
          ).map(([p, label, hint, icon]) => (
            <button
              type="button"
              key={p}
              role="radio"
              aria-checked={platform === p}
              className={`platform-option ${platform === p ? 'selected' : ''}`}
              onClick={() => choosePlatform(p)}
            >
              {icon}
              <strong>{label}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </div>
        {platform === 'linux' && (
          <div className="platform-picker deployment" role="radiogroup" aria-label="Linux deployment">
            {(
              [
                ['host', 'Linux service', 'systemd unit on the host', <Laptop size={18} key="h" />],
                ['container', 'Container', 'Docker image, no host install', <Container size={18} key="c" />],
              ] as const
            ).map(([k, label, hint, icon]) => (
              <button
                type="button"
                key={k}
                role="radio"
                aria-checked={kind === k}
                className={`platform-option ${kind === k ? 'selected' : ''}`}
                onClick={() => setKind(k)}
              >
                {icon}
                <strong>{label}</strong>
                <small>{hint}</small>
              </button>
            ))}
          </div>
        )}
        {platform === 'openshell' && (
          <p className="field-help">
            The connector runs beside your OpenShell gateway on its private network and dials out to the
            harness gateway; the harness never connects in. Agents get the tools ticked below, and the
            OpenShell console manages sandboxes and policies through the trusted administrator path.
          </p>
        )}
        <div className="two-columns">
          <Field label="Name">
            <input
              aria-label="Resource name"
              required
              autoFocus
              placeholder={
                platform === 'openshell'
                  ? 'Lab OpenShell gateway'
                  : kind === 'container'
                    ? 'Build box'
                    : platform === 'chrome'
                      ? 'Ben’s Chrome'
                      : 'Office server'
              }
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!idTouched) setDeviceId(slug(e.target.value));
              }}
            />
          </Field>
          <Field
            label="Resource ID"
            hint="Lowercase letters, digits and dashes. Used in the connector settings."
          >
            <input
              aria-label="Resource ID"
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              value={deviceId}
              onChange={(e) => {
                setIdTouched(true);
                setDeviceId(e.target.value);
              }}
            />
          </Field>
        </div>
        {platform === 'linux' && (
          <Field
            label="Machine access"
            hint="Privileged mode requires reinstalling the Linux container with root and host namespace access. It permits arbitrary host commands, including disruptive actions."
          >
            <select
              aria-label="Machine access"
              disabled={!isAdmin}
              value={accessMode}
              onChange={(e) => {
                setAccessMode(e.target.value as 'restricted' | 'host');
                if (e.target.value === 'host') setKind('container');
              }}
            >
              <option value="restricted">Restricted connector</option>
              <option value="host">Privileged VM host (root)</option>
            </select>
          </Field>
        )}
        <div className="form-section">
          <h3>Tools the agent may use</h3>
          {platform === 'openshell' && (
            <p className="field-help">
              Tools that change sandboxes or policies are marked <em className="risky">acts</em>. Leave them
              off for agents that should only observe; the connector's own settings can forbid them entirely.
            </p>
          )}
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
      ? enrollment.machine.access_mode === 'host'
        ? (['docker'] as const)
        : (['linux', 'docker'] as const)
      : enrollment.machine.platform === 'openshell'
        ? (['openshell', 'openshell-docker'] as const)
        : ([enrollment.machine.platform] as const);
  const [tab, setTab] = useState<string>(
    enrollment.install.preferred && tabs.includes(enrollment.install.preferred as never)
      ? enrollment.install.preferred
      : tabs[0],
  );
  const [token, setToken] = useState(enrollment.token);
  const [gateway, setGateway] = useState(enrollment.connectUrl);
  let snippets = enrollment.install,
    setupError = '';
  try {
    snippets = machineInstallSnippets(enrollment.machine, token, gateway);
  } catch (e) {
    setupError = errorMessage(e);
  }
  const labels: Record<string, string> = {
    linux: 'Linux service',
    docker: 'Container',
    windows: 'Windows',
    chrome: 'Chrome',
    openshell: 'OpenShell host',
    'openshell-docker': 'Container',
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
            <input
              aria-label="Device token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your saved device token"
            />
            <CopyButton value={token} />
          </div>
        </Field>
        <Field
          label="Harness gateway address"
          hint="Enter the harness server IP or DNS name with the gateway port, e.g. ws://192.0.2.10:8090. Use wss:// for TLS."
        >
          <input value={gateway} onChange={(e) => setGateway(e.target.value)} />
        </Field>
        <ErrorNotice error={setupError} />
        {enrollment.machine.platform === 'openshell' && (
          <p className="field-help">
            Run this as the OpenShell operator user, on the OpenShell gateway host or a machine that reaches
            it. The connector reuses that user's <code>openshell</code> gateway registration and mTLS bundle,
            and only needs outbound access to the harness gateway. Pin OpenShell {'0.1.2'}; the connector
            warns on drift.
          </p>
        )}
        {enrollment.machine.access_mode === 'host' && (
          <p className="field-help">
            Commands run as root on the VM host; sudo is unnecessary. Host NVIDIA/DCGM tools must be installed
            on the VM. The connector uses those binaries and devices through host namespaces, so copying
            driver packages into this image or adding --gpus all is unnecessary for this mode. File tools
            remain scoped to the connector work directory; use run_command for host files.
          </p>
        )}
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
            <CopyButton value={setupError ? '' : (snippets[tab] ?? '')} />
          </div>
          <pre>{setupError ? 'Correct the settings above to generate instructions.' : snippets[tab]}</pre>
        </div>
        <p className="field-help">
          Gateway address: <code>{enrollment.connectUrl}</code>. The machine only needs outbound access to it.
        </p>
        {/^wss?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(gateway) && (
          <p role="alert" className="field-help">
            This address points to the connector itself. Enter the harness server’s reachable IP or DNS name
            above before copying the install commands.
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
  isAdmin,
  data,
  machine,
  onClose,
  onSaved,
  onRotated,
}: {
  isAdmin: boolean;
  data: Data;
  machine: Machine;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRotated: (result: Enrollment) => void;
}) {
  const [name, setName] = useState(machine.name);
  const [accessMode, setAccessMode] = useState<'restricted' | 'host'>(machine.access_mode ?? 'restricted');
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
          void send(
            `/devices/${machine.device_id}`,
            {
              name,
              allowedTools: tools,
              disabled,
              ...(accessMode !== (machine.access_mode ?? 'restricted') ? { accessMode } : {}),
            },
            'PUT',
          )
            .then(() => onSaved())
            .then(onClose)
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(''));
        }}
      >
        <div className="two-columns">
          <Field label="Name">
            <input
              aria-label="Resource name"
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
                {platformLabels[machine.platform]} · <span className="mono">{machine.device_id}</span>
                {machine.hostname ? ` · ${machine.hostname}` : ''}
              </small>
            </div>
          </Field>
        </div>
        {machine.platform === 'linux' && !machine.cluster_id && (
          <Field
            label="Machine access"
            hint="Changing this setting disconnects the connector. Reinstall using Installation instructions. The setting alone cannot grant host privileges."
          >
            <select
              aria-label="Machine access"
              disabled={!isAdmin}
              value={accessMode}
              onChange={(e) => setAccessMode(e.target.value as 'restricted' | 'host')}
            >
              <option value="restricted">Restricted connector</option>
              <option value="host">Privileged VM host (root)</option>
            </select>
            <small>
              Active connector:{' '}
              {machine.active_access_mode === 'host'
                ? 'Privileged host'
                : machine.online
                  ? 'Restricted'
                  : 'Offline'}
            </small>
          </Field>
        )}
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
          {machine.cluster_id ? (
            <small className="field-help">
              This node uses its cluster’s shared token. Rotate it from Manage cluster.
            </small>
          ) : (
            <div className="row-actions">
              {(machine.platform === 'linux' || machine.platform === 'openshell') && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setBusy('install');
                    setError('');
                    void send(
                      `/devices/${machine.device_id}`,
                      {
                        name,
                        allowedTools: tools,
                        disabled,
                        ...(accessMode !== (machine.access_mode ?? 'restricted') ? { accessMode } : {}),
                      },
                      'PUT',
                    )
                      .then(async (updated: Machine) => {
                        await onSaved();
                        onRotated({
                          machine: updated,
                          token: '',
                          connectUrl: data.gateway.publicUrl.replace(/\/$/, '') + '/connect',
                          install: {},
                        });
                      })
                      .catch((e) => setError(errorMessage(e)))
                      .finally(() => setBusy(''));
                  }}
                >
                  Installation instructions
                </Button>
              )}
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
            </div>
          )}
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
