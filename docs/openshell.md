# OpenShell managed machines

How OpenHarness uses [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) to confine the work its agents
delegate to remote machines, and how the studio manages OpenShell sandboxes and policies from the console.

The harness agent is **not** sandboxed. It keeps calling any MCP server it is allowed to. OpenShell confines
**executors**: sandboxes on an OpenShell host that run the OpenHarness connector under a policy and appear in the
inventory as ordinary Linux machines. Every command a harness runs on an executor is decided by that sandbox's
OpenShell policy, in the kernel (Landlock, seccomp) and in the OpenShell egress proxy, not by application code.

Pinned release: **OpenShell 0.1.2** (`v0.1.2`, commit `6648bd0`). The edge talks to the OpenShell gateway through
the official Go SDK at that commit; the deployment pins the gateway, sandbox and supervisor images to `0.1.2`.

## The pieces

| Piece                                         | Where it runs                                 | What it does                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openharness-connector` (Go, `connector-go/`) | Any Linux machine, container or sandbox       | Dials out to the device gateway over WebSocket and serves the Linux tools (`run_command`, files, search, system, processes) with a local policy. One image, no install. |
| `openharness-edge` (Go, `connector-go/`)      | Beside the OpenShell gateway, private network | Speaks gRPC to the OpenShell gateway, dials out to the device gateway as an **OpenShell managed machine**, exposes OpenShell as MCP tools, launches executors.          |
| OpenShell gateway                             | The OpenShell host (Docker compute driver)    | Control plane for sandboxes, policies and providers. Deployed by `deploy/openshell/compose.yaml`.                                                                       |
| Executor sandbox                              | Created by the OpenShell gateway on that host | Runs `openharness-connector` under an OpenShell policy; registers as a Linux machine with the `sandboxed` badge.                                                        |
| OpenShell console                             | The studio, `/openshell`                      | Sandboxes, policies, revision history, rule proposals, logs, a run box, and _Launch executor_.                                                                          |

```
OpenHarness server (public)                                   OpenShell host (private)
  studio ─ api ─ device gateway ◄─ wss (self-signed CA ok) ─── openharness-edge ── gRPC ── openshell-gateway
   ▲  /api/openshell/*          ◄─ wss ──────────────────────── executor sandbox: openharness-connector
   └─ admin tool call ─────────►                                  (Landlock · seccomp · egress policy)
```

Three paths stay distinct:

| Path    | What travels                                                                   | Who enforces                                                                                 |
| ------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Agent   | `runner → device gateway /mcp/<machine> → edge or executor`                    | per-machine tool allow-list, approvals, guardrails and budgets in OpenHarness; edge settings |
| Console | `studio → api /api/openshell → device gateway /admin/devices/<id>/call → edge` | administrator role, tenant ownership, admin token, edge settings; audited as `admin`         |
| Sandbox | `program in an executor → supervisor → destination`                            | the sandbox's OpenShell policy (kernel and proxy)                                            |

Nothing on the private side listens for the harness. The two gateways are unrelated; this document says _device
gateway_ and _OpenShell gateway_.

## Deploy on the OpenShell host

1. **Enroll.** Studio: _Inventory → Add resource → OpenShell managed machine_, pick the tools agents may use,
   _Create token_. The dialog prints the exact commands below with the machine id and token filled in.
2. **Deploy.** On the OpenShell host, from a checkout of this repository:

   ```sh
   sh deploy/openshell/build-images.sh          # or pull openharness-edge and openharness-connector from your registry
   cd deploy/openshell && cp .env.example .env  # fill in OPENHARNESS_GATEWAY_URL, OPENHARNESS_DEVICE_ID, OPENHARNESS_TOKEN
   cp /path/to/harness/data/tls/ca.crt certs/   # only for a self-signed harness (scripts/enable-tls.sh on the server)
   docker compose up -d && docker compose logs -f openharness-edge
   ```

   The compose file runs the OpenShell gateway (Docker driver, telemetry off, API on loopback only) and the
   edge. The machine turns online in the inventory; the **OpenShell** page shows the gateway.

3. **Launch executors** from the OpenShell page. The studio enrolls a Linux machine, hands the edge its token
   through the trusted admin path, and the edge creates a sandbox from `EXECUTOR_IMAGE` with this policy:
   `/sandbox` and `/tmp` writable, `landlock.compatibility: hard_requirement`, `run_as_user: 1000`, and a network
   rule that admits only the harness gateway (relayed with `tls: skip`, so the connector verifies the harness
   certificate itself) plus the extra `host:port` destinations you list. The executor dials in and shows up as a
   Linux machine with the _sandboxed_ badge. `OPENHARNESS_EXECUTOR_DEVICE_ID` and `OPENHARNESS_EXECUTOR_TOKEN`
   in `.env` launch one executor at start without the console.

`deploy/openshell/README.md` lists requirements, constraints and operations.

## The harness side with a self-signed certificate

`scripts/enable-tls.sh [public-host]` creates a local certificate authority and a server certificate for every
name the server answers to, writes them under `data/tls/`, and switches `.env` to the TLS front: Caddy on
`TLS_PORT` (8443) serves the studio and API over HTTPS and the device gateway's `/connect` and `/mcp/*` over the
same origin, while the plain ports move to loopback. Run `./start.sh` afterwards.

Give every dial-out component the CA: `GATEWAY_CA_FILE` (or `GATEWAY_CA_PEM`) for the Go connector and edge,
`OPENHARNESS_CA_FILE=/certs/ca.crt` with `ca.crt` in `deploy/openshell/certs/` for the deployment,
`NODE_EXTRA_CA_CERTS` for the Node connector. The edge forwards the CA to every executor it launches.

## Edge settings

Environment of the edge (`deploy/openshell/.env` maps them one to one). They bound what any caller can do
through this edge and hold even against a compromised device gateway.

| Variable                            | Default                       | Meaning                                                                                |
| ----------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `OPENSHELL_ADDRESS`                 | `openshell-gateway:8080`      | OpenShell gateway gRPC address                                                         |
| `OPENSHELL_TLS`, `OPENSHELL_TLS_*`  | off                           | TLS and mTLS files towards the OpenShell gateway                                       |
| `OPENSHELL_TOKEN`                   | —                             | Bearer token when the OpenShell gateway uses OIDC                                      |
| `OPENSHELL_WORKSPACE`               | `default`                     | Workspace used unless a call names another allowed one                                 |
| `OPENSHELL_WORKSPACES`              | —                             | Additional workspaces calls may target                                                 |
| `OPENSHELL_ALLOW_POLICY_CHANGES`    | `true`                        | `set_policy`, `update_policy_rules`, `approve_rule`, `reject_rule`                     |
| `OPENSHELL_ALLOW_SANDBOX_LIFECYCLE` | `true`                        | `create_sandbox`, `delete_sandbox`, `start_sandbox`, `stop_sandbox`, `launch_executor` |
| `OPENSHELL_ALLOW_EXEC`              | `true`                        | `exec_in_sandbox`                                                                      |
| `OPENSHELL_ALLOWED_IMAGES`          | any                           | Image references or prefixes sandboxes and executors may use                           |
| `OPENSHELL_MAX_SANDBOXES`           | `20`                          | Cap on sandboxes this edge created and still exist                                     |
| `OPENSHELL_MANAGE_ALL_SANDBOXES`    | `true`                        | When `false`, only sandboxes labelled `openharness.device=<machine>` can be changed    |
| `EXECUTOR_IMAGE`                    | `openharness-connector:local` | Image executors are created from; must contain `/usr/local/bin/openharness-connector`  |
| `EXECUTOR_ALLOWED_HOSTS`            | —                             | `host:port[:access[:protocol[:enforcement]]]` destinations every executor may reach    |
| `EXECUTOR_GATEWAY_URL`              | `GATEWAY_URL`                 | Harness gateway executors dial, when it differs from the edge's                        |

Every sandbox the edge creates carries the label `openharness.device=<machine id>`; executors also carry
`openharness.executor=<their machine id>`. The edge never changes the gateway-global policy.

## Tools

The edge is an ordinary MCP server. These are the tools the per-machine allow-list can grant to agents and the
console uses through the admin path. Every call is written to the edge's audit log and the device gateway's
audit trail.

| Tool                    | Acts | OpenShell operation (Go SDK)                                                       |
| ----------------------- | ---- | ---------------------------------------------------------------------------------- |
| `openshell_status`      |      | `Health().Check`, `Health().GetGatewayInfo`                                        |
| `list_workspaces`       |      | `Workspaces().ListAll`                                                             |
| `list_sandboxes`        |      | `Sandboxes().ListAll` with a label selector                                        |
| `get_sandbox`           |      | `Sandboxes().Get`, `Config().GetSandbox`                                           |
| `create_sandbox`        | yes  | `Sandboxes().Create` with image, environment, command, policy, labels, providers   |
| `delete_sandbox`        | yes  | `Sandboxes().Delete`                                                               |
| `start_sandbox`         | yes  | `Sandboxes().Start`                                                                |
| `stop_sandbox`          | yes  | `Sandboxes().Stop`                                                                 |
| `exec_in_sandbox`       | yes  | `Exec().Run` (no login shell), bounded by a timeout                                |
| `sandbox_logs`          |      | `Sandboxes().GetLogs` with lines, since, source and level filters                  |
| `list_policy_revisions` |      | `Policy().ListAll`                                                                 |
| `get_policy`            |      | `Policy().GetStatus` (base, any revision) or `Config().GetSandbox` (effective)     |
| `set_policy`            | yes  | `Config().Update` with a full policy                                               |
| `update_policy_rules`   | yes  | `Config().Update` with merge operations (add/remove rules and endpoints, L7 rules) |
| `list_rule_proposals`   |      | `Policy().GetDraft`                                                                |
| `approve_rule`          | yes  | `Policy().ApproveDraftChunk` with the chunk's review token                         |
| `reject_rule`           | yes  | `Policy().RejectDraftChunk`                                                        |
| `get_global_policy`     |      | `Policy().GetStatus` with the global scope                                         |
| `launch_executor`       | yes  | `Sandboxes().Create` + `WaitReady` with the executor policy and environment        |

Policies travel as JSON in the documented OpenShell shape (`version`, `filesystem_policy`, `landlock`, `process`,
`network_policies` with `endpoints` and `binaries`); the edge converts them to the SDK's typed policy and back.
`exec_in_sandbox` returns the exit code, output and `policy_denied: true` when the sandbox policy refused a
connection or a write, so a denial shows up in the run trace as a policy decision rather than a vague failure.

## The OpenShell console

The **OpenShell** entry in the left menu opens the console for each OpenShell managed machine: gateway status
and version with the edge settings in force; the sandboxes with phase, policy revision and whether they are
executors; create, stop, start and delete; **Launch executor**; per sandbox the **base** policy (edit and apply,
with the sandbox's confirmation that the revision loaded), the **effective** policy, the revision history with
load errors, a form to allow one more destination, the advisor's **proposals** (approve or reject with a reason),
the **logs** including `policy_denied` lines, and a **run** box; and the global policy when one is applied.

Reads need a signed-in member of the workspace that owns the machine; changes need an administrator. The console
does not go through the per-machine tool allow-list (that list is for agents); it goes through the device
gateway's admin API, which audits each call under the `admin` identity, and the edge settings still apply.

## How agents use it

Pick an executor in the playground or bind it in a harness like any Linux machine: its tools are the ordinary
Linux tools, but the process, its files and its network are confined by the sandbox policy. Pick the OpenShell
managed machine itself to let a harness manage sandboxes (the **Machine operator** template becomes an
**OpenShell operator**). The existing controls apply unchanged: tool-input and tool-output guardrails, approvals
for tools marked as acting, run budgets, and the trace.

Only network sections of a policy take effect on a running sandbox. Filesystem, Landlock and process settings are
fixed at creation, which is why `launch_executor` sets them. Start a new role's extra destinations in
`enforcement: audit`, watch `sandbox_logs` and the proposals, then switch to `enforce`.

## Constraints

- The OpenShell host needs Docker Engine 28+ and a kernel with Landlock ABI v3 or later; with
  `hard_requirement` a host without it refuses to start the sandbox instead of running it unconfined.
- Proxy egress to loopback, link-local and the metadata address is always blocked inside a sandbox. The harness
  gateway must be a routable address for executors, never `localhost`.
- OpenShell terminates TLS on inspected endpoints with its own certificate authority. The executor's rule for the
  harness gateway therefore uses `tls: skip` (relay) and the connector verifies the harness certificate itself.
- OpenShell inspects MCP methods and tool names, not tool arguments or responses. OpenHarness's guardrails on
  the delegation boundary remain necessary.
- OpenShell telemetry is on by default; the deployment sets `OPENSHELL_TELEMETRY_ENABLED=false`.
- The OpenShell gateway API in the deployment is plaintext inside the compose network and published on loopback
  only. Enable mTLS before exposing it further.
- Policies are JSON here; convert YAML policies before pasting them into the console.

## Verify enforcement on a real deployment

The isolated test stack runs the edge against an in-memory OpenShell stand-in (`OPENSHELL_FAKE=true`), so it
proves the wiring, the console, the edge settings, the executor launch and the trace, not kernel enforcement. On a
real OpenShell host, do this once per role:

1. Launch an executor from the console with one extra destination, for example `pypi.org:443:read-only:rest:enforce`.
   It appears in the inventory online, with the _sandboxed_ badge.
2. In the playground, pick the executor and ask a harness to run `curl -s https://pypi.org/simple/` (allowed) and
   `curl https://api.github.com/` (denied). The second returns exit code 7 and `policy_denied` in the trace;
   the OpenShell page's **Logs** for that sandbox shows `policy_denied` with the destination and the binary,
   written by the supervisor, not by the program.
3. Ask it to write `/etc/probe`. It fails with _Operation not permitted_, and listing `/etc` afterwards shows no
   file: the write was refused by Landlock.
4. Open **Proposals** for the executor, approve the drafted rule for `api.github.com`, and repeat the denied
   command: it succeeds without restarting the sandbox.

## Testing in this repository

- `connector-go`: `go test ./...` covers the device protocol client against an in-process gateway (handshake,
  heartbeats, resume, backoff, permanent refusals), the MCP server, the policy jail, every Linux tool, the edge
  tools against the in-memory OpenShell, policy JSON conversion and the executor policy.
- `gateway/test` covers the admin tool-call endpoint.
- `tests/integration/machines.test.ts` runs the Go connector container against the real device gateway;
  `tests/integration/openshell.test.ts` runs the edge (stand-in mode), the console API, an executor launch and a
  harness run inside a sandbox.
- `tests/browser/openshell.spec.ts` exercises the console and the inventory against scripted API routes.

Related: the design proposal in `design/openshell/design.md`, issue #67 (remote agent confinement) and issue #89
(this integration).
