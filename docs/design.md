# Design notes

The studio, API, runner, and shared execution core form one self-contained
application. Docker builds use only this repository as their context. MongoDB,
RabbitMQ, Weaviate, and uploaded files use dedicated installation volumes.

## Components

| Component       | Responsibility                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `apps/studio`   | Agent configuration, visual workflow canvas, playground, knowledge, profile, and integrations. |
| `apps/api`      | Local authentication, resource APIs, scheduler, durable submission, and static UI hosting.     |
| `apps/runner`   | Queued agent/workflow execution, document ingestion, and deletion.                             |
| `packages/core` | Schemas, model adapters, MCP/OAuth, retrieval, storage, and execution semantics.               |

Harness workflows have explicit Start and Finish nodes, agents, MCP actions,
conditions, and parallel-agent steps. Control edges determine execution order.
Separate resource edges attach MCP tool permissions or knowledge bases to
individual agents. An agent can be configured inline or reference a reusable
agent. Templates use inline configurations so they need no separate agent setup.
At submission, resource bindings are compiled into per-node agent snapshots;
editing a workflow afterwards cannot change the accepted graph or its tool grants.

Cycles are allowed only in explicit harness graphs, with a path to Finish and
an execution budget of 1–500 steps. Agent reasoning/tool loops have separate
budgets set by the agent's effort level (light, medium, high, extra high, max,
or auto, which resolves a level per request): model turns per pass, a total
token budget (from provider usage reports, or estimated), and a time limit; the
worker also enforces a 30-minute run limit. A spent token budget ends with one
tool-less call for the final answer rather than an error. Before every model
call the dialog is compacted to the provider's context window (older tool
results first, then completed turns), and a provider context-length error is
parsed, remembered on the provider, and retried once compacted. Legacy graphs
remain compatible. There is no arbitrary-code node.

## Data boundaries

Every user has a `tenantId`. The storage field `ownerId` identifies that tenant's
workspace for compatibility with existing installations. Teammates share
resources, document access, and execution history within that tenant. All
reference validation, credential lookup, file access and retrieval queries
include that boundary. Administrators manage their tenant's users; members
cannot manage accounts. API-created isolated workspaces have separate admins.

Legacy accounts are migrated to tenant IDs matching their original user IDs,
preserving private resource ownership rather than silently sharing credentials.
Provider and MCP secrets remain write-only for every role. Runs record the
initiating user and trigger; workflow saves include a revision precondition to
prevent silent overwrites when two people edit the same saved version.

API keys are hashed, expiring capabilities with `read` and/or `execute` scopes
and explicit target IDs. They cannot manage studio resources, users, model
providers, or connections. Run reads through an API key are limited to that key's
runs. Embed capabilities are independently revocable and return only execution
status and the final output, without internal traces. Webhook capabilities are
hashed, expiring, target-scoped and use the same queued execution path. The raw
JSON event remains available to template bindings. Webhook polling reveals only
runs created through that webhook. Disabling a capability's creator invalidates
its API keys, webhooks and embeds.

Conversational API turns reserve one pending run per conversation atomically.
Successful turns append bounded server-side history; failed or cancelled turns
release the reservation without adding a fabricated answer. Terminal runs can
settle conversations after a worker interruption. Conversation access is scoped
to the initiating user or API key; it does not create a private run-history
boundary within the shared workspace.

## Secrets and remote endpoints

User passwords use salted scrypt hashes. Session and integration tokens are
stored as SHA-256 hashes. Provider keys, MCP tokens, OAuth clients, PKCE verifiers
and refresh/access tokens are protected with AES-256-GCM. A unique installation
key is generated in `.env`.

Remote HTTP endpoints are validated; connection-time DNS resolution is checked
again before the socket connects. Private addresses require a configured host
allowlist. Cloud metadata addresses are prohibited. Redirects are not followed:
configure the final MCP or provider URL. Loopback is intentionally available only
through a trusted configured hostname such as `host.docker.internal`.

MCP uses the official TypeScript SDK for transport, negotiation, paginated tool
discovery, OAuth discovery, PKCE, token exchange and refresh. OAuth callback state
is short-lived, single-use, and bound to the exact local user session. No MCP
token is treated as an application login.

## Queue semantics

MongoDB is the durable submission record. RabbitMQ publishes are confirmed and
messages are persistent and carry a run/document correlation ID. A periodic dispatcher republishes unclaimed queued
work, including work accepted while the broker was unavailable. Workers
atomically claim jobs and heartbeat a lease; duplicate deliveries cannot claim
an active or terminal run.

The runner writes a checkpoint (cursor, previous result, step count, per-step
attempts) before each workflow step and the step's output after it. It never
claims exactly-once delivery to external services. When a worker dies mid-run,
the expired lease is handled by the workflow's `resumePolicy`: `safe` (default)
re-queues the run so a replacement runner continues at the cursor, unless the
step in flight could have acted externally (an MCP action, an Email step, or an
agent with tools), in which case the run becomes `interrupted` with the reason;
`always` resumes regardless; `never` always interrupts. `MAX_RESUMES` bounds
automatic resumes. Every MCP call carries `_meta.idempotencyKey`
(`runId:nodeId:call`) so deduplicating servers can neutralize a replay.
Indexing jobs can be retried because document vectors use deterministic IDs and
partial vectors are replaced. Documents being removed are immediately excluded
from retrieval and are deleted by a background job.

Model responses stream by default; the runner buffers deltas into the run's
`partial` field a few times a second and clears it when the answer is final. The
API exposes the run through `GET /runs/:id/stream` as server-sent events.

## Storage and portability

MongoDB is the only database. The orchestrator uses the `agentic` database (`MONGODB_DATABASE`); the device
gateway uses its own `agentic_gateway` database on the same server. (These names, the MongoDB/RabbitMQ user
`agentic`, the queue names and the session cookie predate the OpenHarness rename and are kept so existing
installations keep their data and sessions.) Weaviate holds knowledge vectors and
RabbitMQ holds queue messages, but neither is a system of record: runs, documents and settings live in MongoDB.

Moving to PostgreSQL later:

- **Gateway** — already behind two interfaces (`Registry`, `AuditStore` in `gateway/src/registry.ts`). A
  PostgreSQL port is one new file implementing them plus a switch in `createStorage`; the tests run the same
  suite against the in-memory implementation.
- **Orchestrator** — code reaches MongoDB through `collection()` from `packages/core/src/db.ts` in about a
  dozen modules (heaviest: `apps/api/src/resources.ts`, `app.ts`, `triggers.ts`, `packages/core/src/runs.ts`).
  The queries are simple — lookups by id and owner, `$set`/`$unset`/`$inc` updates, capped `$push` for run
  events — and the correctness-critical parts are a handful of atomic compare-and-set updates (run leases,
  conversation turn reservation, schedule dispatch, idempotency keys). A port would introduce a repository per
  collection with those operations as named methods, then implement them with `UPDATE … WHERE … RETURNING`
  transactions. New code should keep MongoDB-specific queries inside `packages/core` so that layer stays thin.

## Excluded surfaces

No provider-specific tool connectors or plugin catalogs, external UI OAuth,
website builders/renderers, business wizards, reports, customers, product/service
catalogs, customer portals, billing, subscriptions, or managed-cloud storage
components are present in the standalone dependency graph or UI navigation.

Knowledge retrieval is a built-in context stage, not a second external connector.
Model inference is a provider adapter, not an agent tool. External tool calls
always go through MCP.
