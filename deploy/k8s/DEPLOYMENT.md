# Nebius deployment record — 2026-09-30

- Cluster: `inference-cluster` (`mk8scluster-u02j8dcmk1117dtatb`), `us-north1`, Linux AMD64.
- Namespace: `openharness`.
- Studio and API: **https://204.12.180.22**.
- Device connection: `wss://204.12.180.22/connect`.
- Registry: `cr.us-north1.nebius.cloud/u02bc9s4ak0850vnha`.
- Eight pods / nine containers; four persistent disks totaling 70 GiB.
- Image pulls use the existing Nebius node service account. No expiring user-token pull secret.
- HTTPS uses a self-signed certificate. Trust the public `deploy/k8s/.local/tls.crt` file, or
  install a certificate for your domain using the deployment guide.
- Administrator: `admin@openharness.local`; the generated password is in the private, ignored
  `deploy/k8s/.local/admin.json` file. Credentials are not stored in this document or Git.
- Model providers and target-machine connections are configured in Studio after deployment.

The four deployed custom server images are pinned by digest in `overlays/nebius/kustomization.yaml`.
The same registry also contains the optional machine images:

| Image       | Published tag | Digest                                                                    |
| ----------- | ------------- | ------------------------------------------------------------------------- |
| `connector` | `k8s-110`     | `sha256:95fc29056f57b70deab8351f691cbb7526727262c0943dc1fab4ebd9a3b1273c` |
| `edge`      | `k8s-110`     | `sha256:67ce30b3808e2f16ae0e80d4cde2d82bca07ec2679c1f2cbd739fd497e45ae8d` |

## Live verification

- Server-side Kubernetes manifest validation and all eight workload rollouts passed.
- All pods were ready with zero restarts after the digest-pinned rollout.
- HTTPS health, Studio HTML, browser login and authenticated UI rendering passed.
- Secure session cookie and unauthenticated API rejection checks passed.
- A queued workflow completed through the API, RabbitMQ, runner and MongoDB.
- NeMo, Garak, gateway health, runner heartbeat and shared file visibility passed.
- Public WSS routed correctly and rejected invalid device credentials.
- A published AMD64 connector enrolled over WSS with certificate verification, exposed MCP tools,
  and successfully executed `uname -s` from a Kubernetes-run workflow (returned `Linux`).
- The temporary connector, its device enrollment and test workflows were removed after validation.
- Re-running secret preparation preserved the existing credentials; login still worked after rollout.
- A sentinel file on the shared PVC survived replacement of the API/runner pod.

## Local verification

Node 22 type checks and 119 unit tests passed. All 30 connector/gateway unit tests passed in Linux
(the Linux connector suite requires `/proc`). The full real-stack integration run used an isolated
`openharness-test-*` Compose project, including fault injection: **213 passed, 2 failed, 4 skipped**
(219 total). No faults were injected into the deployed namespace.

- The effort-budget failure selected the preceding dense-tokenizer fixture. Its isolation fix was
  merged in [PR #112](https://github.com/deepfinery/OpenHarness/pull/112); all 15 feature integration
  tests then passed in a second isolated Compose project.
- The remaining pre-existing task-memory final-synthesis event failure is tracked in
  [issue #114](https://github.com/deepfinery/OpenHarness/issues/114). It reproduced independently
  on a fresh test stack (task-memory suite: 5 passed, 1 failed). No runtime changes were made as
  part of this Kubernetes deployment. The full integration suite is therefore **not fully green**.

The optional guardrail suite was then run with `TEST_NEMO=true` and both NeMo and Garak enabled:
**all 18 tests passed, with no skips**, covering the four cases skipped by the default command.

Hosted CI remains disabled. See [README.md](README.md) for deployment, TLS replacement, backups,
validation commands and the single-replica storage limitation.
