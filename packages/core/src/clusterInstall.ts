import { stringify } from 'yaml';

export function clusterGatewayUrl(value: string) {
  const url = new URL(value);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/', '/connect'].includes(url.pathname) ||
    /[\s'"`$\\]/.test(value)
  )
    throw new Error(
      'Use ws:// or wss:// with a reachable hostname or IP, gateway port, and optional /connect path.',
    );
  url.pathname = '/connect';
  return url.toString();
}
export function clusterInstallGuide(options: {
  gatewayUrl: string;
  token?: string;
  image?: string;
  hostAccess?: boolean;
}) {
  const url = clusterGatewayUrl(options.gatewayUrl);
  const token = options.token || 'REPLACE_WITH_SAVED_CLUSTER_TOKEN';
  if (!/^[A-Za-z0-9._-]{16,512}$/.test(token)) throw new Error('Enter the saved cluster enrollment token.');
  const image = options.image || 'registry.example.com/openharness/connector-linux:latest';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]{0,249}$/.test(image))
    throw new Error('Enter a valid container image name.');
  const environment = `GATEWAY_URL=${url}\nDEVICE_TOKEN=${token}\nGATEWAY_ALLOW_INSECURE=${url.startsWith('ws://')}\n`;
  const clone = 'git clone https://github.com/deepfinery/OpenHarness.git\ncd OpenHarness';
  const saveEnvironment = `umask 077\ncat > cluster.env <<'OPENHARNESS_ENV'\n${environment}OPENHARNESS_ENV`;
  const hostFlag = options.hostAccess ? ' --host-access' : '';
  const docker = `${clone}\n\n${saveEnvironment}\n\nsudo sh connector-linux/install-cluster.sh ./cluster.env${hostFlag}\nsudo docker logs --tail 50 openharness-cluster-node`;
  const native = `${clone}\n\nnpm --prefix connector-core ci\nnpm --prefix connector-core run build\nnpm --prefix connector-linux ci\nnpm --prefix connector-linux run build\n\n${saveEnvironment}\n\nsudo node connector-linux/install-cluster-native.mjs ./cluster.env${hostFlag}\nsudo systemctl status openharness-connector\nsudo journalctl -u openharness-connector -n 50 --no-pager`;
  const namespace = 'openharness-system';
  const labels = { app: 'openharness-cluster-node' };
  const env: any[] = [
    { name: 'GATEWAY_URL', value: url },
    { name: 'GATEWAY_ALLOW_INSECURE', value: String(url.startsWith('ws://')) },
    { name: 'DEVICE_TOKEN', valueFrom: { secretKeyRef: { name: 'openharness-cluster', key: 'token' } } },
    { name: 'CLUSTER_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
    { name: 'DEVICE_HOSTNAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
  ];
  if (options.hostAccess) env.push({ name: 'HOST_ACCESS', value: 'true' });
  const docs = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'openharness-cluster', namespace },
      type: 'Opaque',
      stringData: { token },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'openharness-cluster-node', namespace },
      spec: {
        selector: { matchLabels: labels },
        updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            nodeSelector: { 'kubernetes.io/os': 'linux' },
            tolerations: [{ operator: 'Exists' }],
            ...(options.hostAccess ? { hostPID: true } : {}),
            containers: [
              {
                name: 'connector',
                image,
                imagePullPolicy: 'Always',
                env,
                securityContext: options.hostAccess
                  ? { privileged: true, runAsUser: 0 }
                  : {
                      runAsUser: 1000,
                      runAsNonRoot: true,
                      allowPrivilegeEscalation: false,
                      capabilities: { drop: ['ALL'] },
                    },
                resources: {
                  requests: { cpu: '50m', memory: '64Mi' },
                  limits: { cpu: '500m', memory: '256Mi' },
                },
                ...(options.hostAccess
                  ? { volumeMounts: [{ name: 'host-state', mountPath: '/host-state' }] }
                  : {}),
              },
            ],
            ...(options.hostAccess
              ? {
                  volumes: [
                    {
                      name: 'host-state',
                      hostPath: { path: '/var/lib/openharness-cluster', type: 'DirectoryOrCreate' },
                    },
                  ],
                }
              : {}),
          },
        },
      },
    },
  ];
  const kubernetes = docs.map((d) => stringify(d)).join('---\n');
  const kubernetesCommands = `${clone}\n\ndocker build -f connector-linux/Dockerfile -t '${image}' .\ndocker push '${image}'\n\n# Save the generated YAML below as cluster-nodes.yaml (contains the shared token).\nchmod 600 cluster-nodes.yaml\nkubectl apply -f cluster-nodes.yaml\nkubectl -n ${namespace} rollout status daemonset/openharness-cluster-node\nkubectl -n ${namespace} get pods -o wide`;
  return { environment, docker, native, kubernetes, kubernetesCommands };
}
