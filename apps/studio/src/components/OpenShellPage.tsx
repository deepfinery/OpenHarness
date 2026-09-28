// The OpenShell console: sandboxes, policies, rule proposals and logs of an OpenShell managed machine, driven
// through the connector over the trusted administrator path of the device gateway.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  CheckCircle2,
  Cpu,
  FileJson,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api, errorMessage, send, timestamp, type Data, type Machine } from '../api';
import { Button, Empty, ErrorNotice, Field, IconButton, Modal, PageTitle } from './ui';

type Sandbox = {
  name: string;
  id?: string;
  workspace?: string;
  phase?: string;
  created_at?: string;
  labels?: Record<string, string>;
  current_policy_version?: number;
  policy_source?: string;
  exit_code?: number | null;
  managed?: boolean;
  executor?: string;
};
type Revision = {
  version: number;
  hash?: string;
  status?: string;
  created_at_ms?: number;
  loaded_at_ms?: number;
  load_error?: string;
  provenance?: string;
  policy?: unknown;
};
type Proposal = {
  id: string;
  status: string;
  rule_name?: string;
  binary?: string;
  confidence?: number;
  rationale?: string;
  prover?: string;
  endpoints?: string;
  binaries?: string;
  hits?: string;
};
type Tab = 'policy' | 'proposals' | 'logs' | 'run';
const shortHash = (hash?: string) => (hash ? hash.slice(0, 12) : '—');
const fromMs = (ms?: number) => (ms ? timestamp(new Date(ms).toISOString()) : '—');
const phaseClass = (phase?: string) =>
  phase === 'Ready'
    ? 'ready'
    : phase === 'Error' || phase === 'Failed'
      ? 'failed'
      : phase === 'Stopped'
        ? 'disabled'
        : 'pending';
const readMachine = () => new URLSearchParams(location.search).get('machine') ?? '';
const starterPolicy = JSON.stringify(
  {
    version: 1,
    filesystem: { read_write: ['/sandbox'] },
    landlock: { compatibility: 'hard_requirement' },
    process: { run_as_user: 1000, run_as_group: 1000 },
    network_policies: {
      pypi: {
        name: 'pypi',
        endpoints: [
          { host: 'pypi.org', port: 443, access: 'read-only', protocol: 'rest', enforcement: 'enforce' },
        ],
        binaries: [{ path: '/usr/bin/curl' }],
      },
    },
  },
  null,
  2,
);

