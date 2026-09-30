# Kubernetes deployment

For a new installation on a standard Linux Kubernetes cluster, follow the
[step-by-step installation guide](INSTALL.md). It includes a generic registry/cluster overlay,
private image pulls, storage selection, LoadBalancer or local access, TLS, and first login.

This directory deploys the complete server stack: Studio/API and runner, device gateway,
MongoDB, RabbitMQ, Weaviate, NeMo Guardrails, Garak evaluation service, and a Caddy TLS proxy.
The Nebius overlay publishes only HTTPS (443); device WebSockets and MCP use the same origin.
Database, queue, gateway administration and guardrail ports remain internal.

## Layout and storage

- `base/`: portable Kubernetes resources. Uses the cluster's default dynamic StorageClass.
- `overlays/generic/`: editable provider-neutral example; replace its image placeholders before use.
- `overlays/nebius/`: LoadBalancer and the published Linux AMD64 application images.
- `scripts/`: image publishing, secret/TLS preparation, deployment and smoke checks.
- `.local/`: ignored local credentials, certificate and installation-specific overlay. Never commit it.

The API and runner are two containers in **one pod** and share a 20 GiB ReadWriteOnce PVC.
This avoids cross-node disk attachment conflicts. Keep this Deployment at **one replica**;
scaling it requires an RWX filesystem and a separate API/runner topology. Its Recreate update
strategy deliberately trades brief deployment downtime for safe single-disk ownership.
MongoDB (20 GiB), RabbitMQ (10 GiB) and Weaviate (20 GiB) have their own StatefulSet PVCs.
This is a persistent, single-replica installation, not an HA database deployment. Back up
all four volumes and the encryption key before upgrades; deleting the namespace deletes PVCs
and the default Nebius StorageClass deletes their disks. Never delete PVCs to resolve a rollout.

NetworkPolicy allows inbound traffic within this namespace and public traffic to the TLS proxy.
Use a network plugin that enforces NetworkPolicy (Nebius uses Cilium). Outbound model/MCP
connections remain allowed. Pods do not receive Kubernetes service-account tokens. Application
containers run without root, with read-only roots, dropped capabilities and writable data/tmp
volumes. Caddy retains NET_BIND_SERVICE because the upstream binary carries that file capability.

## Prerequisites

Use Node.js 22+, Python 3, OpenSSL, Docker with Buildx, `kubectl` with Kustomize, and an authenticated
Nebius CLI. The cluster needs roughly 2 vCPU / 3 GiB available for resource requests, additional
memory for actual workloads, dynamic disk provisioning, and a LoadBalancer implementation.
Do not point these commands at an unrelated cluster.

```bash
export KUBE_CONTEXT=your-nebius-context
kubectl --context "$KUBE_CONTEXT" get nodes -L topology.kubernetes.io/region,kubernetes.io/arch
kubectl --context "$KUBE_CONTEXT" get storageclass
```

The existing Nebius overlay references images in `us-north1`. To publish to your own registry:

```bash
export PROJECT_ID=your-us-north1-project
nebius registry create --parent-id "$PROJECT_ID" --name openharness --format json
# Use the ID's suffix: registry-u02abc becomes u02abc in a Docker image path.
export REGISTRY=cr.us-north1.nebius.cloud/u02abc
export IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
./deploy/k8s/scripts/build-push.sh
```

Change the four `images` entries in `overlays/nebius/kustomization.yaml` to your published
repositories and immutable digests (or unique release tags). `PLATFORMS` defaults to `linux/amd64`;
set it explicitly if your nodes use ARM. `BUILD_CONNECTORS=1` also publishes the outbound
Go machine connector and OpenShell edge. These execute beside the target machines/OpenShell
installation, not inside the server pod. The optional Qdrant, OpenSearch, Elasticsearch and
OpenAI vector-store integrations can use external endpoints through the ConfigMap/Secret;
Weaviate is the deployed default. No LLM is bundled: configure a model provider in Studio.

