# Historical simulation and replay

The pipeline is point-in-time by design: every Layer 2/3 row carries `known_at` and `as_of_date`,
and any query "as of date D" filters `as_of_date <= D`. On top of that we support two kinds of
historical runs, and they measure different things.

1. **Deterministic backtests and event studies** (rules mode). These measure edge. They replay the
   rules and strategy stacks that agents produce over history and compute realized returns with costs.
2. **Agent replay** (agent mode). This runs the Proposer/Critic funnel day by day over a past period
   with a simulated clock. It validates the process only. It does NOT measure edge, because the LLMs
   have seen historical outcomes in training and cannot be trusted to be blind to the future. Agent
   replay results are always labeled "process validation" and are never compared with backtest alpha.

This separation is the core rule of this document. Keep it everywhere: collections, reports, and UI.

## 1. Simulated clock (as_of enforcement)

- Every MCP tool (read, screen, get_stock_card, get_feature_history, run_backtest, evaluate_stack,
  get_stock_signals, get_universe_digest, and any future read tool) accepts a session-level `as_of`
  date.
- Enforcement is server-side and mandatory. The tool layer injects `as_of_date <= as_of` into every
  query before it runs. The agent cannot override it, pass a later date, or opt out. The `as_of` is
  bound to the tool session, not to a per-call argument the model controls.
- Default `as_of` is the latest trading date for live runs.
- For replay, the harness sets the session `as_of` to the simulated date before any tool runs.
- Test: with `as_of = D`, no tool may return any row whose `as_of_date > D`. Fuzz every tool with
  random `as_of` dates and random inputs and assert the invariant holds for all of them.

## 2. Replay harness

Signature:

    replay(start, end, cadence="weekly"|"daily", mode="agent"|"rules")

- Loops over trading dates in `[start, end]` at the chosen cadence.
- For each `sim_date`: set the simulated clock (session `as_of = sim_date`), run Stage 0 scoring, then
  in agent mode run the funnel (Proposer, Critic, verdict). Ideas are written to `replay_ideas` with
  `replay_run_id` and `sim_date`.
- Execution is at the next trading day close after the idea date (`execution_lag_days` from
  `backtest.yaml`), with commission and slippage from the same config.
- Each idea is scored at its horizon end against realized excess return. Results go to
  `replay_outcomes`.
- Start with weekly cadence (52 runs per simulated year). Daily cadence is optional and enabled by
  config.

Reports produced per run: hit rate, mean excess return, calibration by probability bucket, quantile
coverage (P10 to P90), turnover, idea diversity, critic rejection rate, and LLM token cost per run.
In agent mode every report carries the "process validation" label.

## 3. Anonymization mode for agent replay

To reduce the chance the model recognizes a specific historical situation:

- Replace ticker and company name with `security_id`.
- Replace calendar dates with relative dates ("day 0", "day -30").
- Keep sector and industry.
- Prefer ranks and percentiles over raw distinctive values on stock cards in this mode.
- Config flag `replay.anonymize`, default true for agent mode. Rules mode ignores it.

Anonymization reduces leakage but does not eliminate it. It does not turn agent replay into an edge
measurement. The labeling rule in section 4 still applies.

## 4. Labeling and holdout rules

- Agent replay results are labeled "process validation" in every collection, report, and UI surface.
  They must never be shown alongside or compared with backtest alpha.
- Edge is measured only by (a) deterministic backtests of the rules and strategy stacks agents
  produce and (b) forward paper trading.
- The locked holdout (last 24 months, `backtest.yaml`) stays locked. Replays inside the holdout
  window are allowed only in agent mode for process validation, or via the one-shot
  `run_holdout_test`. Rules-mode backtests may not touch the holdout.
- Minimum evidence window for any strategy verdict: full history from 2006 (minus the holdout). A
  single simulated year is never sufficient for a verdict. Reports must show a warning when the
  evidence window is under 5 years.

## 4b. Simulated portfolio and trade ledger (paper broker)

Every replay (rules and agent mode) and every live paper-trading run executes through one shared
paper broker, so simulated and live paper results use identical logic.

Paper broker behavior:

- Inputs: approved ideas from the funnel (side, horizon, size, invalidation, stop, take-profit), the
  current portfolio, and prices as of the simulated clock.
- Fills: orders fill at the next trading day close after the decision date (`execution_lag_days`),
  with commission and slippage from `backtest.yaml`. Shorts also pay a borrow cost (config default
  until borrow data exists) and are skipped if flagged hard-to-borrow.
- Position sizing: quarter-Kelly on shrunk edge, capped per position (default 5%), with sector cap
  and gross and net exposure limits from config.
- Exits evaluated daily: invalidation triggered, stop hit, P90 take-profit reached, horizon expired,
  `p_outperform` below 0.50, or replaced by a challenger (hysteresis rules from the strategy
  library). Each exit records its reason.
