# API reference

All paths below start with `/api`. The [Open Harness API](openharness-api.md) adapter is documented separately. Requests and errors are JSON except document
uploads/downloads. Errors have the shape `{ "error": "message" }`. Stored resource
IDs are UUIDs; workflow node/resource IDs are local names. Unknown fields are removed by the input schemas.

## Local accounts and sessions

| Method   | Path           | Purpose                                                                          |
| -------- | -------------- | -------------------------------------------------------------------------------- |
| GET      | `/auth/status` | Returns `needsSetup` and the configured public URL.                              |
| POST     | `/auth/setup`  | First administrator only: `name`, `email`, `password`, `setupToken`.             |
| POST     | `/auth/login`  | `email`, `password`; sets an HttpOnly session cookie.                            |
| GET      | `/auth/me`     | Current local user.                                                              |
| POST     | `/auth/logout` | Invalidates the current session.                                                 |
| PUT      | `/profile`     | `name`, `email`, optional `currentPassword` and `newPassword`.                   |
| GET/POST | `/users`       | Administrator list/create accounts. Create: `name`, `email`, `password`, `role`. |
| PATCH    | `/users/:id`   | Administrator changes `enabled` or `newPassword`.                                |

Passwords require 12–256 characters. Sessions expire after seven days. Password
changes revoke prior sessions. Cookie-authenticated writes require an `Origin`
header matching `PUBLIC_URL`; browser clients supply it automatically. Use a
scoped bearer API key for application integrations.

## Studio resources

The following collections provide `GET /collection`, `POST /collection`,
`GET /collection/:id`, `PUT /collection/:id`, and `DELETE /collection/:id`.
They require a studio session and return only resources in that user's tenant.
PUT uses a complete resource definition. The list endpoints return the newest
500 resources. Delete fails with 409 while dependent resources still reference
the item. Responses include a `revision`. Supply `If-Match: <revision>` on PUT
for optimistic concurrency; a stale version returns 409. The canvas always
uses this precondition. Legacy resources without revisions use `If-Match: 0`.

