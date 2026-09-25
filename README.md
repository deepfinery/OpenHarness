# Agentic Orchestration

A self-hosted studio for agents, MCP tools, and knowledge. Build visual workflows, run agents in a playground, and expose them through an API or an embedded conversation.

The application is self-contained. Its API, runner, studio, configuration, and deployment assets all live in this repository.

## Start

Install Docker with Docker Compose and OpenSSL, then run:

```sh
git clone https://github.com/deepfinery/orchestrator.git
cd orchestrator
./start.sh
```

Open **http://localhost:8088**. Create your local administrator account using the `SETUP_TOKEN` generated in `.env`. There is no default account or password. Subsequent starts use the same configuration and persistent volumes.

`start.sh` generates unique credentials, builds the application, starts Compose, and waits for healthy services. After configuration exists, you can also use:

```sh
docker compose up --build -d --wait
```

For a different port on first launch:

```sh
STUDIO_PORT=8090 ./start.sh
```

Allow approximately 4 GB of available memory for the application stack, plus the memory needed by any locally hosted models. A CPU-only laptop can run the studio with a remote model provider. Ollama or another inference server is configured separately; the project does not download a large model automatically.

## What is included

- **Agent studio:** agent templates (assistant, researcher, planner, reflective writer, autonomous worker, reviewer, support), four agentic patterns (ReAct, plan-and-execute, reflection, autonomous loop), instructions, model choice, explicit tool permissions, multiple MCP connections, knowledge bindings, execution limits, and enable/disable controls.
- **Workflow harness:** seven starters including multi-agent ones (plan → research → write, route to a specialist, research → email), explicit Start and Finish, inline agents, MCP tool and knowledge attachments, conditions, parallel agents, Email steps, bounded cycles, and explicit MCP actions. Drag the labelled ports to connect components, reconnect or delete edges, undo/redo, auto-arrange, or edit/export YAML.
- **Runner:** durable RabbitMQ jobs, persisted execution snapshots, per-step checkpoints, automatic resume on a replacement runner under a per-workflow resume policy, idempotency keys on every tool call, bounded agent loops, cancellation, run history, and interval schedules.
- **Playground:** saved conversations per agent or workflow (like a chat history), token-by-token streaming, a live execution trace, and a run history tab.
- **One tool connector: MCP.** Streamable HTTP or legacy SSE, unauthenticated servers, bearer/API-key authentication, and OAuth discovery, PKCE, dynamic registration or a pre-registered client (for servers such as Finnhub), and refresh tokens. Every call is validated against the server's tool schema before it is sent.
- **Model providers:** guided setup for OpenAI, Anthropic, Gemini, Ollama, or any OpenAI-compatible server, with a connection test for the chat and embedding models before saving. Model providers are inference services; all external agent tools use MCP.
- **Knowledge bases:** filesystem uploads, asynchronous ingestion, Weaviate hybrid search, source citations in the prompt, and retrieval testing. TXT, Markdown, CSV, JSON, YAML, text PDFs, and DOCX are supported.
- **Outgoing email:** workspace SMTP settings (Amazon SES, Google Workspace, SendGrid, Mailgun, Postmark, or any relay) with `.env` defaults, a test send, and an Email workflow step.
- **Shared workspaces:** MongoDB-backed local accounts, administrator-managed teammates, shared agents/workflows/tools/knowledge within a tenant, profile settings, tenant isolation, and workflow edit-conflict detection.
- **Integrations:** target-scoped API keys, persistent conversational API, server-sent event streams per run, authenticated JSON webhooks, and revocable iframe links with allowed frame origins.

No provider-specific tool connectors, external account login, website builder, business setup wizards, reports, customer management, product/service management, billing, or customer portal are included.

## Start with a template

Choose **Create workflow**, then a starter (each opens a connected canvas you can edit):

