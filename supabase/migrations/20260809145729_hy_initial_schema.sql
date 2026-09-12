-- HeYue independent baseline. Creates only hy_* application objects.
-- Foreign-project migrations are archived outside the active migration path.

-- Core tables, functions, RLS, and settings.
-- Crypto Signal Scanner isolated schema objects.
-- This migration intentionally creates only hy_* objects in public.

create extension if not exists pgcrypto with schema extensions;

create table public.hy_strategy_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  strategy_family text not null,
  parameters jsonb not null default '{}'::jsonb,
  training_start_date date,
  training_end_date date,
  validation_start_date date,
  validation_end_date date,
  oos_start_date date,
  oos_end_date date,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PAPER', 'ACTIVE', 'RETIRED')),
  created_at timestamptz not null default now()
);

create table public.hy_instruments (
  symbol text primary key,
  base_asset text not null,
  quote_asset text not null default 'USDT',
  contract_type text not null default 'PERPETUAL',
  exchange_status text not null default 'TRADING',
  price_tick numeric not null,
  quantity_step numeric not null,
  min_quantity numeric,
  max_leverage numeric,
  quote_volume_24h numeric,
  universe_rank integer,
  exchange_filters jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.hy_scan_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  scan_group_key text not null,
  timeframe text not null,
  batch_number integer not null default 0 check (batch_number >= 0),
  batch_count integer not null default 1 check (batch_count > 0),
  universe_size integer not null default 0 check (universe_size >= 0),
  scanned_symbols integer not null default 0 check (scanned_symbols >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  emailed_count integer not null default 0 check (emailed_count >= 0),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  error_summary jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.hy_signals (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid references public.hy_scan_runs(id) on delete set null,
  signal_key text not null unique,
  symbol text not null references public.hy_instruments(symbol) on delete restrict,
  side text not null check (side in ('LONG', 'SHORT')),
  primary_timeframe text not null,
  confirmation_timeframes text[] not null default '{}',
  strategy_family text not null,
  strategy_version text not null,
  score numeric(6, 3) not null check (score >= 0 and score <= 100),
  score_components jsonb not null default '{}'::jsonb,
  market_regime text not null default 'UNKNOWN',
  regime_dependency text not null default 'UNKNOWN',
  entry_price numeric not null check (entry_price > 0),
  stop_price numeric not null check (stop_price > 0),
  take_profit_price numeric not null check (take_profit_price > 0),
  reward_risk numeric(8, 3) not null default 2 check (reward_risk > 0),
  assumed_margin_usdt numeric(20, 8) not null default 100 check (assumed_margin_usdt > 0),
  assumed_leverage numeric(10, 4) not null default 20 check (assumed_leverage > 0),
  position_notional_usdt numeric(20, 8) not null check (position_notional_usdt > 0),
  theoretical_risk_usdt numeric(20, 8) not null check (theoretical_risk_usdt >= 0),
  risk_over_single_cap boolean not null default false,
  risk_budget_blocked boolean not null default false,
  scan_group_key text not null,
  email_reserved boolean not null default false,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REPLACED', 'BUDGET_BLOCKED', 'MANUALLY_CLOSED')),
  valid_until timestamptz not null,
  source_data_timestamp timestamptz not null,
  occurrence_date date not null,
  replaced_by uuid references public.hy_signals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (side = 'SHORT' or stop_price < entry_price),
  check (side = 'LONG' or stop_price > entry_price),
  check (side = 'SHORT' or take_profit_price > entry_price),
  check (side = 'LONG' or take_profit_price < entry_price)
);

create table public.hy_signal_events (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.hy_signals(id) on delete cascade,
  event_type text not null check (event_type in ('CREATED', 'REPLACED', 'EMAIL_QUEUED', 'EMAIL_SENT', 'EMAIL_FAILED', 'BUDGET_BLOCKED', 'ERROR')),
  payload jsonb not null default '{}'::jsonb,
  event_at timestamptz not null default now()
);

create table public.hy_risk_budgets (
  budget_date date primary key,
  daily_limit_usdt numeric(20, 8) not null default 600 check (daily_limit_usdt > 0),
  reserved_risk_usdt numeric(20, 8) not null default 0 check (reserved_risk_usdt >= 0),
  new_signal_count integer not null default 0 check (new_signal_count >= 0),
  new_email_count integer not null default 0 check (new_email_count >= 0),
  updated_at timestamptz not null default now()
);

create table public.hy_notifications (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.hy_signals(id) on delete set null,
  idempotency_key text not null unique,
  channel text not null default 'GMAIL_SMTP' check (channel in ('GMAIL_SMTP')),
  recipient text not null,
  subject text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  provider_message_id text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.hy_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  strategy_version text not null,
  universe_definition jsonb not null default '{}'::jsonb,
  parameter_set jsonb not null default '{}'::jsonb,
  train_window jsonb not null default '{}'::jsonb,
  validation_window jsonb not null default '{}'::jsonb,
  out_of_sample_window jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.hy_system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('SCAN_STARTED', 'SCAN_COMPLETED', 'SCAN_ERROR', 'DATA_SOURCE_ERROR', 'DATABASE_ERROR', 'EMAIL_ERROR', 'CONFIG_ERROR', 'WARNING')),
  severity text not null default 'INFO' check (severity in ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
  component text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table public.hy_app_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  description text,
  updated_at timestamptz not null default now()
);

create unique index hy_signals_one_active_per_symbol_idx
  on public.hy_signals (symbol)
  where status = 'ACTIVE';

create index hy_signals_created_at_idx on public.hy_signals (created_at desc);
create index hy_signals_occurrence_date_idx on public.hy_signals (occurrence_date desc, score desc);
create index hy_signals_status_idx on public.hy_signals (status, symbol);
create index hy_signals_scan_run_id_idx on public.hy_signals (scan_run_id);
create index hy_signals_replaced_by_idx on public.hy_signals (replaced_by);
create index hy_signal_events_signal_id_idx on public.hy_signal_events (signal_id, event_at desc);
create index hy_notifications_status_idx on public.hy_notifications (status, created_at desc);
create index hy_notifications_signal_id_idx on public.hy_notifications (signal_id);
create index hy_system_events_occurred_at_idx on public.hy_system_events (occurred_at desc);
create unique index hy_strategy_versions_one_deployed_stage_idx
  on public.hy_strategy_versions (status)
  where status in ('PAPER', 'ACTIVE');

create or replace function public.hy_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger hy_instruments_set_updated_at
before update on public.hy_instruments
for each row execute function public.hy_set_updated_at();

create trigger hy_signals_set_updated_at
before update on public.hy_signals
for each row execute function public.hy_set_updated_at();

create trigger hy_notifications_set_updated_at
before update on public.hy_notifications
for each row execute function public.hy_set_updated_at();

create trigger hy_risk_budgets_set_updated_at
before update on public.hy_risk_budgets
for each row execute function public.hy_set_updated_at();

create trigger hy_app_settings_set_updated_at
before update on public.hy_app_settings
for each row execute function public.hy_set_updated_at();

-- Atomic same-symbol replacement and daily theoretical-risk reservation.
-- The API calls this function through the server-only Supabase service key.
create or replace function public.hy_claim_signal(
  p_signal jsonb,
  p_budget_date date,
  p_daily_limit_usdt numeric,
  p_single_risk_cap_usdt numeric,
  p_daily_email_cap integer,
  p_should_email boolean,
  p_scan_group_key text,
  p_scan_email_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signal_id uuid;
  v_existing_id uuid;
  v_existing_score numeric;
  v_existing_risk numeric := 0;
  v_new_score numeric;
  v_new_risk numeric;
  v_delta numeric;
  v_budget public.hy_risk_budgets%rowtype;
  v_email_allowed boolean := false;
  v_is_new_opportunity boolean := false;
  v_confirmation_timeframes text[] := '{}';
  v_scan_email_count integer := 0;
begin
  v_signal_id := coalesce(nullif(p_signal->>'id', '')::uuid, gen_random_uuid());
  v_new_score := (p_signal->>'score')::numeric;
  v_new_risk := (p_signal->>'theoretical_risk_usdt')::numeric;

  select id into v_existing_id
  from public.hy_signals
  where signal_key = p_signal->>'signal_key'
  limit 1;

  if v_existing_id is not null then
    return jsonb_build_object('status', 'IDEMPOTENT', 'signal_id', v_existing_id, 'email_allowed', false);
  end if;

  select id, score, theoretical_risk_usdt
    into v_existing_id, v_existing_score, v_existing_risk
  from public.hy_signals
  where symbol = p_signal->>'symbol' and status = 'ACTIVE'
  for update;

  if v_existing_id is not null and v_new_score <= v_existing_score then
    return jsonb_build_object(
      'status', 'REJECTED_LOWER_SCORE',
      'signal_id', v_existing_id,
      'email_allowed', false
    );
  end if;

  v_is_new_opportunity := v_existing_id is null;
  v_delta := greatest(v_new_risk - coalesce(v_existing_risk, 0), 0);

  insert into public.hy_risk_budgets (budget_date, daily_limit_usdt)
  values (p_budget_date, p_daily_limit_usdt)
  on conflict (budget_date) do nothing;

  select * into v_budget
  from public.hy_risk_budgets
  where budget_date = p_budget_date
  for update;

  if v_budget.reserved_risk_usdt + v_delta > v_budget.daily_limit_usdt then
    if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
      select array_agg(value) into v_confirmation_timeframes
      from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
    end if;

    insert into public.hy_signals (
      id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
      confirmation_timeframes, strategy_family, strategy_version, score,
      score_components, market_regime, regime_dependency, entry_price,
      stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
      assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
      risk_over_single_cap, risk_budget_blocked, status, valid_until,
      source_data_timestamp, occurrence_date
    )
    values (
      v_signal_id,
      nullif(p_signal->>'scan_run_id', '')::uuid,
      p_signal->>'signal_key',
      p_signal->>'symbol',
      p_scan_group_key,
      p_signal->>'side',
      p_signal->>'primary_timeframe',
      coalesce(v_confirmation_timeframes, '{}'),
      p_signal->>'strategy_family',
      p_signal->>'strategy_version',
      v_new_score,
      coalesce(p_signal->'score_components', '{}'::jsonb),
      coalesce(p_signal->>'market_regime', 'UNKNOWN'),
      coalesce(p_signal->>'regime_dependency', 'UNKNOWN'),
      (p_signal->>'entry_price')::numeric,
      (p_signal->>'stop_price')::numeric,
      (p_signal->>'take_profit_price')::numeric,
      coalesce((p_signal->>'reward_risk')::numeric, 2),
      (p_signal->>'assumed_margin_usdt')::numeric,
      (p_signal->>'assumed_leverage')::numeric,
      (p_signal->>'position_notional_usdt')::numeric,
      v_new_risk,
      v_new_risk > p_single_risk_cap_usdt,
      true,
      'BUDGET_BLOCKED',
      (p_signal->>'valid_until')::timestamptz,
      (p_signal->>'source_data_timestamp')::timestamptz,
      (p_signal->>'occurrence_date')::date
    );

    insert into public.hy_signal_events (signal_id, event_type, payload)
    values (v_signal_id, 'BUDGET_BLOCKED', jsonb_build_object('delta_risk_usdt', v_delta));

    return jsonb_build_object('status', 'BUDGET_BLOCKED', 'signal_id', v_signal_id, 'email_allowed', false);
  end if;

  if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
    select array_agg(value) into v_confirmation_timeframes
    from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
  end if;

  if v_existing_id is not null then
    update public.hy_signals
    set status = 'REPLACED', replaced_by = v_signal_id, updated_at = now()
    where id = v_existing_id;
  end if;

  insert into public.hy_signals (
    id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
    confirmation_timeframes, strategy_family, strategy_version, score,
    score_components, market_regime, regime_dependency, entry_price,
    stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
    assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
    risk_over_single_cap, risk_budget_blocked, status, valid_until,
    source_data_timestamp, occurrence_date
  )
  values (
    v_signal_id,
    nullif(p_signal->>'scan_run_id', '')::uuid,
    p_signal->>'signal_key',
    p_signal->>'symbol',
    p_scan_group_key,
    p_signal->>'side',
    p_signal->>'primary_timeframe',
    coalesce(v_confirmation_timeframes, '{}'),
    p_signal->>'strategy_family',
    p_signal->>'strategy_version',
    v_new_score,
    coalesce(p_signal->'score_components', '{}'::jsonb),
    coalesce(p_signal->>'market_regime', 'UNKNOWN'),
    coalesce(p_signal->>'regime_dependency', 'UNKNOWN'),
    (p_signal->>'entry_price')::numeric,
    (p_signal->>'stop_price')::numeric,
    (p_signal->>'take_profit_price')::numeric,
    coalesce((p_signal->>'reward_risk')::numeric, 2),
    (p_signal->>'assumed_margin_usdt')::numeric,
    (p_signal->>'assumed_leverage')::numeric,
    (p_signal->>'position_notional_usdt')::numeric,
    v_new_risk,
    v_new_risk > p_single_risk_cap_usdt,
    false,
    'ACTIVE',
    (p_signal->>'valid_until')::timestamptz,
    (p_signal->>'source_data_timestamp')::timestamptz,
    (p_signal->>'occurrence_date')::date
  );

  update public.hy_risk_budgets
  set reserved_risk_usdt = reserved_risk_usdt + v_delta,
      new_signal_count = new_signal_count + case when v_is_new_opportunity then 1 else 0 end,
      updated_at = now()
  where budget_date = p_budget_date;

  insert into public.hy_signal_events (signal_id, event_type, payload)
  values (
    v_signal_id,
    case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    jsonb_build_object('delta_risk_usdt', v_delta, 'previous_signal_id', v_existing_id)
  );

  select count(*) into v_scan_email_count
  from public.hy_signals
  where scan_group_key = p_scan_group_key and email_reserved = true;

  if p_should_email and v_scan_email_count < p_scan_email_cap then
    update public.hy_risk_budgets
    set new_email_count = new_email_count + 1,
        updated_at = now()
    where budget_date = p_budget_date
      and new_email_count < p_daily_email_cap;
    v_email_allowed := found;
  end if;

  if v_email_allowed then
    update public.hy_signals
    set email_reserved = true,
        updated_at = now()
    where id = v_signal_id;
  end if;

  return jsonb_build_object(
    'status', case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    'signal_id', v_signal_id,
    'email_allowed', v_email_allowed,
    'risk_delta_usdt', v_delta
  );
end;
$$;

revoke execute on function public.hy_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
from public, anon, authenticated;
grant execute on function public.hy_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
to service_role;

alter table public.hy_strategy_versions enable row level security;
alter table public.hy_instruments enable row level security;
alter table public.hy_scan_runs enable row level security;
alter table public.hy_signals enable row level security;
alter table public.hy_signal_events enable row level security;
alter table public.hy_risk_budgets enable row level security;
alter table public.hy_notifications enable row level security;
alter table public.hy_backtest_runs enable row level security;
alter table public.hy_system_events enable row level security;
alter table public.hy_app_settings enable row level security;

revoke all on table
  public.hy_strategy_versions,
  public.hy_instruments,
  public.hy_scan_runs,
  public.hy_signals,
  public.hy_signal_events,
  public.hy_risk_budgets,
  public.hy_notifications,
  public.hy_backtest_runs,
  public.hy_system_events,
  public.hy_app_settings
from anon, authenticated;

insert into public.hy_app_settings (setting_key, setting_value, description)
values
  ('risk_policy', '{"margin_usdt":100,"single_signal_cap_usdt":100,"daily_budget_usdt":600,"max_leverage":20,"max_hold_hours":72}'::jsonb, 'Confirmed alert-only risk assumptions'),
  ('scan_policy', '{"timeframes":["15m","1h","4h"],"top_symbols":100,"max_new_emails_per_day":10,"same_symbol_policy":"one_active_highest_score"}'::jsonb, 'Confirmed scanner policy'),
  ('data_policy', '{"retain":"latest_results_only","raw_data":"local_only","universe":"all_usdt_m_perpetuals_light_scan_top_100_deep_scan"}'::jsonb, 'Confirmed data retention policy')
on conflict (setting_key) do nothing;

-- Final atomic signal-claim implementation.
-- Repair the signal claim function for databases that already applied the
-- initial migration before its INSERT value alignment was corrected.

create or replace function public.hy_claim_signal(
  p_signal jsonb,
  p_budget_date date,
  p_daily_limit_usdt numeric,
  p_single_risk_cap_usdt numeric,
  p_daily_email_cap integer,
  p_should_email boolean,
  p_scan_group_key text,
  p_scan_email_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signal_id uuid;
  v_existing_id uuid;
  v_existing_score numeric;
  v_existing_risk numeric := 0;
  v_new_score numeric;
  v_new_risk numeric;
  v_delta numeric;
  v_budget public.hy_risk_budgets%rowtype;
  v_email_allowed boolean := false;
  v_is_new_opportunity boolean := false;
  v_confirmation_timeframes text[] := '{}';
  v_scan_email_count integer := 0;
begin
  v_signal_id := coalesce(nullif(p_signal->>'id', '')::uuid, gen_random_uuid());
  v_new_score := (p_signal->>'score')::numeric;
  v_new_risk := (p_signal->>'theoretical_risk_usdt')::numeric;

  select id into v_existing_id
  from public.hy_signals
  where signal_key = p_signal->>'signal_key'
  limit 1;

  if v_existing_id is not null then
    return jsonb_build_object('status', 'IDEMPOTENT', 'signal_id', v_existing_id, 'email_allowed', false);
  end if;

  select id, score, theoretical_risk_usdt
    into v_existing_id, v_existing_score, v_existing_risk
  from public.hy_signals
  where symbol = p_signal->>'symbol' and status = 'ACTIVE'
  for update;

  if v_existing_id is not null and v_new_score <= v_existing_score then
    return jsonb_build_object(
      'status', 'REJECTED_LOWER_SCORE',
      'signal_id', v_existing_id,
      'email_allowed', false
    );
  end if;

  v_is_new_opportunity := v_existing_id is null;
  v_delta := greatest(v_new_risk - coalesce(v_existing_risk, 0), 0);

  insert into public.hy_risk_budgets (budget_date, daily_limit_usdt)
  values (p_budget_date, p_daily_limit_usdt)
  on conflict (budget_date) do nothing;

  select * into v_budget
  from public.hy_risk_budgets
  where budget_date = p_budget_date
  for update;

  if v_budget.reserved_risk_usdt + v_delta > v_budget.daily_limit_usdt then
    if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
      select array_agg(value) into v_confirmation_timeframes
      from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
    end if;

    insert into public.hy_signals (
      id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
      confirmation_timeframes, strategy_family, strategy_version, score,
      score_components, market_regime, regime_dependency, entry_price,
      stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
      assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
      risk_over_single_cap, risk_budget_blocked, status, valid_until,
      source_data_timestamp, occurrence_date
    )
    values (
      v_signal_id,
      nullif(p_signal->>'scan_run_id', '')::uuid,
      p_signal->>'signal_key',
      p_signal->>'symbol',
      p_scan_group_key,
      p_signal->>'side',
      p_signal->>'primary_timeframe',
      coalesce(v_confirmation_timeframes, '{}'),
      p_signal->>'strategy_family',
      p_signal->>'strategy_version',
      v_new_score,
      coalesce(p_signal->'score_components', '{}'::jsonb),
      coalesce(p_signal->>'market_regime', 'UNKNOWN'),
      coalesce(p_signal->>'regime_dependency', 'UNKNOWN'),
      (p_signal->>'entry_price')::numeric,
      (p_signal->>'stop_price')::numeric,
      (p_signal->>'take_profit_price')::numeric,
      coalesce((p_signal->>'reward_risk')::numeric, 2),
      (p_signal->>'assumed_margin_usdt')::numeric,
      (p_signal->>'assumed_leverage')::numeric,
      (p_signal->>'position_notional_usdt')::numeric,
      v_new_risk,
      v_new_risk > p_single_risk_cap_usdt,
      true,
      'BUDGET_BLOCKED',
      (p_signal->>'valid_until')::timestamptz,
      (p_signal->>'source_data_timestamp')::timestamptz,
      (p_signal->>'occurrence_date')::date
    );

    insert into public.hy_signal_events (signal_id, event_type, payload)
    values (v_signal_id, 'BUDGET_BLOCKED', jsonb_build_object('delta_risk_usdt', v_delta));

    return jsonb_build_object('status', 'BUDGET_BLOCKED', 'signal_id', v_signal_id, 'email_allowed', false);
  end if;

  if jsonb_typeof(p_signal->'confirmation_timeframes') = 'array' then
    select array_agg(value) into v_confirmation_timeframes
    from jsonb_array_elements_text(p_signal->'confirmation_timeframes');
  end if;

  if v_existing_id is not null then
    update public.hy_signals
    set status = 'REPLACED', replaced_by = null, updated_at = now()
    where id = v_existing_id;
  end if;

  insert into public.hy_signals (
    id, scan_run_id, signal_key, symbol, scan_group_key, side, primary_timeframe,
    confirmation_timeframes, strategy_family, strategy_version, score,
    score_components, market_regime, regime_dependency, entry_price,
    stop_price, take_profit_price, reward_risk, assumed_margin_usdt,
    assumed_leverage, position_notional_usdt, theoretical_risk_usdt,
    risk_over_single_cap, risk_budget_blocked, status, valid_until,
    source_data_timestamp, occurrence_date
  )
  values (
    v_signal_id,
    nullif(p_signal->>'scan_run_id', '')::uuid,
    p_signal->>'signal_key',
    p_signal->>'symbol',
    p_scan_group_key,
    p_signal->>'side',
    p_signal->>'primary_timeframe',
    coalesce(v_confirmation_timeframes, '{}'),
    p_signal->>'strategy_family',
    p_signal->>'strategy_version',
    v_new_score,
    coalesce(p_signal->'score_components', '{}'::jsonb),
    coalesce(p_signal->>'market_regime', 'UNKNOWN'),
    coalesce(p_signal->>'regime_dependency', 'UNKNOWN'),
    (p_signal->>'entry_price')::numeric,
    (p_signal->>'stop_price')::numeric,
    (p_signal->>'take_profit_price')::numeric,
    coalesce((p_signal->>'reward_risk')::numeric, 2),
    (p_signal->>'assumed_margin_usdt')::numeric,
    (p_signal->>'assumed_leverage')::numeric,
    (p_signal->>'position_notional_usdt')::numeric,
    v_new_risk,
    v_new_risk > p_single_risk_cap_usdt,
    false,
    'ACTIVE',
    (p_signal->>'valid_until')::timestamptz,
    (p_signal->>'source_data_timestamp')::timestamptz,
    (p_signal->>'occurrence_date')::date
  );

  if v_existing_id is not null then
    update public.hy_signals
    set replaced_by = v_signal_id, updated_at = now()
    where id = v_existing_id;
  end if;

  update public.hy_risk_budgets
  set reserved_risk_usdt = reserved_risk_usdt + v_delta,
      new_signal_count = new_signal_count + case when v_is_new_opportunity then 1 else 0 end,
      updated_at = now()
  where budget_date = p_budget_date;

  insert into public.hy_signal_events (signal_id, event_type, payload)
  values (
    v_signal_id,
    case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    jsonb_build_object('delta_risk_usdt', v_delta, 'previous_signal_id', v_existing_id)
  );

  select count(*) into v_scan_email_count
  from public.hy_signals
  where scan_group_key = p_scan_group_key and email_reserved = true;

  if p_should_email and v_scan_email_count < p_scan_email_cap then
    update public.hy_risk_budgets
    set new_email_count = new_email_count + 1,
        updated_at = now()
    where budget_date = p_budget_date
      and new_email_count < p_daily_email_cap;
    v_email_allowed := found;
  end if;

  if v_email_allowed then
    update public.hy_signals
    set email_reserved = true,
        updated_at = now()
    where id = v_signal_id;
  end if;

  return jsonb_build_object(
    'status', case when v_existing_id is null then 'CREATED' else 'REPLACED' end,
    'signal_id', v_signal_id,
    'email_allowed', v_email_allowed,
    'risk_delta_usdt', v_delta
  );
end;
$$;

revoke execute on function public.hy_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
from public, anon, authenticated;
grant execute on function public.hy_claim_signal(jsonb, date, numeric, numeric, integer, boolean, text, integer)
to service_role;

-- Paper-trading ledger and replacement lifecycle.
-- Paper-trading ledger for the bca signal scanner.
-- This table stores derived results only; raw Binance candles remain local.

create table public.hy_paper_trades (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null unique references public.hy_signals(id) on delete cascade,
  symbol text not null references public.hy_instruments(symbol) on delete restrict,
  side text not null check (side in ('LONG', 'SHORT')),
  strategy_family text not null,
  strategy_version text not null,
  entry_time timestamptz not null,
  entry_price numeric(30, 12) not null check (entry_price > 0),
  entry_fill_price numeric(30, 12) not null check (entry_fill_price > 0),
  stop_price numeric(30, 12) not null check (stop_price > 0),
  take_profit_price numeric(30, 12) not null check (take_profit_price > 0),
  max_hold_until timestamptz not null,
  quantity numeric(30, 12) not null check (quantity > 0),
  assumed_margin_usdt numeric(20, 8) not null check (assumed_margin_usdt > 0),
  assumed_leverage numeric(10, 4) not null check (assumed_leverage > 0),
  position_notional_usdt numeric(20, 8) not null check (position_notional_usdt > 0),
  theoretical_risk_usdt numeric(20, 8) not null check (theoretical_risk_usdt >= 0),
  status text not null default 'OPEN'
    check (status in ('OPEN', 'TAKE_PROFIT', 'STOP_LOSS', 'TIME_LIMIT', 'DATA_END', 'CANCELLED', 'ERROR')),
  last_price numeric(30, 12) not null check (last_price > 0),
  last_candle_close_time timestamptz,
  last_checked_at timestamptz not null default now(),
  unrealized_pnl_usdt numeric(20, 8) not null default 0,
  exit_time timestamptz,
  exit_price numeric(30, 12),
  exit_reason text,
  gross_pnl_usdt numeric(20, 8),
  fees_usdt numeric(20, 8) not null default 0,
  funding_usdt numeric(20, 8) not null default 0,
  slippage_usdt numeric(20, 8) not null default 0,
  net_pnl_usdt numeric(20, 8),
  r_multiple numeric(20, 8),
  settlement_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((side = 'LONG' and stop_price < entry_price) or (side = 'SHORT' and stop_price > entry_price)),
  check ((side = 'LONG' and take_profit_price > entry_price) or (side = 'SHORT' and take_profit_price < entry_price)),
  check (status = 'OPEN' or exit_time is not null or status = 'CANCELLED')
);

create index hy_paper_trades_open_hold_idx
  on public.hy_paper_trades (status, max_hold_until)
  where status = 'OPEN';

create index hy_paper_trades_symbol_entry_idx
  on public.hy_paper_trades (symbol, entry_time desc);

create trigger hy_paper_trades_set_updated_at
before update on public.hy_paper_trades
for each row execute function public.hy_set_updated_at();

-- A higher-scored signal replaces the previous same-symbol signal. Keep the
-- paper ledger aligned so the old signal cannot remain an open paper position.
create or replace function public.hy_cancel_replaced_paper_trade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'REPLACED' and old.status = 'ACTIVE' then
    update public.hy_paper_trades
    set status = 'CANCELLED',
        exit_reason = 'SIGNAL_REPLACED',
        last_checked_at = now(),
        settlement_error = null,
        updated_at = now()
    where signal_id = new.id and status = 'OPEN';
  end if;
  return new;
end;
$$;

drop trigger if exists hy_signals_cancel_replaced_paper_trade on public.hy_signals;
create trigger hy_signals_cancel_replaced_paper_trade
after update of status on public.hy_signals
for each row execute function public.hy_cancel_replaced_paper_trade();

revoke execute on function public.hy_cancel_replaced_paper_trade() from public, anon, authenticated;
grant execute on function public.hy_cancel_replaced_paper_trade() to service_role;

alter table public.hy_paper_trades enable row level security;
revoke all on table public.hy_paper_trades from anon, authenticated;
grant all on table public.hy_paper_trades to service_role;

-- Explicit strategy approval and activation gate.
-- Strategy versions are optimizer artifacts until an operator explicitly
-- activates one through the authenticated API route.

create or replace function public.hy_promote_strategy_version(
  p_version text,
  p_target_status text,
  p_min_profit_factor numeric,
  p_min_oos_signals integer,
  p_max_drawdown_percent numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.hy_strategy_versions%rowtype;
  v_oos jsonb;
  v_net_pnl numeric;
  v_profit_factor numeric;
  v_signals numeric;
  v_max_drawdown numeric;
begin
  if nullif(trim(p_version), '') is null then
    raise exception 'Strategy version is required';
  end if;
  if p_min_profit_factor <= 0 or p_min_oos_signals < 0 or p_max_drawdown_percent <= 0 then
    raise exception 'Invalid strategy approval thresholds';
  end if;
  if p_target_status not in ('PAPER', 'ACTIVE') then
    raise exception 'Target status must be PAPER or ACTIVE';
  end if;

  select * into v_target
  from public.hy_strategy_versions
  where version = p_version
  for update;

  if not found then
    raise exception 'Strategy version % was not found', p_version;
  end if;
  if jsonb_typeof(v_target.parameters->'runtime') <> 'object' then
    raise exception 'Strategy version % has no runtime policy payload', p_version;
  end if;

  v_oos := v_target.metrics->'out_of_sample';
  if v_oos is null then
    v_oos := v_target.metrics->'outOfSample';
  end if;
  if jsonb_typeof(v_oos) <> 'object' then
    raise exception 'Strategy version % has no out-of-sample metrics', p_version;
  end if;

  v_net_pnl := coalesce(
    nullif(v_oos->>'netPnlUsdt', '')::numeric,
    nullif(v_oos->>'net_pnl_usdt', '')::numeric
  );
  v_profit_factor := coalesce(
    nullif(v_oos->>'profitFactor', '')::numeric,
    nullif(v_oos->>'profit_factor', '')::numeric
  );
  v_signals := coalesce(
    nullif(v_oos->>'trades', '')::numeric,
    nullif(v_oos->>'signals', '')::numeric,
    0
  );
  v_max_drawdown := coalesce(
    nullif(v_oos->>'maxDrawdownPercent', '')::numeric,
    nullif(v_oos->>'max_drawdown_percent', '')::numeric
  );

  if v_net_pnl is null
     or v_profit_factor is null
     or v_max_drawdown is null
     or v_net_pnl <= 0
     or v_profit_factor < p_min_profit_factor
     or v_signals < p_min_oos_signals
     or v_max_drawdown > p_max_drawdown_percent then
    raise exception 'Strategy version % failed the approval gate (net_pnl=%, profit_factor=%, signals=%, max_drawdown=%)',
      p_version, v_net_pnl, v_profit_factor, v_signals, v_max_drawdown;
  end if;

  update public.hy_strategy_versions
  set status = 'RETIRED'
  where status = p_target_status and version <> p_version;

  update public.hy_strategy_versions
  set status = p_target_status
  where version = p_version;

  return jsonb_build_object(
    'version', p_version,
    'status', p_target_status,
    'profit_factor', v_profit_factor,
    'out_of_sample_signals', v_signals,
    'max_drawdown_percent', v_max_drawdown
  );
end;
$$;

revoke execute on function public.hy_promote_strategy_version(text, text, numeric, integer, numeric)
from public, anon, authenticated;
grant execute on function public.hy_promote_strategy_version(text, text, numeric, integer, numeric)
to service_role;

-- Signal expiry lifecycle.
-- Expire alert opportunities when their validity window closes. Expiry is a
-- state transition with an auditable event, not a silent cleanup delete.

alter table public.hy_signals
  drop constraint if exists hy_signals_status_check;
alter table public.hy_signals
  drop constraint if exists hy_signals_status_check;
alter table public.hy_signals
  add constraint hy_signals_status_check
  check (status in ('ACTIVE', 'REPLACED', 'BUDGET_BLOCKED', 'MANUALLY_CLOSED', 'EXPIRED'));

alter table public.hy_signal_events
  drop constraint if exists hy_signal_events_event_type_check;
alter table public.hy_signal_events
  drop constraint if exists hy_signal_events_event_type_check;
alter table public.hy_signal_events
  add constraint hy_signal_events_event_type_check
  check (event_type in ('CREATED', 'REPLACED', 'EMAIL_QUEUED', 'EMAIL_SENT', 'EMAIL_FAILED', 'BUDGET_BLOCKED', 'EXPIRED', 'ERROR'));

create index if not exists hy_signals_symbol_source_timestamp_idx
  on public.hy_signals (symbol, source_data_timestamp desc);

create or replace function public.hy_expire_signals(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.hy_signals
    set status = 'EXPIRED',
        updated_at = now()
    where status = 'ACTIVE'
      and valid_until <= p_now
    returning id
  )
  insert into public.hy_signal_events (signal_id, event_type, payload)
  select id, 'EXPIRED', jsonb_build_object('expired_at', p_now)
  from expired;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.hy_expire_signals(timestamptz)
from public, anon, authenticated;
grant execute on function public.hy_expire_signals(timestamptz)
to service_role;

-- Paper exit-profile comparison support.
-- Allow one paper signal to be evaluated under multiple exit profiles.
-- This is paper-only shadow accounting; it does not create exchange orders.

alter table public.hy_paper_trades
  add column if not exists exit_profile text not null default 'PRIMARY_2R';

alter table public.hy_paper_trades
  drop constraint if exists hy_paper_trades_signal_id_key;

alter table public.hy_paper_trades
  add constraint hy_paper_trades_signal_exit_profile_key
  unique (signal_id, exit_profile);

alter table public.hy_paper_trades
  add constraint hy_paper_trades_exit_profile_check
  check (exit_profile in ('PRIMARY_2R', 'AB_2_5R'));

create index if not exists hy_paper_trades_profile_status_idx
  on public.hy_paper_trades (exit_profile, status, entry_time desc);

-- The reviewed one-year candidate starts in PAPER only. Its 29-trade OOS
-- sample is sufficient for observation, but deliberately below the 200-trade
-- ACTIVE gate.
insert into public.hy_strategy_versions (
  version,
  strategy_family,
  parameters,
  training_start_date,
  training_end_date,
  oos_start_date,
  oos_end_date,
  metrics,
  status
)
values (
  'hy-paper-candidate-v2',
  'TREND',
  $json${
    "runtime": {
      "version": "hy-paper-candidate-v2",
      "params": {
        "entryMode": "TREND_PULLBACK",
        "emaFast": 20,
        "emaSlow": 50,
        "rsiPeriod": 14,
        "atrPeriod": 14,
        "stopAtrMultiplier": 0.75,
        "breakoutPeriod": 20,
        "breakoutVolumeRatio": 1.15,
        "meanReversionRsiLow": 35,
        "meanReversionRsiHigh": 65,
        "bollingerPeriod": 20,
        "bollingerDeviation": 2
      },
      "minScore": 80,
      "sideFilter": "SHORT",
      "strategyFamily": "TREND",
      "requireRegimeAlignment": true,
      "riskPolicy": {
        "marginUsdt": 100,
        "leverage": 20,
        "singleSignalRiskCapUsdt": 50,
        "dailyRiskBudgetUsdt": 600,
        "maxHoldHours": 48,
        "rewardRisk": 2,
        "riskPerTradeUsdt": 50,
        "maxPositionNotionalUsdt": 10000
      },
      "cooldownHours": 24,
      "maxExecutionCostRiskFraction": 0.1,
      "takerFeeRate": 0.0004,
      "slippageBps": 2,
      "globalRegimeAlignment": true,
      "globalReferenceSymbol": "BTCUSDT",
      "globalReferenceTimeframe": "4h"
    }
  }$json$::jsonb,
  date '2025-08-09',
  date '2026-05-08',
  date '2026-05-09',
  date '2026-08-09',
  $json${
    "out_of_sample": {
      "trades": 29,
      "netPnlUsdt": 469.3117,
      "profitFactor": 1.6,
      "maxDrawdownPercent": 3.5108
    },
    "rolling_base": {
      "trades": 216,
      "netPnlUsdt": 1429.5988,
      "profitableFolds": 3,
      "folds": 4,
      "maxDrawdownPercent": 9.2414
    },
    "rolling_cost_stress": {
      "trades": 216,
      "netPnlUsdt": 934.1459,
      "profitableFolds": 3,
      "folds": 4,
      "maxDrawdownPercent": 9.9922
    },
    "decision": "paper-forward-validation-only"
  }$json$::jsonb,
  'PAPER'
);

insert into public.hy_app_settings (setting_key, setting_value, description)
values (
  'deployment_mode',
  '{"stage":"PAPER","exchange_orders_enabled":false}'::jsonb,
  'Hard deployment marker. HeYue observation deployments never place exchange orders.'
);


-- Data API privileges are explicit and separate from RLS. Only the server-side
-- service role receives table access; anon and authenticated remain revoked.
grant all on table
  public.hy_strategy_versions,
  public.hy_instruments,
  public.hy_scan_runs,
  public.hy_signals,
  public.hy_signal_events,
  public.hy_risk_budgets,
  public.hy_notifications,
  public.hy_backtest_runs,
  public.hy_system_events,
  public.hy_app_settings,
  public.hy_paper_trades
to service_role;
