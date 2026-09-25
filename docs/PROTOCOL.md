# Device gateway — wire protocol (v1)

This document is normative for `connector-core`, the gateway and every connector. Everything after the
handshake is plain MCP (JSON-RPC 2.0); the protocol adds only connection setup, liveness and resume.

## 1. Transport

- WebSocket over TLS. Devices connect to `wss://<gateway>/connect` with subprotocol
  `agentic-mcp.v1`. The gateway rejects the upgrade when the subprotocol is missing (HTTP 400) and
  plain `ws://` is accepted only when `GATEWAY_ALLOW_INSECURE_WS=true` (local development).
- Frames are UTF-8 **text** frames, each containing exactly one JSON object. Binary frames close the
  connection with `4008`. Maximum frame size is 4 MiB; larger frames close with `1009`.
- Nothing sensitive travels in the URL or query string. Authentication is the first frame.
- The gateway sits behind a reverse proxy; the proxy must forward `Upgrade`/`Connection` headers and
  keep idle WebSockets open for at least 90 s.

## 2. Handshake

### 2.1 `hello` (device → gateway, first frame, within 10 s of the upgrade)

```json
{
  "type": "hello",
  "protocol_version": 1,
  "device_id": "laptop-1",
  "platform": "linux",
  "hostname": "laptop-1.lan",
  "token": "dv_3f9a…",
  "connector_version": "0.1.0",
  "capabilities": ["run_command", "read_file", "list_dir", "system_info"],
  "resume": { "session_id": "sess_01J…" }
}
```

| Field               | Rules                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `protocol_version`  | Integer, currently `1`. Unsupported → close `4013`.                                                      |
| `device_id`         | `^[a-z0-9][a-z0-9-]{0,62}$`; must exist in the registry and not be disabled.                             |
| `platform`          | `linux` \| `windows` \| `chrome`; must match the enrolled platform.                                      |
| `hostname`          | ≤ 253 chars, informational.                                                                              |
| `token`             | The one-time enrollment token; verified against the argon2id hash. Never logged.                         |
| `connector_version` | Semver string, informational (surfaced by `device_status`).                                              |
| `capabilities`      | Tool names the connector exposes (≤ 200). Informational; the authoritative list comes from `tools/list`. |
| `resume`            | Optional. `session_id` from a previous `welcome`; see §5.                                                |

### 2.2 `welcome` (gateway → device)

```json
{
  "type": "welcome",
  "session_id": "sess_01J…",
  "heartbeat_seconds": 30,
  "resumed": false,
  "server_time": "2026-09-25T10:00:00Z"
}
```

`resumed: true` means the previous session's identity was kept (§5). After `welcome` the connection is
in the **MCP phase**.

### 2.3 Close codes

| Code   | Meaning                                                                    |
| ------ | -------------------------------------------------------------------------- |
| `4001` | Unauthenticated: unknown device, bad token, or no `hello` within 10 s.     |
| `4003` | Forbidden: device disabled, or platform mismatch.                          |
| `4008` | Protocol error: malformed frame, binary frame, MCP frame before `welcome`. |
| `4009` | Superseded: a newer connection for the same `device_id` was accepted.      |
| `4013` | Unsupported `protocol_version`.                                            |
| `4029` | Rate limited (too many hello attempts from one device or address).         |
| `1001` | Gateway shutting down; reconnect.                                          |
| `1009` | Frame too large.                                                           |

The gateway never explains _why_ a token failed beyond the code.

## 3. MCP phase

After `welcome`, every frame is a **single JSON-RPC 2.0 message** exactly as the MCP SDK produces it:
requests, responses (results or errors) and notifications. Batches (`[…]`) are not used. Frames that are
not valid JSON-RPC close the connection with `4008`.

Both ends implement this as a `Transport` for `@modelcontextprotocol/sdk` (1.30.1):

- Device side: `WebSocketClientTransport` in `connector-core`, given to `McpServer.connect()`. `send()`
  writes one frame; `onmessage` fires per received frame; `close()` sends `1000`.
- Gateway side: `WebSocketServerTransport`, one per accepted socket, given to an SDK `Client`. The
  gateway sends `initialize` once after `welcome`, then `notifications/initialized`, then `tools/list`.

Direction of requests:

| Direction        | Allowed                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gateway → device | `initialize`, `ping`, `tools/list`, `tools/call`, and pass-through of any method family the device declared in `initialize` (`resources/*`, `prompts/*`). `notifications/cancelled` for timed-out or cancelled calls.                                                                 |
| device → gateway | Responses to the above; `notifications/tools/list_changed` (the gateway re-lists and notifies orchestrator sessions); `notifications/message` (logged at the gateway). Device-initiated **requests** (sampling, elicitation, roots) receive `-32601 method not supported by gateway`. |

The orchestrator's `_meta` on `tools/call` (for example `idempotencyKey`) is forwarded unchanged, so a
connector that deduplicates on it can make replays harmless.

## 4. Liveness

- The gateway sends a WebSocket **ping** control frame every `heartbeat_seconds` (30). A device that
  fails to answer two consecutive pings (no pong within 2 × 30 s) is marked **offline** and its socket
  closed with `1001`.
- Runtimes that cannot observe control frames (Chrome extensions) additionally send
  `{"type":"heartbeat"}` every 30 s; the gateway answers `{"type":"heartbeat_ack","server_time":…}`.
  Either signal counts as liveness. Both frames are allowed in the MCP phase and are not JSON-RPC.
- Devices treat 60 s without any inbound frame (pong, ack or MCP traffic) as a dead connection and
  reconnect.
- `last_seen` in the registry is updated at connect, at most once per minute on heartbeats, and at
  disconnect.

## 5. Reconnect and resume

