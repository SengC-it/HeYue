# HY-R6.2A.1 CI Reproducibility + Release Surface Audit

## Scope

- Branch: `feat/hy-r6-b4-shadow`
- Previous head: `7bb10067df78a1d7cb11e6ab06643fb44dc8e400`
- Draft PR: `#5`
- B4 contract: `hy-b4-shadow-v1`
- Production deployment, Production Supabase migration, Vercel changes, Production environment changes, and Shadow activation: none.

This remediation keeps the accepted B4 Shadow semantics unchanged. It makes the release tests runnable from a fresh clone without local research data, and removes unrelated historical research from the PR surface.

## Root cause and inventory

The failed GitHub run had 5 failing tests because 10 filesystem-dependent test files were coupled to ignored local artifacts under `data/raw/**` and `reports/**`. The missing artifacts included:

- `clean-artifact-hashes.json`
- `hy-r5.8a-basis-premium-hypothesis-freeze.json`
- `listing-evidence.json`
- `feature-specification.json`
- `coverage-matrix.json`

The historical tests were removed from this release branch rather than loading raw data in CI. The remaining release tests use only tracked source, the B4 migration, and one small immutable fixture. No current B4 runtime or release test reads ignored research data or local research reports.

## Fixture policy

Versioned fixture:

- `tests/fixtures/hy-research-freezes/r6.1-b4-shadow-contract.json`

It contains only the small frozen B4 contract metadata and accepted hash references. It is test-only; Production runtime does not import `tests/fixtures`.

Raw Binance archives, materialized historical datasets, coverage matrices, local caches, and full research outputs are not committed.

## Release surface classification

| Classification | Included paths / disposition |
| --- | --- |
| `RUNTIME_REQUIRED` | `.env.example`, `app/api/health/route.ts`, `app/api/scan/route.ts`, `lib/config.ts`, `lib/services/b4-shadow-repository.ts`, `lib/signal-engine/b4-shadow-sidecar.ts`, `lib/signal-engine/b4-shadow-types.ts`, `lib/signal-engine/b4-shadow-validation.ts`, `lib/signal-engine/b4-shadow.ts`, `lib/signal-engine/index.ts` |
| `SHADOW_RELEASE_TEST_REQUIRED` | `tests/b4-shadow-engine.test.ts`, `tests/hy-r6.2a-release-candidate.test.ts`, `tests/fixtures/hy-research-freezes/r6.1-b4-shadow-contract.json` |
| `MIGRATION_REQUIRED` | `supabase/migrations/20260909132405_hy_r61_b4_shadow_signal_engine.sql` (validated only; not applied) |
| `RESEARCH_EVIDENCE_REQUIRED` | Existing R6.1 and R6.2A release evidence reports; this remediation report |
| `SUPPORTING_RELEASE_CONFIG` | `.gitignore`, `tsconfig.json` |
| `UNRELATED_HISTORICAL_RESEARCH` | 111 R2–R5 research source, runner, migration, and test files removed from the PR index and moved to `.tmp-r6.2a-pr-hygiene/removed-from-pr/`; local safety ref: `backup/hy-r6-before-pr-hygiene-7bb1006` |

The B4 runtime no longer imports the `lib/basis-premium` barrel. The scan and health routes and the B4 repository use direct B4 module imports, avoiding accidental bundling of the historical research subsystem.

Final PR surface: 21 files, 2,067 added lines, and 2 modified/deleted lines relative to `codex/paper-observation-deploy`. This includes the remediation report itself. No raw dataset or cache is included.

## Frozen B4 regression gate

- `LONG_WATCH`: price-change percentile `<= 0.25` and premium-change percentile `>= 0.75`.
- `SHORT_WATCH`: price-change percentile `>= 0.75` and premium-change percentile `<= 0.25`.
- Formation: `FALSE_TO_TRUE` only; `TRUE_TO_TRUE` is suppressed and `TRUE_TO_FALSE` resets the episode.
- Version: `hy-b4-shadow-v1`.
- Feature flag: `HY_B4_SHADOW_ENABLED=false` by default.
- Flag false behavior: no evaluation, no persistence, no email, and no change to the existing PAPER path.

## Verification performed

- Local tests: `117/117 PASS`.
- Local typecheck: `PASS`.
- Local lint: `PASS`.
- Local build: `PASS`.
- Local diff check: `PASS`.
- Current ignored local dependencies used by release tests/runtime: `0`.
- Raw historical data committed: `NO`.
- Email path added to Shadow: `NO`.
- Private API/order/leverage/position path added: `NO`.
- `AUTO_TRADING`: `FALSE`.

Fresh-clone parity and GitHub CI are release gates and must be recorded after the remediation commit is pushed. A failed gate remains invalid and must stop promotion.

## Recovery

Keep `HY_B4_SHADOW_ENABLED=false` and do not apply the migration. The removed historical files remain recoverable from the local archive or safety ref. Revert the remediation commit if the release surface needs to be restored.
