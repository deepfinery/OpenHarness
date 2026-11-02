# Market data pipeline (Layers 2–3)

Turns the raw FMP/EDGAR data synced by the **Dataset feature (Layer 1)** into typed, point-in-time
clean collections (Layer 2), derived features + agent views (Layer 3), and the MCP tools + backtest
engine the strategy-discovery swarm consumes. Full spec: the "OpenHarness Market Data Pipeline Spec".

## Layers
- **Layer 1 (exists):** raw FMP collections in the workspace DB, one per dataset. See `config/layer1_mapping.yaml`.
- **Layer 2 (clean):** `securities`, `trading_calendar`, `prices_daily`, `corporate_actions`,
  `fundamentals_pit`, estimates/consensus/analyst/earnings events, insider/congress/13F, `index_membership`,
  `macro_daily`, `dq_issues`. Typed, deduplicated, versioned, point-in-time (`known_at`/`as_of_date`), with lineage.
- **Layer 3 (features + views):** `universe_daily`, `features_daily`, `features_ranked`, `regime_daily`,
  `stock_cards`, `universe_digest`, plus `strategy_*` and `backtest_runs`.

## Directory layout
```
pipeline/
  config/                 # all thresholds/universes/windows/schedules (no logic in code)
    layer1_mapping.yaml   # [done] Layer 1 collection + field mapping (from live inspection)
    universe.yaml composites.yaml features.yaml grade_mapping.yaml ...
  core/                   # db handle, PIT helpers, lineage, dq, config loader, feature registry
  layer2/                 # one module per build_* transform
  layer3/                 # features, ranking, views
  backtest/               # safe expression parser + engine + metrics + holdout
  tools/                  # MCP read/backtest/write tools exposed via OpenHarness
  tests/                  # unit + lookahead + engine-sanity (spec §8)
GAPS.md                   # [done] Layer 1 gap analysis
```

## Conventions (spec §1) — enforced by `core/`
- Join on immutable `security_id`, never ticker.
- Every Layer 2/3 row carries `known_at`, `as_of_date`, `version`/`is_latest`, and lineage
  (`source_collection`, `source_ids`, `transform_name`, `transform_version`, `processed_at`).
- Transforms are idempotent over `(start_date, end_date[, security_ids])`; daily == 1-day range.
- Rejected/flagged rows go to `dq_issues`; never silently dropped. Money USD float64; pct as decimals.

## Implementation order (spec §9) — status
1. **[in progress]** Inspect Layer 1 → `config/layer1_mapping.yaml`, `GAPS.md`. ✅
2. `trading_calendar`, `securities`.
3. `corporate_actions`, `prices_daily`, `macro_daily`.
4. `fundamentals_pit`.
5. Backtest engine on price-only features (proves PIT machinery end-to-end).
5b. Historical simulation: rules-mode replay, the shared paper broker, and server-side `as_of`
    enforcement in the tool layer. Reuses the backtest engine's costs/delisting/holdout. See
    [docs/replay.md](docs/replay.md).
6. Remaining Layer 2.
7. `universe_daily`, `regime_daily`, `features_daily`, `features_ranked`.
8. Validation gates + lookahead tests.
9. Agent views + MCP tools.
9b. Agent replay: agent-mode replay over history with anonymization and process-validation
    reporting through the same paper broker. Validates process only, never edge. See
    [docs/replay.md](docs/replay.md).
10. Holdout protection + `strategy_*`.
11. Backfill full history; acceptance tests.

## Execution model
The transforms are Python (pandas/pymongo). How they are orchestrated within OpenHarness is set at
step 2 — see the open decision in the deployment notes. The logic lives here as a testable package
regardless; orchestration is a thin shim.
