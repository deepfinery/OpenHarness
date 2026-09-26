import { useCallback, useEffect, useState } from 'react';
import { Activity, Layers3, Network, RefreshCw, Server } from 'lucide-react';
import { api, errorMessage, type Data, type Machine } from '../api';
import { Button, ErrorNotice, PageTitle } from './ui';
import { MachinesPage } from './MachinesPage';
import { ClustersPage } from './ClustersPage';

export type FleetCluster = {
  _id: string;
  name: string;
  node_count: number;
  max_nodes: number;
  disabled: boolean;
  remediation: string;
  actions: string[];
  cooldown_seconds: number;
  monitor?: { enabled: boolean; intervalSeconds: number; error?: string; [key: string]: any };
};
function readView() {
  const params = new URLSearchParams(location.search);
  return {
    tab: location.pathname === '/clusters' || params.get('view') === 'clusters' ? 'clusters' : 'machines',
    cluster: params.get('cluster') ?? '',
  };
}
export function InfrastructurePage({
  data,
  refresh,
  act,
  isAdmin,
  onUseMachine,
}: {
  data: Data;
  refresh: () => Promise<void>;
  act: (task: () => Promise<unknown>) => Promise<void>;
  isAdmin: boolean;
  onUseMachine: (machine: Machine) => void;
}) {
  const [view, setView] = useState(readView);
  const [clusters, setClusters] = useState<FleetCluster[]>([]);
  const [fleet, setFleet] = useState<Data | null>(null);
  const [clusterError, setClusterError] = useState('');
  const [nodeError, setNodeError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    await Promise.all([
      api('/clusters')
        .then((r) => {
          setClusters(r.clusters);
          setClusterError('');
        })
        .catch((e) => setClusterError(errorMessage(e))),
      api('/devices')
        .then((r) => {
          setFleet({
            ...data,
            machines: r.machines ?? [],
            gateway: {
              ...data.gateway,
              configured: Boolean(r.configured),
              publicUrl: r.publicUrl ?? '',
              catalog: r.catalog ?? {},
              error: r.error,
            },
          });
          setNodeError('');
        })
        .catch((e) => setNodeError(errorMessage(e))),
    ]);
    setLoaded(true);
  }, [data]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (active) timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load]);
  useEffect(() => {
    if (location.pathname === '/clusters') history.replaceState({}, '', '/machines?view=clusters');
    const pop = () => setView(readView());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const changeView = (tab: string, cluster = view.cluster) => {
    const params = new URLSearchParams();
    if (tab === 'clusters') params.set('view', 'clusters');
    if (cluster) params.set('cluster', cluster);
    history.pushState({}, '', `/machines${params.size ? `?${params}` : ''}`);
    setView({ tab, cluster });
  };
  const refreshAll = async () => {
    await Promise.all([refresh(), load()]);
  };
  const current = { ...data, ...(fleet ? { machines: fleet.machines, gateway: fleet.gateway } : {}) };
  const online = current.machines.filter((m) => m.online && !m.disabled).length;
  return (
    <div className="fleet-page">
      <PageTitle
        eyebrow="INFRASTRUCTURE"
        title="Machines & clusters"
        text="One place for your connected machines, GPU fleets, and monitoring agents."
        action={
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await act(refreshAll);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={15} className={busy ? 'spin' : ''} />
            Refresh
          </Button>
        }
      />
      <div className="fleet-summary" aria-label="Infrastructure summary">
        {[
          {
            label: 'Registered machines',
            value: current.machines.length,
            icon: Server,
            detail: 'Hosts, containers & browsers',
          },
          {
            label: 'Online',
            value: online,
            icon: Network,
            detail: `${current.machines.filter((m) => !m.online && !m.disabled).length} offline · ${current.machines.filter((m) => m.disabled).length} disabled`,
          },
          {
            label: 'Clusters',
            value: loaded && !clusterError ? clusters.length : '—',
            icon: Layers3,
            detail: 'Shared node enrollment',
          },
          {
            label: 'Monitors enabled',
            value:
              loaded && !clusterError
                ? clusters.filter((c) => c.monitor?.enabled && !c.disabled).length
                : '—',
            icon: Activity,
            detail: 'Scheduled node inspections',
          },
        ].map(({ label, value, icon: Icon, detail }) => (
          <div className="fleet-stat" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={17} />
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <div className="fleet-tabs" aria-label="Infrastructure views">
        <button
          aria-pressed={view.tab === 'machines'}
          className={view.tab === 'machines' ? 'active' : ''}
          onClick={() => changeView('machines')}
        >
          <Server size={16} />
          Machines<span>{current.machines.length}</span>
        </button>
        <button
          aria-pressed={view.tab === 'clusters'}
          className={view.tab === 'clusters' ? 'active' : ''}
          onClick={() => changeView('clusters')}
        >
          <Layers3 size={16} />
          Clusters<span>{clusters.length}</span>
        </button>
        <small>Updates every 10 seconds</small>
      </div>
      <ErrorNotice error={nodeError ? `Could not refresh machines: ${nodeError}` : current.gateway.error} />
      <ErrorNotice error={clusterError ? `Could not refresh clusters: ${clusterError}` : ''} />
      {!loaded ? (
        <div className="fleet-loading" role="status">
          Loading infrastructure…
        </div>
      ) : view.tab === 'machines' ? (
        <MachinesPage
          data={current}
          refresh={refreshAll}
          act={act}
          onUseMachine={onUseMachine}
          clusters={clusters}
          clusterId={view.cluster}
          onClusterChange={(id) => changeView('machines', id)}
        />
      ) : (
        <ClustersPage
          data={current}
          isAdmin={isAdmin}
          refreshData={refreshAll}
          clusters={clusters}
          refreshClusters={load}
          onViewNodes={(id) => changeView('machines', id)}
        />
      )}
    </div>
  );
}