| Starter               | Shape                                                  | Agents | Needs               |
| --------------------- | ------------------------------------------------------ | ------ | ------------------- |
| Knowledge research    | Start → Researcher → Finish                            | 1      | a knowledge base    |
| MCP tool assistant    | Start → Tool assistant → Finish                        | 1      | an MCP connection   |
| Research and review   | Start → Researcher → Reviewer → Finish                 | 2      | a knowledge base    |
| Plan, research, write | Start → Planner → Researcher → Writer → Finish         | 3      | an MCP connection   |
| Route to a specialist | Start → Triage → Condition → Specialist A / B → Finish | 3      | nothing             |
| Research and email    | Start → Analyst → Email → Finish                       | 1      | MCP + SMTP settings |
| Blank canvas          | Start → Finish                                         | 0      | nothing             |

Select or create your model provider and resources in the starter, then open a connected canvas. Agents in a workflow pass results to each other through templates: `{{last}}` is the previous step's result and `{{steps.<id>}}` any earlier one, so a Writer can read `{{steps.researcher}}` while a Reviewer reads `{{last}}`.

An agent's left/right ports control execution. Its bottom **Tools** and **Knowledge** ports attach resources available during its reasoning loop; one agent can attach several MCP servers and knowledge bases, and the inspector of any attached card offers **+ MCP tools** / **+ Knowledge** to add more. Tools are not forced into the execution sequence: the model chooses when to call the tools you selected. Use an **MCP action** step when a specific call must happen in a fixed order, and an **Email** step to send a result through your SMTP settings. Clicking a palette item adds and connects it; dragging a port creates or replaces a connection. Select an edge and press Delete to disconnect it, or use the inspector. **Save & test** opens the workflow in the playground.

## Agentic patterns

Every agent, reusable or inline on the canvas, runs one of four patterns. Tools and knowledge are available in all of them; the pattern decides how the agent organizes its passes over the model.

| Pattern              | How it works                                                                                                                                | Use it for                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **ReAct** (default)  | Each turn the model either calls tools or answers. Tool results feed the next turn, bounded by the agent's turn limit.                      | Assistants, most workflow steps                  |
| **Plan and execute** | One pass writes a short numbered plan without tools; each step then runs with tools and records its result; a final pass writes the answer. | Multi-step research, comparisons, reports        |
| **Reflection**       | Draft, critique as a strict reviewer, revise with tools for verification. One to three rounds.                                              | Writing, analysis, anything that must be checked |
| **Autonomous loop**  | Work in iterations, carrying progress forward, until the agent ends a message with the done marker or hits the iteration limit.             | Long tasks with a clear completion condition     |

Patterns beyond ReAct receive up to four times the agent's turn limit in total model calls. Every pass is visible in the trace as `plan`, `plan_step`, `reflection`, and `iteration` events.

In **Settings → Team & workspace**, administrators can name the workspace and add teammates. Teammates share resources and run history. Model/MCP credentials stay write-only. Conversation histories are scoped to their initiating user or API key; workspace members can still inspect the shared execution history.

## First agent

1. In **Settings → Model providers**, pick where your models run (OpenAI, Anthropic, Gemini, Ollama, or another OpenAI-compatible server), paste the key, choose a chat model and, if this provider will index knowledge, an embedding model. **Test connection** checks both against the real endpoint before you save and shows the provider's exact error message if something is wrong.
2. In **MCP connections**, paste the server URL. Use an API key, or choose OAuth and click **Authorize** after saving: a window opens for the provider's login, returns here, and tools are discovered automatically. Discovered tools appear on the connection card, each with its input schema.
3. In **Agents**, start from a template, adjust the instructions and pattern, choose a model, and select the exact tools the agent may use. An empty tool selection grants no tool access.
4. Optionally create a **Knowledge base**, upload documents, wait for their `ready` status, and attach it to the agent.
5. Use the **Playground**: conversations are saved per agent, answers stream as they are written, and the side panel shows the live trace or the run history.

The studio starts without API keys. Actual model runs and vector embeddings require a configured provider. Local Ollama needs the selected models pulled in advance.

## Outgoing email

**Settings → Email (SMTP)** configures one outgoing mail server per workspace, with presets for Amazon SES, Google Workspace, SendGrid, Mailgun and Postmark, a **Send test** action, and the same private-network rules as other endpoints. Operators can preconfigure every workspace through `.env`:

