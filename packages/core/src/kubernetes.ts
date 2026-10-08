import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

/**
 * The Kubernetes API from inside a pod: the service account's token and CA, no client library. Only what the
 * Python executor needs: Jobs, their pods and pod logs, in one namespace.
 */
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

export class KubernetesError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const inCluster = () => Boolean(process.env.KUBERNETES_SERVICE_HOST);
let ca: Buffer | undefined;
export async function ownNamespace() {
  return (await readFile(`${SA}/namespace`, 'utf8')).trim();
}
async function k8s<T = unknown>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  if (!inCluster()) throw new KubernetesError(0, 'Not running inside a Kubernetes cluster');
  // The token rotates; it is read for every request so a long-lived runner keeps working.
  const [token, cert] = await Promise.all([readFile(`${SA}/token`, 'utf8'), ca ?? readFile(`${SA}/ca.crt`)]);
  ca = cert;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: process.env.KUBERNETES_SERVICE_HOST,
        port: Number(process.env.KUBERNETES_SERVICE_PORT ?? 443),
        method,
        path,
        ca: cert,
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          Accept: raw ? 'text/plain' : 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let message = text.slice(0, 500);
            try {
              message = (JSON.parse(text) as { message?: string }).message ?? message;
            } catch {
              // Plain text error.
            }
            return reject(
              new KubernetesError(status, `Kubernetes ${method} ${path} -> ${status}: ${message}`),
            );
          }
          if (raw) return resolve(text as T);
          resolve((text ? JSON.parse(text) : {}) as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new KubernetesError(0, `Kubernetes ${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
export type JobStatus = {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: { type: string; status: string; reason?: string; message?: string }[];
};
export type PodSummary = {
  name: string;
  phase?: string;
  /** The container's waiting/terminated reason, for example ImagePullBackOff or OOMKilled. */
  reason?: string;
  message?: string;
  exitCode?: number;
};
export const createJob = (namespace: string, manifest: unknown) =>
  k8s<{ metadata: { name: string } }>('POST', `/apis/batch/v1/namespaces/${namespace}/jobs`, manifest);
export const getJob = (namespace: string, name: string) =>
  k8s<{ status?: JobStatus }>('GET', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`);
export const deleteJob = (namespace: string, name: string) =>
  k8s('DELETE', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`, {
    propagationPolicy: 'Background',
  }).catch((error: KubernetesError) => {
    if (error.status !== 404) throw error;
  });
export async function jobPods(namespace: string, jobName: string): Promise<PodSummary[]> {
  const list = await k8s<{
    items: {
      metadata: { name: string };
      status?: {
        phase?: string;
        containerStatuses?: {
          state?: {
            waiting?: { reason?: string; message?: string };
            terminated?: { reason?: string; message?: string; exitCode?: number };
          };
        }[];
      };
    }[];
  }>(
    'GET',
    `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
  );
  return list.items.map((pod) => {
    const state = pod.status?.containerStatuses?.[0]?.state;
    return {
      name: pod.metadata.name,
      phase: pod.status?.phase,
      reason: state?.waiting?.reason ?? state?.terminated?.reason,
      message: state?.waiting?.message ?? state?.terminated?.message,
      exitCode: state?.terminated?.exitCode,
    };
  });
}
export const podLogs = (namespace: string, pod: string, tailLines = 50) =>
  k8s<string>(
    'GET',
    `/api/v1/namespaces/${namespace}/pods/${pod}/log?tailLines=${tailLines}`,
    undefined,
    true,
  );
/** The image of a container (or init container) of this very pod, so a digest pinned by kustomize is reused. */
export async function ownPodContainerImage(container: string) {
  const name = process.env.POD_NAME;
  if (!name) return undefined;
  const pod = await k8s<{
    spec: {
      containers: { name: string; image: string }[];
      initContainers?: { name: string; image: string }[];
    };
  }>('GET', `/api/v1/namespaces/${await ownNamespace()}/pods/${name}`);
  return [...(pod.spec.initContainers ?? []), ...pod.spec.containers].find((c) => c.name === container)
    ?.image;
}
