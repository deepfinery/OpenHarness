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

Workflows support agent, MCP tool, condition, parallel-agent, and output nodes.
The graph is acyclic; each agent has a separate bounded reasoning/tool loop.
All external tools use explicit MCP bindings. There is no arbitrary-code node.

## Data boundaries

Every resource has an `ownerId`. Studio users operate their own resources.
Administrators manage local accounts; they do not implicitly receive other
users' credentials. A run stores workflow and agent snapshots at submission;
credentials and provider connections are resolved from that owner's resources.

API keys are hashed, expiring capabilities with `read` and/or `execute` scopes
and explicit target IDs. They cannot manage studio resources, users, model
providers, or connections. Run reads through an API key are limited to that key's
runs. Embed capabilities are independently revocable and return only execution
status and the final output, without internal traces.

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
messages are persistent. A periodic dispatcher republishes unclaimed queued
work, including work accepted while the broker was unavailable. Workers
atomically claim jobs and heartbeat a lease; duplicate deliveries cannot claim
an active or terminal run.

The runner checkpoints node outputs and events. It never claims exactly-once
delivery to external services. When a worker dies mid-run, the expired lease
causes an `interrupted` terminal state rather than blind replay. Indexing jobs
can be retried because document vectors use deterministic IDs and partial
vectors are replaced. Documents being removed are immediately excluded from
retrieval and are deleted by a background job.

## Excluded surfaces

No provider-specific tool connectors or plugin catalogs, external UI OAuth,
website builders/renderers, wizards, reports, customers, product/service
catalogs, customer portals, billing, subscriptions, or managed-cloud storage
components are present in the standalone dependency graph or UI navigation.

Knowledge retrieval is a built-in context stage, not a second external connector.
Model inference is a provider adapter, not an agent tool. External tool calls
always go through MCP.
