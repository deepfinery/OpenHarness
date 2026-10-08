# Install OpenHarness on Kubernetes, step by step

This guide installs a **new, empty OpenHarness instance** on an existing Linux Kubernetes cluster.
It covers a managed cloud cluster, a bare-metal cluster with a LoadBalancer implementation, and
local evaluation through `kubectl port-forward`. No Nebius account or CLI is required for this
path. The [Nebius reference](README.md) documents the original cloud-specific overlay.

The manifests use standard Kubernetes APIs, but the cluster must meet the requirements below.
The full cloud deployment was verified on Nebius with AMD64 nodes; this is not a claim that every
distribution, CPU architecture or admission-policy configuration has been tested.

**Use a separate checkout for each installation.** The helper scripts use namespace `openharness`
and keep installation-specific files in `deploy/k8s/.local/`. Do not reuse that directory between
clusters. These instructions create their own database and administrator; they do not migrate
users, workspaces, model keys or files from another installation.

## What will run

```text
Browser / device connector
          │ HTTPS / WSS, TCP 443
          ▼
Kubernetes Service: proxy (LoadBalancer)
          │ encrypted TCP → port 8443
          ▼
Caddy proxy pod ── TLS certificate from Secret: openharness-tls
          ├── /connect and /mcp/* → device gateway
          └── all other paths    → Studio / API
                                      │
                                RabbitMQ → runner
                                      │
                               MongoDB / Weaviate
                               NeMo / Garak services
```

TLS terminates **in Caddy**, behind the load balancer. There is no cloud-specific certificate
installation on the load balancer itself. Studio, the API and device connections share one
public origin. An Ingress controller is not required for the documented configuration.

| Workload                          | Role                                                     | Persistent storage                |
| --------------------------------- | -------------------------------------------------------- | --------------------------------- |
| `app` Deployment, two containers  | Studio/API and runner                                    | Shared `files` PVC, 20 GiB        |
| `gateway` Deployment              | Outbound device connections and their MCP tools          | Registry/audit records in MongoDB |
| `mongo` StatefulSet               | Users, workspace configuration, runs and execution state | 20 GiB (Nebius overlay: 1 TiB)    |
| `rabbitmq` StatefulSet            | Durable run queue                                        | 10 GiB                            |
| `weaviate` StatefulSet            | Default vector store                                     | 20 GiB                            |
| `guardrails` Deployment           | NeMo policy service                                      | Configuration in its image        |
| `guardrail-evaluation` Deployment | Garak probe service                                      | No dedicated PVC                  |
| `proxy` Deployment                | HTTPS/WSS termination and routing                        | Certificate/key in a Secret       |

The result is eight pods, nine containers and four PVCs totaling **70 GiB**. Models are not
bundled: you configure a model provider after login. Machine connectors run on the target
machines, not automatically on the Kubernetes nodes.

## 1. Prepare the cluster and your workstation

The cluster needs:

- Linux nodes with enough free capacity. Plan for at least 4 vCPU and 8 GiB of available memory
  for a small installation, plus capacity required by other workloads and your own models.
- Working cluster DNS and pod-to-pod networking.
- A CSI/storage provisioner, or pre-provisioned volumes, supporting the four filesystem-backed
  ReadWriteOnce claims. A default StorageClass is simplest; step 5 shows explicit selection.
- A CNI that enforces NetworkPolicy. Internal services are reachable only within the installation
  namespace; public ingress is allowed only to the proxy. Outbound model/MCP calls are permitted.
- Access to the image registries. The base also pulls MongoDB, RabbitMQ and Caddy from Docker Hub,
  and Weaviate from `cr.weaviate.io`; an air-gapped installation must mirror these images too.
- Permission to create the namespace, Secrets, ConfigMaps, Services, PVCs, Deployments,
  StatefulSets and NetworkPolicies, and to inspect pods/logs and run verification commands.

These are single-replica services. The database images use their upstream entrypoint/user
behavior. Clusters that enforce restricted Pod Security or arbitrary UIDs, including some
OpenShift configurations, need administrator-approved adaptations before installation.