```sh
SMTP_HOST=email-smtp.eu-west-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=AKIA...          # SES SMTP credentials, not IAM keys
SMTP_PASSWORD=...
SMTP_FROM=reports@example.com
```

Workspace settings saved in the studio take precedence over `.env`. Email is sent by the **Email** workflow step (recipients, subject and body are templates such as `{{last}}` or `{{payload.email}}`). Because sending is an external side effect, a run that crashes inside an Email step is not replayed under the default resume policy.

## Model endpoints

| Type              | Example base URL                                   | Notes                                                                                                                      |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| OpenAI compatible | `https://api.openai.com/v1`                        | Also supports compatible inference services such as vLLM and LM Studio. Supply that service's exact base URL and model ID. |
| Anthropic         | `https://api.anthropic.com/v1`                     | Chat/tool use. Select a different provider for embeddings.                                                                 |
| Gemini            | `https://generativelanguage.googleapis.com/v1beta` | Chat/tool use and configured embedding models. This is unrelated to UI login.                                              |
| Ollama            | `http://host.docker.internal:11434`                | Native Ollama chat and embedding APIs. The host gateway is configured in Compose.                                          |

Private endpoints are denied unless their hostname is explicitly listed in `ALLOWED_PRIVATE_HOSTS`. The default permits `host.docker.internal` and `ollama`. For an MCP server on your network, add its hostname to `.env` and recreate the API and runner:

```sh
docker compose up -d api runner
```

MCP OAuth callback URL: `PUBLIC_URL/api/mcp/oauth/callback` (shown, with a copy button, in the connection form). Configure the public URL before authorizing a server. OAuth here authorizes tools; studio users always use local accounts. Servers without dynamic registration can use a pre-registered client ID and optional client secret: for example, Finnhub's remote server at `https://mcp.finnhub.io/mcp` uses Streamable HTTP with OAuth and a published client ID, and its 70 tools appear on the connection card after authorizing. A remote stdio-only MCP server should be exposed through an HTTP/SSE MCP gateway; the application does not execute arbitrary shell commands supplied in the UI.

## API, conversation, webhooks, and iframe

Create an API key in **Integrations**, choosing its allowed agent or workflow. Then:

```sh
curl -X POST http://localhost:8088/api/runs \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: a-unique-request-id' \
  -d '{"agentId":"YOUR_AGENT_ID","input":"Summarize the available knowledge."}'
```

The response is `202 Accepted` with an `id`. Poll `GET /api/runs/:id` using the same key, or open `GET /api/runs/:id/stream` for server-sent events that deliver the status, the trace, and the answer text as it streams from the model. Terminal statuses are `succeeded`, `failed`, `cancelled`, and `interrupted`. Cancel with `POST /api/runs/:id/cancel`. Use `workflowId` instead of `agentId` for workflows.

For a conversation, call `POST /api/chat` with `workflowId` (or `agentId`) and `message`. Subsequent turns send the returned `conversationId` and a new `message`; history is maintained on the server. Each turn is queued and returns a run ID to poll or stream. `GET /api/conversations?agentId=…` lists the caller's conversations for a target.

For event-driven workflows, use **Integrations → Webhooks**. Choose a target and optionally a JSON input field such as `event.message`. Send JSON to the generated URL with its bearer secret. The input field becomes `{{input}}`; all event fields are available through `{{payload.field}}`. Poll `/api/hooks/:id/runs/:runId` with the same secret. Webhook retries support `Idempotency-Key`.

For iframes, choose **Integrations → Iframe embeds**, select one target, set exact allowed website origins and an expiration, then copy the generated HTML. The capability is carried in the URL fragment and sent as an authorization header by the embedded UI. No third-party login cookie is needed. Treat the embed link as a credential: it can run the selected target until revoked or expired. Allowed frame origins restrict where the UI may be framed; they do not make a copied capability secret.

See [the API reference](docs/api.md) for request shapes and permissions.

## Architecture

### Components

