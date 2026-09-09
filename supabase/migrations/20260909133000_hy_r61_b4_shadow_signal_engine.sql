-- HY-R6.1 B4 Price/Premium Divergence Shadow Signal Engine.
-- Local review artifact only. Do not apply to Supabase Production in R6.1.
-- This migration is additive and never alters existing scanner, PAPER, or
-- hy_signal_events / hy_signal_intelligence_events tables.

create table public.hy_shadow_signal_events (
  event_id uuid primary key default gen_random_uuid(),
  episode_key text not null,
  experiment text not null check (experiment = 'HY-R6.1'),
  version text not null check (version = 'hy-b4-shadow-v1'),
  created_at timestamptz not null,
  market_timestamp timestamptz not null,
  pit_available_at timestamptz not null,
  symbol text not null check (char_length(btrim(symbol)) between 1 and 32),
  direction text not null check (direction in ('BULLISH', 'BEARISH')),
  alert_type text not null check (alert_type in ('LONG_WATCH', 'SHORT_WATCH')),
  family text not null check (family = 'B4'),
  hypothesis text not null check (hypothesis = 'DIVERGENCE_REVERSAL'),
  feature_version text not null,
  cutoff_version text not null,
  perpetual_price numeric(30, 12) not null check (perpetual_price > 0),
  premium_value numeric(30, 18) not null,
  price_change_value numeric(30, 18) not null,
  premium_change_value numeric(30, 18) not null,
  price_percentile numeric(12, 10) not null check (price_percentile between 0 and 1),
  premium_change_percentile numeric(12, 10) not null check (premium_change_percentile between 0 and 1),
  funding_state jsonb not null check (jsonb_typeof(funding_state) = 'object'),
  mark_index_basis_state jsonb not null check (jsonb_typeof(mark_index_basis_state) = 'object'),
  market_regime text not null,
  volatility_bucket text not null,
  liquidity_bucket text not null,
  calendar_period text not null,
  data_completeness text not null check (data_completeness = 'COMPLETE'),
  pit_status text not null check (pit_status = 'PASS'),
  dedup_state text not null check (dedup_state = 'NEW_FALSE_TO_TRUE'),
  shadow_status text not null check (shadow_status = 'WOULD_HAVE_ALERTED'),
  control_status text not null check (control_status in ('AVAILABLE', 'CONTROL_UNAVAILABLE')),
  control_event_id text,
  control_match_key text not null,
  unique (episode_key)
);

create table public.hy_shadow_signal_outcomes (
  outcome_id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.hy_shadow_signal_events(event_id) on delete restrict,
  direction text not null check (direction in ('BULLISH', 'BEARISH')),
  horizon_hours smallint not null check (horizon_hours in (1, 4, 12, 24)),
  future_observation_timestamp timestamptz not null,
  future_available_at timestamptz not null,
  future_price numeric(30, 12) not null check (future_price > 0),
  signed_return numeric(20, 12) not null,
  max_favorable_move numeric(20, 12) not null,
  max_adverse_move numeric(20, 12) not null,
  pit_safe boolean not null default true check (pit_safe),
  outcome_status text not null check (outcome_status = 'MATURED'),
  calculation_version text not null check (calculation_version = 'hy-b4-shadow-v1'),
  created_at timestamptz not null default now(),
  unique (event_id, horizon_hours)
);

create index hy_shadow_signal_events_symbol_market_idx
  on public.hy_shadow_signal_events (symbol, market_timestamp desc);

create index hy_shadow_signal_events_direction_created_idx
  on public.hy_shadow_signal_events (direction, created_at desc);

create index hy_shadow_signal_events_status_created_idx
  on public.hy_shadow_signal_events (shadow_status, created_at desc);

create index hy_shadow_signal_outcomes_event_horizon_idx
  on public.hy_shadow_signal_outcomes (event_id, horizon_hours);

create index hy_shadow_signal_outcomes_status_created_idx
  on public.hy_shadow_signal_outcomes (outcome_status, created_at desc);

create or replace function public.hy_shadow_signal_events_immutable_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'hy_shadow_signal_events is immutable';
end;
$$;

create trigger hy_shadow_signal_events_immutable_trigger
before update or delete on public.hy_shadow_signal_events
for each row execute function public.hy_shadow_signal_events_immutable_guard();

alter table public.hy_shadow_signal_events enable row level security;
alter table public.hy_shadow_signal_outcomes enable row level security;

-- Keep shadow evidence server-side only. service_role is used only from the
-- server repository; no anon/authenticated client policy is created.
revoke all on table
  public.hy_shadow_signal_events,
  public.hy_shadow_signal_outcomes
from anon, authenticated;

grant select, insert on table public.hy_shadow_signal_events to service_role;
grant select, insert, update on table public.hy_shadow_signal_outcomes to service_role;

revoke all on function public.hy_shadow_signal_events_immutable_guard() from public, anon, authenticated;
grant execute on function public.hy_shadow_signal_events_immutable_guard() to service_role;
