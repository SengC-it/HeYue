-- Structured per-run and per-symbol observation telemetry for HeYue scans.
-- This migration only creates new hy_* objects and does not alter existing
-- signal or scan semantics.

create table public.hy_scan_diagnostics (
  scan_run_id uuid primary key references public.hy_scan_runs(id) on delete cascade,
  strategy_version text not null,
  global_regime text,
  deep_universe_size integer not null check (deep_universe_size >= 0),
  deep_universe_symbols jsonb not null default '[]'::jsonb,
  filter_funnel jsonb not null default '{}'::jsonb,
  symbol_diagnostics jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index hy_scan_diagnostics_created_at_idx
  on public.hy_scan_diagnostics (created_at desc);

create index hy_scan_diagnostics_strategy_created_idx
  on public.hy_scan_diagnostics (strategy_version, created_at desc);

alter table public.hy_scan_diagnostics enable row level security;
revoke all on table public.hy_scan_diagnostics from anon, authenticated;
grant all on table public.hy_scan_diagnostics to service_role;
