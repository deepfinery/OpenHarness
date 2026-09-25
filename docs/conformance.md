# Open Harness conformance

OpenHarness runs the [Open Harness](https://github.com/jeffrschneider/OpenHarness) conformance suite in CI. The
suite is pinned to upstream commit `f727de1` and drives the harness through the adapter in `conformance/adapter`.
That adapter is a thin Python client that implements the spec's `HarnessAdapter` over the `/openharness/v1` HTTP
API. Other clients can use it too:

```sh
pip install ./conformance/adapter   # needs the spec's `openharness` Python package
export OPENHARNESS_URL=https://studio.example.com/openharness/v1
export OPENHARNESS_API_KEY=oh_sk_...   # a workspace key from Integrations → API key
export OPENHARNESS_AGENT_ID=...        # optional: the agent (workflow) used when a request names none
```

`conformance/run.sh` downloads the pinned suite and adds the adapter to its list. Through the API, it prepares a
conformance agent with the fixture's MCP tools and a workspace key, then runs pytest. The results are written to
`test-results/conformance.xml`, which CI uploads as the `conformance-results` artifact.

In CI, the model is the deterministic fixture model. It answers the suite's prompts the way a model would, for
example "56" for 7 × 8, a pirate greeting for the pirate persona, and a tool call when a prompt asks for one. So
the run checks the harness (routes, events, agents, tools, errors), not a model's quality. To run the suite against
a real model, point the conformance agent at a real provider.

## Latest results

Run: 2026-09-25, OpenHarness 0.2.0, spec 0.2.0 (`f727de1`).

| Category                                                     | Result                      | Notes                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution                                                    | 6 of 6 passed               | An empty message returns an empty result: the spec requires a non-empty message, so the adapter doesn't send it.                                                                                                                                                                |
| Streaming                                                    | 6 of 6 passed               | Event types, text content, the terminal `done`, and stream output matching `execute`.                                                                                                                                                                                           |
| Tool events                                                  | 5 of 5 passed               | Real tool calls: start, end and result pair by id, and a failing tool reports its error.                                                                                                                                                                                        |
| Agents                                                       | 7 of 7 passed               | Create, get, list, delete, config, execute with `agent_id`, and an invalid id.                                                                                                                                                                                                  |
| MCP                                                          | 6 of 6 passed               | Tools come from MCP servers, including a server error and several servers.                                                                                                                                                                                                      |
| Tools                                                        | 5 of 7 passed, 2 deselected | Registering and unregistering custom tools is deselected. External tools are MCP-only here, and the upstream tests call the async API without awaiting it, so they fail for every adapter upstream as well.                                                                     |
| Sessions, memory, sub-agents, skills, hooks, planning, files | Skipped                     | The adapter does not claim these yet. See the support table in [openharness-api.md](openharness-api.md). Sub-agents and hooks exist in OpenHarness, but their spec domains are not mapped yet (#12). The suite's hooks are Python callbacks, which a remote harness cannot run. |

In total, 35 passed, 0 failed and 48 skipped, with 2 deselected.

The spec's conformance routes (`/conformance/run`, `/results`, `/status`, `/diagnostics`, `/logs`) still answer 501. The suite runs in CI rather than inside the harness.
