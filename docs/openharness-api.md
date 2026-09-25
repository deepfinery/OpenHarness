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

## Support

| Domain                                                                   | Status    | Notes                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness registry                                                         | Supported | List, get, capabilities, health and validate-credentials. The registry is read-only (register, update and unregister return 501) because one installation serves one harness. `validate-credentials` tests a model API key against the workspace default provider. `store: true` saves it and needs a workspace key or a studio session. |
| Execution                                                                | Supported | Execute, stream, list, get, attach with `Last-Event-ID`, cancel, result and tool calls. Artifacts and input come with issue #7.                                                                                                                                                                                                          |
| Models                                                                   | Supported | Multiple providers, and a per-execution `model` switch.                                                                                                                                                                                                                                                                                  |
| Agents, tools                                                            | Planned   | Issues #3 and #4.                                                                                                                                                                                                                                                                                                                        |
| Skills, MCP servers, sessions, memory, subagents, files, hooks, planning | Planned   | See the roadmap issue #26.                                                                                                                                                                                                                                                                                                               |
| Conformance and diagnostics                                              | Planned   | Issue #16.                                                                                                                                                                                                                                                                                                                               |