export function OpenShellPage({
  data,
  isAdmin,
  navigate,
}: {
  data: Data;
  isAdmin: boolean;
  navigate: (page: string) => void;
}) {
  const machines = useMemo(() => data.machines.filter((m) => m.platform === 'openshell'), [data.machines]);
  const [deviceId, setDeviceId] = useState(readMachine);
  const machine: Machine | undefined = machines.find((m) => m.device_id === deviceId) ?? machines[0];
  const [status, setStatus] = useState<any>(null);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<Tab>('policy');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [globalPolicy, setGlobalPolicy] = useState<any>(null);
  useEffect(() => {
    if (machine && machine.device_id !== deviceId) setDeviceId(machine.device_id);
  }, [machine?.device_id]);
  const base = machine ? `/openshell/${machine.device_id}` : '';
  const act = useCallback(async (label: string, task: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await task();
      if (done) setNotice(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }, []);
  const loadSandboxes = useCallback(async () => {
    if (!base) return;
    const result = await api(`${base}/sandboxes`);
    setSandboxes(result.sandboxes ?? []);
  }, [base]);
  const load = useCallback(async () => {
    if (!base) {
      setLoaded(true);
      return;
    }
    setError('');
    try {
      const [s] = await Promise.all([api(`${base}/status`), loadSandboxes()]);
      setStatus(s);
      setGlobalPolicy(await api(`${base}/policy/global`).catch(() => null));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, [base, loadSandboxes]);
  useEffect(() => {
    setStatus(null);
    setSandboxes([]);
    setSelected('');
    setLoaded(false);
    void load();
  }, [load]);
  useEffect(() => {
    if (!base) return;
    const timer = setInterval(() => void loadSandboxes().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [base, loadSandboxes]);
  const chooseMachine = (id: string) => {
    setDeviceId(id);
    const params = new URLSearchParams(location.search);
    params.set('machine', id);
    history.replaceState({}, '', `/openshell?${params}`);
  };
  const current = sandboxes.find((s) => s.name === selected);
  const gatewayState: string = status?.status?.status ?? (machine?.online ? 'unknown' : 'offline');
  const authState: string = status?.status?.authentication?.status ?? '—';
  if (!machines.length)
    return (
      <div className="fleet-page">
        <PageTitle
          eyebrow="OPENSHELL"
          title="OpenShell"
          text="Sandboxes, policies and rule proposals on your OpenShell managed machines, from the console."
        />
        <Empty
          icon={<Boxes size={30} />}
          title="No OpenShell managed machine yet"
          text="Add an OpenShell managed machine in the inventory: it enrolls like a Linux machine and its connector dials out from the OpenShell host, so the harness never connects into the private network."
          action={
            <Button onClick={() => navigate('inventory')}>
              <Plus size={16} />
              Add an OpenShell machine
            </Button>
          }
        />
      </div>
    );
  return (
    <div className="fleet-page openshell-page">
      <PageTitle
        eyebrow="OPENSHELL"
        title="OpenShell"
        text="Sandboxes, policies and rule proposals on your OpenShell managed machines, from the console."
        action={
          <Button variant="secondary" disabled={busy === 'refresh'} onClick={() => void act('refresh', load)}>
            <RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} />
            Refresh
          </Button>
        }
      />
      <div className="fleet-filters">
        <select
          aria-label="OpenShell machine"
          value={machine?.device_id ?? ''}
          onChange={(e) => chooseMachine(e.target.value)}
        >
          {machines.map((m) => (
            <option key={m.device_id} value={m.device_id}>
              {m.name}
              {m.online ? '' : ' (offline)'}
            </option>
          ))}
        </select>
        {machine && (
          <span className={`status ${machine.disabled ? 'disabled' : machine.online ? 'ready' : 'pending'}`}>
            <i />
            {machine.disabled ? 'disabled' : machine.online ? 'connector online' : 'connector offline'}
          </span>
        )}
        <small className="fleet-subtle">Sandboxes refresh every 15 seconds</small>
      </div>
      <div className="fleet-summary" aria-label="OpenShell summary">
        {[
          {
            label: 'Gateway',
            value: gatewayState,
            icon: ShieldCheck,
            detail: status?.status?.server ?? 'OpenShell gateway',
          },
          {
            label: 'Authentication',
            value: authState,
            icon: CheckCircle2,
            detail: status?.status?.authentication?.provider ?? status?.status?.authentication?.mode ?? '—',
          },
          {
            label: 'OpenShell',
            value: status?.status?.version ?? '—',
            icon: Boxes,
            detail: `CLI ${status?.cli_version ?? '—'} · ${status?.gateway_info?.compute_drivers?.map((d: any) => d.name).join(', ') || 'driver unknown'}`,
          },
          {
            label: 'Sandboxes',
            value: loaded ? sandboxes.length : '—',
            icon: ListChecks,
            detail: `${sandboxes.filter((s) => s.phase === 'Ready').length} ready · ${sandboxes.filter((s) => s.managed).length} created here`,
          },
        ].map(({ label, value, icon: Icon, detail }) => (
          <div className="fleet-stat" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={17} />
            </div>
            <strong className="openshell-stat-value">{String(value)}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <ErrorNotice error={error} />
      {notice && (
        <div className="notice">
          <CheckCircle2 size={16} />
          <span>{notice}</span>
        </div>
      )}
      {status?.connector_policy && !status.connector_policy.allow_policy_changes && (
        <p className="field-help">
          Policy changes are disabled in this connector's settings; the console can inspect policies but not
          change them.
        </p>
      )}
      <div className="openshell-layout">
        <section className="openshell-panel" aria-label="Sandboxes">
          <div className="fleet-section-heading">
            <div>
              <h2>Sandboxes</h2>
              <p>Workloads confined by OpenShell on this machine.</p>
            </div>
            {isAdmin && machine?.online && (
              <div className="row-actions">
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  Create sandbox
                </Button>
                <Button onClick={() => setLaunching(true)}>
                  <Cpu size={16} />
                  Launch executor
                </Button>
              </div>
            )}
          </div>
          {!loaded ? (
            <div className="fleet-loading" role="status">
              Loading sandboxes…
            </div>
          ) : !sandboxes.length ? (
            <Empty
              icon={<Boxes size={26} />}
              title="No sandboxes"
              text={
                machine?.online
                  ? 'Launch an executor (a confined machine for your harnesses) or create a sandbox; harnesses can also create sandboxes through this machine’s tools.'
                  : 'The connector is offline; start it on the OpenShell host to see its sandboxes.'
              }
            />
          ) : (
            <div className="fleet-table-wrap">
              <table className="fleet-table openshell-table">
                <thead>
                  <tr>
                    <th>Sandbox</th>
                    <th>Phase</th>
                    <th>Policy</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sandboxes.map((s) => (
                    <tr key={s.name} className={s.name === selected ? 'selected' : ''}>
                      <td data-label="Sandbox">
                        <div className="fleet-machine-name">
                          <span className="fleet-platform-icon">
                            <Boxes size={18} />
                          </span>
                          <div>
                            <button
                              className="text-button"
                              onClick={() => setSelected(s.name)}
                              aria-label={`Open sandbox ${s.name}`}
                            >
                              {s.name}
                            </button>
                            <small title={s.id}>
                              {s.workspace ?? 'default'} ·{' '}
                              {s.executor ? (
                                <em
                                  className="sandboxed-tag"
                                  title="Runs the OpenHarness connector under this policy"
                                >
                                  executor {s.executor}
                                </em>
                              ) : s.managed ? (
                                'created here'
                              ) : (
                                'operator sandbox'
                              )}{' '}
                              · {timestamp(s.created_at)}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td data-label="Phase">
                        <span className={`status ${phaseClass(s.phase)}`}>
                          <i />
                          {(s.phase ?? 'unknown').toLowerCase()}
                        </span>
                      </td>
                      <td data-label="Policy">
                        <strong className="fleet-tool-count">v{s.current_policy_version ?? '?'}</strong>
                        <small className="fleet-last-seen">
                          {s.policy_source === 'global' ? 'global policy' : 'sandbox policy'}
                        </small>
                      </td>
                      <td data-label="Actions">
                        <div className="fleet-row-actions">
                          <IconButton
                            title={`Policy of ${s.name}`}
                            aria-label={`Policy of ${s.name}`}
                            onClick={() => {
                              setSelected(s.name);
                              setTab('policy');
                            }}
                          >
                            <FileJson size={15} />
                          </IconButton>
                          {isAdmin && (
                            <>
                              <IconButton
                                title={s.phase === 'Stopped' ? `Start ${s.name}` : `Stop ${s.name}`}
                                disabled={Boolean(busy)}
                                onClick={() =>
                                  void act(`lifecycle:${s.name}`, async () => {
                                    await send(
                                      `${base}/sandboxes/${s.name}/${s.phase === 'Stopped' ? 'start' : 'stop'}`,
                                      {},
                                    );
                                    await loadSandboxes();
                                  })
                                }
                              >
                                {s.phase === 'Stopped' ? <Play size={15} /> : <Square size={15} />}
                              </IconButton>
                              <IconButton
                                title={`Delete ${s.name}`}
                                disabled={Boolean(busy)}
                                onClick={() => {
                                  if (
                                    !confirm(
                                      `Delete sandbox “${s.name}”? Its processes stop and its state is removed.`,
                                    )
                                  )
                                    return;
                                  void act(
                                    `delete:${s.name}`,
                                    async () => {
                                      await api(`${base}/sandboxes/${s.name}`, { method: 'DELETE' });
                                      if (selected === s.name) setSelected('');
                                      await loadSandboxes();
                                    },
                                    `Deleted ${s.name}`,
                                  );
                                }}
                              >
                                <Trash2 size={15} />
                              </IconButton>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {globalPolicy?.scope === 'global' && (
            <details className="openshell-global">
              <summary>
                <ShieldCheck size={14} /> A global policy (revision {globalPolicy.version}) overrides every
                sandbox policy on this gateway
              </summary>
              <pre>{JSON.stringify(globalPolicy.policy ?? globalPolicy, null, 2)}</pre>
            </details>
          )}
        </section>
        <section className="openshell-panel" aria-label="Sandbox detail">
          {!current ? (
            <Empty
              icon={<FileJson size={26} />}
              title="Pick a sandbox"
              text="Its policy, revision history, drafted rules and logs appear here."
            />
          ) : (
            <SandboxDetail
              key={`${base}:${current.name}`}
              base={base}
              sandbox={current}
              tab={tab}
              setTab={setTab}
              isAdmin={isAdmin && Boolean(machine?.online)}
              act={act}
              busy={busy}
              onChanged={loadSandboxes}
            />
          )}
        </section>
      </div>
      {launching && machine && (
        <LaunchExecutorModal
          base={base}
          onClose={() => setLaunching(false)}
          onLaunched={async (name) => {
            setLaunching(false);
            setNotice(`Executor ${name} launched; it registers as machine ${name} in the inventory`);
            await loadSandboxes();
            setSelected(name);
          }}
        />
      )}
      {creating && machine && (
        <CreateSandboxModal
          base={base}
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false);
            setNotice(`Created ${name}`);
            await loadSandboxes();
            setSelected(name);
          }}
        />
      )}
    </div>
  );
}

function SandboxDetail({
  base,
  sandbox,
  tab,
  setTab,
  isAdmin,
  act,
  busy,
  onChanged,
}: {
  base: string;
  sandbox: Sandbox;
  tab: Tab;
  setTab: (tab: Tab) => void;
  isAdmin: boolean;
  act: (label: string, task: () => Promise<unknown>, done?: string) => Promise<void>;
  busy: string;
  onChanged: () => Promise<void>;
}) {
  const path = `${base}/sandboxes/${sandbox.name}`;
  const [view, setView] = useState<'base' | 'full'>('base');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [policy, setPolicy] = useState<any>(null);
  const [draft, setDraft] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalStatus, setProposalStatus] = useState('pending');
  const [logs, setLogs] = useState('');
  const [since, setSince] = useState('1h');
  const [source, setSource] = useState('all');
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<any>(null);
  const [rule, setRule] = useState({
    host: '',
    port: '443',
    access: 'read-only',
    protocol: 'rest',
    enforcement: 'enforce',
    binary: '/usr/bin/curl',
    name: '',
  });
  const [detailError, setDetailError] = useState('');
  const loadPolicy = useCallback(async () => {
    const [p, r] = await Promise.all([api(`${path}/policy?view=${view}`), api(`${path}/policy/revisions`)]);
    setPolicy(p);
    setDraft(JSON.stringify(p.policy ?? {}, null, 2));
    setRevisions((r.revisions ?? []).slice().sort((a: Revision, b: Revision) => b.version - a.version));
  }, [path, view]);
  const loadProposals = useCallback(async () => {
    setProposals(
      (await api(`${path}/proposals${proposalStatus ? `?status=${proposalStatus}` : ''}`)).proposals ?? [],
    );
  }, [path, proposalStatus]);
  const loadLogs = useCallback(async () => {
    setLogs((await api(`${path}/logs?since=${since}&source=${source}&lines=300`)).text ?? '');
  }, [path, since, source]);
  useEffect(() => {
    setDetailError('');
    const task =
      tab === 'policy' ? loadPolicy : tab === 'proposals' ? loadProposals : tab === 'logs' ? loadLogs : null;
    if (task) task().catch((e) => setDetailError(errorMessage(e)));
  }, [tab, loadPolicy, loadProposals, loadLogs]);
  const tabs: [Tab, string, typeof FileJson][] = [
    ['policy', 'Policy', FileJson],
    ['proposals', 'Proposals', ListChecks],
    ['logs', 'Logs', ScrollText],
    ['run', 'Run', Terminal],
  ];
  return (
    <>
      <div className="fleet-section-heading">
        <div>
          <h2>{sandbox.name}</h2>
          <p>
            {sandbox.phase ?? 'unknown'} · policy v{sandbox.current_policy_version ?? '?'}
            {sandbox.labels && Object.keys(sandbox.labels).length
              ? ` · ${Object.entries(sandbox.labels)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')}`
              : ''}
          </p>
        </div>
      </div>
      <div className="tabs compact" role="tablist" aria-label="Sandbox views">
        {tabs
          .filter(([id]) => id !== 'run' || isAdmin)
          .map(([id, label, Icon]) => (
            <button
              type="button"
              role="tab"
              key={id}
              aria-selected={tab === id}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
      </div>
      <ErrorNotice error={detailError} />
      {tab === 'policy' && (
        <div className="policy-editor">
          <div className="compact-actions">
            <button
              type="button"
              className={`text-button ${view === 'base' ? 'active' : ''}`}
              onClick={() => setView('base')}
              aria-pressed={view === 'base'}
            >
              Base policy
            </button>
            <button
              type="button"
              className={`text-button ${view === 'full' ? 'active' : ''}`}
              onClick={() => setView('full')}
              aria-pressed={view === 'full'}
            >
              Effective policy
            </button>
            <small>
              {policy
                ? `revision ${policy.version ?? '?'} · ${policy.status ?? ''} · ${shortHash(policy.hash)}`
                : 'loading…'}
              {policy?.policy_source === 'global' ? ' · overridden by the global policy' : ''}
            </small>
          </div>
          <textarea
            aria-label="Policy JSON"
            className="mono"
            spellCheck={false}
            readOnly={!isAdmin || view === 'full'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {isAdmin && (
            <div className="openshell-actions between">
              <small className="field-help">
                Edit from the base policy. Only network sections take effect on a running sandbox; filesystem,
                Landlock and process changes need a new sandbox.
              </small>
              <div className="row-actions">
                <Button
                  variant="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void loadPolicy().catch((e) => setDetailError(errorMessage(e)))}
                >
                  Reset
                </Button>
                <Button
                  disabled={Boolean(busy) || view === 'full'}
                  onClick={() =>
                    void act(
                      'policy',
                      async () => {
                        await send(`${path}/policy`, { policy: draft, wait: true }, 'PUT');
                        await Promise.all([loadPolicy(), onChanged()]);
                      },
                      `Policy applied to ${sandbox.name}`,
                    )
                  }
                >
                  <ShieldCheck size={15} />
                  Apply policy
                </Button>
              </div>
            </div>
          )}
          {isAdmin && (
            <form
              className="rule-form"
              aria-label="Add a network rule"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  'rule',
                  async () => {
                    await send(`${path}/policy/rules`, {
                      add_endpoints: [
                        `${rule.host}:${rule.port}:${rule.access}:${rule.protocol}:${rule.enforcement}`,
                      ],
                      binaries: rule.binary ? [rule.binary] : undefined,
                      rule_name: rule.name || undefined,
                      wait: true,
                    });
                    setRule({ ...rule, host: '', name: '' });
                    await Promise.all([loadPolicy(), onChanged()]);
                  },
                  `Rule added to ${sandbox.name}`,
                );
              }}
            >
              <h3>Allow a destination</h3>
              <div className="rule-grid">
                <Field label="Host">
                  <input
                    aria-label="Rule host"
                    required
                    placeholder="api.github.com"
                    value={rule.host}
                    onChange={(e) => setRule({ ...rule, host: e.target.value })}
                  />
                </Field>
                <Field label="Port">
                  <input
                    aria-label="Rule port"
                    required
                    pattern="\d{1,5}"
                    value={rule.port}
                    onChange={(e) => setRule({ ...rule, port: e.target.value })}
                  />
                </Field>
                <Field label="Access">
                  <select
                    aria-label="Rule access"
                    value={rule.access}
                    onChange={(e) => setRule({ ...rule, access: e.target.value })}
                  >
                    <option value="read-only">read-only</option>
                    <option value="read-write">read-write</option>
                  </select>
                </Field>
                <Field label="Protocol">
                  <select
                    aria-label="Rule protocol"
                    value={rule.protocol}
                    onChange={(e) => setRule({ ...rule, protocol: e.target.value })}
                  >
                    <option value="rest">rest</option>
                    <option value="tcp">tcp</option>
                    <option value="websocket">websocket</option>
                    <option value="mcp">mcp</option>
                  </select>
                </Field>
                <Field label="Enforcement">
                  <select
                    aria-label="Rule enforcement"
                    value={rule.enforcement}
                    onChange={(e) => setRule({ ...rule, enforcement: e.target.value })}
                  >
                    <option value="enforce">enforce</option>
                    <option value="audit">audit</option>
                  </select>
                </Field>
                <Field label="Binary">
                  <input
                    aria-label="Rule binary"
                    placeholder="/usr/bin/curl"
                    value={rule.binary}
                    onChange={(e) => setRule({ ...rule, binary: e.target.value })}
                  />
                </Field>
                <Field label="Rule name">
                  <input
                    aria-label="Rule name"
                    placeholder="optional"
                    value={rule.name}
                    onChange={(e) => setRule({ ...rule, name: e.target.value })}
                  />
                </Field>
              </div>
              <div className="openshell-actions">
                <Button type="submit" variant="secondary" disabled={Boolean(busy) || !rule.host}>
                  <Plus size={15} />
                  Add rule
                </Button>
              </div>
            </form>
          )}
          <h3 className="openshell-subheading">Revisions</h3>
          {!revisions.length ? (
            <p className="fleet-subtle">No revisions reported yet.</p>
          ) : (
            <ul className="revision-list">
              {revisions.map((r) => (
                <li key={r.version}>
                  <span
                    className={`status ${r.status === 'loaded' ? 'ready' : r.status === 'failed' ? 'failed' : 'pending'}`}
                  >
                    <i />
                    {r.status ?? 'unknown'}
                  </span>
                  <strong>v{r.version}</strong>
                  <span className="mono">{shortHash(r.hash)}</span>
                  <small>
                    {fromMs(r.created_at_ms)}
                    {r.provenance ? ` · ${r.provenance}` : ''}
                  </small>
                  {r.load_error && <em className="revision-error">{r.load_error}</em>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === 'proposals' && (
        <div className="proposals">
          <div className="compact-actions">
            <select
              aria-label="Proposal status"
              value={proposalStatus}
              onChange={(e) => setProposalStatus(e.target.value)}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="">All</option>
            </select>
            <small>Rules the policy advisor drafted from denied requests.</small>
          </div>
          {!proposals.length ? (
            <p className="fleet-subtle">No {proposalStatus || ''} proposals.</p>
          ) : (
            proposals.map((p) => (
              <article className="proposal-card" key={p.id}>
                <div>
                  <strong>{p.rule_name ?? p.id}</strong>
                  <span
                    className={`status ${p.status === 'approved' ? 'ready' : p.status === 'rejected' ? 'failed' : 'pending'}`}
                  >
                    <i />
                    {p.status}
                  </span>
                </div>
                <p>{p.rationale}</p>
                <small>
                  {p.endpoints ? `${p.endpoints} · ` : ''}
                  {p.binaries ?? p.binary ?? ''}
                  {p.confidence !== undefined ? ` · confidence ${p.confidence}%` : ''}
                  {p.prover ? ` · prover: ${p.prover}` : ''}
                  {p.hits ? ` · hits ${p.hits}` : ''}
                </small>
                {isAdmin && p.status === 'pending' && (
                  <div className="row-actions">
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void act(
                          'approve',
                          async () => {
                            await send(`${path}/proposals/${p.id}/approve`, {});
                            await Promise.all([loadProposals(), onChanged()]);
                          },
                          'Rule approved; it hot-reloads into the sandbox',
                        )
                      }
                    >
                      <CheckCircle2 size={15} />
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        const reason =
                          prompt('Why is this rule rejected? The agent can read the reason.') ?? '';
                        void act(
                          'reject',
                          async () => {
                            await send(`${path}/proposals/${p.id}/reject`, { reason });
                            await loadProposals();
                          },
                          'Rule rejected',
                        );
                      }}
                    >
                      <XCircle size={15} />
                      Reject
                    </Button>
                  </div>
                )}
              </article>
            ))
          )}
        </div>
      )}
      {tab === 'logs' && (
        <div className="sandbox-logs">
          <div className="compact-actions">
            <select aria-label="Log window" value={since} onChange={(e) => setSince(e.target.value)}>
              <option value="10m">Last 10 minutes</option>
              <option value="1h">Last hour</option>
              <option value="6h">Last 6 hours</option>
              <option value="24h">Last day</option>
            </select>
            <select aria-label="Log source" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="all">Sandbox and gateway</option>
              <option value="sandbox">Sandbox</option>
              <option value="gateway">Gateway</option>
            </select>
            <button
              type="button"
              className="text-button"
              onClick={() => void loadLogs().catch((e) => setDetailError(errorMessage(e)))}
            >
              Reload
            </button>
          </div>
          <pre className="log-output" aria-label="Sandbox log">
            {logs || 'No log lines in this window.'}
          </pre>
        </div>
      )}
      {tab === 'run' && isAdmin && (
        <form
          className="run-form"
          onSubmit={(e) => {
            e.preventDefault();
            const argv = command.trim().startsWith('[')
              ? (JSON.parse(command) as string[])
              : command.trim().split(/\s+/);
            void act('run', async () => {
              setOutput(await send(`${path}/exec`, { argv, timeout_seconds: 60 }));
            });
          }}
        >
          <Field
            label="Command"
            hint="Program and arguments separated by spaces, or a JSON array. There is no shell."
          >
            <input
              aria-label="Command"
              placeholder="curl -s https://api.github.com/"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </Field>
          <div className="openshell-actions">
            <Button type="submit" disabled={Boolean(busy) || !command.trim()}>
              <Play size={15} />
              Run in sandbox
            </Button>
          </div>
          {output && (
            <div className="run-output">
              <div className="compact-actions">
                <span
                  className={`status ${output.policy_denied ? 'failed' : output.exit_code === 0 ? 'ready' : 'pending'}`}
                >
                  <i />
                  {output.policy_denied ? 'denied by policy' : `exit ${output.exit_code ?? output.signal}`}
                </span>
                {output.truncated && <small>output truncated</small>}
              </div>
              <pre className="log-output" aria-label="Command output">
                {[output.stdout, output.stderr].filter(Boolean).join('\n') || '(no output)'}
              </pre>
            </div>
          )}
        </form>
      )}
    </>
  );
}
function CreateSandboxModal({
  base,
  onClose,
  onCreated,
}: {
  base: string;
  onClose: () => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [command, setCommand] = useState('');
  const [policy, setPolicy] = useState(starterPolicy);
  const [noKeep, setNoKeep] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Create a sandbox" onClose={onClose} wide>
      <form
        className="form-content"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const argv = command.trim()
            ? command.trim().startsWith('[')
              ? (JSON.parse(command) as string[])
              : command.trim().split(/\s+/)
            : undefined;
          void send(`${base}/sandboxes`, {
            name: name || undefined,
            image: image || undefined,
            command: argv,
            policy: policy.trim() || undefined,
            no_keep: noKeep || undefined,
          })
            .then((created) => onCreated(created.name ?? name))
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="two-columns">
          <Field label="Name" hint="Lowercase letters, digits and dashes; generated when empty.">
            <input
              aria-label="Sandbox name"
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Image"
            hint="A container image reference the connector allows; the gateway default when empty."
          >
            <input
              aria-label="Sandbox image"
              placeholder="registry.example.com/agents/worker:1.0"
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Main command" hint="Optional. Runs detached; the sandbox stays up when empty.">
          <input
            aria-label="Sandbox command"
            placeholder="./worker --once"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
        <Field
          label="Policy"
          hint="YAML or JSON. Filesystem, Landlock and process settings only apply at creation."
        >
          <textarea
            aria-label="Sandbox policy"
            className="mono policy-textarea"
            spellCheck={false}
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
          />
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={noKeep} onChange={(e) => setNoKeep(e.target.checked)} />
          <span>
            <strong>Delete when the main command exits</strong>
            <small>For one-shot jobs. Not compatible with exposed services.</small>
          </span>
        </label>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            <Plus size={15} />
            Create sandbox
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LaunchExecutorModal({
  base,
  onClose,
  onLaunched,
}: {
  base: string;
  onClose: () => void;
  onLaunched: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [hosts, setHosts] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Launch an executor" onClose={onClose} wide>
      <form
        className="form-content"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void send(`${base}/executors`, {
            name,
            image: image || undefined,
            allowed_hosts: hosts
              .split(/[\s,]+/)
              .map((h) => h.trim())
              .filter(Boolean),
          })
            .then((result) => onLaunched(result.machine?.device_id ?? name))
            .catch((err) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <p className="field-help">
          An executor is a sandbox on this OpenShell host that runs the OpenHarness connector under a policy.
          The studio enrolls it as a Linux machine and hands the edge its token; the sandbox may reach only
          the harness gateway and the hosts you list. Pick it in the playground like any machine: every
          command a harness runs on it is confined by OpenShell.
        </p>
        <div className="two-columns">
          <Field label="Machine name" hint="Lowercase letters, digits and dashes; also the sandbox name.">
            <input
              aria-label="Executor name"
              required
              autoFocus
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              placeholder="worker-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Image"
            hint="Defaults to the edge's executor image; it must contain openharness-connector."
          >
            <input aria-label="Executor image" value={image} onChange={(e) => setImage(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Extra destinations"
          hint="host:port[:access[:protocol[:enforcement]]], one per line. The harness gateway is always allowed."
        >
          <textarea
            aria-label="Executor allowed hosts"
            rows={3}
            placeholder={'pypi.org:443:read-only:rest:enforce\napi.github.com:443'}
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
          />
        </Field>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            <Cpu size={15} />
            {busy ? 'Launching…' : 'Launch executor'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