Run the command blocks in **Bash** (start it with `bash` if your usual shell is different).
On your workstation, install Git, Bash, Python 3, OpenSSL, curl and `kubectl` with built-in
Kustomize. Install Docker with Buildx if building images. Node.js **22 or later** is needed only
for the optional authenticated smoke test and development checks. On Windows, use a Linux shell
such as WSL for the scripts. Have your cluster administrator supply the appropriate kubeconfig.

```bash
git clone https://github.com/deepfinery/OpenHarness.git OpenHarness-install
cd OpenHarness-install

kubectl config get-contexts
export KUBE_CONTEXT='your-cluster-context'
kubectl --context "$KUBE_CONTEXT" cluster-info
kubectl --context "$KUBE_CONTEXT" get nodes -L kubernetes.io/arch
kubectl --context "$KUBE_CONTEXT" get storageclass
kubectl --context "$KUBE_CONTEXT" auth can-i create namespaces
```

All following commands run from this checkout's root. The helpers require `KUBE_CONTEXT`
explicitly; selecting a context in your shell alone is not sufficient.

## 2. Build and publish the four application images

Choose a registry/project you can push to. `REGISTRY_HOST` is just the registry hostname;
`REGISTRY` includes your repository prefix. For example:

```bash
export REGISTRY_HOST='registry.example.com'
export REGISTRY='registry.example.com/my-team/openharness'
export IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
export PLATFORMS='linux/amd64'

docker info
docker buildx version
docker login "$REGISTRY_HOST"
```

The release tag should uniquely identify the source being built. Use `linux/arm64` only after
checking that all base/service images support your node architecture. For a mixed cluster,
publish the required platforms with a Buildx builder that supports them; do not assume an image
built on an ARM laptop will run on AMD64 nodes.

```bash
docker buildx build --platform "$PLATFORMS" --push \
  -f Dockerfile -t "$REGISTRY/openharness:$IMAGE_TAG" .
docker buildx build --platform "$PLATFORMS" --push \
  -f gateway/Dockerfile -t "$REGISTRY/gateway:$IMAGE_TAG" .
docker buildx build --platform "$PLATFORMS" --push \
  -f guardrails/Dockerfile -t "$REGISTRY/guardrails:$IMAGE_TAG" .
docker buildx build --platform "$PLATFORMS" --push \
  -f guardrails/evaluation/Dockerfile -t "$REGISTRY/garak-probes:$IMAGE_TAG" .

for image in openharness gateway guardrails garak-probes; do
  docker buildx imagetools inspect "$REGISTRY/$image:$IMAGE_TAG"
done
```

Build from the repository root. The Dockerfiles install their dependencies from this repository;
no sibling projects or locally built application artifacts are needed. The API and runner share
the `openharness` image. `scripts/build-push.sh` is the Nebius-specific alternative; the commands
above work with an ordinary OCI/Docker registry login.

If your organization supplies prebuilt images, skip building and use its approved image
references in the next step. The private Nebius image references in this repository are not
public images that arbitrary clusters can pull.

## 3. Configure your installation overlay

Use the generic overlay and replace its example registry and tag:

```bash
export KUSTOMIZE_BASE='../overlays/generic'
python3 - <<'PY'
import os
from pathlib import Path
p = Path('deploy/k8s/overlays/generic/kustomization.yaml')
s = p.read_text()
assert 'registry.example.com/openharness' in s, 'Overlay already customized; edit it directly for an upgrade'
s = s.replace('registry.example.com/openharness', os.environ['REGISTRY'])
s = s.replace('newTag: replace-me', 'newTag: ' + os.environ['IMAGE_TAG'])
p.write_text(s)
PY
kubectl kustomize deploy/k8s/overlays/generic
```

Check the rendered images, Service and PVCs before proceeding. The generic overlay contains no
Nebius image names or StorageClass. `KUSTOMIZE_BASE` is relative to `deploy/k8s/.local/`, where
`prepare.sh` later writes the final overlay. Keep this variable set when rerunning preparation;
its default remains `../overlays/nebius` for the existing deployment workflow.

