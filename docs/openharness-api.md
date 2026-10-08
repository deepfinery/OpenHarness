# Open Harness API

OpenHarness implements the [Open Harness API](https://github.com/jeffrschneider/OpenHarness), pinned to spec 0.2.0 at `f727de17dffe5adac4f54c7e87f3aae2afe7b864`. The [vendored contract](spec/openharness.mapi.md) generates request schemas for the authenticated OpenAPI document. The [support matrix](openharness-support.md) is generated from the same operation registry that mounts the API.

## Harnesses and agents

A **harness** is a saved visual graph, formerly called a workflow. Its ID, resources, schedules, conversations, and execution history are preserved. The studio uses `/harnesses`; legacy `/workflows` links still open it. Both `/api/harnesses` and `/api/workflows` address the same records.

`GET /openharness/v1/harnesses` lists saved harnesses accessible to the caller. `/harnesses/{harnessId}/agents` addresses the agent cards inside that graph. Execute without `agent_id` to run the graph, or select a card's node ID to run that agent with its bound resources. Selecting one agent creates an execution snapshot; it does not change the saved graph.

For older integrations, `OPENHARNESS_HARNESS_ID` (default `openharness`) remains a workspace-wide compatibility alias. Beneath that alias, legacy agent IDs refer to whole saved graphs. New clients should list harnesses and use their IDs.

## Authentication and explorer

The default base path is `/openharness/v1`, configurable with `OPENHARNESS_BASE_PATH`. Open **Integrations → API explorer** for searchable endpoints, request schemas, editable JSON, multipart uploads, cURL examples, streamed results, and file downloads. Download `GET /openapi.json` from the explorer to import into OpenAPI tools.

Send `Authorization: Bearer <key>`:

- Workspace keys (`oh_sk_…`, `harness` scope) manage the workspace. Administrators create them under Integrations → API key → Whole workspace.
- Target keys (`ao_…`) retain their existing read/execute scopes and harness grants. They cannot manage configuration or enumerate shared MCP/skill/file resources. Executions are also restricted to the issuing key.
- Same-origin studio cookies work. Writes require a matching `Origin`; cross-origin access requires bearer authentication. WebSocket cookie authentication likewise requires the studio origin.

Providers, skills, MCP connections, and hook subscriptions are workspace resources. Files belong to a harness; sessions, executions, agent memory and child agents are scoped to their harness and tenant. API keys entered into the explorer are held in page memory, not persisted in browser storage.

## Examples

```sh
export OH_URL=http://localhost:8088/openharness/v1
# Obtain a workspace key in Integrations; do not commit it.
curl -H "Authorization: Bearer $OH_KEY" "$OH_URL/harnesses"
curl -H "Authorization: Bearer $OH_KEY" "$OH_URL/harnesses/$HARNESS_ID/agents"
curl -N -H "Authorization: Bearer $OH_KEY" -H 'Content-Type: application/json' \
  -d '{"message":"Summarize the latest incident notes"}' \
  "$OH_URL/harnesses/$HARNESS_ID/execute/stream"
```

The dependency-free [JavaScript/TypeScript client](../packages/openharness-client) uses operation IDs from OpenAPI and supports JSON, multipart, raw files and streaming responses. The [Python adapter](../conformance/adapter) implements the pinned upstream adapter interface for conformance testing.

## Domain behavior

| Domain                      | Behavior                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harnesses and agents        | Harness CRUD; agent cards, OAF import/export/clone, per-agent execution. Imports resolve configured models, skills and MCP references. Exported MCP URLs redact credentials. Remote SDK/IDE process launching is not supported.                                                                             |
| Execution                   | Async creation, SSE, cancellation, results, tool traces, human input and artifacts. `model`, `skills`, `system_prompt`, `session_id` and the `x-openharness.machine_id` and `x-openharness.timezone` (caller's IANA zone for the runtime clock) extensions are supported. Idempotency keys protect retries. |
| MCP and tools               | HTTP/SSE server CRUD, discovery, tools, resources, prompts, health, invocation and streaming. External tools must be served over MCP. Direct custom-code tool registration and spawning host stdio processes are intentionally unavailable. OAuth authorization happens in the studio.                      |
| Skills                      | `SKILL.md` bundles, supporting text files, validation, discovery in harness workspace paths, downloads, immutable version snapshots, upgrades and rollback. Studio edits also create versions.                                                                                                              |
| Sessions                    | Durable serialized turns, history, fork, pause/resume/end, synchronous messages, SSE and authenticated WebSockets. History retains 100 messages; model prompts use the latest 20. Ended sessions cannot resume.                                                                                             |
| Memory                      | Per-agent core blocks, read-only enforcement, archival notes, search, ZIP export/import. Runtime tools read/write core blocks, which are retrieved as untrusted reference data. Embedding providers enable configured vector storage; otherwise search falls back to keywords.                              |
| Subagents                   | Spawn a child from the parent configuration, delegate, stream, read results and terminate. Children inherit tools, knowledge and safety policies, cannot recursively delegate, and have a maximum 30,000-token budget per task. Child runs expose parent/harness identifiers.                               |
| Files                       | Harness-scoped file and directory CRUD, binary uploads/downloads, batches and search. Runtime `workspace_list`, `workspace_read` and `workspace_write` share the same workspace. Uploaded files are served with a sandboxed content policy.                                                                 |
| Planning                    | Durable plans and tasks for plan-execute agents. API edits to pending steps affect subsequent runner execution. Running/completed steps cannot be rewritten. Completed outputs survive resume.                                                                                                              |
| Hooks                       | Shared lifecycle events, replayable streams and bounded signed HTTP webhook delivery. Local Python callbacks are not a remote API feature.                                                                                                                                                                  |
| Diagnostics and conformance | Redacted execution-state logs, streaming logs, runtime diagnostics, persisted read-only protocol checks and SSE results. Status is explicitly partial; this endpoint does not certify behavioral conformance. CI runs the pinned upstream suite and real-stack tests.                                       |

## Limits and compatibility

Messages are bounded to 32,000 characters. Context compaction, provider output limits, active-run quotas and agent budgets still apply. The pinned spec's `temperature` and `max_tokens` overrides are accepted for older clients but do not override the configured runtime budgets; capability limitations report this. Agent manifests may contain unsupported fields: imports report warnings rather than silently granting extra capabilities.

Skill bundles and file uploads are limited to 10 MiB and 100 files; downloads to 50 MiB. Files are stored separately from the host filesystem. File paths reject traversal. Search uses RE2 regular expressions (no backreferences/lookaround) and bounds scanned content to 50 MiB. Core memory has at most 50 blocks per agent and a 12,000-character prompt allowance. Archived content uses the configured embedding provider; changing that provider requires reindexing old entries.

Errors use `{ "error": { "code", "message", "domain", "operation", "details" } }`. Pagination uses `limit` (1–100) and `offset`. Unsupported configurations return structured errors. A mounted route is not a promise that every optional transport or local-process behavior is supported; inspect the capability manifest and generated matrix.

Execution SSE uses `text`, `tool_call_start`, `tool_call_end`, `tool_result`, `progress`, `error`, and terminal `done`. `Last-Event-ID` resumes a replay stream. Terminal streams remain available for one hour; results remain readable afterward. Session WebSockets use the spec's `message`/`stdin`/`cancel` inputs and `text`/`tool_call`/`stdout`/`stderr`/`prompt`/`error`/`done` outputs, with ping/pong health checks. A synchronous session request that reaches a human pause returns `INPUT_REQUIRED` with the execution ID so the client can answer it.
