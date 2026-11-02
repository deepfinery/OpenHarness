# Config export / import

Export and import StockHarness **configurations** (not data, not secrets): dataset syncs, harness
workflows (including their Python code), agents, and skills. Lets you recreate the system from
version-controlled config.

## What it does
- **Export** pulls the live configs via the API, strips server-managed fields (ids, timestamps,
  cursors, discovered tools, run state), and rewrites environment-specific references
  (`connectionId`, `providerId`, `agentId`, `knowledgeBaseId`, `guardrailIds`, ...) as by-name
  `{"$ref": {type, name}}`. Secrets are never exported (connections/providers themselves are not
  exported, only referenced by name).
- **Apply** reads the files, resolves by-name refs against the target install, and upserts
  idempotently (update if a resource of that name exists, else create) in dependency order:
  skills, agents, workflows, dataset syncs.

## Files (committed under `exports/`)
- `dataset-syncs.json` - all dataset sync configs (schedule, dataset, symbols/preset, from/to,
  retention, target collection).
- `workflows.yaml` - harness workflows including Python code nodes.
- `agents.yaml`, `skills.yaml`.

## Usage
```bash
export OH_BASE=https://openharness.faberiq.ai OH_EMAIL=you@example.com OH_PASSWORD=...
python config_io.py export               # write exports/
python config_io.py apply --dry-run      # resolve + report, no writes
python config_io.py apply                # recreate on the target
```

## Prerequisites for apply
The connections, providers, and knowledge bases referenced by name must already exist on the target
(they hold secrets and are created per install). Apply then wires everything else to them by name.
Requires `pyyaml`.
