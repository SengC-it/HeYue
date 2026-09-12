# HY-R6.2C.3 Final Frozen Measurement Foundation

## Scope and safety

- Branch: `feat/hy-r6-b4-live-foundation`
- Existing Draft PR: `#7`
- Reviewed starting HEAD: `ba2218f771a2939441b91b614766e8936da58df7`
- Applied migration changed: **NO**. Only the un-applied `20260909150000_hy_r62c_b4_live_shadow_foundation.sql` is part of this change.
- Production, Vercel, Supabase Production, PAPER strategy, email delivery, Binance private API, and orders were not touched.
- `HY_B4_SHADOW_ENABLED` remains a disabled-by-default gate; `AUTO_TRADING=false` remains a hard contract.

## Frozen measurement corrections

- Liquidity uses average competition rank: `less + (equal + 1) / 2`, normalized as `(rank - 1) / (N - 1)`. `N < 2` is unavailable. Ties therefore produce the same percentile and `[100, 200, 300]` maps `200` to `0.5` / `NORMAL`.
- Regime uses the same-timestamp cross-sectional median of `close_1h(t) / close_1h(t-4h) - 1`, with complete contiguous 1h bars only. The `[-0.005, +0.005]` interval is `RANGE`; a 4h candle pair is rejected.
- Every observation remains PIT-safe: closed-bar availability is `open_time + 1h`, rolling primitives use the prior 720 observations, and future observations are never used for feature construction.

## Frozen B4 universe

Manifest: `hy-b4-shadow-universe-v1`
Universe hash: `833894b120a52fbf2e68ca9fc46b5d5607bc4db3e0aacc7e40106492c29c56f3`
Symbol count: **49**
Source commit: `7bb10067df78a1d7cb11e6ab06643fb44dc8e400`
Runner blob: `5dc0672ecc60a8b68299237a2d9a534f1c05f317`
Cutoff blob: `6ec0c67651332a1bf8e56beaed0411d7970f4856`
Feature specification hash: `bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51`

The exact sorted symbols are:

`1000BONKUSDT`, `1000CATUSDT`, `1000PEPEUSDT`, `1000SHIBUSDT`, `AAVEUSDT`, `ADAUSDT`, `ARCUSDT`, `AVAXUSDT`, `BANKUSDT`, `BEATUSDT`, `BNBUSDT`, `BTCUSDT`, `COOKIEUSDT`, `COTIUSDT`, `DEXEUSDT`, `DODOXUSDT`, `DOGEUSDT`, `ENAUSDT`, `EPICUSDT`, `ETHUSDT`, `FILUSDT`, `GWEIUSDT`, `HEIUSDT`, `HOMEUSDT`, `HYPEUSDT`, `ICPUSDT`, `INJUSDT`, `IOTXUSDT`, `LINKUSDT`, `LTCUSDT`, `NEARUSDT`, `ONDOUSDT`, `PAXGUSDT`, `PENGUUSDT`, `PUMPUSDT`, `SAGAUSDT`, `SIRENUSDT`, `SKYAIUSDT`, `SOLUSDT`, `SUIUSDT`, `SYNUSDT`, `TAOUSDT`, `TRXUSDT`, `TSTUSDT`, `UNIUSDT`, `WLDUSDT`, `XLMUSDT`, `XMRUSDT`, `XRPUSDT`.

The live resolver checks this frozen set against current `TRADING` USDT perpetual instruments. Missing live metadata returns `CONTEXT_INCOMPLETE`; it never shrinks the expected denominator. PUMPUSDT has an explicit suspended interval and a later relaunched interval.

## Collection and isolation

- New collector: `lib/services/b4-shadow-collector.ts`.
- New endpoint: `app/api/b4-shadow/collect/route.ts`, CRON-secret protected and public-data only.
- B4 uses deterministic batches over the frozen 49-symbol universe and a context key consisting of universe version plus closed UTC hour. The existing PAPER `/api/scan` retains its Top-10 path and only enables microstructure through `HY_MICROSTRUCTURE_ENABLED`.
- Durable staged rows are finalized only after every expected symbol is present. Finalized context is immutable evidence; partial context produces zero B4 events.
- A durable feature-state tail avoids repeated hourly network fetches for an already staged/evaluated symbol-hour. Re-bootstrap is used after a detected gap.

## Control and maturity contracts

- `hy_b4_shadow_control_claims` scopes without-replacement claims by `(control_event_id, direction)` while keeping `event_id` unique. The same control can therefore be used once per direction, and an event can have only one control.
- `hy_b4_shadow_control_outcomes` is idempotent on `(control_event_id, direction, horizon_hours)` and uses the control observation timestamp as the origin. Full contiguous paths provide directional signed return, MFE, and MAE.
- Pending maturity functions return only due, missing event/horizon or control/direction/horizon pairs, capped at 5,000 with keyset ordering. This prevents old incomplete rows from starving newer work.
- `hy_b4_shadow_metric_readiness()` is schema/readiness only; performance and lift fields remain `NULL`, with `future_performance_not_calculated=true`.

## Evidence fixtures and validation

- Real outcome-free R5.10A feature fixture: `tests/fixtures/hy-research-freezes/r6.2c-b4-feature-parity.json` with five 720-primitive samples covering BULLISH, BEARISH, and NO_EVENT.
- Real outcome-free context fixture: `tests/fixtures/hy-research-freezes/r5.10a-b4-context-parity.json` with 49 same-timestamp returns and peer volume values.
- Both fixtures carry the real R5 source commit/blob provenance; no future-return, MFE, MAE, PnL, or other future label is used for feature selection.
- Scheduler preparation artifact: `supabase/b4-shadow-scheduler.sql`; it explicitly says `DO NOT APPLY` and leaves `hy-scan-batch-0` unchanged.
- Migration security: all new tables are `hy_` prefixed, RLS-enabled, denied to `public`/`anon`/`authenticated`, and granted only to `service_role`; security-definer functions use `search_path = public, pg_temp` and explicit grants.

Local gates:

| Gate | Result |
| --- | --- |
| `pnpm test` | PASS — 149/149 |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS |
| `git diff --check` | PASS; Git only reported LF/CRLF normalization warnings |
| GitHub CI | Pending the new pushed HEAD |

Classification before remote CI: **READY_FOR_CI_REVIEW**.