- Backoff: `delay = min(60 s, 1 s × 2^attempt)` with full jitter (`random(0, delay)`), reset after a
  connection that stayed open for ≥ 60 s. Attempts are logged locally; the token is never logged.
- On reconnect the device sends `hello` with `resume.session_id`. If the gateway still holds that
  session (sessions are retained **10 minutes** after a disconnect), it answers `resumed: true` and keeps
  the device's identity and cached tool list. Otherwise it issues a new `session_id` (`resumed: false`).
- Resume does **not** replay in-flight requests. Any `tools/call` that was pending when the socket
  dropped is failed towards the orchestrator with `-32014 device reconnected`. The gateway does not know
  whether the tool ran; the orchestrator's resume policy already treats external tool steps as
  non-replayable.
- A connection from a `device_id` that is already online supersedes the old one (`4009` to the old
  socket) so a device whose previous socket is half-open can always come back.

## 6. Correlation, timeouts, cancellation (gateway)

- Each orchestrator session owns an SDK `Server`; each device connection owns an SDK `Client`. Request
  ids on the two sides are independent and correlated by the SDK's own pending-request tables, so
  multiple orchestrator sessions can multiplex over one device socket without id collisions.
- Per request timeout: `GATEWAY_TOOL_TIMEOUT_SECONDS` (default 120), overridable per tool with
  `GATEWAY_TOOL_TIMEOUTS="run_command=600,get_ui_tree=30"`. On expiry the gateway sends
  `notifications/cancelled` to the device and returns `-32013` to the orchestrator.
- An orchestrator-side cancellation (`notifications/cancelled` or a closed HTTP request) is forwarded
  as `notifications/cancelled` to the device.

## 7. Gateway ↔ orchestrator (Streamable HTTP MCP)

- Endpoint per device: `https://<gateway>/mcp/{device_id}`; fleet: `https://<gateway>/mcp/fleet`.
  Standard MCP Streamable HTTP: `POST` for messages, `GET` for the SSE notification stream, `DELETE` to
  end a session; `Mcp-Session-Id` as issued by the gateway; sessions idle for 30 min are evicted.
- `Authorization: Bearer <orchestrator token>` on every request; missing or wrong → HTTP 401 with
  `{"error":"unauthorized"}` before any MCP parsing.
- `initialize` is answered by the gateway with `serverInfo: { name: "agentic-gateway", version }`,
  `capabilities: { tools: { listChanged: true } }` plus the device's own declared capabilities when it
  is online.
- `tools/list` returns the device's tools filtered by `allowed_tools`. When the device is offline and a
  cached list exists, it is returned with `_meta: { stale: true }`.
- Error codes used by the gateway (JSON-RPC `error.code`, in the implementation-defined range and clear of the SDK's own `-32000`/`-32001`):

| Code     | Message                           | When                                            |
| -------- | --------------------------------- | ----------------------------------------------- |
| `-32010` | `device offline`                  | No live session for the device.                 |
| `-32011` | `tool not allowed`                | Tool not in the device's `allowed_tools`.       |
| `-32012` | `approval denied`                 | Approval provider denied or timed out.          |
| `-32013` | `device timeout`                  | Per-request timeout expired.                    |
| `-32014` | `device reconnected`              | Socket dropped while the request was in flight. |
| `-32601` | `method not supported by gateway` | Device-initiated request families.              |

Errors are also written to the audit log with the matching `outcome`.

### 7.1 Fleet tools

`list_devices` — no arguments → `structuredContent`:

```json
{
  "devices": [
    {
      "device_id": "laptop-1",
      "platform": "linux",
      "online": true,
      "hostname": "laptop-1.lan",
      "connector_version": "0.1.0",
      "last_seen": "2026-09-25T10:00:00Z",
      "allowed_tools": ["run_command"],
      "endpoint": "https://gateway.example.com/mcp/laptop-1"
    }
  ]
}
```

`device_status` — `{ "device_id": string }` → the same record plus `session_id`, `connected_at`,
`capabilities`, and `pending_requests`. Unknown device → `isError: true`.

## 8. Versioning

`protocol_version` is a single integer. A gateway supports the current version and, when a later
version exists, the previous one for a deprecation period. Additive fields in `hello`/`welcome` do not
bump the version; changes to framing, handshake semantics or close codes do. The MCP protocol version
itself is negotiated by the SDK in `initialize`, independently of this number.

## 9. Full example

```text
device → gateway   {"type":"hello","protocol_version":1,"device_id":"laptop-1","platform":"linux","hostname":"laptop-1.lan","token":"dv_…","connector_version":"0.1.0","capabilities":["run_command","read_file"]}
gateway → device   {"type":"welcome","session_id":"sess_01J…","heartbeat_seconds":30,"resumed":false,"server_time":"2026-09-25T10:00:00Z"}
gateway → device   {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agentic-gateway","version":"0.1.0"}}}
device → gateway   {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"connector-linux","version":"0.1.0"}}}
gateway → device   {"jsonrpc":"2.0","method":"notifications/initialized"}
gateway → device   {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
device → gateway   {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"run_command","inputSchema":{…}}, …]}}
…
orchestrator → gateway (HTTP POST /mcp/laptop-1)   {"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"run_command","arguments":{"argv":["uname","-a"]},"_meta":{"idempotencyKey":"run:node:1"}}}
gateway → device   {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_command","arguments":{"argv":["uname","-a"]},"_meta":{"idempotencyKey":"run:node:1"}}}
device → gateway   {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Linux laptop-1 6.8.0 …"}],"structuredContent":{"exit_code":0,"stdout":"Linux laptop-1 6.8.0 …","stderr":"","truncated":false}}}
gateway → orchestrator (HTTP response)   {"jsonrpc":"2.0","id":7,"result":{…same result…}}
```