Nebius node groups with a service account that can read the registry pull images automatically.
This is the preferred durable configuration; it does not embed a 12-hour user access token.
See [Nebius image-pull configuration](https://docs.nebius.com/kubernetes/workloads/images-container-registry)
and [registry authentication](https://docs.nebius.com/container-registry/authentication).
For other Kubernetes environments, attach a durable registry credential using `imagePullSecrets`
on each application pod (or its service account).

## Install

Reserve the proxy's public address before generating its certificate and public URL:

```bash
kubectl --context "$KUBE_CONTEXT" apply -f deploy/k8s/base/namespace.yaml
kubectl --context "$KUBE_CONTEXT" -n openharness create service loadbalancer proxy \
  --tcp=443:8443 --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -
kubectl --context "$KUBE_CONTEXT" -n openharness get service proxy -w
```

Set your DNS record to this address and supply a certificate/key, or use a self-signed certificate
for an IP-based evaluation install. The public URL is the origin, with no path.

```bash
export PUBLIC_URL=https://openharness.example.com
export TLS_CERT=/path/to/fullchain.crt
export TLS_KEY=/path/to/server.key
./deploy/k8s/scripts/prepare.sh
./deploy/k8s/scripts/deploy.sh
./deploy/k8s/scripts/smoke.sh
```

For an evaluation install, replace the two TLS variables with `SELF_SIGNED_TLS=1` and use
`PUBLIC_URL=https://<load-balancer-ip>`. Trust `.local/tls.crt` in your browser/system. The
self-signed public certificate is embedded into Studio's generated connector instructions.
Never distribute `.local/tls.key`. If changing the hostname or certificate, explicitly provide
`TLS_CERT` and `TLS_KEY` again; preparation preserves an existing TLS secret otherwise.

`prepare.sh` defaults to the Nebius overlay. Set `KUSTOMIZE_BASE=../overlays/generic`
to select the generic example; the path is relative to `deploy/k8s/.local`.

`prepare.sh` creates random secrets only if the Secret is absent. It preserves existing database
passwords and encryption keys. Do not delete/recreate this Secret while retaining the databases;
changing its password fields alone does not rotate database credentials. `deploy.sh` validates
against the API server, applies the overlay, restarts processes that consume configuration,
and waits for every workload to become ready. Hosted CI is not required or enabled.

## Administrator and checks

Open Studio and use the setup token from the Kubernetes Secret to create your administrator:

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness get secret openharness-secrets \
  -o jsonpath='{.data.SETUP_TOKEN}' | base64 --decode
```

Alternatively, the authenticated smoke test bootstraps `admin@openharness.local` with a random
password on a fresh install, writes it only to `.local/admin.json` (mode 0600), verifies secure
login and runs a real queued workflow through the runner. On existing installations, supply
`ADMIN_CREDENTIALS_FILE` pointing to a private JSON file with `email` and `password`.

```bash
NODE_EXTRA_CA_CERTS="$PWD/deploy/k8s/.local/tls.crt" \
  node deploy/k8s/scripts/auth-smoke.mjs
```

The health smoke tests cover MongoDB, RabbitMQ and Weaviate through `/api/health`, Studio HTML,
NeMo/Garak, the device gateway, runner heartbeat and shared file visibility. Integration and
fault-injection tests must run in the isolated local Compose project, never against this namespace:

```bash
npm ci
npm run typecheck
npm test
./scripts/test-stack.sh
```

Linux connector unit tests require Linux `/proc`; run `npm run devices:test` in a Linux build
container when developing on macOS. To inspect the deployed stack:

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness get pods,pvc,service
kubectl --context "$KUBE_CONTEXT" -n openharness logs deployment/app -c api --tail=80
kubectl --context "$KUBE_CONTEXT" -n openharness logs deployment/app -c runner --tail=80
kubectl --context "$KUBE_CONTEXT" -n openharness get events --sort-by=.metadata.creationTimestamp
```

After editing images or configuration, rerun `deploy.sh` and both smoke checks. For rollback,
restore the preceding image digests in the overlay and redeploy. Rollback does not restore database
contents. Preserve the TLS secret, encryption key and PVCs across deployments.
