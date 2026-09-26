# Safety policies and NeMo Guardrails

OpenHarness checks user input, model output, retrieved knowledge/experience, tool arguments and tool results. Policies are workspace resources with revisioned run snapshots. Add them on **Guardrails**, select workspace defaults there, select workflow defaults in **Workflow settings**, or attach a policy box to an agent's **top** port. The box is a resource attachment, not an execution step. Agent settings also support direct attachments. Workspace and workflow policies are additive; an agent cannot remove them. Changes affect new runs, including new scheduled runs; paused runs retain their accepted policy snapshots.

## Run the service

```sh
docker compose --profile guardrails up -d --build guardrails
```

The repository builds `openharness-guardrails:0.24.1` from Python 3.12.12 and `nemoguardrails[server]==0.24.1`. The container runs the real `nemoguardrails server` and exposes no host port. The orchestrator calls its native `/v1/checks` endpoint. Each logical stage is submitted as a check payload with the stage and data-only policy in trusted context; NeMo runs the configured Colang policy flow without generating a replacement agent answer. Arbitrary Python or Colang uploads through the UI are not supported. Internal safety checks use HTTP; the agent's external capabilities remain MCP tools.

The default `openharness` configuration has deterministic content/jailbreak patterns, topic deny lists and PII masking. It does not download or host a language model. **Pattern matching is a baseline, not a guarantee against all prompt injection or harmful content.** A GPU is not required for this configuration. The built-in provider supplies the same baseline and typed tool-argument rules when NeMo is unavailable or unwanted.

For semantic safety classification, configure a local NIM or another OpenAI-compatible model, then enable **Use configured safety model** on the policy:

```dotenv
NEMO_SAFETY_MODEL_URL=http://your-local-model:8000/v1
NEMO_SAFETY_MODEL=your-safety-model
NEMO_SAFETY_MODEL_KEY=your-local-key
```

The endpoint receives stage-specific classification instructions and must return JSON `{"allowed":true}` or `{"allowed":false}`. Use a model and serving template compatible with that contract; models with a different native safety response format need an adapter. Missing configuration, invalid classification and failed checks cannot silently fall back to a public model. Configure `NEMO_GUARDRAILS_URL` only if the service lives elsewhere.

## Decisions, budgets and storage

Each stage can be enabled separately. A check allows, blocks with the configured response, or modifies the content (for example, PII redaction). A denied tool never dispatches. Hook edits and human-edited arguments are checked before execution and validated against the current MCP schema; approval cannot override a rail. Children inherit policies. Guarded model answers are buffered before streaming. Retrieval drops blocked passages, and modified tool results are used for model context, trace output and offloaded evidence. Raw tool-file artifacts are omitted when tool-result rails are active, since text checks cannot inspect arbitrary binary content. Checked final answers remain downloadable.

The default failure mode is closed, including tool stages. Explicit fail-open policies record that a check was unavailable. Per-check timeouts and a durable per-policy/run latency budget bound overhead across restarts and concurrent calls. The budget must cover at least one timeout. Payloads over 250,000 characters fail the check instead of being silently truncated. The original user submission remains in the execution record; policy redaction governs runtime processing, not retroactive deletion of user input.

The run trace records each decision, policy revision, stage and latency. `guardrail_audit` keeps 90 days of decisions without copying inspected text or arguments. The Guardrails page shows recent decisions; the signed harness event feed emits `guardrail.decided`.

Policy edits, deletion, workspace defaults and evaluations require an administrator. Members can attach existing policies. Cross-workspace references are rejected. Workflow exports reference policies by name; importing into another workspace requires an enabled matching policy rather than silently dropping protection.

## Evaluations before publishing

**Evaluate workflow** starts a durable, bounded job using a small safety dataset (benign input, jailbreak, unsafe content and PII). Reports retain the workflow revision, per-probe execution links and pass/fail outcomes. Changing the workflow during a job stops that report. Evaluation runs simulate external tool calls, notebook writes, human reviews and email; they do not execute proposed remediation. Human prompts and nested delegation are disabled for evaluations.

For an additional offline dataset from Garak:

```sh
docker compose --profile safety-evaluation up -d --build guardrail-evaluation
```

**Run Garak probes** uses the pinned Garak 0.17.0 packaged PromptInject attack templates, with two contexts per template and a target-string detector. This is a bounded ten-probe subset, not a full Garak scan or a certification. The service loads packaged data only; it does not load Garak model adapters, download datasets, or invoke arbitrary probes. Reports can show failed probes even when the evaluation job completed normally. Review them before publishing; publishing is not automatically authorized or blocked by a report.

## Outbound behavior

NeMo 0.24.1 enables anonymous usage telemetry by default. This image sets `NEMO_GUARDRAILS_NO_USAGE_STATS=1` and `DO_NOT_TRACK=1` before import, plus `HF_HUB_DISABLE_TELEMETRY=1`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `OTEL_SDK_DISABLED=true` and disabled LangChain tracing. No model configuration is present by default. Allow, block and redact checks were verified in a container with `--network none`; optional semantic classification contacts only the explicitly configured endpoint. Build-time package installation requires network access. The Garak data service is likewise usable without network access.

Sources: [NeMo telemetry controls](https://github.com/NVIDIA-NeMo/Guardrails/blob/v0.24.1/docs/telemetry.mdx), [native check endpoint](https://github.com/NVIDIA-NeMo/Guardrails/blob/v0.24.1/nemoguardrails/server/api.py), [Garak PromptInject](https://github.com/NVIDIA/garak/blob/v0.17.0/garak/probes/promptinject.py). NVIDIA retired the older [Safety for Agentic AI blueprint](https://github.com/NVIDIA-AI-Blueprints/safety-for-agentic-ai) in April 2026; this implementation uses the maintained Guardrails package and retains the requested build/deploy/run checks.