```mermaid
flowchart LR
  subgraph Clients
    Browser[Browser: React agent studio]
    External[API key / chat / webhook / iframe caller]
  end

  subgraph "apps/api"
    API[Express API<br/>auth · resources · scheduler · queue dispatcher · static UI hosting]
  end

  subgraph "Shared state"
    Mongo[(MongoDB<br/>metadata + outbox)]
    MQ[(RabbitMQ)]
    Files[(Shared filesystem)]
  end

  subgraph "apps/runner"
    Runner[Queue consumer<br/>run execution · document ingestion/deletion]
  end

  subgraph "External services"
    Vector[(Weaviate)]
    LLM[Configured model providers]
    MCP[MCP servers]
  end

  Browser --> API
  External --> API
  API --> Mongo
  API --> MQ
  API --> Files
  MQ --> Runner
  Runner --> Mongo
  Runner --> Files
  Runner --> Vector
  Runner --> LLM
  Runner --> MCP
  API -. provider test .-> LLM
  API -. tool discovery .-> MCP
  API -. retrieval test .-> Vector
```

| Path            | Purpose                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api`      | Local authentication, resource APIs, integrations, scheduler, queue dispatcher, static UI hosting |
| `apps/runner`   | RabbitMQ consumer, run leases, execution, document ingestion and deletion                         |
| `apps/studio`   | Trimmed React studio, workflow canvas, playground, knowledge and settings                         |
| `packages/core` | Shared schemas, agent runtime, provider adapters, MCP/OAuth, storage, retrieval, queue            |
| `tests`         | Unit, real-stack integration, fault-injection, and browser tests with test-only provider fixtures |

The dotted edges are administrative, not execution: the API calls a model provider directly only to verify credentials (`POST /providers/:id/test`), calls an MCP server directly only to list its tools (`POST /connections/:id/discover`), and calls Weaviate directly only for the Knowledge Base's inline retrieval test (`POST /knowledge/:id/search`). Every agent turn, workflow tool call, and document ingestion/deletion runs in the runner, reached only through RabbitMQ.

MongoDB, RabbitMQ, and Weaviate use their community distributions, run locally, and have independent persistent volumes. Only the studio HTTP port is published by the default Compose stack. No AWS, Google account login, S3, Redis, or managed database service is needed.

### Run lifecycle

Submitting a run and getting its result crosses the outbox, the broker, and a leased execution in the runner:

```mermaid
sequenceDiagram
  participant C as Client (UI / API key / webhook)
  participant A as API
  participant M as MongoDB
  participant Q as RabbitMQ
  participant R as Runner
  participant X as Model providers / MCP / Weaviate

  C->>A: POST /runs (or /chat)
  A->>M: insert run, status = queued (the outbox row)
  A->>Q: publish (kind: run, id) - best effort
  alt broker reachable
    A->>M: set publishedAt
  else broker unreachable
    Note over A,M: run stays queued with no publishedAt, the periodic dispatcher republishes it later
  end
  A-->>C: 202 Accepted (id)
  Q->>R: deliver job
  R->>M: claim atomically: queued to running, leaseId, leaseUntil = now + 30s
  loop every 5s while running
    R->>M: refresh leaseUntil
  end
  R->>X: agent turns, tool calls, retrieval
  X-->>R: results
  R->>M: append trace events, checkpoint each node's output
  R->>M: set terminal status: succeeded / failed / cancelled / interrupted
  R->>Q: ack
  C->>A: GET /runs/:id (poll)
  A->>M: read run
  A-->>C: status + output + trace
