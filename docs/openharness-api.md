# Open Harness API

OpenHarness implements the [Open Harness API](https://github.com/jeffrschneider/OpenHarness), an open specification
for driving agent harnesses through one REST, SSE and WebSocket interface. This installation is one harness. The
adapter maps the spec's resources onto OpenHarness workflows, runs, conversations and resources. The studio's own
`/api` stays unchanged.

The pinned spec version is 0.2.0, at upstream commit `f727de1`. The route table is generated from its
`openharness.mapi.md` into `apps/api/src/openharness/spec.ts`.

## Base URL and identity

| Setting                  | Default           | Meaning                                                      |
| ------------------------ | ----------------- | ------------------------------------------------------------ |
| `OPENHARNESS_BASE_PATH`  | `/openharness/v1` | Where the spec's routes are mounted, below `PUBLIC_URL`.     |
| `OPENHARNESS_HARNESS_ID` | `openharness`     | The `{harnessId}` every route expects. Other IDs return 404. |

For example, the capability manifest is at
`https://studio.example.com/openharness/v1/harnesses/openharness/capabilities`.

## Authentication

Send `Authorization: Bearer <key>`. Two kinds of key work:

- **Workspace keys** (`oh_sk_…`) have the `harness` scope and reach the whole workspace through this API. Only
  administrators create them, under Integrations → API key → "Whole workspace · Open Harness API". Through the
  `/api` routes, the same key has read and execute access.
- **Workflow keys** (`ao_…`) keep their `read` and `execute` scopes and their workflow targets. Operations that
  change configuration return 403 `INSUFFICIENT_SCOPE`.

A studio session cookie also works from the studio's own origin. Cookie writes need a matching `Origin` header.
Cross-origin requests are allowed only with bearer keys. `GET …/health` needs no credentials, and anonymous callers
get pass or fail per check without internal messages.

## Conventions

- **Errors** use the spec envelope `{ "error": { "code", "message", "domain", "operation", "details" } }`. Codes
  include `VALIDATION_ERROR` (with `details.issues`), `INVALID_JSON`, `UNAUTHORIZED`, `FORBIDDEN`,
  `INSUFFICIENT_SCOPE`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED` and `CAPABILITY_NOT_SUPPORTED`.
- **Pagination** uses `limit` (1–100, default 20) and `offset`. Lists return `data`, `total`, `limit`, `offset` and
  `has_more`.
- **Unsupported operations** answer 501 `CAPABILITY_NOT_SUPPORTED` and name the domain and operation. Every route of
  the spec is mounted, so an unknown route answers 404 while a known but unimplemented one answers 501.
- **Extensions** go under `x-openharness` keys, so they never collide with future spec fields.

## Capability manifest

`GET /harnesses/{harnessId}/capabilities` is generated from the same registry that mounts the routes. A domain is
reported as supported only when a mounted operation provides it. Clients should read it before calling a domain.

## Executions

`POST /execute` starts a task and answers 202 with `execution_id`, `status` and `stream_url`. `POST /execute/stream`
does the same and streams the execution in the one response. The request fields are:

- **`agent_id`** is a workflow ID; agents in OpenHarness are workflows. Older stand-alone agent records work too.
  Without it, the task runs on a per-workspace default agent that uses the workspace default model provider.
- **`model`** picks a configured provider for this execution, by provider ID, provider name or model name. An
  unknown value returns 400 `model_not_available` with the available models in `details`.
- **`system_prompt`** is appended to every agent's instructions for this execution. **`skills`** adds workspace
  skill IDs to what the agents may load.
- **`x-openharness.machine_id`** runs the task with a registered machine's tools, and `x-openharness.payload` passes
  structured fields to workflow templates.
- An `Idempotency-Key` header makes retries safe, as on `/api/runs`.

Limits: messages are capped at 32,000 characters (400 `context_length_exceeded`). `temperature` and `max_tokens`
are accepted but not applied. `session_id` returns 501 until the sessions domain lands.

Execution states map from run states: `queued` is `pending`, `succeeded` is `completed`, and `interrupted` (a runner
that died past its resume budget) is `failed`, with the original state in `x-openharness.run_status`.
`GET /executions` filters by `status`, `agent_id` and `since`. `/cancel` answers 409 once the execution has finished,
and `/result` answers 409 while it is still running.

### Streaming

Streams use the spec's event names:

| Event                              | Source                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`                             | Model output as it is written, and at the end any part of the final answer not yet sent. Concatenated, it always ends with the final output. |
| `tool_call_start`, `tool_call_end` | An agent or workflow step calls a tool. `input` holds the arguments.                                                                         |
| `tool_result`                      | The tool's answer, with `success` and `output.content`.                                                                                      |
| `progress`                         | Workflow steps, plans, iterations, skills and budget events. `x-openharness.type` keeps the original event type.                             |
| `error`                            | The execution failed, was cancelled or was interrupted (`EXECUTION_FAILED`, `EXECUTION_CANCELLED`, `EXECUTION_INTERRUPTED`).                 |
| `done`                             | Always last, exactly once, with token `usage`.                                                                                               |

Event ids have the form `<run events>.<text characters>`. Reconnect to `GET /executions/{id}/stream` with a
`Last-Event-ID` header to resume without repeats. Without the header, the stream replays from the start. Streams
remain available for one hour after an execution finishes; after that the endpoint answers 410 and the result stays
readable. `GET /executions/{id}/tool-calls` lists every call with its input, output, status and timing.

## Agents

An agent is a workflow. The spec's agent view is built from the workflow and its entry agent, which is the first
agent reached from Start. The mapping is:

- **Identity.** `vendorKey`, `agentKey`, `version`, `author`, `license` and `tags` are stored on the workflow as
  `identity`. When absent, they are derived from the workspace and workflow names.
- **Configuration.** `config.model`, `config.system_prompt` and `config.tools_access` describe the entry agent.
  `PATCH` changes that agent. `tools_access.allow` and `deny` narrow its bound MCP tools, and patterns may end in
  `*`.
- **References.** `skills` and `mcp_servers` list every skill and MCP connection the workflow uses.

`POST /agents` accepts `multipart/form-data`, with a `metadata` JSON field and `files` whose names are package paths
such as `AGENTS.md` or `skills/<name>/SKILL.md`. It also accepts JSON:
`{ "metadata": {...}, "files": [{ "path", "content" }] }`. The manifest follows the
[Open Agent Format](https://openagentformat.com) and is resolved like this:

| Manifest field                                                                       | Becomes                                                                                |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Markdown body                                                                        | The agent's instructions.                                                              |
| `model`                                                                              | The provider whose model or name matches, else the workspace default (with a warning). |
| `skills` and `skills/*/SKILL.md`                                                     | Workspace skills with the same name, else new skills created from the bundle.          |
| `mcpServers[].server`                                                                | The workspace MCP connection with that name. `config.tools.allowed` narrows its tools. |
| `packs`, `weblets`, `agents`, `orchestration`, `memory`, `temperature`, `max_tokens` | Ignored, with a warning.                                                               |

Agent names are unique. `DELETE` answers 409 while the agent has queued or running executions. `clone` copies the
workflow under `new_name`, with any schedule disabled.

**Export** returns `<agentKey>.zip` with these files:

- `AGENTS.md`, with OAF frontmatter and the entry agent's instructions;
- `skills/<name>/SKILL.md` for every skill;
- `mcp-configs/<server>/config.yaml` with URL and transport only, since credentials are never exported;
- `PACKAGE.yaml`.

The complete workflow travels in `harnessConfig.openharness`, with every workspace reference described by name.
Multi-agent workflows therefore survive a round trip.

**Import** takes the zip as the `bundle` field. `merge_strategy` decides what happens when an agent with the same
vendor and agent key, or the same name, exists: `fail` answers 409 with its ID, `skip` returns it, and `overwrite`
replaces its definition in place. `rename_to` imports a copy under a new name and key. References are resolved by
name in this workspace. Anything missing is left out and listed in `warnings`. Bundles are limited to 500 files and
50 MB extracted; only text files are read, and paths that escape the package are refused.

## Tools

`GET /tools` lists `builtin.load_skill` and every discovered tool of the enabled MCP connections, machines
included, as `mcp.<connectionId>.<tool>`, with `source_id` and `input_schema`. `x-openharness` carries the server
name, the machine ID and MCP annotations. `POST /tools/{id}/invoke` calls one tool outside any run. It uses the same
MCP client, schema validation and machine gateway policy as agents, needs manage access (a workspace key or a studio
session), is rate limited, and is recorded in `tool_invocations`. `/invoke/stream` sends `progress`, `output`,
`error` and `done` events.

Custom tools are not registered through this API, because external tools are served over MCP here: `POST /tools`
answers 501. Built-in and MCP tools cannot be unregistered (409).

## Hooks, events and webhooks

Hooks are workspace-wide webhooks called at fixed points of every run.

| Event           | When                                                                  | The hook may answer                                                                                                              |
| --------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pre_tool`      | Before an MCP or machine tool call, from an agent or a workflow step. | `{"decision":"allow"}`, `{"decision":"deny","reason":"..."}`, or `{"decision":"modify","input":{...}}` to replace the arguments. |
| `post_tool`     | After the tool answered.                                              | `allow`, or `{"decision":"modify","output":"..."}` to replace what the agent sees.                                               |
| `stop`, `error` | When a run ends successfully, or unsuccessfully.                      | Nothing; these are notifications.                                                                                                |

A denied call reaches the agent as `Blocked by a hook: <reason>`, and the tool is never called. In a workflow tool
step, a denied call fails the run. Hooks run in registration order, and each `modify` feeds the next hook. Every
decision is recorded in the run trace as a `hook` event and in the event feed as `hook.triggered`.

- **Failure mode.** Set `x-openharness.fail_mode` to `closed` or `open`. A `closed` hook that times out or fails
  blocks the call. An `open` hook is skipped. Tool hooks default to `closed` and notifications to `open`.
  `x-openharness.timeout_ms` defaults to 10 seconds.
- **Handlers.** Only `webhook` handlers are accepted; `command` handlers answer 400, because the harness never runs
  shell commands for API callers. URLs must be HTTPS, unless the host is listed in `ALLOWED_PRIVATE_HOSTS`, and pass
  the same SSRF checks as MCP servers.
- **Signing.** Every request carries `X-OpenHarness-Timestamp` and
  `X-OpenHarness-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`, keyed with the secret that
  registration returns once in `x-openharness.secret`.

The **event feed** (`GET /events`, `GET /events/stream`) records these events for seven days:
`execution.started`, `execution.completed` (with `status` and `result_url`), `hook.triggered`, `skill.installed`
and `skill.uninstalled`. Stream ids sort by time. Pass `Last-Event-ID` to replay what a client missed, and
`?events=a,b` to filter.

**Webhooks** (`POST /webhooks` with `url`, `events`, and an optional `secret`) receive matching feed events through
a durable outbox. The payload has `id`, `event`, `harness_id`, the event's fields and `timestamp`, signed like
hooks. A failed delivery is retried after 1, 5, 30 and 120 minutes, then marked failed. Hooks, the feed and
webhooks need manage access: a workspace key or a studio session.

## Support

| Domain                                                            | Status    | Notes                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness registry                                                  | Supported | List, get, capabilities, health and validate-credentials. The registry is read-only (register, update and unregister return 501) because one installation serves one harness. `validate-credentials` tests a model API key against the workspace default provider. `store: true` saves it and needs a workspace key or a studio session. |
| Agents                                                            | Supported | Create (multipart or JSON), list, get, update, delete, clone, and OAF export and import with merge strategies.                                                                                                                                                                                                                           |
| Tools                                                             | Supported | List, get, invoke and invoke/stream for MCP and built-in tools. Registering custom tools returns 501; serve them over MCP.                                                                                                                                                                                                               |
| Execution                                                         | Supported | Execute, stream, list, get, attach with `Last-Event-ID`, cancel, result and tool calls. Artifacts and input come with issue #7.                                                                                                                                                                                                          |
| Hooks and events                                                  | Supported | `pre_tool`, `post_tool`, `stop` and `error` webhook hooks with allow, deny and modify; the event feed and its stream; signed webhooks with retries. `custom` hooks are accepted but never fired.                                                                                                                                         |
| Models                                                            | Supported | Multiple providers, and a per-execution `model` switch.                                                                                                                                                                                                                                                                                  |
| Skills, MCP servers, sessions, memory, subagents, files, planning | Planned   | See the roadmap issue #26.                                                                                                                                                                                                                                                                                                               |
| Conformance and diagnostics                                       | Planned   | Issue #16.                                                                                                                                                                                                                                                                                                                               |
