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

## Start with a policy template

Open **Guardrails → Policy templates** and choose Bias, Toxicity, Hallucinations, Opacity, PII presence, or Vulnerability. This creates an editable draft, not an attachment or a shared template mutation. Name it, adjust its checks and inspection stages, and use **Try it out** to preview a decision. Save it to **My policies**, then open **Workflows** and add the saved policy from the toolbox to an agent's top port, or select it in workflow settings. Workspace defaults remain a separate, explicit choice.

Bias and Toxicity classify inputs and answers. Hallucinations and Opacity inspect answers only. These four templates enable NeMo semantic checks with editable safety instructions; they require the operator-configured safety model described above. An unavailable model follows the policy's failure mode, which defaults to blocking. Instructions cannot be saved with semantic checks disabled or with the built-in provider. They are revisioned and snapshotted along with the rest of the policy.

The Hallucinations template checks unsupported certainty and internal contradictions in the answer text; it does not independently verify external facts or compare against hidden retrieval context. Opacity checks for a useful explanation, assumptions, and uncertainty, never private chain-of-thought. PII presence uses built-in pattern masking without a model. Vulnerability starts with NeMo injection/content patterns and editable tool restrictions; it is not a vulnerability scanner. Template descriptions and limitations remain visible in the editor. Previews and evaluations help assess behavior, but do not certify semantic accuracy.

## YAML policies and templates

Every template has a source file in `guardrails/templates/`. **Policy YAML** in the policy editor shows the complete configuration. Valid YAML edits update the form; form edits appear in YAML when switching views or exporting. **Try it out**, **Save policy**, and **Export YAML** use the same validated settings. Invalid YAML stays in the editor for correction and cannot be saved, previewed, or exported. Formatting and comments are normalized on save or form edits.

**Import YAML** on the Guardrails page opens a new draft. **Import YAML into draft** replaces the current draft's settings; changes are persisted only with **Save policy**. **Export YAML** downloads the current draft, including unsaved valid changes. Template originals are unchanged when creating or editing a saved policy.

The YAML uses NeMo's configuration shape and its [`custom_data` extension](https://github.com/NVIDIA-NeMo/Guardrails/blob/v0.24.1/nemoguardrails/rails/llm/config.py). The supported adapter layout is:

```yaml
models: []
colang_version: '1.0'
rails:
  input:
    flows: [openharness policy]
  dialog:
    user_messages:
      embeddings_only: true
custom_data:
  openharness:
    version: 1
    policy:
      name: Example privacy policy
      provider: builtin
      pii: true
      stages: [input, output, retrieval, tool_input, tool_output]
```

Edit fields under `custom_data.openharness.policy`. The top-level flow binding is fixed to the installed OpenHarness adapter. OpenHarness reads the policy settings, applies stage routing and tool restrictions, and supplies each policy snapshot to NeMo in trusted request context. The file represents this integration, **not a standalone NeMo deployment bundle**: it requires the OpenHarness runtime and the bundled `rails.co`/`actions.py`. Model endpoints and credentials remain service configuration. Arbitrary model definitions, action URLs, imports, Colang, and unknown fields are rejected rather than silently ignored. Files are limited to 256 KiB; duplicate keys, extra YAML documents, anchors, aliases, and explicit tags are rejected.

Authenticated clients can download `/api/guardrails/:id/yaml` or `/api/guardrail-templates/:id/yaml`. Administrators can validate an import with `POST /api/guardrail-yaml/validate` and JSON `{ "yaml": "..." }`, then save its returned `policy` through the existing policy API. Export is scoped to the current workspace and excludes record IDs, ownership, and credentials. Existing permissions and policy revision snapshots apply.

To change a built-in template in source control, edit its YAML and run `npm run generate:guardrail-templates`. This generates the shared JSON catalogue used by the server and browser. Builds, type checks, development startup, and unit tests also generate it automatically, so a fresh clone needs no external template files.