```

If the runner process dies mid-run, its message is never acked and its lease is never renewed. A periodic sweep (`recoverStaleJobs`) finds runs whose `leaseUntil` has passed and applies the workflow's **resume policy**: under the default `safe` policy the run goes back to `queued` and a replacement runner continues from the checkpoint written before the in-flight step, unless that step could have acted on an external system (an MCP action, an Email step, or an agent with tools), in which case the run is marked `interrupted` for review. `always` resumes regardless; `never` always interrupts. Automatic resumes are capped by `MAX_RESUMES` (default 3). See [Run states](#run-states) and [Idempotency, resiliency, and what "handled" actually means](#idempotency-resiliency-and-what-handled-actually-means).

### Run states

```mermaid
stateDiagram-v2
  [*] --> queued : createRun (dedups on Idempotency-Key or schedule)
  queued --> running : a runner claims it
  queued --> cancelled : cancelled before any runner claims it
  running --> succeeded : executeRun resolves
  running --> failed : executeRun throws
  running --> cancelled : cancellation observed by the runner
  running --> queued : lease expires and the resume policy allows it - resumeCount + 1
  running --> interrupted : lease expires and the in-flight step may have acted externally
  succeeded --> [*]
  failed --> [*]
  cancelled --> [*]
  interrupted --> [*]
```

`interrupted` is terminal: a tool call before the crash may already have taken effect, so replaying it blind is unsafe. Review the run's trace and start a new run deliberately. Steps without external side effects are resumed automatically instead, and the trace records a `resumed` event with the reason.

### Workflow node types

| Node type   | Behavior                                                                                   | Outgoing connections                                       |
| ----------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `start`     | Entry point of the workflow                                                                | one `next`                                                 |
| `agent`     | Runs an agent's bounded reasoning loop; the model chooses when to call its bound MCP tools | one `next`, plus bottom-port MCP tool / knowledge bindings |
| `tool`      | Makes one fixed MCP call with templated arguments, no model involved                       | one `next`                                                 |
| `parallel`  | Runs 2-8 agents concurrently on the same prompt and waits for all                          | one `next`                                                 |
| `email`     | Sends a templated email through the workspace SMTP settings                                | one `next`                                                 |
| `condition` | Evaluates a templated comparison                                                           | `onTrue` and `onFalse`                                     |
| `output`    | Renders a template from accumulated state and ends that path                               | none - terminal                                            |
| `finish`    | Same as `output`; the canonical end of a workflow                                          | none - terminal                                            |

For example, the **Research and review** starter wires two agents and a knowledge binding like this:

```mermaid
flowchart LR
  Start([Start]) --> Researcher[["Researcher (agent)"]]
  Researcher --> Reviewer[["Reviewer (agent)"]]
  Reviewer --> Finish([Finish])
  Knowledge[("Knowledge base")] -. bound to .-> Researcher