| Collection    | Required fields                       | Optional fields                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`   | `name`, `kind`, `baseUrl`, `model`    | `apiKey`, `embeddingModel`, `maxOutputTokens`, `contextWindow` (tokens, default 128000; updated automatically from provider limit errors), `outputTokenParameter` (`max_tokens` or `max_completion_tokens`), `streaming` (default `true`)                                                       |
| `connections` | `name`, `url`                         | `transport` (`http`/`sse`), `authType` (`none`/`token`/`oauth`), `token`, `tokenHeader`, `oauthClientId`, `oauthClientSecret`, `oauthScope`, `enabled`                                                                                                                                          |
| `agents`      | `name`, `providerId`, `systemPrompt`  | `description`, `connections`, `knowledgeBaseIds`, `maxTurns`, `timeoutSeconds`, `tokenBudget`, `pattern`, `patternConfig`, `effort` (`light`/`medium`/`high`/`extra-high`/`max`/`auto`), `enabled`. The studio configures agents inline on workflow cards; this collection remains for API use. |
| `knowledge`   | `name`, `providerId`                  | `description`                                                                                                                                                                                                                                                                                   |
| `skills`      | `name`, `description`, `instructions` | `enabled`. Referenced by agents through `skillIds`; delete fails with 409 while in use.                                                                                                                                                                                                         |
| `workflows`   | `name`, `startAt`, `nodes`            | `description`, `enabled`, `schedule`, `resources`, `bindings`, `maxSteps`, `resumePolicy` (`safe`/`always`/`never`)                                                                                                                                                                             |

Agent `pattern` is one of `react` (default), `plan-execute`, `reflection`, or `loop`.
`patternConfig` holds `maxPlanSteps` (1–8), `reflections` (1–3), `iterations` (1–10), and
`doneMarker`; unused fields are ignored. Agents take `skillIds` (up to 20 workspace skills). The server snapshots them into the run; the model sees their names and descriptions and loads one through the built-in `load_skill` tool (`skill_loaded` trace event). A client-supplied `skills` field is ignored.
`effort` selects loop and token budget presets
(light 4 turns/30k tokens, medium 12/120k, high 24/400k, extra-high 36/1M, max 40/5M).
For a fixed level the stored `maxTurns`, `timeoutSeconds`, `patternConfig` and
`tokenBudget` (default: the preset) are what the runner enforces; `auto` resolves a
level per request and applies that preset, recorded as an `effort` trace event.
When the token budget is spent the agent gets one final tool-less call
(`budget_exhausted` event).

Secret fields are write-only. Omit them on PUT to preserve an existing secret;
an explicit empty string clears it. Responses expose `hasApiKey`, `hasToken`,
`hasClientSecret`, or `authorized` flags instead of the encrypted values.

Agent MCP bindings are explicit:

```json
{
  "connections": [{ "connectionId": "MCP_CONNECTION_UUID", "tools": ["search", "read_document"] }]
}
```

Discover tools before selecting them. Empty lists grant no tool permissions.

| Method   | Path                          | Purpose                                                                                                               |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| POST     | `/providers/test-config`      | Tests an unsaved provider body (chat, and embeddings when `embeddingModel` is set); `providerId` reuses a stored key. |
| POST     | `/providers/:id/test`         | Runs a short chat request against the configured model.                                                               |
| GET/PUT  | `/settings/email`             | Workspace SMTP settings (PUT is administrator-only; `password` is write-only).                                        |
| DELETE   | `/settings/email`             | Removes workspace SMTP settings, falling back to `.env` defaults.                                                     |
| POST     | `/settings/email/test`        | Sends a test email to `{ "to": "address" }` (administrator-only).                                                     |
| POST     | `/connections/:id/discover`   | Lists and persists the MCP server's tools.                                                                            |
| POST     | `/connections/:id/oauth`      | Returns `authorizationUrl` or `authorized: true`.                                                                     |
| GET      | `/mcp/oauth/callback`         | Browser OAuth callback, bound to local session and one-time state.                                                    |
| POST     | `/connections/:id/disconnect` | Removes stored MCP OAuth credentials and tool discovery.                                                              |
| GET/POST | `/knowledge/:id/documents`    | List documents or upload one multipart `file`.                                                                        |
| POST     | `/knowledge/:id/notes`        | Create a Markdown note: `{ "title", "content" }`; stored as `<title>.md` with `kind: "note"` and queued for indexing. |
| GET      | `/documents/:id/content`      | Text of a TXT/MD/CSV/JSON/YAML document (≤ 2 MB) for editing.                                                         |
| PUT      | `/documents/:id`              | Replace a text document's `content` (and optionally `title`); re-indexes. 409 while it is being indexed.              |
| POST     | `/knowledge/:id/search`       | Search with `{ "query": "question" }`.                                                                                |
| GET      | `/documents/:id/download`     | Download the owner's original file.                                                                                   |
| POST     | `/documents/:id/reindex`      | Queue a ready or failed document for reindexing.                                                                      |
| DELETE   | `/documents/:id`              | Mark for asynchronous vector and filesystem deletion.                                                                 |

## Workflow definitions

```yaml
name: MCP research assistant
enabled: true
startAt: start
maxSteps: 100
nodes:
  - id: start
    name: Start
    type: start
    next: researcher
  - id: researcher
    name: Researcher
    type: agent
    config:
      name: Researcher
      providerId: PROVIDER_UUID
      systemPrompt: Use the selected tools to research the question and verify the results.
    prompt: '{{input}}'
    next: finish
  - id: finish
    name: Finish
    type: finish
    template: '{{last}}'
resources:
  - id: research_tools
    name: Research tools
    type: mcp
    connectionId: MCP_CONNECTION_UUID
    tools: [search, read_document]
bindings:
  - agentNodeId: researcher
    resourceId: research_tools
```

Nodes use stable local IDs (letters, numbers, `_` and `-`, beginning with a
letter, maximum 64 characters). All nodes must be reachable from `startAt`.
An explicit harness has exactly one Start at the entry and at least one Finish;
every step needs a possible path to Finish. Cycles are permitted with a bounded
`maxSteps` (default 100, maximum 500). Exhaustion fails the run. Execution cannot
return to Start. Legacy graphs without Start keep their acyclic validation.

| Type        | Fields                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`     | `next`                                                                                                                                                                       |
| `agent`     | Exactly one of `agentId` or inline `config` (agent definition), `prompt`, `next`                                                                                             |
| `tool`      | `connectionId`, `tool`, object `arguments`, `next`                                                                                                                           |
| `parallel`  | `agentNodeIds` (agent cards in this workflow) and/or legacy `agentIds` (saved agents), up to 8 in total, `prompt`, `next`. Member cards need no place in the execution path. |
| `email`     | `to` (comma-separated templates), `subject`, `body`, `next`; sent via SMTP settings                                                                                          |
| `condition` | `value`, `operator`, `compare`, `onTrue`, `onFalse`                                                                                                                          |
| `finish`    | `template`                                                                                                                                                                   |
| `output`    | Legacy alias for Finish                                                                                                                                                      |

