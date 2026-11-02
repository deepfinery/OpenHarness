# Layer 1 gap analysis (spec §9 step 1)

From live inspection of the workspace DB on 2026-10-23. These are the deltas between what the
dataset feature currently produces and what the Layer 2/3 pipeline needs.

| # | Gap | Impact | Plan |
|---|-----|--------|------|
| G1 | `pulled_at` is stored as **`_syncedAt`** | none — just a name | Map in `layer1_mapping.yaml` (done). No re-sync. |
| G2 | **No `payload_hash`** | Layer 2 can't cheaply skip unchanged rows | Optional: add a content hash to the dataset feature's upsert. Low priority (Layer 2 upserts are idempotent anyway). |
| G3 | FMP fields are **flattened** (no `payload` wrapper) | none | Readers use flat fields (mapping documents this). |
| G4 | **`eod_prices` is a recent window only** (~8.8k rows), not 5y history | `prices_daily`, all momentum/vol features, backtests need history | Configure the dataset-feature `eod_prices` sync with `from = today-5y`, `symbolsMode = preset/universe`, and run the one-off backfill. |
| G5 | **Fundamentals cover recent reporters only** (~3.2k rows in `fin_*`) | `fundamentals_pit`, all valuation/quality/growth features need full history | Configure `income_statement`/`balance_sheet`/`cash_flow` (quarter+annual) syncs over the universe with history, run backfill. (Currently the harness wrote `fin_income/fin_balance/fin_cashflow`; standardize on the dataset-feature collections.) |
| G6 | **No earnings BMO/AMC timing** from FMP | `earnings_events.announce_timing`, `reaction_date` | Default `announce_timing = unknown` → act next trading day (conservative, matches spec fallback). Optionally enrich later. |
| G7 | **Index constituents 402-blocked** on the FMP plan | `index_membership`, `securities.index flags`, `in_spx/ndx/dji`, universe-by-index | Cannot pull exact membership. Use screener-based universe (already built) for `universe_daily`; leave `index_membership` empty / flagged until a plan upgrade or an alternate source. |
| G8 | **No SEC EDGAR 13F ingestion** (`raw_13f_*`) | `holdings_13f`, `filers_13f`, all ownership/13F features & `ownership_score` | Add EDGAR sources: daily index + `informationTable.xml` (incremental) + quarterly data-set TSV (backfill). Needs a descriptive `User-Agent` and ≤10 req/s. Phase: after core price/fundamental layers (spec §9 step 6). |
| G9 | **No OpenFIGI CUSIP→security_id map** (`raw_cusip_map`) | 13F CUSIP resolution | Add OpenFIGI client; populate on unknown CUSIPs. Paired with G8. |
| G10 | **No `raw_trading_calendar`** | `trading_calendar`, every PIT/as_of computation | Generate from `pandas_market_calendars` (NYSE) — not a dataset-feature sync; a Layer 2 build (`build_trading_calendar`). |
| G11 | **Statement collection naming** — harness wrote `fin_income/fin_balance/fin_cashflow`; dataset-feature defaults are `income_statement/balance_sheet/cash_flow` | ambiguity | Standardize: point `build_fundamentals_pit` at the `fin_*` collections (mapping) and configure the dataset feature to keep writing them, OR migrate. Chosen: map to `fin_*` for now. |

## Non-gaps (confirmed working for the pipeline)
- Synced collections are **readable as a tool**: MongoDB MCP (`find`/`aggregate`) + `oh.read()` in Python nodes.
- `fin_*` statements carry **`acceptedDate`** → correct point-in-time `known_at`.
- `company_profiles` carry **CIK + CUSIP** → identity resolution for `securities`.
- `dividends_calendar` + `splits_calendar` → `corporate_actions` and price adjustment.
- `insider_trades`, `congress_*` carry **filing/disclosure dates** → correct `known_at` (not transaction date).

## Dataset-feature changes implied (small, optional)
- G2 (payload_hash) and richer earnings timing (G6) are optional enhancements.
- G4/G5 are **configuration** (set `from` dates + run backfills), not code.
- G8/G9/G10 are **new ingestion** (EDGAR, OpenFIGI, calendar) — net-new modules.
