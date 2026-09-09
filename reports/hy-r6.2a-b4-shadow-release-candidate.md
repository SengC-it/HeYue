# HY-R6.2A B4 SHADOW RELEASE CANDIDATE + DEPLOYMENT PREFLIGHT

Classification: **SHADOW_RELEASE_CANDIDATE_READY**

Branch: `feat/hy-r6-b4-shadow`

This candidate is review-ready only. It has not been deployed, promoted, activated in Production, or applied to Supabase Production.

## Frozen signal

- Candidate: `B4 PRICE_PREMIUM_DIVERGENCE`
- Version: `hy-b4-shadow-v1`
- `LONG_WATCH`: price-change percentile `<= 0.25` AND premium-change percentile `>= 0.75`.
- `SHORT_WATCH`: price-change percentile `>= 0.75` AND premium-change percentile `<= 0.25`.
- Formation: `FALSE_TO_TRUE_TRANSITION`; persistent TRUE is suppressed and FALSE resets the episode.
- Direction, 75/25 cutoffs, and dedup semantics are unchanged.

## Sidecar integration and isolation

The new path is an observability sidecar in `app/api/scan/route.ts`, implemented by `lib/signal-engine/b4-shadow-sidecar.ts`. When `HY_B4_SHADOW_ENABLED=false` (the default), it performs zero evaluations, zero shadow DB writes, zero emails, and zero changes to the existing PAPER path. When enabled, the current public snapshot can provide Mark/Index and Funding context, but it cannot provide the required historical Premium-change rolling percentiles; the adapter therefore emits explicit incomplete input and fails closed. No alternate signal is formed.

Sidecar errors are captured as `DEGRADED` for input/evaluation errors or `FAILED` for persistence errors. They do not fail the existing scanner response. The existing candidate engine, strategy thresholds, PAPER selection, paper-trade path, and email path remain separate.

## Idempotency and immutability

Default event identity is deterministic:

`hy-b4-shadow-v1|symbol|market_timestamp|direction|FALSE_TO_TRUE`

The event table has a unique `episode_key`, and the repository conflict path returns the canonical existing event. Outcomes use the database unique key `(event_id, horizon_hours)` and conflict read-back. Outcome cache identity remains direction-aware: `symbol|timestamp|direction|horizon`.

`hy_shadow_signal_events` has an update/delete trigger. Later outcome maturity writes only to `hy_shadow_signal_outcomes`; it cannot overwrite Premium, percentiles, Funding, regime, context, or direction.

## Migration and privileges

`supabase/migrations/20260909133000_hy_r61_b4_shadow_signal_engine.sql` creates only:

- `hy_shadow_signal_events`
- `hy_shadow_signal_outcomes`

It adds only their indexes, constraints, unique identities, RLS, and immutable-event trigger. Anonymous and authenticated table access is revoked; the repository is server-side and service-role-only. No Production migration was applied. No retention cleanup was added.

## Health telemetry

`/api/health` now includes `b4Shadow` with enabled/version/status, last evaluation, eligible symbols, conditions evaluated, events, LONG/SHORT counts, duplicate suppression, incomplete/PIT failures, and `emailSent=0`. Scan responses include the same telemetry. The canonical flag is `HY_B4_SHADOW_ENABLED`, default `false`.

## Local smoke

The local tests prove LONG and SHORT event generation, FALSE→TRUE transitions, TRUE→TRUE deduplication, TRUE→FALSE reset, 1h/4h maturity, Control B unavailable retention, immutable event evidence, direction-aware outcomes, feature-flag no-op, and sidecar failure isolation. The smoke has zero emails, zero private API calls, and zero orders.

## Frozen hashes

| Artifact | SHA-256 | Representation |
|---|---|---|
| `lib/signal-engine/b4-shadow.ts` | `7c9ef10c38afc3fb228dfad095e0c785ba92168b02bf0c925b957ba4c9a93d0a` | Raw UTF-8 bytes |
| `supabase/migrations/20260909133000_hy_r61_b4_shadow_signal_engine.sql` | `4a86bb8faeaff1472c853ffa4f3a4b1b0d0589ae85e39c72beb6cd49783dc4e1` | Raw UTF-8 bytes |
| R6.2A integration (`app/api/scan/route.ts` + sidecar) | `5704296a20527e104d37beaa0eeb6a9920efe466d5dc44a62f53093e48dc0790` | Path + NUL + raw bytes + NUL, ordered |
| Schema contract | `1233b3cb94838eac3e47972574aaf2a81ada9f8e8f522c9283f3cb2d0573e9db` | Canonical JSON contract |

## Verification and safety

- Tests: **326/326 PASS**
- Typecheck: **PASS**
- Lint: **PASS**
- Build: **PASS**
- Diff check: **PASS**
- CI: pending Draft PR creation
- Production / Supabase Production / Vercel / Production env / scheduler: **unchanged**
- Existing PAPER strategy: **unchanged**
- Emails sent: **0**
- Private API called: **NO**
- Orders: **0**
- `AUTO_TRADING`: **FALSE**
- Commit: not yet created at report generation time
