# Machines — security model

What the device gateway and connectors defend against, how, and where the limits are. The orchestrator's
own model (encrypted credentials, tenant isolation, tool allow-lists per agent) is described in
[design.md](design.md); this document covers the path from an agent's tool call to a command on a machine.

## Principals and trust

| Principal    | Trusts                                                                     | Never trusted with                                                     |
| ------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Orchestrator | Gateway (bearer token per orchestrator, mTLS-ready)                        | Device tokens; anything on the machine beyond allowed tools            |
| Gateway      | Its registry; enrolled connectors (argon2id-hashed token, platform match)  | Deciding what a program may do on the machine                          |
| Connector    | Its local config and token file                                            | Instructions inside tool output; the gateway's word on what is allowed |
| Model        | Nothing: its tool calls are validated at three layers before anything runs | —                                                                      |

**Defence in depth is the point.** The gateway enforces a per-machine allow-list; the connector enforces
its own command allow/deny lists, path jail, output caps and timeouts inside every tool function. A
compromised orchestrator can call only allowed tools on machines it owns; a compromised gateway can still
call only what each connector's local policy permits. Neither can widen the other's policy.

## Controls

- **Outbound only.** Machines dial `wss://<gateway>/connect`; they expose no listening port. The gateway is
  the only component that needs a public address, and TLS is terminated in front of it. Sockets that did not
  arrive over TLS are refused unless `GATEWAY_ALLOW_INSECURE_WS=true` (development); connectors refuse
  `ws://` unless `allow_insecure`/`GATEWAY_ALLOW_INSECURE` is set.
- **Tokens.** Device tokens are 256-bit random values shown once and stored as argon2id hashes; orchestrator
  tokens are compared as SHA-256 digests in constant time. Tokens travel only in the first WebSocket frame
  or in an `Authorization` header — never in URLs or query strings. Connectors read the token from a
  0600 file or the environment and never log it; the shared logger redacts keys that look like credentials.
- **Deny by default.** A freshly enrolled machine has an empty allowed-tools list unless the operator ticks
  tools at enrollment; the studio labels tools that change state as **acts**. The connector's
  `allow_commands` is empty by default (the container image allows a read-mostly set) and `rm`, `dd`, `mkfs`,
  `sudo`, `su`, `shutdown`, `reboot`, `mount` are denied even when `*` is allowed.
- **Path jail.** Every file path is resolved with `realpath` and must stay under the work directory; for
  writes the deepest existing ancestor is checked, so neither symlinked files nor symlinked parent
  directories can lead outside. `read_only` disables writes.
- **No shell.** `run_command` takes argv and spawns without a shell; a shell mode exists but is off by
  default. Output is capped (`max_output_bytes`) and the process is killed at the timeout.
- **Tool output is data.** Connectors return results as MCP content only; nothing in a result can alter the
  connector's configuration, allow-lists or token. The orchestrator places tool output in the model's
  context as tool messages, never as instructions.
- **Audit.** The gateway writes one JSON line per call with orchestrator identity, machine, tool, redacted
  arguments, duration and outcome (`ok`, `error`, `denied`, `approval_denied`, `timeout`, `offline`); the
  connector keeps its own local audit line per call. Arguments pass a redaction hook before they are written.
- **Approvals.** Tools listed in `GATEWAY_APPROVAL_TOOLS` wait for an `ApprovalProvider` decision. The
  shipped providers are `noop` (allow) and `webhook` (POST the pending call, poll for `approved`/`denied`,
  deny on timeout). Approval happens before forwarding, so a denied call never reaches the machine.
- **Idempotency.** The orchestrator's `_meta.idempotencyKey` reaches the connector unchanged; `run_command`
  and `write_file` remember results per key for ten minutes, so a replay after a reconnect does not act twice.
- **Liveness and supersession.** Two missed heartbeats mark a machine offline; a newer connection for the same
  machine closes the older one (`4009`), so a stolen token cannot silently coexist with the legitimate
  connector — the operator sees the flapping in the gateway log and can rotate the token.
- **Rate limits.** Handshakes are limited per source address; the orchestrator's own limits apply to runs.
- **Least-privilege runtime.** The systemd unit uses `ProtectSystem=strict`, `ProtectHome`,
  `NoNewPrivileges`, an empty capability set, `PrivateTmp`/`PrivateDevices`, and only the state directory is
  writable. The container image runs as `node`, and the Compose stack drops all capabilities. Neither the
  gateway nor the connector ever runs shell commands sent by the UI.

## What a compromise buys an attacker

| Compromised component | Can                                                                             | Cannot                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Orchestrator token    | Call allowed tools on machines owned by that tenant                             | Enroll machines, change allow-lists (admin token), run programs outside each connector's allow-list     |
| Gateway host          | Forward any tool call to any online machine within the connector's local policy | Read files outside work directories, run denied programs, obtain device tokens (only hashes are stored) |
| Device token          | Impersonate that one machine (superseding the real connector, which is visible) | Reach other machines or the admin API; a rotated token ends it                                          |
| Machine               | Return misleading tool output                                                   | Instruct the orchestrator (output is data), reach the gateway's admin API, see other machines           |

## Operational guidance

- Rotate device tokens from the machine's settings when a host is reimaged or a token may have leaked.
- Give machines the narrowest work directory and command allow-list that the intended workflows need; add
  `read_only: true` for observation-only machines.
- Put `run_command` and `write_file` in `GATEWAY_APPROVAL_TOOLS` with the webhook provider when a human must
  confirm changes; the trace still shows what the agent asked for.
- Keep `/admin/*` off the public listener (the Caddyfile does); the orchestrator reaches it internally.
- Back up the gateway data directory with the orchestrator volumes; it holds only hashes and allow-lists.

## Known limits

- The gateway cannot know whether a tool acted before a connection dropped; in-flight calls fail with
  `device reconnected` and are not replayed. Combine with the orchestrator's `safe` resume policy.
- `GATEWAY_APPROVAL_PROVIDER=webhook` is a reference implementation (POST + polling), not a UI.
- Windows and Chrome connectors ship in the next release; their allow-lists can be prepared now.
- The registry supports SQLite today; `DATABASE_URL` for Postgres is reserved and rejected with a clear error.
