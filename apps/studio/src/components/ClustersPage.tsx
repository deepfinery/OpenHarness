import { useEffect, useState } from 'react';
import { api, send, errorMessage, timestamp, type Data } from '../api';
import { Button, CopyButton, ErrorNotice, Field, Modal, PageTitle } from './ui';
const actions = ['gpu_reset', 'restart_fabric_manager', 'reboot'];
export function ClustersPage({ data, isAdmin }: { data: Data; isAdmin: boolean }) {
  const [clusters, setClusters] = useState<any[]>([]),
    [error, setError] = useState('');
  const [adding, setAdding] = useState(false),
    [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<any>(null),
    [selected, setSelected] = useState<any>(null);
  const [cycles, setCycles] = useState<any[]>([]),
    [monitor, setMonitor] = useState<any>(null);
  const [policy, setPolicy] = useState<any>(null);
  const refresh = async () => {
    const r = await api('/clusters');
    setClusters(r.clusters);
  };
  const act = async (task: () => Promise<unknown>) => {
    try {
      setError('');
      await task();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void act(refresh);
    const timer = setInterval(() => void refresh().catch(() => {}), 10000);
    return () => clearInterval(timer);
  }, []);
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
      <PageTitle
        title="Clusters"
        action={isAdmin && <Button onClick={() => setAdding(true)}>Create cluster</Button>}
      />
      <p className="muted">
        One enrollment token for the cluster. Nodes register themselves; a coordinator schedules a separate
        agent run on each online node in bounded waves.
      </p>
      <ErrorNotice error={error} />
      <div className="card-grid">
        {clusters.map((c) => (
          <article className="resource-card" key={c._id}>
            <h3>{c.name}</h3>
            <p>
              {c.node_count} registered nodes · {c.disabled ? 'Disabled' : 'Enabled'}
            </p>
            <p className="muted">
              Monitoring {c.monitor?.enabled ? `every ${c.monitor.intervalSeconds / 60} minutes` : 'paused'} ·
              Remediation {c.remediation}
            </p>
            {c.monitor?.error && <ErrorNotice error={c.monitor.error} />}
            <Button variant="secondary" onClick={() => void act(() => open(c))}>
              Configure {c.name}
            </Button>
          </article>
        ))}
      </div>
      {adding && (
        <Modal title="Create cluster" onClose={() => setAdding(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
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
            <Button type="submit">Create</Button>
          </form>
        </Modal>
      )}
      {enrollment && (
        <Modal title="Install cluster nodes" onClose={() => setEnrollment(null)}>
          <p>
            Save this shared enrollment configuration as a root-readable file on each node. The token is shown
            once. Rotation disconnects every node until its configuration is updated.
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
            for development. Host tools use the node’s installed NVIDIA/DCGM utilities. Disruptive operations
            also require HOST_REMEDIATION_ACTIONS and a fresh drain authorization on that node.
          </p>
        </Modal>
      )}
      {selected && monitor && policy && (
        <Modal title={`Cluster: ${selected.name}`} onClose={() => setSelected(null)} wide>
          <form
            onSubmit={(e) => {
              e.preventDefault();
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
                <Button type="submit">Save cluster</Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void act(async () => {
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
                      <a href={`/runs?cycle=${encodeURIComponent(c._id)}`}>View node runs</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No monitoring cycles yet.</p>
          )}
        </Modal>
      )}
    </>
  );
}
