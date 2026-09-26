# Open Harness conformance and API verification

OpenHarness tests against [the upstream Open Harness specification](https://github.com/jeffrschneider/OpenHarness), pinned to `f727de17dffe5adac4f54c7e87f3aae2afe7b864` (0.2.0). A fresh clone contains the Python adapter, TypeScript client/adapter, test fixtures, and isolated Compose configuration.

`BROWSER_TESTS=1 ./scripts/test-stack.sh` builds a new `openharness-test-*` project, runs unit tests, real-stack integration tests, the pinned pytest suite and browser tests, then removes only that isolated stack. CI publishes `test-results/conformance.xml`. Any failure in these suites fails CI. The integration suite exercises every advertised domain, including remote API features that the upstream adapter tests do not cover.

## Recorded upstream result

2026-09-26: **56 passed, 27 skipped, 2 deselected** using deterministic fixture model responses and actual MongoDB, RabbitMQ, runner and MCP transports. This verifies harness behavior; it does not evaluate model intelligence or imply independent certification.

| Coverage                                 | Verification                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution, SSE, tool events, agents, MCP | Pinned upstream suite and real HTTP integration tests                                                                                                                                  |
| Sessions, core memory, skill discovery   | Pinned upstream suite plus durable-turn, WebSocket, memory archive and versioning API tests                                                                                            |
| Files, subagents, planning, hooks        | Real-stack HTTP tests: tenant/harness isolation, file bytes and traversal, child execution/results/cancellation, live pending-plan edits, signed webhook delivery and lifecycle events |
| TypeScript adapter                       | Real HTTP execution, streaming, manifest, agent enumeration and file roundtrip                                                                                                         |
| Explorer and terminology                 | Browser checks on desktop/mobile, plus existing studio tests updated for Harnesses labels                                                                                              |

The 27 upstream skips are files (8), hooks (6), planning (7), and subagents (6): those tests use the upstream adapter's local callback, filesystem, todo-management or spawn conventions, rather than this service's HTTP contracts. Their remote API equivalents are tested in `tests/integration/openharness*.test.ts`; the Python adapter does not claim the incompatible local conventions. Two custom-tool registration tests are deselected because this project requires external tools to be served through MCP (the upstream tests also omit awaiting registration).

## Runtime diagnostics versus CI conformance

`POST /conformance/run` runs read-only route, manifest and storage checks, records their results and exposes an SSE replay. `/conformance/status` reports **partial**, never certified, because these are runtime protocol checks rather than the full upstream behavioral suite. `/diagnostics`, `/logs` and `/logs/stream` expose operational state without conversation bodies, tool arguments, credentials or stack traces.

The [generated support matrix](openharness-support.md) and [API guide](openharness-api.md) list operation availability and intentional limits, including MCP-only tools and hosted execution. They are the compatibility contract; a green protocol check alone is not proof that every optional feature in the upstream specification exists.

## Running separately

```sh
TEST_BASE_URL=http://localhost:18088 ./conformance/run.sh
# Against an already-running isolated test stack, with Node.js 22+:
TEST_BASE_URL=http://localhost:18088 node --import tsx --test --test-concurrency=1 tests/integration/openharness*.test.ts
```

The Python adapter can be installed from `conformance/adapter` with the pinned upstream Python package. Configure `OPENHARNESS_URL`, `OPENHARNESS_API_KEY`, and optionally `OPENHARNESS_HARNESS_ID` and `OPENHARNESS_AGENT_ID`. The TypeScript adapter is in `packages/openharness-client`; API keys are supplied by the caller and never bundled.