For a release, pin each custom image by the digest printed by `imagetools inspect`:

```yaml
images:
  - name: openharness
    newName: registry.example.com/my-team/openharness/openharness
    digest: sha256:REPLACE_WITH_THE_PUBLISHED_IMAGE_DIGEST
```

Replace that entry's `newTag` with `digest`; repeat for the other three image mappings. Keep the
actual image names/prefixes consistent with step 2. Kustomize handles these image substitutions;
see the [official Kustomize guide](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/).

## 4. Allow the cluster to pull private images

Create the namespace first:

```bash
kubectl --context "$KUBE_CONTEXT" apply -f deploy/k8s/base/namespace.yaml
```

If your nodes already have registry access through their cloud identity/credential provider,
no pull Secret is necessary. Otherwise, create a dedicated read-only registry credential and
use the following commands. Your workstation's `docker login` does **not** authenticate cluster
nodes. The registry account/token needs pull access to all four application repositories.

```bash
umask 077
mkdir -p deploy/k8s/.local
read -r -p 'Registry username: ' REGISTRY_USER
read -r -s -p 'Registry password or read token: ' REGISTRY_PASSWORD
printf '\n'
export REGISTRY_HOST REGISTRY_USER REGISTRY_PASSWORD
python3 - <<'PY' > deploy/k8s/.local/registry-pull.json
import os, json, base64
credential = (os.environ['REGISTRY_USER'] + ':' + os.environ['REGISTRY_PASSWORD']).encode()
print(json.dumps({'auths': {os.environ['REGISTRY_HOST']: {
    'auth': base64.b64encode(credential).decode()
}}}))
PY
unset REGISTRY_PASSWORD

kubectl --context "$KUBE_CONTEXT" -n openharness create secret generic registry-credentials \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=deploy/k8s/.local/registry-pull.json \
  --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -

kubectl --context "$KUBE_CONTEXT" -n openharness patch serviceaccount default --type=merge \
  -p '{"imagePullSecrets":[{"name":"registry-credentials"}]}'
rm deploy/k8s/.local/registry-pull.json
```

This configures the default ServiceAccount in the **new installation namespace**; if it already
has pull secrets, merge the entries rather than replacing its list. The pull Secret must be in
the same namespace as the pods. The application pods disable API-token mounting; this does not
prevent use of the ServiceAccount's image-pull credentials. See the
[Kubernetes private-registry instructions](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/).

For short-lived registry credentials, configure your platform's supported renewal mechanism.
An expired manually copied token will break later pulls even when already-running pods stay healthy.

## 5. Select persistent storage

If the cluster has an appropriate default StorageClass, no manifest edit is needed. Otherwise,
append these two items to the **existing `patches:` list** in
`deploy/k8s/overlays/generic/kustomization.yaml`, replacing `your-storage-class`:

<!-- prettier-ignore -->
```yaml
  - target:
      kind: PersistentVolumeClaim
      name: files
    patch: |-
      - op: add
        path: /spec/storageClassName
        value: your-storage-class
  - target:
      kind: StatefulSet
    patch: |-
      - op: add
        path: /spec/volumeClaimTemplates/0/spec/storageClassName
        value: your-storage-class
```

Keep the two-space indentation aligned with the existing list entries. Do not add a second `patches:` key. The first item configures the shared files claim; the second
configures all three database/queue claim templates. Render the overlay again to check the result.
If using static volumes, have the cluster administrator supply matching PVs for all four claims
before rollout. `WaitForFirstConsumer` claims can remain Pending until their pods are scheduled.
See [Kubernetes persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/).

The API and runner must remain together in their single pod so they can share this RWO filesystem.
Do not increase the `app` replica count: independent API/runner replicas require a different
shared-storage topology. Set initial sizes and StorageClass before installation; StatefulSet
claim templates and an existing claim's StorageClass cannot simply be changed by redeploying.

## 6. Choose how users reach the frontend

### Option A: external or private LoadBalancer address

