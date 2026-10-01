# Open Harness API support

Generated from the mounted registry and pinned 0.2.0 contract with `npm run generate:openharness-support`. See [API guide](openharness-api.md) and [test evidence](conformance.md). Support means the listed operations are available, subject to these limits; it is not certification.

| Domain    | Operations                                                                              | Limits                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agents    | create, update, delete, clone, export, import                                           | Agents are cards in a harness; the legacy workspace alias maps agent IDs to whole harnesses; Transfer memory separately with the memory export/import endpoints; agent bundle include_memory is not applied; temperature and max_tokens are accepted but not applied            |
| skills    | list, install, uninstall, versions, rollback, upgrade, validate, export, discover       | Discover searches supplied workspace paths, never host filesystem paths; Skill bundles are limited to 10 MiB and 100 text files; versions use major.minor.patch; Skill instructions are limited to 256000 characters and are never silently truncated                           |
| mcp       | list, connect, disconnect, tools, resources, prompts, health                            | Custom tools are not registered directly; serve them over MCP and connect the server; HTTP and SSE transports only; run stdio servers behind an MCP bridge; OAuth authorization takes place in the studio; enrolled machine servers are read-only                               |
| execution | input, artifacts, sync, stream, cancel, tool-calls                                      | temperature and max_tokens are accepted but not applied; choose the model with the model field; Messages are limited to 32000 characters; Artifacts capture final answers and embedded MCP resources up to 5 MiB each (50 per execution); external file URLs are not downloaded |
| sessions  | list, create, update, resume, end, history, fork, message, stream, connect              | Session history retains the latest 100 messages; prompts use the latest 20 messages                                                                                                                                                                                             |
| memory    | read, write, archive, search, export, import                                            | Core memory prompt injection is capped at 12000 characters and treated as untrusted reference data; At most 50 blocks per agent; archive search uses the configured vector store when an embedding provider is available, with keyword fallback                                 |
| subagents | list, spawn, terminate, delegate, result, stream                                        | API child agents inherit parent tools and safety policies and cannot delegate further; Each delegate call has an independent 30000-token budget; active-run workspace limits also apply                                                                                         |
| files     | list, read, download, write, delete, mkdir, upload, uploadBatch, download-batch, search | Workspace files are scoped to the harness and stored separately from the host filesystem; Maximum 10 MiB per file, 100 files and 10 MiB per upload batch, 50 MiB per download batch; Content search uses bounded RE2 regular expressions (no backreferences or lookaround)      |
| hooks     | pre-tool, post-tool, stop, events                                                       | Handlers are webhooks; command handlers are not supported; pre_tool and post_tool hooks cover MCP and machine tools; custom hooks are accepted but never fired                                                                                                                  |
| planning  | read, update, stream                                                                    | Plans come from plan-and-execute agents; in multi-agent harnesses the most recently updated plan is exposed; Only pending steps can be edited; running and completed steps are immutable                                                                                        |
| models    | multi-model, model-switch                                                               | model selects a configured provider by id, name or model name for one execution                                                                                                                                                                                                 |

## Transport coverage

