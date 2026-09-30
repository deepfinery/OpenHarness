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

## Model identity investigation — issue #117

Run `08574d87-276f-4648-9106-8ca665a77a97` selected
`nvidia/Nemotron-3-Ultra-550b-a55b` at
`https://api.tokenfactory.us-central1.nebius.com/v1/`. Its run snapshot references the
Nemotron provider, whose configuration had not been revised since creation.
There is no Claude identity string in the runtime prompt or an automatic fallback to Anthropic.
Provider retries retain the same destination, credentials and requested model; redirects are rejected.

The workflow's earlier runs used the configured DeepSeek provider and produced Claude identity claims.
Those answers were saved as notebook experiments. The reported Nemotron run recalled three of those
experiments, including two Claude claims. Its conversational history was empty, so starting a new chat
alone did not remove the misinformation from the notebook.

Controlled requests from the API pod to the configured Nebius endpoint isolated the cause:

| Request context                                      | Answer                                                         | Server-reported model               |
| ---------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Identity question alone                              | “I am Nemotron 3 Ultra, a language model developed by NVIDIA.” | `nvidia/Nemotron-3-Ultra-550b-a55b` |
| Same question with the recalled experiments          | “I'm Claude, an AI assistant made by Anthropic…”               | `nvidia/Nemotron-3-Ultra-550b-a55b` |
| Same experiments plus current runtime model identity | “I'm nvidia/Nemotron-3-Ultra-550b-a55b.”                       | `nvidia/Nemotron-3-Ultra-550b-a55b` |

The fix supplies the selected model ID as system context for each agent call, including reflection judges
and final synthesis. It is included in context budgeting and protected during compaction. Prior memories
and generated self-descriptions are explicitly excluded as evidence of current model identity.
It does not replace the model's answer with a hardcoded response or delete previous experiments.

New run trace events `model_request` and `model_response` record the selected provider ID/revision,
provider kind, endpoint, requested model, server-reported model, response ID and whether the model IDs
match. Endpoint credentials, query strings and fragments are omitted. A different server-reported ID can
be a legitimate alias; it is recorded without silently switching providers. Missing upstream metadata is
recorded as unknown. The original run predates this telemetry and cannot be retroactively given a
server-reported model or response ID.

### Data boundary

This harness uses hosted Nebius TokenFactory inference, not a Nemotron deployment inside the Kubernetes
cluster. Its two attached notebooks use the separately configured `Qwen/Qwen3-Embedding-8B` provider at
`https://api.tokenfactory.nebius.com/v1/` for embeddings. Queries and indexed notebook content therefore
leave the cluster for those configured services. The model-question run executed no MCP tool calls.
No Anthropic destination or provider fallback was found in this investigation. This verifies application
routing and upstream response metadata; it does not independently attest the weights loaded inside
Nebius or establish a complete historical network-egress audit.

### Regression checks

- Node 22 type checks and all 129 unit tests passed.
- All 32 existing context-budget, feature and runtime-clock integration checks passed in the isolated
  `openharness-test-117` Compose project.
- All three new real-stack identity tests passed: streamed and JSON responses retain requested versus
  reported identity through compaction, and reflection judges receive their own configured identity.

### Verified rollout

Published `openharness:k8s-117` for Linux AMD64, pinned in the Nebius overlay as
`sha256:500edf7b98b4cef9b4ca27f96a096417538351f01439c04cb23d2ea04b4aaedd`.
The API/runner deployment rolled out successfully. HTTPS, Studio HTML, gateway, NeMo, Garak,
runner heartbeat and shared-storage smoke checks passed.

Live verification run `4d907f02-7561-45d5-b2c1-bfd9982a907a` used the existing workflow and original
question. It still recalled the Claude-containing experiment `079ef531-efb5-5541-ae7e-139d8a87933a`,
and answered:

> I am **nvidia/Nemotron-3-Ultra-550b-a55b** — this is the exact configured model ID for this session.

The `model_response` event recorded requested and reported model
`nvidia/Nemotron-3-Ultra-550b-a55b`, `modelMatches: true`, the configured US Central endpoint,
and upstream response ID `chatcmpl-b0efc1c16e6c5df0`.
In Studio, open the run trace and expand **Calling configured model provider** and
**Received response from configured model provider** to inspect this evidence on new runs.
