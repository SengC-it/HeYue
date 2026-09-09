-- HY-R4.7 Signal Intelligence MVP-1 data layer.
-- This migration is additive and intentionally does not alter the existing
-- hy_signal_events lifecycle log, scanner tables, notifications, or PAPER path.

create table public.hy_signal_intelligence_events (
  id uuid primary key default gen_random_uuid(),
  symbol text not null check (char_length(btrim(symbol)) between 1 and 32),
  signal_type text not null check (
    signal_type in ('LONG_WATCH', 'SHORT_WATCH', 'RISK_WARNING', 'MARKET_STATUS')
  ),
  created_at timestamptz not null default now(),
  market_regime text not null default 'UNKNOWN' check (
    market_regime in ('BULL', 'BEAR', 'RANGE', 'UNKNOWN')
  ),
  quality_score numeric(6, 3) not null check (quality_score between 0 and 100),
  risk_score numeric(6, 3) not null check (risk_score between 0 and 100),
  confidence numeric(6, 3) not null check (confidence between 0 and 100),
  reason_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(reason_codes) = 'array'),
  human_explanation text not null check (char_length(btrim(human_explanation)) > 0),
  reference_price numeric(30, 12) not null check (reference_price > 0),
  status text not null default 'CREATED' check (
    status in ('CREATED', 'DELIVERED', 'EXPIRED', 'EVALUATED', 'DISMISSED')
  )
);

create table public.hy_signal_features (
  signal_id uuid primary key references public.hy_signal_intelligence_events(id) on delete cascade,
  trend jsonb not null default '{}'::jsonb check (jsonb_typeof(trend) = 'object'),
  momentum jsonb not null default '{}'::jsonb check (jsonb_typeof(momentum) = 'object'),
  volume jsonb not null default '{}'::jsonb check (jsonb_typeof(volume) = 'object'),
  volatility jsonb not null default '{}'::jsonb check (jsonb_typeof(volatility) = 'object'),
  funding_state jsonb not null default '{}'::jsonb check (jsonb_typeof(funding_state) = 'object'),
  open_interest_state jsonb not null default '{}'::jsonb check (jsonb_typeof(open_interest_state) = 'object'),
  liquidity_state jsonb not null default '{}'::jsonb check (jsonb_typeof(liquidity_state) = 'object'),
  market_breadth jsonb not null default '{}'::jsonb check (jsonb_typeof(market_breadth) = 'object'),
  captured_at timestamptz not null default now(),
  pit_safe boolean not null default true check (pit_safe),
  snapshot_hash text
);

create table public.hy_alert_delivery (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.hy_signal_intelligence_events(id) on delete cascade,
  channel text not null default 'EMAIL' check (channel = 'EMAIL'),
  email text not null,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED')
  ),
  sent_at timestamptz,
  failure_reason text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.hy_signal_replays (
  signal_id uuid primary key references public.hy_signal_intelligence_events(id) on delete cascade,
  future_4h_price numeric(30, 12),
  future_12h_price numeric(30, 12),
  future_24h_price numeric(30, 12),
  return_4h numeric(20, 10),
  return_12h numeric(20, 10),
  return_24h numeric(20, 10),
  max_favorable_move numeric(20, 10),
  max_adverse_move numeric(20, 10),
  reference_timestamp timestamptz not null,
  pit_safe boolean not null default true check (pit_safe),
  replay_status text not null default 'PENDING' check (
    replay_status in ('PENDING', 'COMPLETE', 'NOT_EVALUABLE', 'FAILED')
  ),
  evaluated_at timestamptz,
  calculation_version text,
  created_at timestamptz not null default now()
);

create table public.hy_signal_feedback (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.hy_signal_intelligence_events(id) on delete cascade,
  user_action text not null check (user_action in ('WATCHED', 'TRADED', 'IGNORED')),
  manual_direction text check (manual_direction in ('LONG', 'SHORT')),
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  check (user_action <> 'TRADED' or manual_direction is not null)
);

create index hy_signal_intelligence_events_symbol_created_idx
  on public.hy_signal_intelligence_events (symbol, created_at desc);

create index hy_signal_intelligence_events_type_created_idx
  on public.hy_signal_intelligence_events (signal_type, created_at desc);

create index hy_signal_intelligence_events_status_created_idx
  on public.hy_signal_intelligence_events (status, created_at desc);

create index hy_signal_intelligence_events_regime_created_idx
  on public.hy_signal_intelligence_events (market_regime, created_at desc);

create index hy_signal_features_captured_at_idx
  on public.hy_signal_features (captured_at desc);

create index hy_alert_delivery_signal_sent_idx
  on public.hy_alert_delivery (signal_id, sent_at desc);

create index hy_alert_delivery_status_created_idx
  on public.hy_alert_delivery (status, created_at desc);

create index hy_signal_replays_status_created_idx
  on public.hy_signal_replays (replay_status, created_at desc);

create index hy_signal_feedback_signal_created_idx
  on public.hy_signal_feedback (signal_id, created_at desc);

create or replace function public.hy_signal_features_immutable_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'hy_signal_features is immutable';
end;
$$;

create trigger hy_signal_features_immutable_trigger
before update or delete on public.hy_signal_features
for each row execute function public.hy_signal_features_immutable_guard();

alter table public.hy_signal_intelligence_events enable row level security;
alter table public.hy_signal_features enable row level security;
alter table public.hy_alert_delivery enable row level security;
alter table public.hy_signal_replays enable row level security;
alter table public.hy_signal_feedback enable row level security;

revoke all on table
  public.hy_signal_intelligence_events,
  public.hy_signal_features,
  public.hy_alert_delivery,
  public.hy_signal_replays,
  public.hy_signal_feedback
from anon, authenticated;

grant select, insert, update on table public.hy_signal_intelligence_events to service_role;
grant select, insert on table public.hy_signal_features to service_role;
grant select, insert, update on table public.hy_alert_delivery to service_role;
grant select, insert, update on table public.hy_signal_replays to service_role;
grant select, insert on table public.hy_signal_feedback to service_role;

revoke all on function public.hy_signal_features_immutable_guard() from public, anon, authenticated;
grant execute on function public.hy_signal_features_immutable_guard() to service_role;