```

An agent's bound MCP tools and knowledge bases are available throughout its own turn budget, not fixed steps in the graph; a `tool` node is for a call that must happen in a fixed order outside any agent's reasoning.

## Design rationale

### Idempotency, resiliency, and what "handled" actually means

Six mechanisms cover this, each with a stated limit:

- **Submission idempotency.** `POST /runs` and webhook deliveries accept an `Idempotency-Key`. The same key with the same payload returns the original run; the same key with a different payload is rejected with `409` (`createRun` in `packages/core/src/runs.ts`). Scheduled workflows dedup the same way on a `scheduleKey`, so a scheduler restart cannot double-fire an interval.
- **Durable delivery (the outbox).** A run is written to MongoDB with `status: queued` _before_ anything is published to RabbitMQ. If the broker is down at that instant, the write still succeeds, and a periodic dispatcher (`dispatchPending`) republishes it once the broker is reachable again. No run is lost to a broker outage — the fault-injection test in `tests/integration/reliability.test.ts` stops the RabbitMQ container mid-submission to verify exactly this.
- **Exclusive execution.** A runner claims a run with an atomic `findOneAndUpdate` (`queued` → `running`, tagged with a `leaseId`). A duplicate delivery of the same message finds the run already claimed and no-ops instead of executing it twice. A 5-second heartbeat keeps the lease alive; if the runner process dies, the lease simply stops renewing.

- **Checkpointed resume.** Before each workflow step runs, the runner writes a checkpoint (`cursor`, the previous result, the step count, and per-step attempt counts) to the run document, and after it completes the step's output is stored. When a lease expires, the sweep re-queues the run and a replacement runner rebuilds its scope from those checkpoints and continues at the cursor, so completed steps are never repeated. A `resumed` event names the reason; `resumeCount` caps runaway crash loops (`MAX_RESUMES`, default 3).
- **Side-effect-aware policy.** The one thing a checkpoint cannot prove is whether the step that was in flight already acted on the outside world. MCP defines no generic way to ask "did that call take effect?", so the default `safe` policy resumes only when the in-flight step has no external side effects (`start`, `condition`, `finish`, agents without tools) and otherwise fails to `interrupted` with the reason spelled out. Workflows that call idempotent tools can opt into `always`; audited pipelines can choose `never`.
- **Idempotency keys on every tool call.** Each MCP call carries `_meta.idempotencyKey = runId:nodeId:callNumber` (or `:attempt` for explicit actions), so an MCP server that deduplicates on it can make a replay harmless. Servers that ignore `_meta` are unaffected, which is why the policy above stays conservative by default.

This is the saga shape without pretending to have compensations the tools cannot offer: forward recovery for everything the platform controls, an explicit stop with a reason for the one step it cannot vouch for, and the key an external system needs to close the gap. `docs/design.md`'s "Queue semantics" section records the same rules.

### Why this design holds up

- **One tool protocol, not N connectors.** Search, ticketing, file access, and any other external capability arrive through MCP. That means one auth model (bearer or OAuth with PKCE), one discovery mechanism (`listTools`), and one place — `toolValidation.ts` — where every tool call is checked against the server's own live schema before it is dispatched. A new integration is a new MCP server, not new orchestrator code.
- **Durable by construction.** The outbox → broker → lease → heartbeat chain means a client's dropped connection, a broker restart, or a runner crash cannot silently lose a submitted run. This is exercised, not assumed: the isolated test stack actually kills the RabbitMQ container and `SIGKILL`s the runner mid-run.
- **Bounded everywhere.** Agent turns, per-turn tool-call counts, run step budgets, context size, and wall-clock timeouts are all capped (`agent.maxTurns`, `workflow.maxSteps`, a 30-minute worker limit). An agent cannot run away with your token budget or your infrastructure.
- **Least privilege by default.** An agent's tool access is an explicit allow-list (`agent.connections[].tools`); an empty list grants nothing. Provider and MCP credentials are write-only, even to administrators.
- **Tenant isolation at the execution layer, not just the UI.** `ownerId`/tenant scoping is enforced in the same resource-lookup functions the runner calls to execute a job — a misconfigured or compromised agent cannot read another tenant's connections or knowledge base.
- **Tested against real infrastructure.** Integration tests run against real MongoDB, RabbitMQ, and Weaviate containers with deterministic MCP/model fixtures, including fault injection — killed containers, expired OAuth tokens, interrupted runs. A passing suite here means the failure mode was actually exercised, not asserted away with a mock.

### Agentic architecture in context

This project does not use LangChain, or any agent framework — there is no such dependency in `package.json`, and `packages/core/src/runtime.ts` talks to each model provider's native API directly. It's still useful to place this design against the architecture most agent frameworks (LangChain's `AgentExecutor` and its equivalents elsewhere) converge on, since the same tradeoffs apply either way:

```mermaid
flowchart LR
  U[User input] --> L["LLM: decide next action"]
  L -->|tool call| T[Tool executor]
  T -->|observation| L
  L -->|final answer| O[Response]
  Mem[("Conversation memory / chat history")] -.-> L
