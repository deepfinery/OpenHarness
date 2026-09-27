import { useState } from 'react';
import { clusterInstallGuide } from '../../../../packages/core/src/clusterInstall.js';
import { Button, CopyButton, ErrorNotice, Field } from './ui';

export function ClusterInstall({ enrollment }: { enrollment: { token?: string; connectUrl: string } }) {
  const [tab, setTab] = useState<'docker' | 'native' | 'kubernetes'>('docker');
  const [gateway, setGateway] = useState(() => {
    const url = new URL(enrollment.connectUrl);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = window.location.hostname;
    return url.toString();
  });
  const [token, setToken] = useState(enrollment.token ?? '');
  const [hostAccess, setHostAccess] = useState(true);
  const [image, setImage] = useState('registry.example.com/openharness/connector-linux:latest');
  let guide: ReturnType<typeof clusterInstallGuide> | undefined,
    error = '';
  try {
    guide = clusterInstallGuide({ gatewayUrl: gateway, token, image, hostAccess });
  } catch (e) {
    error = e instanceof Error ? e.message : 'Invalid installation settings';
  }
  const code = (title: string, value: string) => (
    <section className="cluster-install-step">
      <h3>{title}</h3>
      <pre>{value}</pre>
      <CopyButton value={value} />
    </section>
  );
  function download() {
    if (!guide) return;
    const url = URL.createObjectURL(new Blob([guide.kubernetes], { type: 'application/yaml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cluster-nodes.yaml';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="fleet-cluster-form cluster-install">
      <p>
        Install a connector on each Linux node. All nodes use this shared token and register automatically,
        including nodes added later. Save the token now; it is shown only at creation or rotation.
      </p>
      <Field
        label="Harness gateway address"
        hint="Use the harness server IP or DNS name and gateway port, for example ws://192.0.2.10:8090. This is the gateway port, not the studio port."
      >
        <input value={gateway} onChange={(e) => setGateway(e.target.value)} spellCheck={false} />
      </Field>
      <Field
        label="Shared cluster token"
        hint="Reuse your saved token when adding nodes. No rotation or per-node token is needed."
      >
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your saved cluster token"
        />
      </Field>
      {!token && (
        <p className="muted">
          The original token cannot be recovered. Paste your saved token or replace the token placeholder in
          the instructions. Rotate only if the token is lost or compromised.
        </p>
      )}
      <label>
        <input type="checkbox" checked={hostAccess} onChange={(e) => setHostAccess(e.target.checked)} />{' '}
        Enable privileged host diagnostics (NVIDIA, DCGM, NVLink and host logs)
      </label>
      <p className="muted">
        Host access runs the connector with root privileges. Remediation remains disabled until separately
        authorized on the cluster and node. NVIDIA/DCGM tools must be installed on each host.
      </p>
      <div className="guardrail-tabs" role="tablist" aria-label="Installation method">
        {(['docker', 'native', 'kubernetes'] as const).map((method) => (
          <button
            key={method}
            role="tab"
            type="button"
            aria-selected={tab === method}
            className={tab === method ? 'active' : ''}
            onClick={() => setTab(method)}
          >
            {method === 'native' ? 'Linux service' : method === 'docker' ? 'Docker' : 'Kubernetes'}
          </button>
        ))}
      </div>
      {tab === 'kubernetes' && (
        <Field
          label="Connector image"
          hint="Use a registry all cluster nodes can pull from. Authenticate Docker before pushing; configure imagePullSecrets for a private registry."
        >
          <input value={image} onChange={(e) => setImage(e.target.value)} spellCheck={false} />
        </Field>
      )}
      <ErrorNotice error={error} />
      {guide && (
        <>
          {tab === 'docker' && (
            <>
              <p>
                Requires Git, Docker, sudo and a unique /etc/machine-id on each node. Run these steps on every
                node; the installer builds the connector and keeps it running after reboot.
              </p>
              {code('1. Clone, configure and install', guide.docker)}
            </>
          )}
          {tab === 'native' && (
            <>
              <p>
                Requires Git, Node.js 22.13 or later with npm, systemd and sudo on each Linux node. Install
                these prerequisites using your distribution’s supported packages.
              </p>
              {code('1. Clone, build and install the Linux service', guide.native)}
            </>
          )}
          {tab === 'kubernetes' && (
            <>
              <p>
                Requires Git, Docker, kubectl, a container registry and permission to install a DaemonSet. The
                DaemonSet runs on every eligible Linux node, tolerates taints, and enrolls new nodes
                automatically. Privileged mode requires a namespace that permits privileged pods. Build an
                image for your nodes’ CPU architecture.
              </p>
              {code(
                '1. Build and publish the connector image, then apply the YAML',
                guide.kubernetesCommands,
              )}
              {code('2. Save cluster-nodes.yaml', guide.kubernetes)}
              <Button variant="secondary" onClick={download}>
                Download Kubernetes YAML
              </Button>
              <p className="muted">
                The YAML contains the token in a Kubernetes Secret. Keep the file private. After rotating a
                token, update the Secret and run kubectl -n openharness-system rollout restart
                daemonset/openharness-cluster-node.
              </p>
            </>
          )}
          <section className="cluster-install-step">
            <h3>Verify nodes and enable monitoring</h3>
            <p>
              Open this cluster’s <strong>View nodes</strong> inventory and wait for nodes to appear online.
              Then choose <strong>Manage cluster → New monitoring agent</strong>, select a model provider,
              save the agent, and enable scheduled monitoring. The default interval is five minutes.
            </p>
          </section>
          <p className="muted">
            WS is available for testing when the gateway allows insecure connections. For TLS, use wss:// with
            a certificate trusted by the nodes. Open the gateway port to nodes; they initiate outbound
            connections. A shared token enrolls nodes up to the cluster’s configured capacity. Disabling a
            cluster or rotating its token revokes access.
          </p>
        </>
      )}
    </div>
  );
}
