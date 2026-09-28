# OpenShell managed machines

How OpenHarness uses [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) to confine the work its agents
delegate to remote machines, and how the studio manages OpenShell sandboxes and policies from the console.

The harness agent is **not** sandboxed. It keeps calling any MCP server it is allowed to. OpenShell applies to
the sandboxes on an **OpenShell managed machine**: a host on which the OpenShell gateway runs. Agents create
sandboxes, run programs inside them and read their logs through MCP tools; every network connection and file
write inside a sandbox is decided by the sandbox's OpenShell policy, in the kernel (Landlock, seccomp) and in the
OpenShell egress proxy, not by application code in OpenHarness.

Pinned release: **OpenShell 0.1.2** (`v0.1.2`, commit `6648bd0`). The connector checks the CLI version at start
and warns on drift. Re-verify the tool contract before moving to another release; the CLI flags it uses are listed
in the connector source (`connector-openshell/src/openshell.ts`).

## Where things run

```
public network                                  private network
┌──────────────────────────────┐                ┌──────────────────────────────────────────┐
│ OpenHarness                  │                │ OpenShell host                           │
│  studio ─ api ─ runner       │   WebSocket    │  connector-openshell ──► openshell CLI    │
│              │               │◄───────────────│        (dials out, no inbound port)      │
│        device gateway        │                │                 │                        │
│   /mcp/<machine>  /admin     │                │        OpenShell gateway (control plane) │
└──────────────────────────────┘                │                 │                        │
                                                │   ┌─────────────┴──────────────┐         │
                                                │   │ sandbox: supervisor + agent │ ──► approved
                                                │   │  Landlock · seccomp · proxy │     destinations
                                                │   └────────────────────────────┘         │
                                                └──────────────────────────────────────────┘
```

Three paths stay distinct:

| Path    | What travels                                                                        | Who enforces                                                                            |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Agent   | `runner → device gateway /mcp/<machine> → connector → openshell CLI`                | per-machine tool allow-list, approvals and guardrails in OpenHarness; connector policy  |
| Console | `studio → api /api/openshell → device gateway /admin/devices/<id>/call → connector` | administrator role, tenant ownership, admin token, connector policy; audited as `admin` |
| Sandbox | `program in sandbox → supervisor → destination`                                     | the sandbox's OpenShell policy (kernel and proxy)                                       |

The OpenShell gateway never has to be reachable from the harness: the connector runs beside it and dials out over
WebSocket to the device gateway, exactly like the Linux connector. Nothing on the private side listens for the
harness. The two gateways are unrelated; this document says _device gateway_ and _OpenShell gateway_.

## Enroll an OpenShell managed machine

**Inventory → Add resource → OpenShell managed machine.** Name it, pick the tools agents may use (tools that change
sandboxes or policies are marked _acts_; leave them off for observers) and click **Create token**. The dialog shows
two installation tabs.

**OpenShell host** (recommended). Run as the OpenShell operator user, the account that can already run
`openshell status`, on the OpenShell gateway host or a machine that reaches it:

```sh
git clone https://github.com/deepfinery/OpenHarness.git && cd OpenHarness
npm --prefix connector-core ci && npm --prefix connector-core run build
npm --prefix connector-openshell ci && npm --prefix connector-openshell run build
GATEWAY_URL='wss://gateway.example.com/connect' DEVICE_ID='openshell-1' DEVICE_TOKEN='dv_…' sh connector-openshell/install.sh
```

The installer creates a systemd **user** service, `openharness-openshell-connector`, so the connector reuses that
user's `~/.config/openshell` gateway registration and mTLS bundle and needs no privileges of its own. Run
`sudo loginctl enable-linger $USER` to keep it running after logout. Configuration lives in
`~/.config/openharness-openshell-connector/config.json`, the token in `token` next to it (mode 0600), the audit
log under `~/.local/state/openharness-openshell-connector/`.

**Container.** `connector-openshell/Dockerfile` builds an image that contains the pinned OpenShell CLI (downloaded
from the GitHub release and verified against the published SHA-256). Run it with the host network, so it reaches
the local OpenShell gateway on `127.0.0.1:17670`, and the operator's OpenShell configuration mounted read-only:

```sh
docker run -d --name openharness-openshell-1 --restart unless-stopped --env-file ./machine.env \
  --network host --security-opt no-new-privileges:true --cap-drop ALL \
  -v "$HOME/.config/openshell:/home/node/.config/openshell:ro" openharness-connector-openshell
```

The connector never receives the Docker socket, the host root filesystem or the device gateway admin token.