- Corporate actions: splits adjust share counts; dividends credit cash (debit for shorts); delisting
  closes at the last price with the configured delisting return.

Every order links back to the idea, the debate transcript, and the tool outputs that justified it,
so any trade can be audited end to end ("why did we buy this on that date").

Reporting adds: equity curve vs benchmark, CAGR, Sharpe, Sortino, max drawdown, hit rate per trade,
average win and loss, profit factor, turnover, exposure over time, P&L attribution by strategy,
category, sector, side, and exit reason, and calibration of predicted vs realized outcomes.

## 5. Data availability constraint

- Estimate revisions and price-target/grade consensus exist only from our first weekly snapshot
  onward (FMP keeps no history, see C2). Strategies that require them (E01 to E12 and any composite
  using `revisions_score`) must be marked `evidence_window_start = first_snapshot_date` and excluded
  from backtests before that date.
- Fallback: revision-proxy features built from historical `analyst_events` (grade and price-target
  changes), which do have history. These let revision-style strategies be evaluated over the full
  window with a documented proxy rather than the true consensus series.

## Collections

### replay_runs
`run_id`, `mode` (agent, rules), `cadence`, `start`, `end`, `config_hash`, `seed`, `anonymize`,
`label` (process_validation for agent mode; backtest for rules mode), `status`, `started_at`,
`finished_at`, `sim_dates`, `token_cost`, `evidence_window_start`, `evidence_window_warning` (bool).

### replay_ideas
`idea_id`, `replay_run_id`, `sim_date`, `security_id`, `side`, `horizon`, `strategy_stack`,
`thesis`, `p_outperform`, `quantiles` (P10..P90), `created_by` (lens or agent run id), `anonymized`,
`invalidation`, `stop`, `take_profit`.

### replay_outcomes
`outcome_id`, `replay_run_id`, `idea_id`, `sim_date`, `horizon_end_date`, `realized_return`,
`realized_excess_return`, `benchmark_return`, `hit`, `predicted_prob`, `quantile_landed`,
`calibration_bucket`.

### sim_orders
`order_id`, `run_id`, `idea_id`, `decision_date`, `fill_date`, `security_id`,
`side` (buy, sell, short, cover), `qty`, `fill_price`, `commission`, `slippage`,
`reason` (entry, stop, invalidation, take_profit, horizon, replace, rebalance),
`decided_by` (agent run id or rule id).

### sim_positions
Daily snapshot per `run_id` + `date` + `security_id`: `qty`, `avg_cost`, `market_value`,
`unrealized_pnl`, `weight`, `days_held`, `idea_id`.

### sim_portfolio_daily
Per `run_id` + `date`: `cash`, `gross_exposure`, `net_exposure`, `nav`, `daily_return`,
`benchmark_return`, `drawdown`, `num_positions`, `turnover`.

### sim_trades
Closed round trips: `entry_order_id`, `exit_order_id`, `security_id`, `side`, `holding_days`,
`realized_return`, `excess_vs_sector`, `excess_vs_benchmark`, `exit_reason`, `predicted_prob_at_entry`,
`quantiles_at_entry`, `quantile_landed`, `idea_id`, `run_id`.

## Config (backtest.yaml, replay and broker keys)

See `pipeline/config/backtest.yaml`. Keys include `execution_lag_days`, `commission_bps`,
`slippage_bps`, `borrow_cost_bps_default`, `delisting_return`, `holdout_months`, `capacity_aum`,
sizing (`kelly_fraction`, `max_weight`, `sector_cap`, `gross_limit`, `net_limit`), and the `replay:`
block (`anonymize`, `default_cadence`, `min_evidence_years`, `allow_daily`).

## Acceptance criteria

- as_of fuzz test passes for all MCP tools: with `as_of = D`, no tool returns a row with
  `as_of_date > D`, over random tools, inputs, and dates.
- A rules-mode replay of a known strategy (12-1 momentum, top decile) reproduces `run_backtest`
  results for the same window within rounding.
- A rules-mode replay through the paper broker matches the `run_backtest` equity curve for the same
  strategy and window within rounding.
- An agent-mode weekly replay over 1 simulated year completes end to end and produces the full
  report (with the process-validation label).
- NAV reconciles every day: cash + market value of positions = NAV, and the sum of trade P&L plus
  dividends minus costs equals the NAV change since start.
- Rerunning the same replay with the same config and seed produces identical ledgers.

## Where this sits in the build order

- Historical simulation (rules-mode replay, the paper broker, and as_of enforcement) comes after the
  backtest engine (spec step 5). It reuses the engine's costs, delisting, and holdout logic.
- Agent replay (agent-mode replay with anonymization and process-validation reporting) comes after
  the agent harness (spec step 9 / roadmap Phase 5). It reuses the same paper broker.
