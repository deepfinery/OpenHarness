# API reference

All paths below start with `/api`. Requests and errors are JSON except document
uploads/downloads. Errors have the shape `{ "error": "message" }`. All resource
IDs are UUIDs. Unknown fields are removed by the input schemas.

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
They require a studio session and return only resources owned by that account.
PUT uses a complete resource definition. The list endpoints return the newest
500 resources. Delete fails with 409 while dependent resources still reference
the item.

| Collection    | Required fields                      | Optional fields                                                                                                                                        |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providers`   | `name`, `kind`, `baseUrl`, `model`   | `apiKey`, `embeddingModel`, `maxOutputTokens`, `outputTokenParameter` (`max_tokens` or `max_completion_tokens`)                                        |
| `connections` | `name`, `url`                        | `transport` (`http`/`sse`), `authType` (`none`/`token`/`oauth`), `token`, `tokenHeader`, `oauthClientId`, `oauthClientSecret`, `oauthScope`, `enabled` |
| `agents`      | `name`, `providerId`, `systemPrompt` | `description`, `connections`, `knowledgeBaseIds`, `maxTurns`, `timeoutSeconds`, `enabled`                                                              |
| `knowledge`   | `name`, `providerId`                 | `description`                                                                                                                                          |
| `workflows`   | `name`, `startAt`, `nodes`           | `description`, `enabled`, `schedule`                                                                                                                   |

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

| Method   | Path                          | Purpose                                                            |
| -------- | ----------------------------- | ------------------------------------------------------------------ |
| POST     | `/providers/:id/test`         | Runs a short chat request against the configured model.            |
| POST     | `/connections/:id/discover`   | Lists and persists the MCP server's tools.                         |
| POST     | `/connections/:id/oauth`      | Returns `authorizationUrl` or `authorized: true`.                  |
| GET      | `/mcp/oauth/callback`         | Browser OAuth callback, bound to local session and one-time state. |
| POST     | `/connections/:id/disconnect` | Removes stored MCP OAuth credentials and tool discovery.           |
| GET/POST | `/knowledge/:id/documents`    | List documents or upload one multipart `file`.                     |
| POST     | `/knowledge/:id/search`       | Search with `{ "query": "question" }`.                             |
| GET      | `/documents/:id/download`     | Download the owner's original file.                                |
| POST     | `/documents/:id/reindex`      | Queue a ready or failed document for reindexing.                   |
| DELETE   | `/documents/:id`              | Mark for asynchronous vector and filesystem deletion.              |

## Workflow definitions

```yaml
name: Research and summarize
enabled: true
startAt: research
nodes:
  - id: research
    name: Research
    type: agent
    agentId: AGENT_UUID
    prompt: '{{input}}'
    next: answer
  - id: answer
    name: Final response
    type: output
    template: '{{steps.research}}'
```

Nodes use stable local IDs. All nodes must be reachable from `startAt`; cycles
are rejected. Supported definitions:

| Type        | Fields                                                      |
| ----------- | ----------------------------------------------------------- |
| `agent`     | `agentId`, `prompt`, optional `next`                        |
| `tool`      | `connectionId`, `tool`, object `arguments`, optional `next` |
| `parallel`  | `agentIds` (up to 8), `prompt`, optional `next`             |
| `condition` | `value`, `operator`, `compare`, `onTrue`, `onFalse`         |
| `output`    | `template`                                                  |

Every node also has `id`, `name`, and optional `position: {x,y}`. Conditions use
`equals`, `notEquals`, `contains`, `truthy`, or `greaterThan`. A complete binding
such as `{{steps.query}}` preserves the underlying JSON value in tool arguments.
Embedded bindings such as `Result: {{last}}` render text. Missing values fail the
run explicitly.

An optional schedule is `{ "enabled": true, "everyMinutes": 60,
"input": "Run the daily research." }`. It begins after the next dispatcher poll.

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
messages. The browser playground supplies recent conversation history; runs
are otherwise independent. An `Idempotency-Key` header reuses the existing run
for an identical request. Reusing it for a different payload returns 409.

| Method   | Path                       | Access                                                           |
| -------- | -------------------------- | ---------------------------------------------------------------- |
| POST     | `/runs`                    | Session or API token with `execute` for the target; returns 202. |
| GET      | `/runs?page=0`             | Session or API token with `read`; 50 runs per page.              |
| GET      | `/runs/:id`                | Owner session, or the creating API token with `read`.            |
| POST     | `/runs/:id/cancel`         | Owner session, or the creating API token with `execute`.         |
| GET/POST | `/integrations/tokens`     | Session only; list/create a scoped API key.                      |
| DELETE   | `/integrations/tokens/:id` | Session only; revoke immediately.                                |
| GET/POST | `/integrations/embeds`     | Session only; list/create a scoped embed.                        |
| DELETE   | `/integrations/embeds/:id` | Session only; revoke immediately.                                |

Token creation: `name`, `agentIds`, `workflowIds`, `scopes` (`read`, `execute`),
and `expiresDays` (1–365). At least one target is required. The token is returned
once. Send `Authorization: Bearer ao_...` on subsequent requests.

Embed creation: `name`, exactly one target ID, `origins` (exact HTTP(S) origins),
and `expiresDays` (1–30). The returned URL contains a one-time-disclosed token in
its fragment. The embedded UI calls `/embed/:id`, `/embed/:id/runs`, and
`/embed/:id/runs/:runId` with `Authorization: Embed ...`. Visitors never receive
agent snapshots, tool arguments, retrieval sources, or execution traces through
these endpoints.

Run creation is bounded per account (`MAX_ACTIVE_RUNS`) and rate limited.
Authentication, provider tests, retrieval tests, and embeds also have request
limits. Use 429 responses to back off. External tools can have side effects;
cancellation stops future/in-flight work where possible but does not undo an
action already accepted by an external service.
