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

## Support

| Domain                                                                   | Status    | Notes                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness registry                                                         | Supported | List, get, capabilities, health and validate-credentials. The registry is read-only (register, update and unregister return 501) because one installation serves one harness. `validate-credentials` tests a model API key against the workspace default provider. `store: true` saves it and needs a workspace key or a studio session. |
| Agents, tools, execution                                                 | Planned   | Issues #3, #4, #5, #6 and #7.                                                                                                                                                                                                                                                                                                            |
| Skills, MCP servers, sessions, memory, subagents, files, hooks, planning | Planned   | See the roadmap issue #26.                                                                                                                                                                                                                                                                                                               |
| Conformance and diagnostics                                              | Planned   | Issue #16.                                                                                                                                                                                                                                                                                                                               |