## Connector settings

The `openshell` section of `config.json`, or the environment variables in the second column, bound what any
caller can do through this connector. They hold even against a compromised device gateway.

| Setting                   | Environment                         | Default     | Meaning                                                                             |
| ------------------------- | ----------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `bin`                     | `OPENSHELL_BIN`                     | `openshell` | Path of the OpenShell CLI                                                           |
| `gateway`                 | `OPENSHELL_GATEWAY`                 | active      | Registered gateway name (`openshell gateway list`)                                  |
| `gateway_endpoint`        | `OPENSHELL_GATEWAY_ENDPOINT`        | —           | Direct endpoint URL instead of stored metadata                                      |
| `workspace`               | `OPENSHELL_WORKSPACE`               | `default`   | Workspace used unless a call names another allowed one                              |
| `workspaces`              | `OPENSHELL_WORKSPACES`              | `[]`        | Additional workspaces calls may target                                              |
| `allow_policy_changes`    | `OPENSHELL_ALLOW_POLICY_CHANGES`    | `true`      | `set_policy`, `update_policy_rules`, `approve_rule`, `reject_rule`                  |
| `allow_sandbox_lifecycle` | `OPENSHELL_ALLOW_SANDBOX_LIFECYCLE` | `true`      | `create_sandbox`, `delete_sandbox`, `start_sandbox`, `stop_sandbox`                 |
| `allow_exec`              | `OPENSHELL_ALLOW_EXEC`              | `true`      | `exec_in_sandbox`                                                                   |
| `allowed_images`          | `OPENSHELL_ALLOWED_IMAGES`          | any         | Image references or prefixes `create_sandbox` may use                               |
| `max_sandboxes`           | `OPENSHELL_MAX_SANDBOXES`           | `20`        | Cap on sandboxes this connector created and still exist                             |
| `manage_all_sandboxes`    | `OPENSHELL_MANAGE_ALL_SANDBOXES`    | `true`      | When `false`, only sandboxes labelled `openharness.device=<machine>` can be changed |
| `cli_timeout_seconds`     | `OPENSHELL_CLI_TIMEOUT_SECONDS`     | `120`       | Deadline per CLI call; create, start and exec extend it                             |

Every sandbox the connector creates carries the label `openharness.device=<machine id>`, so operator sandboxes and
harness sandboxes are always distinguishable in `openshell sandbox list --selector`. The connector never changes
the gateway-global policy; `get_global_policy` only reads it.

## Tools

The connector is an ordinary MCP server. These are the tools the per-machine allow-list can grant to agents and
the console uses through the admin path. Every call is written to the connector's audit log and to the device
gateway's audit trail.

| Tool                    | Acts | OpenShell command                                                   |
| ----------------------- | ---- | ------------------------------------------------------------------- |
| `openshell_status`      |      | `status -o json`, `gateway info -o json`, `--version`               |
| `list_workspaces`       |      | `workspace list -o json`                                            |
| `list_sandboxes`        |      | `sandbox list -o json [--selector]`                                 |
| `get_sandbox`           |      | `sandbox get <name> -o json`                                        |
| `create_sandbox`        | yes  | `sandbox create --detach --no-auto-providers [--from] [--policy] …` |
| `delete_sandbox`        | yes  | `sandbox delete <name>`                                             |
| `start_sandbox`         | yes  | `sandbox start <name>`                                              |
| `stop_sandbox`          | yes  | `sandbox stop <name>`                                               |
| `exec_in_sandbox`       | yes  | `sandbox exec -n <name> --no-tty --no-login-shell --timeout … -- …` |
| `sandbox_logs`          |      | `logs <name> -n … [--since] [--source] [--level]`                   |
| `list_policy_revisions` |      | `policy list <name> -o json`                                        |
| `get_policy`            |      | `policy get <name> --base                                           | --full [--rev] -o json` |
| `set_policy`            | yes  | `policy set <name> --policy <file> --wait --timeout …`              |
| `update_policy_rules`   | yes  | `policy update <name> --add-endpoint … --binary … [--dry-run]`      |
| `list_rule_proposals`   |      | `rule get <name> [--status]`                                        |
| `approve_rule`          | yes  | `rule approve <name> --chunk-id …`                                  |
| `reject_rule`           | yes  | `rule reject <name> --chunk-id … --reason …`                        |
| `get_global_policy`     |      | `policy get --global --full -o json`                                |