```

_A generic ReAct-style agent-executor loop — the common shape behind LangChain and most other agent frameworks, shown here as background, not as this repository's own stack._

That loop's benefits are real: a large ecosystem of pre-built tool, memory, and retriever integrations; a shared vocabulary (chains, agents, tools, memory) that's easy to hire and reason about; and fast prototyping. Its costs are just as real for a long-lived, self-hosted product: a fast-moving dependency with frequent breaking changes, an abstraction layer between the developer and the provider's actual request/response, and no built-in opinion about durability, multi-tenancy, or credential handling — that part gets built regardless of the framework underneath. This project takes the other side of that trade: a small, dependency-light execution core purpose-built around the durability, tenancy, and tool-validation guarantees described above, in exchange for not inheriting a framework's integration catalog. MCP is the integration catalog instead.

**Agentic patterns, and what this platform supports today:**

```mermaid
flowchart TD
  subgraph "Single agent patterns - per agent setting"
    A1["ReAct: reason, call tools, observe, answer"]
    A2["Plan and execute: plan, run each step with tools, synthesize"]
    A3["Reflection: draft, critique, revise"]
    A4["Autonomous loop: iterate until the done marker"]
  end
  subgraph "Sequential pipeline - next edges"
    S1[agent] --> S2[agent] --> S3[agent]
  end
  subgraph "Parallel multi-agent - parallel node"
    P0[agent] --> P1{{parallel node}}
    P1 --> P2[agent A]
    P1 --> P3[agent B]
  end
  subgraph "Routing - condition after a triage agent"
    R0[triage agent] --> R1{condition}
    R1 -->|SUPPORT| R2[support agent]
    R1 -->|SALES| R3[sales agent]
  end
