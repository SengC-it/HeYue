# HY-R6.1 B4 PRICE/PREMIUM DIVERGENCE SHADOW SIGNAL ENGINE

Classification: **SHADOW_ENGINE_READY**

This is a local, review-ready shadow implementation. It is not enabled in Production and does not call the scanner, scheduler, email sender, Binance private API, order path, or position-management path.

## Frozen B4 contract

- Version: `hy-b4-shadow-v1`
- Hypothesis: `DIVERGENCE_REVERSAL`
- Bullish: price-change percentile `<= 0.25` AND premium-change percentile `>= 0.75` → `LONG_WATCH`.
- Bearish: price-change percentile `>= 0.75` AND premium-change percentile `<= 0.25` → `SHORT_WATCH`.
- Event formation: `FALSE_TO_TRUE_TRANSITION`; `TRUE_TO_TRUE` is deduplicated and `TRUE_TO_FALSE` resets the episode.
- Frozen feature/cutoff references: `hy-r5.7-basis-premium-frozen-v1`, `hy-r5.8a1-basis-premium-event-cutoff-v1`.
- R5.7 feature hash: `bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51`.
- R5.8A hypothesis hash: `0b5a790a1783704fc5eb130c4d1fa65c865339e68232fa1b54af9012c58db0f3`.
- R5.8A.1 cutoff hash: `95fe1b5a20b0d4804e52dbc01c2f0e730a8f6b377e0c29ae2877875d8f06e800`.

## Architecture

| Layer | Implementation | Boundary |
|---|---|---|
| Observation/PIT validation | `lib/signal-engine/b4-shadow-validation.ts` | Requires closed, complete, PIT-available market data and rolling history. |
| B4 transition engine | `lib/signal-engine/b4-shadow.ts` | Pure `WOULD_HAVE_ALERTED` event generation; no delivery side effect. |
| Control B and outcome helpers | `lib/signal-engine/b4-shadow.ts` | Event-time PIT selection and later maturity calculation. |
| Persistence | `lib/services/b4-shadow-repository.ts` | Writes only the new `hy_shadow_*` tables when explicitly called by a server caller. |

The module is deliberately not wired into the existing scanner or scheduler in this round, preserving the current PAPER strategy and production email behavior.

## Shadow event and storage contract

Each event records immutable event-time evidence: symbol, direction, alert type, market/decision timestamps, PIT availability, perpetual price, premium value, both change values and percentiles, Funding state, Mark/Index basis state, regime, volatility/liquidity buckets, completeness, PIT status, dedup state, Control B result, and `shadow_status=WOULD_HAVE_ALERTED`.

The local migration is:

`supabase/migrations/20260909133000_hy_r61_b4_shadow_signal_engine.sql`

It creates only:

- `hy_shadow_signal_events` — immutable shadow event snapshots.
- `hy_shadow_signal_outcomes` — separate 1h/4h/12h/24h outcome rows with a unique event/horizon key.

Both tables have RLS enabled. `anon` and `authenticated` receive no table privileges; the server-side repository uses `service_role`. The migration has **not** been applied to Supabase Production.

## PIT and fail-closed rules

The engine requires a closed observation, `pit_safe=true`, `pit_available_at <= decision_timestamp`, positive perpetual/Mark/Index prices, available Funding and Mark/Index context, finite Premium Index values, both B4 changes and both rolling percentiles, and ready rolling history. Missing Premium, missing history, incomplete market data, or uncertain PIT produces `NO_SIGNAL`/`DATA_INCOMPLETE` and resets the episode. No price-trend, Funding, or Mark/Index fallback can form B4.

## Control B

Control B uses only event-time fields:

`symbol`, `calendar_period`, `market_regime`, `volatility_bucket`, `liquidity_bucket`, `funding_state`, and `mark_index_basis_state`.

Selection is deterministic and requires candidate PIT availability no later than the event decision timestamp. B4 feature strength and outcome values are absent from the matching contract. If no legal candidate exists, the event remains stored with `CONTROL_UNAVAILABLE`.

## Outcome maturity

The primary outcome is 1h; 4h is secondary; 12h and 24h are exploratory. An outcome is emitted only after a closed future observation at or after event timestamp plus the requested horizon is PIT-available by evaluation time. Directional return is positive for a favorable move in the event direction; MFE and MAE are recorded without sizing, leverage, entry, stop, target, PnL, or profit-factor logic.

## Hard blocks and observability

- `HY_B4_SHADOW_ENABLED` is the canonical flag and defaults to `false`.
- The shadow module imports no email sender, SMTP, notification queue, exchange-private, order, leverage, or PAPER strategy path.
- Diagnostics include enabled/version, last evaluation, market status, history readiness, eligible symbols, evaluations, generated events, LONG/SHORT counts, duplicate suppression, incomplete/PIT failures, and `emails_sent=0`.
- Local verification produced two synthetic shadow events and zero emails. This is a contract test fixture, not a Production scan.

## Verification

- Tests: **PASS (316/316)**
- Typecheck: **PASS**
- Lint: **PASS**
- `git diff --check`: **PASS**
- Supabase Production modified: **NO**
- Vercel modified: **NO**
- Production environment modified: **NO**
- Scheduler modified: **NO**
- Emails sent: **0**
- Private API called: **NO**
- Orders: **0**
- `AUTO_TRADING`: **FALSE**
- Commit created: **NO**

This classification means the local implementation satisfies the shadow engine contract. It does not claim that the 30-day / 1,000 matured pooled 1h matched-event gate for any future real-email decision has been reached.