Every node has `id`, `name`, and optional `position: {x,y}`. Resources use
`type: mcp`, `connectionId`, and a nonempty `tools` selection, or
`type: knowledge` and `knowledgeBaseId`, plus the same ID/name/position fields.
`bindings` grant resources to an agent; they never advance the execution path.
Every resource must be attached to an agent. One resource may serve several
agents, and an agent may attach multiple MCP connections or knowledge bases.
The server validates all references and discovered tool names within the tenant.

Conditions use `equals`, `notEquals`, `contains`, `truthy`, or `greaterThan`.
A complete binding such as `{{steps.query}}` preserves the underlying JSON value
in tool arguments. Embedded bindings such as `Result: {{last}}` render text.
`{{payload.event.id}}` accesses structured API/webhook payloads. Missing values
fail the run explicitly. Resource cards cannot be used as control targets; explicit MCP action steps can.

An optional schedule is `{ "enabled": true, "everyMinutes": 60,
"input": "Run the research." }`. Interval schedules begin after the next dispatcher
poll. For `everyMinutes` of 1440 or more, add `at: "HH:MM"` and `timezone` (an IANA
name such as `Europe/Berlin`) to fire at that wall-clock time; `everyMinutes: 10080`
with `weekday` (0 = Sunday … 6 = Saturday) fires weekly. Each slot is deduplicated
with a `scheduleKey`, and the resource exposes `nextRunAt` and `lastScheduleError`.

## Runs and integrations

Create run:

```json
{
  "agentId": "AGENT_UUID",
  "input": "What changed?",
  "history": [
    { "role": "user", "content": "Previous question" },
    { "role": "assistant", "content": "Previous answer" }
  ]
}
```

Specify exactly one of `agentId` and `workflowId`. History is optional, up to 20
messages. These runs are independent; use `/chat` for server-managed history.
An optional `payload` object exposes structured fields to workflow templates. An `Idempotency-Key` header reuses the existing run
for an identical request. Reusing it for a different payload returns 409.

| Method   | Path                              | Access                                                                                                                                               |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/runs`                           | Session or API token with `execute` for the target; returns 202.                                                                                     |
| GET      | `/runs?page=0`                    | Session or API token with `read`; 50 runs per page.                                                                                                  |
| GET      | `/runs/:id`                       | Tenant session, or the creating API token with `read`.                                                                                               |
| GET      | `/runs/:id/stream`                | Server-sent events (`event: run`) with the same body as `/runs/:id` on every change, including `partial` streamed text; closes on a terminal status. |
| POST     | `/runs/:id/feedback`              | `rating` (`up`/`down`) and optional `comment` on a finished run. With learning on, it becomes a lesson.                                              |
| GET      | `/workflows/:id/experience.jsonl` | Session only. Runs with feedback or lessons, as JSON Lines.                                                                                          |
| POST     | `/runs/:id/cancel`                | Tenant session, or the creating API token with `execute`.                                                                                            |
| GET/POST | `/integrations/tokens`            | Session only; list/create a scoped API key.                                                                                                          |
| DELETE   | `/integrations/tokens/:id`        | Session only; revoke immediately.                                                                                                                    |
| GET/POST | `/integrations/embeds`            | Session only; list/create a scoped embed.                                                                                                            |
| DELETE   | `/integrations/embeds/:id`        | Session only; revoke immediately.                                                                                                                    |

Token creation: `name`, `agentIds`, `workflowIds`, `scopes` (`read`, `execute`),
and `expiresDays` (1–365). At least one target is required. The token is returned
once. Send `Authorization: Bearer ao_...` on subsequent requests.

Administrators can instead create a workspace key with `scopes: ["harness"]` and no
targets. It is returned as `oh_sk_...`, has full access through the
[Open Harness API](openharness-api.md), and has read and execute access on `/api`.

Embed creation: `name`, exactly one target ID, `origins` (exact HTTP(S) origins),
and `expiresDays` (1–30). The returned URL contains a one-time-disclosed token in
its fragment. The embedded UI calls `/embed/:id`, `/embed/:id/runs`, and
`/embed/:id/runs/:runId` with `Authorization: Embed ...`. Visitors never receive
agent snapshots, tool arguments, retrieval sources, or execution traces through
these endpoints.

Run creation is bounded per tenant (`MAX_ACTIVE_RUNS`) and rate limited.
Authentication, provider tests, retrieval tests, and embeds also have request
limits. Use 429 responses to back off. External tools can have side effects;
cancellation stops future/in-flight work where possible but does not undo an
action already accepted by an external service.

## Machines

Requires a configured gateway (`GATEWAY_URL`, `GATEWAY_API_TOKEN`, `GATEWAY_ADMIN_TOKEN`). Machines are
scoped to the tenant; each has a mirrored `connections` record with `kind: "device"` that only this API
manages.

| Method | Path                        | Purpose                                                                                                                            |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/devices`                  | `{ configured, publicUrl, machines[], catalog }` — live status from the gateway; tools are discovered when a machine comes online. |
| POST   | `/devices`                  | Enroll `{ name, platform: linux                                                                                                    | windows | chrome, deviceId?, allowedTools[] }`→`{ machine, token, connectUrl, install }`. The token is shown once. |
| PUT    | `/devices/:id`              | `{ name?, allowedTools?, disabled? }`; the allow-list is enforced by the gateway.                                                  |
| POST   | `/devices/:id/rotate-token` | New one-time token; the connector is disconnected until reconfigured.                                                              |
| POST   | `/devices/sync`             | Re-read the gateway and refresh tool lists.                                                                                        |
| DELETE | `/devices/:id`              | Remove the machine (409 while a workflow references it).                                                                           |