```

The `agent` node runs one of the four agentic patterns above (ReAct, plan-and-execute, reflection, autonomous loop), `next` edges chain agents into a sequential pipeline, the `parallel` node fans one prompt out to 2-8 agents and waits for all of them, and a `condition` after a triage agent routes to specialists. Plan-then-delegate across _several_ agents is the **Plan, research, write** starter: a planning agent, a plan-and-execute researcher with tools, and a reflective writer, connected through `{{steps.<id>}}` templates.

### The agent and tool design, in depth

Zooming into `packages/core/src/runtime.ts` and `mcp.ts` — the parts of this platform that decide what an agent is allowed to do and how it does it:

- **The tool-calling loop is explicit and inspectable.** Each turn, the model sees the full tool list with live schemas, picks zero or more calls, each call is validated locally against that schema before dispatch, and every call and result is written to the run's event log as it happens rather than reconstructed afterward. That log is what the Playground's trace and the Executions page render.
- **Tool errors are recoverable, not fatal.** A schema violation or an MCP-side error is handed back to the model as a normal tool result (marked `tool_error`) so it can retry with corrected arguments inside its existing turn budget — instead of one bad call, like the Tavily `topic` enum mismatch that motivated this fix, taking down the entire run.
- **Every tool call happens inside a lease.** Tool calls only ever run inside a claimed, heartbeating run; if the runner dies mid-call, no other replica can also be mid-call on the same run, and the run fails safe to `interrupted` instead of silently continuing from stale state.
- **Retrieval is a context stage, not a tool the model can misuse.** Knowledge lookups happen before the model sees the prompt, are cited by source title, and are explicitly labeled as reference data rather than instructions in the system prompt — the model cannot be tricked into treating retrieved text as a new instruction the way an ungoverned RAG-as-a-tool integration can be.
- **Nothing here trusts the model's judgment for authorization.** Which tools exist, which knowledge base is searched, which tenant's data is reachable, and how many turns or tool calls are allowed are all decided by configuration before the model runs, never requested by the model at run time.

Why this matters in production, specifically: the failure modes above are not hypothetical — they are the exact shape of the bugs reported against this platform, such as a bad tool argument crashing an entire customer-facing run, or no visibility into whether a crashed run's side effects already happened. A framework or a hand-rolled prototype that skips schema validation, run leasing, or explicit tool grants will work in a demo and then produce exactly these incidents the first time a tool's schema drifts, two workers race on the same job, or an agent is given more trust than the person configuring it intended. Durability, least privilege, and schema validation are not polish layered on top of the agent loop — for a system that lets an LLM take real external actions, they are the difference between a demo and something a customer's workflow can safely run behind.

## Operations and limits

- Keep `.env` backed up with the volumes. In particular, existing encrypted credentials cannot be recovered without `ENCRYPTION_KEY`.
- The `files` volume is mounted at `/data` in both the API and runner. For a mounted shared filesystem, use [compose.shared-fs.yaml](compose.shared-fs.yaml).
- The default HTTP listener binds to loopback. For a server, put a TLS reverse proxy in front of it and set `PUBLIC_URL` to the HTTPS URL. Set `TRUST_PROXY=1` only when there is exactly one trusted proxy.
- Scale runners with `docker compose up -d --scale runner=2`. Keep the same database, broker, Weaviate instance, credentials, and filesystem for all replicas.
- A Mongo run/document record is the durable outbox. Queue deliveries are at least once. Atomic claims prevent two workers from executing the same active run.
- A run whose runner dies resumes from its last checkpoint on another replica when the step in flight had no external side effects (workflow `resumePolicy: safe`, the default). A run interrupted during external work (an MCP action, an Email step, or an agent with tools) is marked **interrupted**, not replayed: a tool may have acted before the process was lost. Review the trace and start a new run deliberately. `resumePolicy: always` or `never` override this per workflow; `MAX_RESUMES` caps automatic resumes. This is not an exactly-once guarantee for external side effects.
- Agent tool errors, including arguments that fail the tool's schema and hard MCP errors, are returned to the model for correction within its turn budget. An explicit workflow tool error fails that run. There is no automatic retry of a potentially mutating MCP tool. Every call carries an idempotency key in `_meta` for servers that deduplicate.
- Streaming is on per provider by default and falls back to a single response when a server ignores the `stream` flag. Streamed text is kept in the run's `partial` field until the answer is final.
- Harness workflows have one Start and at least one Finish. Every execution step needs a possible path to Finish. Cycles are permitted with a step budget (default 100, maximum 500); a run fails when it exhausts that budget. Agent turns and timeouts are bounded separately. Template bindings support `input`, `last`, `steps.<id>`, and `payload.<field>`; arbitrary code is not evaluated. Legacy graphs remain runnable and are upgraded visually when opened and saved.
- Parallel agent steps wait for all agents. A failed sibling aborts the others' in-flight requests; it cannot undo completed external actions.
- Interval schedules dispatch while the API is running. After downtime, an overdue schedule dispatches once; it does not replay every missed interval.
- Knowledge indexing is retriable and replaces partial document vectors. Changing the embedding configuration of a provider already bound to a knowledge base is blocked; create a new provider/base instead.
- Scanned PDFs/images need OCR before upload. Extraction is limited to 2 million characters and 4,000 chunks per document; oversized documents fail explicitly. The default upload limit is 20 MB.
- Run history and documents persist until you remove them or their volumes. Backups and retention are the installation operator's responsibility.

See [operations](docs/operations.md) for backup and recovery, and [design notes](docs/design.md) for the architecture and execution guarantees.

## Upgrade

Back up your configuration and volumes, then run `git pull --ff-only` and `./start.sh` from your clone. Existing private accounts keep separate workspaces and their data; the upgrade does not automatically share previously private credentials. New teammates created by a workspace administrator join that administrator's workspace. See [upgrade details](docs/operations.md#upgrading-to-02).

## Development and verification

Node.js 22 or later is required outside Docker.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Run the complete isolated-stack suite (creates and removes **test-only** Compose volumes):

```sh
./scripts/test-stack.sh
```

Include Chromium browser tests:

```sh
npx playwright install --with-deps chromium
BROWSER_TESTS=1 ./scripts/test-stack.sh
```

On Linux, `BROWSER_TESTS=container ./scripts/test-stack.sh` runs Chromium in
the matching Playwright container instead of installing browser system libraries.

For UI development against the running local Compose API, use `npm run dev` and
open `http://localhost:5173`. For a non-default API URL, set `DEV_API_URL` and
`DEV_API_ORIGIN` to its reachable endpoint and configured public origin. Direct
API/runner development requires explicitly supplying the configuration in
`packages/core/src/config.ts` and reachable development database/broker URLs.

The fixtures provide deterministic model, MCP, and OAuth endpoints. MongoDB, RabbitMQ, Weaviate, the API, and the runner are real containers. Tests exercise protocol plumbing, queue recovery, and access isolation; hosted models and your particular external MCP services should also be checked with their real credentials before release.

The GitHub Actions workflow builds and tests every push and pull request. Installation credentials are generated locally; `.env`, data, dependency folders, and test artifacts are excluded from version control.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party packages and container images retain their respective licenses.