This is the default generic-overlay configuration. The cluster must have a controller that can
provision LoadBalancer Services. A managed cloud usually supplies one; bare-metal clusters need
an administrator-configured equivalent. Kubernetes itself does not allocate an external load
balancer without an implementation. See [Service types](https://kubernetes.io/docs/concepts/services-networking/service/).

Reserve the address before creating its TLS certificate:

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness create service loadbalancer proxy \
  --tcp=443:8443 --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -
kubectl --context "$KUBE_CONTEXT" -n openharness get service proxy -w
```

Wait for `EXTERNAL-IP` to become an IP address or hostname, then press Ctrl-C. Point your DNS
name at it: typically an A/AAAA record for an IP or a CNAME for an LB hostname. Use the DNS name
in the URL and certificate, or use the IP directly for a self-signed evaluation install.
`PUBLIC_URL` must be an origin (scheme, host and optional port), with no application path.

```bash
export PUBLIC_URL='https://openharness.example.com'
# Or: export PUBLIC_URL='https://YOUR_LOAD_BALANCER_IP'
```

If your platform requires Service annotations, a `loadBalancerClass`, or internal-LB settings,
add the same settings to the reserved Service and the generic overlay before deployment, using
your cluster administrator's configuration. The documented path expects **TCP passthrough** on
443 to Caddy. A controller-specific HTTP/HTTPS Ingress is a different configuration and must
preserve WebSockets, streaming, forwarded protocol headers and certificate trust.

### Option B: no load balancer, local evaluation

Skip the reservation command above. In the generic overlay, change the Service-type patch
from `value: LoadBalancer` to `value: ClusterIP`. Keep Service port 443 and targetPort 8443.
Then set:

```bash
export PUBLIC_URL='https://localhost:8443'
```

After step 8, open a second terminal and keep this process running:

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness port-forward service/proxy 8443:443
```

Use `https://localhost:8443` for the browser and smoke tests. This is access from your workstation
while the tunnel runs; it does not expose a permanent public endpoint. Remote machine connectors
need a URL they can reach, so use Option A for those devices. In the second terminal, set
`KUBE_CONTEXT` again if it is not inherited from your original shell.

## 7. Install the TLS certificate and generate application secrets

Choose **one** certificate option.

### Self-signed certificate for evaluation

```bash
unset TLS_CERT TLS_KEY
export SELF_SIGNED_TLS=1
./deploy/k8s/scripts/prepare.sh
```

This generates a certificate valid for one year, with a DNS or IP subject alternative name
matching `PUBLIC_URL`, and creates the TLS Secret. It also creates random application secrets
if none exist: database/queue passwords, the encryption key, setup token and gateway credentials.
The command does not print their values.

### Certificate issued by a trusted CA

Have a certificate whose subject alternative names include the chosen hostname and whose
private key matches it. Use an absolute path for each file:

```bash
unset SELF_SIGNED_TLS
export TLS_CERT='/absolute/path/to/fullchain.crt'
export TLS_KEY='/absolute/path/to/server.key'
./deploy/k8s/scripts/prepare.sh
```

The helpers do not request or automatically renew CA certificates. If using your organization's
private CA, separately distribute its public root/intermediate trust chain to browsers and
connectors; a server certificate is not necessarily the CA trust anchor.

For both options, the certificate is installed as follows:

| Location                                 | Contents / use                                              |
| ---------------------------------------- | ----------------------------------------------------------- |
| Secret `openharness/openharness-tls`     | `tls.crt` and `tls.key`                                     |
| Caddy container                          | Read-only `/certs/server.crt` and `/certs/server.key`       |
| Local `.local/tls.crt`                   | Public certificate exported by preparation                  |
| Local `.local/tls.key`                   | Private key, only when generated locally                    |
| Secret `openharness/openharness-secrets` | Application credentials and bootstrap token                 |
| Local `.local/secrets.json`              | Private copy created on first secret generation             |
| Local `.local/kustomization.yaml`        | Selected overlay plus public URLs and optional connector CA |

Trust `.local/tls.crt` in your browser/OS for the self-signed option. A certificate warning means
the client has not established that trust. Only the public certificate is shared with clients;
keep the key and credential files private. `.local/` is excluded from Git and Docker build contexts.

Preparation preserves existing application secrets and preserves the TLS Secret unless you
explicitly supply `TLS_CERT`/`TLS_KEY`. Do not delete secrets as a way to retry an installation:
new database passwords would not match existing database volumes, and losing `ENCRYPTION_KEY`
prevents decryption of saved application credentials.

## 8. Validate and deploy

Render the final installation and validate it against the API server before applying it:

```bash
kubectl kustomize deploy/k8s/.local > deploy/k8s/.local/rendered.yaml
kubectl --context "$KUBE_CONTEXT" apply --dry-run=server -k deploy/k8s/.local
./deploy/k8s/scripts/deploy.sh
```

`deploy.sh` repeats server-side validation, applies the resources, restarts the API/runner,
gateway and proxy to load configuration, and waits for each workload. Initial disk provisioning
and image pulls can take several minutes. The command ends by listing pods, claims and Services.

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness get pods
kubectl --context "$KUBE_CONTEXT" -n openharness get pvc
kubectl --context "$KUBE_CONTEXT" -n openharness get service proxy
```

Expect eight Running pods; `app` should show `2/2`, and the others `1/1`. All four PVCs should
be Bound. With Option B, now start the port-forward from step 6 before opening the UI or running
HTTP checks.

## 9. Verify health and create your administrator

For the self-signed configuration:

```bash
curl --fail --cacert deploy/k8s/.local/tls.crt "$PUBLIC_URL/api/health"
curl --fail --cacert deploy/k8s/.local/tls.crt "$PUBLIC_URL/api/auth/status"
./deploy/k8s/scripts/smoke.sh
```

Expected health response: `{"status":"ready"}`. A fresh installation reports `needsSetup: true`.
The smoke script also checks Studio HTML, gateway/NeMo/Garak availability, runner heartbeat and
file visibility between the API and runner. For a publicly trusted certificate you can use
ordinary `curl --fail "$PUBLIC_URL/api/health"`. If necessary, point the smoke script's `TLS_CA`
variable at your system or organization's CA bundle instead of the exported server certificate.

### Create your own account in the browser

Retrieve the setup token privately:

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness get secret openharness-secrets \
  -o jsonpath='{.data.SETUP_TOKEN}' | python3 -c \
  'import base64,sys; print(base64.b64decode(sys.stdin.read()).decode())'
```

Open `PUBLIC_URL`. Enter the setup token, your name, email and a password of at least 12
characters. Setup creates the first administrator and its workspace; the default workspace
name is **Team workspace**. Change the workspace name and manage members in Settings.
The setup token is not your login password. There is **no universal default username/password**.

### Optional: automatic setup and authenticated end-to-end smoke test

Instead of completing browser setup first, you can run:

```bash
node --version # must be 22 or later
NODE_EXTRA_CA_CERTS="$PWD/deploy/k8s/.local/tls.crt" \
  node deploy/k8s/scripts/auth-smoke.mjs
```

On a fresh database, this creates `admin@openharness.local` with a random password and writes
both values to `deploy/k8s/.local/admin.json` with mode 0600. It checks login, secure cookies,
authentication boundaries, a real queued workflow and public WSS routing. The password differs
for each installation. Inspect the private file to log in; do not reuse credentials from the
original Nebius deployment.

If you already created your own administrator, supply a private JSON file containing that
account's `email` and `password`, then set `ADMIN_CREDENTIALS_FILE` to its absolute path. For a
private CA, `NODE_EXTRA_CA_CERTS` must point to the appropriate trust bundle; for a publicly
trusted certificate, the extra CA setting is usually unnecessary.

## 10. Connect a model and optional tools

The application now runs, but it has no inference model configured:

1. Open Settings and add your model provider's endpoint and credentials. Select **LLM**, **Vision** or
   **Embedding** as its type, and enter one model ID per entry. Use the
   connection test before saving it as the workspace default. See the
   [model-provider guide](../../README.md#1-connect-a-model-provider).
2. Open Harnesses, create a simple harness with an agent using that provider, and run a prompt
   in Playground. Check the execution trace and saved output.
3. To give agents external tools, add an MCP server through **MCP connections**, discover its
   tools, and explicitly enable the tools the agent should use.
4. For device tools, enroll a machine through Inventory and run its generated connector command
   on the target machine. It must reach `wss://YOUR_ORIGIN/connect` and trust your certificate.
5. For retrieval, create an **Embedding** model entry, create a knowledge base using it and
   upload a small document. Wait for indexing before trying a grounded query.

For image questions, add a **Vision** model entry and select it in the agent's **General → Harness
vision model** field. In Playground, attach or drag and drop a PNG, JPEG or WebP image and ask a
question. Up to four images per message are supported, each up to 10 MB and 25 megapixels. The API
normalizes images to JPEG (maximum 2048-pixel edge); the runner reads them from the shared files PVC
and sends them to the chosen vision endpoint. No additional Kubernetes service or Docling install is
needed. Follow-up questions retain images and keep using the vision model. A new text-only
conversation uses the primary model. The connection test for Vision sends a small synthetic image.

The upgrade automatically splits old combined chat/embedding definitions and preserves notebook
references. Reclassify your image-capable entries as Vision after upgrading. See the
[model-provider guide](../../README.md#1-connect-a-model-provider) for migration and storage details.
Images use the existing file volume and MongoDB backup procedure; removed draft uploads currently
remain stored, subject to a 1 GB soft quota per workspace.

If the model or MCP server is inside a private network, add only its required hostnames to
`ALLOWED_PRIVATE_HOSTS` through a ConfigMap patch. The default intentionally does not allow
arbitrary private URLs. For example, append this item to the generic overlay's `patches:` list,
substituting your own internal inference hostname:

<!-- prettier-ignore -->
```yaml
  - patch: |-
      apiVersion: v1
      kind: ConfigMap
      metadata:
        name: openharness-config
      data:
        ALLOWED_PRIVATE_HOSTS: gateway,my-model.inference.svc.cluster.local
```

Rerun `deploy.sh` after changing configuration. An internal model in another namespace also
needs its own ingress/network policy to permit requests from OpenHarness. Model API keys belong
in Studio's provider configuration or the appropriate secret mechanism, not in committed YAML.

Optional Qdrant, OpenSearch, Elasticsearch and OpenAI vector-store endpoints can be configured
through the application's existing settings/environment. They are alternative backends; this
installation deploys Weaviate as the default. OpenShell runs separately with its edge/connector
on the target infrastructure; see [the OpenShell guide](../../docs/openshell.md).

## 11. Upgrade, replace certificates and back up

### Application upgrade

1. Back up the four persistent stores and `openharness-secrets` before an upgrade. Preserve
   `ENCRYPTION_KEY`; restoring database data without it does not restore access to encrypted keys.
2. Build/publish a new uniquely tagged release, update the four image references/digests in
   your generic overlay and inspect the rendered diff.
3. Run `deploy.sh`, then both smoke checks. The API/runner Deployment uses Recreate because
   it shares one disk, so allow a brief interruption during replacement.
4. For an image rollback, restore the previous image digests and redeploy. This does not undo
   data/schema changes; those require a compatible backup/restore procedure.

Image-only changes do not require another `prepare.sh` run. Public URL/certificate changes do.
Keep `KUBE_CONTEXT`, `PUBLIC_URL` and `KUSTOMIZE_BASE` set correctly when reopening your terminal.
Use a private environment file if desired; do not commit installation credentials.

### Certificate replacement

Provide the replacement certificate and matching key, run preparation, then redeploy the
proxy so Caddy loads them:

```bash
export TLS_CERT='/absolute/path/to/replacement-fullchain.crt'
export TLS_KEY='/absolute/path/to/replacement.key'
# For a public CA replacement:
unset SELF_SIGNED_TLS
./deploy/k8s/scripts/prepare.sh
./deploy/k8s/scripts/deploy.sh
```

For another self-signed certificate, keep `SELF_SIGNED_TLS=1` so the public certificate is
embedded in newly generated connector instructions. Existing devices still need their trust
configuration updated. Changing `PUBLIC_URL` alone does not reissue the certificate; its SAN
must also match the new hostname/IP.

### Backup and recovery boundaries

Use application-consistent backups or coordinated quiescing/snapshots for MongoDB, RabbitMQ,
Weaviate and shared files. Follow the database and storage vendor's recovery procedures and
test restoring into a separate namespace/cluster. Also back up application secrets and TLS
material in your secret-management system. PVCs provide persistence across pod replacement;
they are not themselves a backup or high-availability solution.

Deleting the namespace deletes its PVCs. Whether backing disks are retained depends on their
PV/StorageClass reclaim policy; many dynamic classes use Delete. Do not delete the namespace
or PVCs to troubleshoot a Pending or unhealthy pod. This guide intentionally has no automatic
data-destroying uninstall command.

## 12. Troubleshooting

Start with these commands, using your explicit context:

```bash
kubectl --context "$KUBE_CONTEXT" -n openharness get pods,pvc,service
kubectl --context "$KUBE_CONTEXT" -n openharness get events --sort-by=.metadata.creationTimestamp
kubectl --context "$KUBE_CONTEXT" -n openharness describe pod POD_NAME
kubectl --context "$KUBE_CONTEXT" -n openharness logs deployment/app -c api --tail=100
kubectl --context "$KUBE_CONTEXT" -n openharness logs deployment/app -c runner --tail=100
kubectl --context "$KUBE_CONTEXT" -n openharness logs deployment/gateway --tail=100
kubectl --context "$KUBE_CONTEXT" -n openharness logs deployment/proxy --tail=100
```

| Symptom                                       | What to check                                                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImagePullBackOff` / `ErrImagePull`           | Registry path, tag/digest, node architecture, registry reachability and pull credentials in `openharness`. Check pod events for the actual registry error.             |
| LoadBalancer `EXTERNAL-IP` stays Pending      | The cluster's LB controller, Service annotations/class, subnet/address capacity and permissions. Use port-forward for local evaluation if no LB implementation exists. |
| PVC Pending                                   | Default/explicit StorageClass, provisioner events, disk quota, access mode and scheduling. `WaitForFirstConsumer` needs a schedulable consuming pod.                   |
| `Multi-Attach` for shared files               | Keep `app` at one replica and allow the previous pod/disk attachment to terminate. Do not split the API/runner onto unrelated nodes with the existing RWO claim.       |
| Pod Pending with insufficient CPU/memory      | Free cluster capacity, node affinity/taints and resource requests. Add capacity or carefully size the requests for your workload.                                      |
| Database permission/admission failure         | Storage ownership semantics and cluster security policies. The upstream database entrypoints may need root for initial ownership setup.                                |
| API health is 503                             | MongoDB credentials/readiness, RabbitMQ readiness, Weaviate authentication and network/DNS reachability. Inspect their StatefulSet pod logs.                           |
| HTTPS certificate warning                     | Trust the self-signed/private CA chain, or install a CA-issued certificate matching the URL. Check the SAN and expiry.                                                 |
| Login/CSRF errors after changing host         | `PUBLIC_URL` must equal the browser origin, including a non-default port. Re-prepare with the correct origin and matching certificate, then redeploy.                  |
| Device cannot connect                         | Public `wss://` URL, certificate trust, `/connect` WebSocket forwarding, device token and gateway logs. A remote device cannot use your workstation's `localhost`.     |
| Private model/MCP endpoint rejected           | Set the specific trusted hostname in `ALLOWED_PRIVATE_HOSTS`; also verify egress/routing and the target namespace's ingress policies.                                  |
| Authentication fails after recreating Secrets | Stored database passwords and new Secret values no longer agree. Restore the original secrets or perform a coordinated database credential rotation.                   |

For source-code validation, use Node 22+ and the repository's local checks. Run fault injection
only in the isolated test Compose project, never against the installed cluster. See the
[deployment validation record](DEPLOYMENT.md) for the tested Nebius installation and known
pre-existing integration-test limitation; it is separate from these installation instructions.