Everything is argv, never a shell string; values that could look like flags are rejected. Policies arrive as YAML
or JSON text and are handed to the CLI through a private temporary file. `exec_in_sandbox` returns the exit code,
bounded output and `policy_denied: true` when the sandbox policy refused a connection or a write, so a denial shows
up in the run trace as a policy decision rather than a vague failure.

## The OpenShell console

The **OpenShell** entry in the left menu opens the console for each OpenShell managed machine:

- gateway reachability, authentication and version, and the connector policy in force;
- the sandboxes with phase, policy revision and whether the harness created them; create, stop, start and delete;
- per sandbox: the **base** policy (edit and apply, with the sandbox's confirmation that the revision loaded), the
  **effective** policy including provider rules, the revision history with load errors, a form to allow one more
  destination, the **proposals** the policy advisor drafted from denied requests (approve or reject with a reason),
  the **logs** including `policy_denied` lines, and a **run** box for a quick command;
- the global policy, when an administrator applied one on that gateway.

Reads need a signed-in member of the workspace that owns the machine; changes need an administrator. The console
does not go through the per-machine tool allow-list (that list is for agents); it goes through the device gateway's
admin API, which audits each call under the `admin` identity, and the connector's own settings still apply.

## How agents use it

Pick an OpenShell managed machine in the playground or bind it in a harness (the **Machine operator** template
becomes an **OpenShell operator** with matching instructions). Every agent in the run receives the machine's allowed
tools and an instruction to work inside sandboxes and report denials as they are. The existing controls apply
unchanged: tool-input and tool-output guardrails, approvals for tools marked as acting, run budgets, and the trace.

Only network sections of a policy take effect on a running sandbox. Filesystem, Landlock and process settings are
fixed at creation, so `create_sandbox` is where the static boundary is set: pass a policy with
`landlock.compatibility: hard_requirement` and a non-root `process.run_as_user`. Start a new role in
`enforcement: audit`, watch `sandbox_logs` and the proposals, then switch to `enforce`.

## Constraints

- The sandbox host needs Landlock ABI v3 or later; with `hard_requirement` a host without it refuses to start the
  sandbox instead of running it unconfined.
- Proxy egress to loopback, link-local and the metadata address is always blocked inside a sandbox. A model server
  on the host needs a routable, policy-approved address.
- OpenShell inspects MCP methods and tool names, not tool arguments or responses. OpenHarness's guardrails on the
  delegation boundary remain necessary.
- OpenShell telemetry is on by default. Set `OPENSHELL_TELEMETRY_ENABLED=false` on the OpenShell gateway (or use a
  telemetry-free build) before relying on the "no unsolicited outbound calls" property.
- `--no-keep` cannot be combined with exposed services. The connector's `no_keep` option is for one-shot jobs.
- The connector shells out to the pinned CLI. The TypeScript SDK is distributed through GitHub Packages and would
  make a fresh clone depend on a registry token, so it is not used; the driver sits behind an interface
  (`OpenShellDriver`) for a later swap.

## Verify enforcement on a real deployment

The isolated test stack uses a CLI test double (`tests/fixtures/openshell-fake`), so it proves the wiring, the
console, the connector policy and the trace, not kernel enforcement. On a real OpenShell host, do this once per role:

1. Create a sandbox from the console with a policy that allows one destination, for example `pypi.org:443`.
2. In **Run**, execute `curl -s https://pypi.org/simple/` (allowed) and `curl https://api.github.com/` (denied).
   The second returns `policy_denied`; **Logs** shows `policy_denied` with the destination and the binary, written
   by the supervisor, not by the program.
3. Execute `touch /etc/probe`. It fails with _Operation not permitted_, and `ls /etc/probe` afterwards shows no
   file: the write was refused by Landlock.
4. Open **Proposals**, approve the drafted rule for `api.github.com`, and repeat the denied command: it succeeds
   without restarting the sandbox.

Keep the run trace of a harness that performed step 2 through `exec_in_sandbox`; its `tool_completed` event
carries `policy_denied: true` and the sandbox log line is the enforcement evidence.

## Testing in this repository

- `connector-openshell/test` drives the connector against the CLI test double: tool surface, argv shapes, the
  connector policy, idempotent replay.
- `gateway/test` covers the admin tool-call endpoint (audited as `admin`, timeouts, disabled machines).
- `tests/integration/openshell.test.ts` runs in the isolated Compose project: enrollment, the console API, a harness
  run that works inside a sandbox, a denied request in the trace, tenant isolation and roles.
- `tests/browser/openshell.spec.ts` exercises the console and the inventory against scripted API routes.

Related: the design proposal in `design/openshell/design.md`, issue #67 (remote agent confinement) and issue #89
(this integration).