| Operation                     | Method and path                                                                       | Availability                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| harnesses.list                | `GET /harnesses`                                                                      | Available                                                    |
| harnesses.get                 | `GET /harnesses/{harnessId}`                                                          | Available                                                    |
| harnesses.register            | `POST /harnesses`                                                                     | Available                                                    |
| harnesses.update              | `PATCH /harnesses/{harnessId}`                                                        | Available                                                    |
| harnesses.unregister          | `DELETE /harnesses/{harnessId}`                                                       | Available                                                    |
| harnesses.capabilities        | `GET /harnesses/{harnessId}/capabilities`                                             | Available                                                    |
| harnesses.health              | `GET /harnesses/{harnessId}/health`                                                   | Available                                                    |
| harnesses.validateCredentials | `POST /harnesses/{harnessId}/validate-credentials`                                    | Available                                                    |
| agents.list                   | `GET /harnesses/{harnessId}/agents`                                                   | Available                                                    |
| agents.create                 | `POST /harnesses/{harnessId}/agents`                                                  | Available                                                    |
| agents.get                    | `GET /harnesses/{harnessId}/agents/{agentId}`                                         | Available                                                    |
| agents.update                 | `PATCH /harnesses/{harnessId}/agents/{agentId}`                                       | Available                                                    |
| agents.delete                 | `DELETE /harnesses/{harnessId}/agents/{agentId}`                                      | Available                                                    |
| agents.clone                  | `POST /harnesses/{harnessId}/agents/{agentId}/clone`                                  | Available                                                    |
| agents.export                 | `GET /harnesses/{harnessId}/agents/{agentId}/export`                                  | Available                                                    |
| agents.import                 | `POST /harnesses/{harnessId}/agents/import`                                           | Available                                                    |
| skills.list                   | `GET /harnesses/{harnessId}/skills`                                                   | Available                                                    |
| skills.register               | `POST /harnesses/{harnessId}/skills`                                                  | Available                                                    |
| skills.get                    | `GET /harnesses/{harnessId}/skills/{skillId}`                                         | Available                                                    |
| skills.update                 | `PATCH /harnesses/{harnessId}/skills/{skillId}`                                       | Available                                                    |
| skills.uninstall              | `DELETE /harnesses/{harnessId}/skills/{skillId}`                                      | Available                                                    |
| skills.listVersions           | `GET /harnesses/{harnessId}/skills/{skillId}/versions`                                | Available                                                    |
| skills.rollback               | `POST /harnesses/{harnessId}/skills/{skillId}/rollback`                               | Available                                                    |
| skills.discover               | `POST /harnesses/{harnessId}/skills/discover`                                         | Available                                                    |
| skills.validate               | `POST /harnesses/{harnessId}/skills/validate`                                         | Available                                                    |
| skills.download               | `GET /harnesses/{harnessId}/skills/{skillId}/download`                                | Available                                                    |
| skills.upgrade                | `POST /harnesses/{harnessId}/skills/{skillId}/upgrade`                                | Available                                                    |
| mcp.list                      | `GET /harnesses/{harnessId}/mcp-servers`                                              | Available                                                    |
| mcp.connect                   | `POST /harnesses/{harnessId}/mcp-servers`                                             | Available                                                    |
| mcp.get                       | `GET /harnesses/{harnessId}/mcp-servers/{serverId}`                                   | Available                                                    |
| mcp.update                    | `PATCH /harnesses/{harnessId}/mcp-servers/{serverId}`                                 | Available                                                    |
| mcp.disconnect                | `DELETE /harnesses/{harnessId}/mcp-servers/{serverId}`                                | Available                                                    |
| mcp.listTools                 | `GET /harnesses/{harnessId}/mcp-servers/{serverId}/tools`                             | Available                                                    |
| mcp.listResources             | `GET /harnesses/{harnessId}/mcp-servers/{serverId}/resources`                         | Available                                                    |
| mcp.listPrompts               | `GET /harnesses/{harnessId}/mcp-servers/{serverId}/prompts`                           | Available                                                    |
| mcp.health                    | `POST /harnesses/{harnessId}/mcp-servers/{serverId}/health`                           | Available                                                    |
| tools.list                    | `GET /harnesses/{harnessId}/tools`                                                    | Available                                                    |
| tools.get                     | `GET /harnesses/{harnessId}/tools/{toolId}`                                           | Available                                                    |
| tools.register                | `POST /harnesses/{harnessId}/tools`                                                   | MCP required; direct custom-code registration is unavailable |
| tools.unregister              | `DELETE /harnesses/{harnessId}/tools/{toolId}`                                        | MCP required; direct custom-code registration is unavailable |
| tools.invoke                  | `POST /harnesses/{harnessId}/tools/{toolId}/invoke`                                   | Available                                                    |
| tools.invokeStream            | `POST /harnesses/{harnessId}/tools/{toolId}/invoke/stream`                            | Available                                                    |
| execution.run                 | `POST /harnesses/{harnessId}/execute`                                                 | Available                                                    |
| execution.stream              | `POST /harnesses/{harnessId}/execute/stream`                                          | Available                                                    |
| execution.list                | `GET /harnesses/{harnessId}/executions`                                               | Available                                                    |
| execution.get                 | `GET /harnesses/{harnessId}/executions/{executionId}`                                 | Available                                                    |
| execution.attachStream        | `GET /harnesses/{harnessId}/executions/{executionId}/stream`                          | Available                                                    |
| execution.cancel              | `POST /harnesses/{harnessId}/executions/{executionId}/cancel`                         | Available                                                    |
| execution.result              | `GET /harnesses/{harnessId}/executions/{executionId}/result`                          | Available                                                    |
| execution.listArtifacts       | `GET /harnesses/{harnessId}/executions/{executionId}/artifacts`                       | Available                                                    |
| execution.downloadArtifact    | `GET /harnesses/{harnessId}/executions/{executionId}/artifacts/{artifactId}`          | Available                                                    |
| execution.listToolCalls       | `GET /harnesses/{harnessId}/executions/{executionId}/tool-calls`                      | Available                                                    |
| execution.sendInput           | `POST /harnesses/{harnessId}/executions/{executionId}/input`                          | Available                                                    |
| sessions.list                 | `GET /harnesses/{harnessId}/sessions`                                                 | Available                                                    |
| sessions.create               | `POST /harnesses/{harnessId}/sessions`                                                | Available                                                    |
| sessions.get                  | `GET /harnesses/{harnessId}/sessions/{sessionId}`                                     | Available                                                    |
| sessions.update               | `PATCH /harnesses/{harnessId}/sessions/{sessionId}`                                   | Available                                                    |
| sessions.end                  | `DELETE /harnesses/{harnessId}/sessions/{sessionId}`                                  | Available                                                    |
| sessions.resume               | `POST /harnesses/{harnessId}/sessions/{sessionId}/resume`                             | Available                                                    |
| sessions.history              | `GET /harnesses/{harnessId}/sessions/{sessionId}/history`                             | Available                                                    |
| sessions.fork                 | `POST /harnesses/{harnessId}/sessions/{sessionId}/fork`                               | Available                                                    |
| sessions.connect              | `WS /harnesses/{harnessId}/sessions/{sessionId}/connect`                              | Available                                                    |
| sessions.sendMessage          | `POST /harnesses/{harnessId}/sessions/{sessionId}/message`                            | Available                                                    |
| sessions.sendMessageStream    | `POST /harnesses/{harnessId}/sessions/{sessionId}/message/stream`                     | Available                                                    |
| memory.get                    | `GET /harnesses/{harnessId}/agents/{agentId}/memory`                                  | Available                                                    |
| memory.listBlocks             | `GET /harnesses/{harnessId}/agents/{agentId}/memory/blocks`                           | Available                                                    |
| memory.getBlock               | `GET /harnesses/{harnessId}/agents/{agentId}/memory/blocks/{label}`                   | Available                                                    |
| memory.updateBlock            | `PUT /harnesses/{harnessId}/agents/{agentId}/memory/blocks/{label}`                   | Available                                                    |
| memory.createBlock            | `POST /harnesses/{harnessId}/agents/{agentId}/memory/blocks`                          | Available                                                    |
| memory.deleteBlock            | `DELETE /harnesses/{harnessId}/agents/{agentId}/memory/blocks/{label}`                | Available                                                    |
| memory.search                 | `POST /harnesses/{harnessId}/agents/{agentId}/memory/search`                          | Available                                                    |
| memory.getArchive             | `GET /harnesses/{harnessId}/agents/{agentId}/memory/archive`                          | Available                                                    |
| memory.addToArchive           | `POST /harnesses/{harnessId}/agents/{agentId}/memory/archive`                         | Available                                                    |
| memory.export                 | `POST /harnesses/{harnessId}/agents/{agentId}/memory/export`                          | Available                                                    |
| memory.import                 | `POST /harnesses/{harnessId}/agents/{agentId}/memory/import`                          | Available                                                    |
| subagents.list                | `GET /harnesses/{harnessId}/agents/{agentId}/subagents`                               | Available                                                    |
| subagents.spawn               | `POST /harnesses/{harnessId}/agents/{agentId}/subagents`                              | Available                                                    |
| subagents.get                 | `GET /harnesses/{harnessId}/agents/{agentId}/subagents/{subagentId}`                  | Available                                                    |
| subagents.terminate           | `DELETE /harnesses/{harnessId}/agents/{agentId}/subagents/{subagentId}`               | Available                                                    |
| subagents.delegate            | `POST /harnesses/{harnessId}/agents/{agentId}/subagents/{subagentId}/delegate`        | Available                                                    |
| subagents.delegateStream      | `POST /harnesses/{harnessId}/agents/{agentId}/subagents/{subagentId}/delegate/stream` | Available                                                    |
| subagents.result              | `GET /harnesses/{harnessId}/agents/{agentId}/subagents/{subagentId}/result`           | Available                                                    |
| subagents.attachStream        | `GET /harnesses/{harnessId}/agents/{agentId}/subagents/{subagentId}/stream`           | Available                                                    |
| files.list                    | `GET /harnesses/{harnessId}/files`                                                    | Available                                                    |
| files.read                    | `GET /harnesses/{harnessId}/files/{path}`                                             | Available                                                    |
| files.write                   | `PUT /harnesses/{harnessId}/files/{path}`                                             | Available                                                    |
| files.delete                  | `DELETE /harnesses/{harnessId}/files/{path}`                                          | Available                                                    |
| files.search                  | `POST /harnesses/{harnessId}/files/search`                                            | Available                                                    |
| files.upload                  | `POST /harnesses/{harnessId}/files/upload`                                            | Available                                                    |
| files.uploadBatch             | `POST /harnesses/{harnessId}/files/upload-batch`                                      | Available                                                    |
| files.download                | `GET /harnesses/{harnessId}/files/{path}/download`                                    | Available                                                    |
| files.downloadBatch           | `POST /harnesses/{harnessId}/files/download-batch`                                    | Available                                                    |
| files.mkdir                   | `POST /harnesses/{harnessId}/files/mkdir`                                             | Available                                                    |
| hooks.list                    | `GET /harnesses/{harnessId}/hooks`                                                    | Available                                                    |
| hooks.register                | `POST /harnesses/{harnessId}/hooks`                                                   | Available                                                    |
| hooks.get                     | `GET /harnesses/{harnessId}/hooks/{hookId}`                                           | Available                                                    |
| hooks.update                  | `PATCH /harnesses/{harnessId}/hooks/{hookId}`                                         | Available                                                    |
| hooks.unregister              | `DELETE /harnesses/{harnessId}/hooks/{hookId}`                                        | Available                                                    |
| hooks.streamEvents            | `GET /harnesses/{harnessId}/events/stream`                                            | Available                                                    |
| hooks.listEvents              | `GET /harnesses/{harnessId}/events`                                                   | Available                                                    |
| webhooks.register             | `POST /harnesses/{harnessId}/webhooks`                                                | Available                                                    |
| webhooks.list                 | `GET /harnesses/{harnessId}/webhooks`                                                 | Available                                                    |
| webhooks.delete               | `DELETE /harnesses/{harnessId}/webhooks/{webhookId}`                                  | Available                                                    |
| planning.get                  | `GET /harnesses/{harnessId}/executions/{executionId}/plan`                            | Available                                                    |
| planning.update               | `PATCH /harnesses/{harnessId}/executions/{executionId}/plan`                          | Available                                                    |
| planning.listTasks            | `GET /harnesses/{harnessId}/executions/{executionId}/plan/tasks`                      | Available                                                    |
| planning.updateTask           | `PATCH /harnesses/{harnessId}/executions/{executionId}/plan/tasks/{taskId}`           | Available                                                    |
| planning.stream               | `GET /harnesses/{harnessId}/executions/{executionId}/plan/stream`                     | Available                                                    |
| conformance.run               | `POST /harnesses/{harnessId}/conformance/run`                                         | Available                                                    |
| conformance.stream            | `GET /harnesses/{harnessId}/conformance/run/stream`                                   | Available                                                    |
| conformance.results           | `GET /harnesses/{harnessId}/conformance/results`                                      | Available                                                    |
| conformance.status            | `GET /harnesses/{harnessId}/conformance/status`                                       | Available                                                    |
| diagnostics.get               | `GET /harnesses/{harnessId}/diagnostics`                                              | Available                                                    |
| diagnostics.logs              | `GET /harnesses/{harnessId}/logs`                                                     | Available                                                    |
| diagnostics.streamLogs        | `GET /harnesses/{harnessId}/logs/stream`                                              | Available                                                    |

Conformance endpoints run read-only protocol diagnostics and report partial status. The pinned behavioral suite and real-stack domain tests run in CI; see the linked test evidence for exclusions.
