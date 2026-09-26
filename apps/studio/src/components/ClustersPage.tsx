import { AgentFields } from './agentFields';
import { defaultAgent } from '../workflowGraph';
import type { Agent } from '../../../../packages/core/src/schema.js';
import { useState } from 'react';
import { Activity, ArrowRight, Layers3, Plus, ShieldCheck } from 'lucide-react';
import type { FleetCluster } from './InfrastructurePage';
import { api, send, errorMessage, timestamp, type Data } from '../api';
import { Button, CopyButton, ErrorNotice, Field, Modal, Empty } from './ui';
const actions = ['gpu_reset', 'restart_fabric_manager', 'reboot'];
export function ClustersPage({
  data,
  isAdmin,
  refreshData,
  clusters,
  refreshClusters,
  onViewNodes,
}: {
  data: Data;
  isAdmin: boolean;
  refreshData: () => Promise<void>;
  clusters: FleetCluster[];
  refreshClusters: () => Promise<void>;
  onViewNodes: (id: string) => void;
}) {
  const [draftAgent, setDraftAgent] = useState<(Agent & { id?: string }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false),
    [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<any>(null),
    [selected, setSelected] = useState<any>(null);
  const [cycles, setCycles] = useState<any[]>([]),
    [monitor, setMonitor] = useState<any>(null);
  const [policy, setPolicy] = useState<any>(null);
  const refresh = refreshClusters;
  const act = async (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      setError('');
      await task();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (cluster: any) => {
    setSelected(cluster);
    setPolicy({ ...cluster });
    setMonitor(
      cluster.monitor ?? {
        enabled: false,
        agentId: data.agents[0]?.id ?? '',
        intervalSeconds: 300,
        concurrency: 4,
        instructions:
          'Inspect GPU health, NVIDIA kernel Xid errors, NVLink status and DCGM. Identify causes of training slowdowns using evidence. Compare with saved observations and report uncertainty. Request only permitted remediation; never stop active workloads.',
      },
    );
    setCycles(await api(`/clusters/${cluster._id}/cycles`));
  };
  return (
    <>
      <div className="fleet-section-heading">
        <div>
          <h2>Your clusters</h2>
          <p>Group nodes under one enrollment token and coordinate their monitoring.</p>
        </div>
        {isAdmin && data.gateway.configured && (
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} />
            Create cluster
          </Button>
        )}
      </div>
      <div className="fleet-filters">
        <input
          aria-label="Search clusters"
          placeholder="Search clusters…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="fleet-subtle">{clusters.length} clusters</span>
      </div>
      <ErrorNotice error={!selected && !adding && !enrollment && !draftAgent ? error : ''} />
      <div className="fleet-cluster-grid">
        {clusters
          .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
          .map((c) => {
            const online = data.machines.filter(
              (m) => m.cluster_id === c._id && m.online && !m.disabled,
            ).length;
            return (
              <article className="fleet-cluster-card" key={c._id}>
                <div className="fleet-cluster-top">
                  <span className="fleet-cluster-icon">
                    <Layers3 size={23} />
                  </span>
                  <span className={`status ${c.disabled ? 'disabled' : 'ready'}`}>
                    <i />
                    {c.disabled ? 'disabled' : 'enabled'}
                  </span>
                </div>
                <h3>{c.name}</h3>
                <div className="fleet-cluster-nodes">
                  <strong>{c.node_count}</strong>
                  <span>
                    registered nodes
                    <small>
                      {online} online · capacity {c.max_nodes.toLocaleString()}
                    </small>
                  </span>
                </div>
                <div
                  className="fleet-capacity"
                  role="meter"
                  aria-label={`${c.name} node capacity`}
                  aria-valuenow={c.node_count}
                  aria-valuemin={0}
                  aria-valuemax={c.max_nodes}
                >
                  <i style={{ width: `${Math.min(100, (c.node_count / c.max_nodes) * 100)}%` }} />
                </div>
                <div className="fleet-cluster-facts">
                  <div>
                    <Activity size={15} />
                    <span>Monitoring</span>
                    <strong>
                      {c.disabled
                        ? 'Cluster disabled'
                        : c.monitor?.enabled
                          ? `Every ${c.monitor.intervalSeconds / 60} min`
                          : 'Not scheduled'}
                    </strong>
                  </div>
                  <div>
                    <ShieldCheck size={15} />
                    <span>Remediation</span>
                    <strong>
                      {c.remediation === 'approval'
                        ? 'Human approval'
                        : c.remediation === 'automatic'
                          ? 'Automatic'
                          : 'Diagnostics only'}
                    </strong>
                  </div>
                </div>
                {c.monitor?.error && <ErrorNotice error={c.monitor.error} />}
                <div className="fleet-cluster-footer">
                  <Button
                    variant="secondary"
                    aria-label={`Configure ${c.name}`}
                    onClick={() => void act(() => open(c))}
                    disabled={busy}
                  >
                    Manage cluster
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`View nodes in ${c.name}`}
                    onClick={() => onViewNodes(c._id)}
                  >
                    View nodes
                    <ArrowRight size={14} />
                  </Button>
                </div>
              </article>
            );
          })}
      </div>
      {!clusters.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())).length && (
        <Empty
          icon={<Layers3 size={30} />}
          title={query ? 'No matching clusters' : 'Bring your fleet together'}
          text={
            query
              ? 'Try a different cluster name.'
              : 'Create a cluster once, install its connector on your nodes, and let them register automatically.'
          }
          action={
            query ? (
              <Button variant="secondary" onClick={() => setQuery('')}>
                Clear search
              </Button>
            ) : isAdmin && data.gateway.configured ? (
              <Button onClick={() => setAdding(true)}>Set up a cluster</Button>
            ) : undefined
          }
        />
      )}
      <div className="fleet-guide">
        <Layers3 size={22} />
        <div>
          <h3>One cluster. One enrollment configuration.</h3>
          <p>
            Create a cluster → install the connector on your nodes → choose a monitoring agent. Nodes appear
            in the machine inventory as they connect.
          </p>
          <small>
            Start with diagnostics. Enable remediation separately when your cluster and nodes are ready.
          </small>
        </div>
      </div>
      {adding && (
        <Modal title="Create cluster" onClose={() => setAdding(false)}>
          <form
            className="fleet-cluster-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isAdmin || busy) return;
              void act(async () => {
                const r = await send('/clusters', { name });
                setEnrollment(r.install);
                setAdding(false);
                setName('');
                await refresh();
              });
            }}
          >
            <Field label="Cluster name">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <ErrorNotice error={error} />
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </form>
        </Modal>
      )}
      {enrollment && (
        <Modal title="Install cluster nodes" onClose={() => setEnrollment(null)} wide>
          <div className="fleet-cluster-form">
            <ErrorNotice error={error} />
            <p>
              Save this shared enrollment configuration as a root-readable file on each node. The token is
              shown once. Rotation disconnects every node until its configuration is updated.
            </p>
            <pre>{enrollment.environment}</pre>
            <CopyButton value={enrollment.environment} />
            <p>From a checkout of this repository, install the connector container:</p>
            <pre>{enrollment.command}</pre>
            <CopyButton value={enrollment.command} />
            <p>For host NVIDIA diagnostics, explicitly grant privileged host access:</p>
            <pre>{enrollment.privilegedCommand}</pre>
            <CopyButton value={enrollment.privilegedCommand} />
            <p className="muted">
              Use a gateway address reachable from every node. WSS validates TLS certificates; WS is available
              for development. Host tools use the node’s installed NVIDIA/DCGM utilities. Disruptive
              operations also require HOST_REMEDIATION_ACTIONS and a fresh drain authorization on that node.
            </p>
          </div>
        </Modal>
      )}
      {selected && monitor && policy && !enrollment && !draftAgent && (
        <Modal title={`Cluster: ${selected.name}`} onClose={() => setSelected(null)} wide>
          <form
            className="fleet-cluster-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isAdmin || busy) return;
              void act(async () => {
                await send(
                  `/clusters/${selected._id}`,
                  {
                    name: policy.name,
                    disabled: policy.disabled,
                    max_nodes: Number(policy.max_nodes),
                    remediation: policy.remediation,
                    actions: policy.actions,
                    cooldown_seconds: Number(policy.cooldown_seconds),
                  },
                  'PUT',
                );
                if (monitor.agentId) await send(`/clusters/${selected._id}/monitor`, monitor, 'PUT');
                await refresh();
                setSelected(null);
              });
            }}
          >
            <ErrorNotice error={error} />
            <h3 className="fleet-form-heading">Cluster access</h3>
            <Field label="Cluster name">
              <input
                disabled={!isAdmin}
                value={policy.name}
                onChange={(e) => setPolicy({ ...policy, name: e.target.value })}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={policy.disabled}
                onChange={(e) => setPolicy({ ...policy, disabled: e.target.checked })}
              />{' '}
              Disable cluster access
            </label>
            <Field label="Maximum registered nodes">
              <input
                type="number"
                min={1}
                max={10000}
                disabled={!isAdmin}
                value={policy.max_nodes}
                onChange={(e) => setPolicy({ ...policy, max_nodes: Number(e.target.value) })}
              />
            </Field>
            <h3 className="fleet-form-heading">Scheduled monitoring</h3>
            {isAdmin && (
              <div className="row-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setDraftAgent({
                      ...defaultAgent(data),
                      name: 'GPU monitor',
                      tokenBudget: 16000,
                      systemPrompt:
                        'Inspect the assigned GPU node using its diagnostics tools. Report evidence and uncertainty. Follow cluster remediation controls and never stop workloads to force a reset.',
                    })
                  }
                >
                  New monitoring agent
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!monitor.agentId}
                  onClick={() => {
                    const a = data.agents.find((a) => a.id === monitor.agentId);
                    if (a) setDraftAgent(a as Agent & { id: string });
                  }}
                >
                  Edit monitoring agent
                </Button>
              </div>
            )}
            <Field label="Monitoring agent">
              <select
                required={monitor.enabled}
                disabled={!isAdmin}
                value={monitor.agentId}
                onChange={(e) => setMonitor({ ...monitor, agentId: e.target.value })}
              >
                <option value="">Choose an agent</option>
                {data.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <label>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={monitor.enabled}
                onChange={(e) => setMonitor({ ...monitor, enabled: e.target.checked })}
              />{' '}
              Enable scheduled monitoring
            </label>
            <Field label="Interval (seconds)">
              <input
                type="number"
                min={300}
                max={86400}
                disabled={!isAdmin}
                value={monitor.intervalSeconds}
                onChange={(e) => setMonitor({ ...monitor, intervalSeconds: Number(e.target.value) })}
              />
            </Field>
            <Field label="Concurrent node agents">
              <input
                type="number"
                min={1}
                max={50}
                disabled={!isAdmin}
                value={monitor.concurrency}
                onChange={(e) => setMonitor({ ...monitor, concurrency: Number(e.target.value) })}
              />
            </Field>
            <Field label="Monitoring instructions">
              <textarea
                rows={4}
                disabled={!isAdmin}
                value={monitor.instructions}
                onChange={(e) => setMonitor({ ...monitor, instructions: e.target.value })}
              />
            </Field>
            <h3 className="fleet-form-heading">Remediation controls</h3>
            <Field label="Remediation mode">
              <select
                disabled={!isAdmin}
                value={policy.remediation}
                onChange={(e) => setPolicy({ ...policy, remediation: e.target.value })}
              >
                <option value="disabled">Disabled (diagnostics only)</option>
                <option value="approval">Human approval</option>
                <option value="automatic">Automatic within limits</option>
              </select>
            </Field>
            <p className="muted">
              At most one disruptive request per cluster cooldown. The node additionally requires fresh
              workload-drain authorization, no active GPU jobs and a ten-minute cooldown. Pausing monitoring
              stops new dispatch; runs already started remain visible in Runs.
            </p>
            {actions.map((action) => (
              <label key={action}>
                <input
                  type="checkbox"
                  disabled={!isAdmin}
                  checked={policy.actions.includes(action)}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      actions: e.target.checked
                        ? [...policy.actions, action]
                        : policy.actions.filter((x: string) => x !== action),
                    })
                  }
                />
                {action.replaceAll('_', ' ')}
              </label>
            ))}
            <Field label="Cluster disruption cooldown (seconds)">
              <input
                type="number"
                min={60}
                max={86400}
                disabled={!isAdmin}
                value={policy.cooldown_seconds}
                onChange={(e) => setPolicy({ ...policy, cooldown_seconds: Number(e.target.value) })}
              />
            </Field>
            {isAdmin && (
              <div className="row-actions">
                <Button type="submit" disabled={busy}>
                  Save cluster
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void act(async () => {
                      if (
                        !confirm(
                          'Rotate the shared token? Every node must be reconfigured before it can reconnect.',
                        )
                      )
                        return;
                      const r = await send(`/clusters/${selected._id}/rotate-token`);
                      setEnrollment(r.install);
                    })
                  }
                >
                  Rotate enrollment token
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void act(async () => {
                      await send(`/clusters/${selected._id}/scan`);
                      setCycles(await api(`/clusters/${selected._id}/cycles`));
                    })
                  }
                >
                  Scan now
                </Button>
              </div>
            )}
          </form>
          <div className="fleet-cluster-form">
            <h3>Recent monitoring cycles</h3>
            {cycles.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Progress</th>
                    <th>Results</th>
                  </tr>
                </thead>
                <tbody>
                  {cycles.map((c) => (
                    <tr key={c._id}>
                      <td>{timestamp(c.createdAt)}</td>
                      <td>
                        {c.status} · {c.cursor}/{c.nodeCount} dispatched · {c.offline} offline
                      </td>
                      <td>
                        {c.completed} succeeded · {c.failed} failed · {c.skipped} skipped
                        {c.error && <ErrorNotice error={c.error} />}
                        <a href={`/executions?cycle=${encodeURIComponent(c._id)}`}>View node runs</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No monitoring cycles yet.</p>
            )}
          </div>
        </Modal>
      )}
      {draftAgent && (
        <Modal
          title={draftAgent.id ? 'Edit monitoring agent' : 'New monitoring agent'}
          onClose={() => setDraftAgent(null)}
          wide
        >
          <ErrorNotice error={error} />
          <form
            className="fleet-cluster-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isAdmin || busy) return;
              void act(async () => {
                const saved = await send(
                  draftAgent.id ? `/agents/${draftAgent.id}` : '/agents',
                  draftAgent,
                  draftAgent.id ? 'PUT' : 'POST',
                );
                await refreshData();
                setMonitor((current: any) => ({ ...current, agentId: saved.id }));
                setDraftAgent(null);
              });
            }}
          >
            <Field label="Monitoring agent name">
              <input
                required
                value={draftAgent.name}
                onChange={(e) => setDraftAgent({ ...draftAgent, name: e.target.value })}
              />
            </Field>
            <AgentFields
              value={draftAgent}
              data={data}
              refresh={refreshData}
              onChange={(patch) => setDraftAgent((current) => (current ? { ...current, ...patch } : current))}
            />
            <Button type="submit" disabled={busy}>
              Save monitoring agent
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