`POST /runs` and `POST /chat` accept `"deviceId"`: every agent in the run receives the machine's tools and an
instruction naming it; the run records `device`, and a conversation remembers its machine (send `null` to drop it).
The wire protocol between connectors and the gateway is in [PROTOCOL.md](PROTOCOL.md).

## Tenant membership

`GET /tenant` returns the current tenant's ID, name, member count and
`defaultProviderId` — the model provider new agents start with (the chosen one, or
the oldest provider when none is chosen or the chosen one was deleted). An
administrator can rename the workspace with `PUT /tenant {"name":"Research team"}`
or choose the default with `PUT /tenant {"defaultProviderId":"PROVIDER_UUID"}`
(`null` clears it).
`/users` lists only the current tenant; creating a user defaults to the same
tenant. A member cannot manage users. Account updates are limited to the admin's
tenant and invalidate that user's sessions when access/password changes.

To provision an isolated workspace through the admin API, supply
`"workspace":"new"` in `POST /users`. The new user becomes its administrator;
the requesting administrator does not join the new tenant. Emails are unique
across the installation. Existing accounts retain their original private tenants
on upgrade. Resources, runs and credentials are never implicitly transferred.

## Conversational API

With a session or a target-scoped bearer API key, submit:

```json
{ "workflowId": "WORKFLOW_UUID", "message": "Research this topic." }
```

`POST /chat` returns `202 { "id": "RUN_UUID", "runId": "RUN_UUID",
"conversationId": "CONVERSATION_UUID", "status": "queued" }`. Use `agentId`
instead for an agent. Poll `/runs/:id` as usual. The next turn sends:

```json
{ "conversationId": "CONVERSATION_UUID", "message": "Which sources support that?" }
```

The target cannot change. Only the initiating user or API key can continue or
read the conversation. `GET /conversations/:id` returns its successful user and
assistant messages (last 20) and `activeRunId` if a turn is pending.
`GET /conversations?agentId=…` (or `workflowId=…`) lists the caller's
conversations for that target, newest first, with a `title` taken from the first
message; `DELETE /conversations/:id` removes one. Run history is unaffected. A second
concurrent turn receives 409. Failed/cancelled turns are omitted from memory.
`/chat` does not accept `Idempotency-Key`; use one turn at a time and retain its
returned IDs. API keys require `execute` to submit and `read` to poll.
Conversation privacy does not restrict the tenant's shared execution history.

Cross-origin browser clients may send bearer requests; CORS allows Authorization,
Content-Type, and Idempotency-Key. Cookie credentials are never enabled by CORS.
Do not put a privileged studio session or a broadly scoped API key in public code.

## Webhook triggers

Session-only management:

- `GET /integrations/webhooks`: list this tenant's webhook metadata.
- `POST /integrations/webhooks`: `name`, exactly one `agentId` or `workflowId`,
  optional `inputPath` (dot-separated JSON field), and `expiresDays` (1–365).
  Returns `id`, `url`, and a one-time `secret`.
- `DELETE /integrations/webhooks/:id`: revoke the capability.

Send `POST /hooks/:id` with `Authorization: Bearer <secret>` and a JSON object.
With `inputPath: "event.message"`, that field becomes the run input; missing
fields return 400. Without a path, the `input` field is used, or the entire JSON
object if absent. The full event is always available as `payload`. Non-string
input values are serialized as JSON. The response is 202 with the queued run ID.

An optional `Idempotency-Key` deduplicates identical events for this webhook;
reuse with a different body returns 409. Poll `GET /hooks/:id/runs/:runId` with
the same secret. It returns only status/output and a generic failure message,
and cannot access other webhooks' runs. Secrets are hashed, expiring, revocable,
and bound to an enabled creator. Webhooks accept up to 60 submissions per minute.
