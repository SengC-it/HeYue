-- HY-R6.2C B4 live shadow foundation.
-- Additive review artifact only. Do not apply to Production in R6.2C.
-- The previously applied 20260909132405_hy_r61_b4_shadow_signal_engine.sql
-- remains immutable.

create table public.hy_b4_shadow_feature_state (
  symbol text primary key check (char_length(btrim(symbol)) between 1 and 32),
  version text not null check (version = 'hy-b4-shadow-v1'),
  current_direction text check (current_direction in ('BULLISH', 'BEARISH')),
  last_evaluated_closed_bar timestamptz,
  current_episode_key text,
  rolling_primitives jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rolling_primitives) = 'array'),
  updated_at timestamptz not null default now()
);

create table public.hy_b4_shadow_runtime_state (
  singleton_key text primary key check (singleton_key = 'B4'),
  enabled boolean not null default false,
  version text not null check (version = 'hy-b4-shadow-v1'),
  status text not null check (status in ('DISABLED', 'WARMING_UP', 'READY', 'DEGRADED', 'FAILED')),
  last_evaluation_at timestamptz,
  last_closed_bar_evaluated timestamptz,
  warmup_ready boolean not null default false,
  eligible_symbols text[] not null default '{}',
  conditions_evaluated integer not null default 0 check (conditions_evaluated >= 0),
  events_generated integer not null default 0 check (events_generated >= 0),
  long_watch integer not null default 0 check (long_watch >= 0),
  short_watch integer not null default 0 check (short_watch >= 0),
  duplicates_suppressed integer not null default 0 check (duplicates_suppressed >= 0),
  data_incomplete integer not null default 0 check (data_incomplete >= 0),
  pit_failures integer not null default 0 check (pit_failures >= 0),
  last_error text,
  email_sent smallint not null default 0 check (email_sent = 0),
  updated_at timestamptz not null default now(),
  constraint hy_b4_shadow_runtime_disabled_consistent
    check (not enabled or status <> 'DISABLED')
);

create index hy_b4_shadow_feature_state_updated_idx
  on public.hy_b4_shadow_feature_state (updated_at desc);

create index hy_b4_shadow_runtime_state_updated_idx
  on public.hy_b4_shadow_runtime_state (updated_at desc);

-- Non-event, PIT-safe observations retained for future Control-B matching.
-- This is additive and deliberately does not reuse hy_shadow_signal_events.
create table public.hy_b4_shadow_control_candidates (
  control_event_id uuid primary key default gen_random_uuid(),
  symbol text not null check (char_length(btrim(symbol)) between 1 and 32),
  market_timestamp timestamptz not null,
  pit_available_at timestamptz not null,
  reference_price numeric(30, 12) not null check (reference_price > 0),
  calendar_period text not null,
  market_regime text not null check (market_regime <> 'UNKNOWN'),
  volatility_bucket text not null check (volatility_bucket <> 'UNKNOWN'),
  liquidity_bucket text not null check (liquidity_bucket <> 'UNKNOWN'),
  funding_state text not null,
  mark_index_basis_state text not null,
  source text not null check (source = 'B4_NON_EVENT'),
  created_at timestamptz not null default now(),
  unique (symbol, market_timestamp),
  check (pit_available_at >= market_timestamp)
);

create index hy_b4_shadow_control_candidates_match_idx
  on public.hy_b4_shadow_control_candidates (
    symbol, calendar_period, market_regime, volatility_bucket,
    liquidity_bucket, funding_state, mark_index_basis_state,
    pit_available_at desc
  );

-- The row lock makes TRUE/FALSE transitions safe across Vercel invocations.
-- The placeholder insert closes the first-observation race before the row lock
-- is acquired. A FALSE direction resets the episode; a non-null direction
-- returns TRUE only when the prior durable state was not the same direction.
create or replace function public.hy_b4_shadow_transition_episode(
  p_symbol text,
  p_direction text,
  p_closed_bar timestamptz,
  p_episode_key text,
  p_version text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous_direction text;
  previous_closed_bar timestamptz;
  previous_episode_key text;
begin
  if p_symbol is null or char_length(btrim(p_symbol)) not between 1 and 32 then
    raise exception 'invalid B4 shadow symbol';
  end if;
  if p_version <> 'hy-b4-shadow-v1' then
    raise exception 'unsupported B4 shadow version';
  end if;
  if p_direction is not null and p_direction not in ('BULLISH', 'BEARISH') then
    raise exception 'unsupported B4 shadow direction';
  end if;
  if p_closed_bar is null then
    raise exception 'closed bar is required';
  end if;

  insert into public.hy_b4_shadow_feature_state (
    symbol, version, current_direction, last_evaluated_closed_bar,
    current_episode_key
  ) values (
    p_symbol, p_version, null, null, null
  )
  on conflict (symbol) do nothing;

  select current_direction
       , last_evaluated_closed_bar
       , current_episode_key
    into previous_direction
       , previous_closed_bar
       , previous_episode_key
    from public.hy_b4_shadow_feature_state
   where symbol = p_symbol
   for update;

  if previous_closed_bar is not null and p_closed_bar < previous_closed_bar then
    return false;
  end if;
  if previous_closed_bar is not null and p_closed_bar = previous_closed_bar
     and (previous_direction is distinct from p_direction
       or previous_episode_key is distinct from p_episode_key) then
    raise exception 'B4 same-bar transition invariant failure';
  end if;

  if previous_closed_bar is not null and p_closed_bar = previous_closed_bar then
    return false;
  end if;

  update public.hy_b4_shadow_feature_state
     set version = p_version,
         current_direction = p_direction,
         last_evaluated_closed_bar = p_closed_bar,
         current_episode_key = p_episode_key,
         updated_at = now()
   where symbol = p_symbol;

  return p_direction is not null and previous_direction is distinct from p_direction;
end;
$$;

-- Monotonic rolling-tail persistence. An older or shorter incremental result
-- cannot rewind the durable state established by a newer closed bar.
create or replace function public.hy_b4_shadow_upsert_feature_state(
  p_symbol text,
  p_version text,
  p_last_evaluated_closed_bar timestamptz,
  p_rolling_primitives jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous_closed_bar timestamptz;
  previous_length integer;
begin
  if p_symbol is null or char_length(btrim(p_symbol)) not between 1 and 32 then
    raise exception 'invalid B4 shadow symbol';
  end if;
  if p_version <> 'hy-b4-shadow-v1' then
    raise exception 'unsupported B4 shadow version';
  end if;
  if p_last_evaluated_closed_bar is null or p_rolling_primitives is null
     or jsonb_typeof(p_rolling_primitives) <> 'array' then
    raise exception 'invalid B4 feature state payload';
  end if;

  insert into public.hy_b4_shadow_feature_state (symbol, version)
  values (p_symbol, p_version)
  on conflict (symbol) do nothing;

  select last_evaluated_closed_bar, jsonb_array_length(rolling_primitives)
    into previous_closed_bar, previous_length
    from public.hy_b4_shadow_feature_state
   where symbol = p_symbol
   for update;

  if previous_closed_bar is not null and p_last_evaluated_closed_bar < previous_closed_bar then
    return 'STALE';
  end if;
  if jsonb_array_length(p_rolling_primitives) < previous_length then
    return 'STALE';
  end if;

  update public.hy_b4_shadow_feature_state
     set version = p_version,
         last_evaluated_closed_bar = p_last_evaluated_closed_bar,
         rolling_primitives = p_rolling_primitives,
         updated_at = now()
   where symbol = p_symbol;
  return 'UPDATED';
end;
$$;

-- Atomic B4 FALSE->TRUE claim plus canonical event insert. No JavaScript
-- ordering can split the durable transition from its event evidence.
create or replace function public.hy_b4_shadow_transition_and_insert(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_symbol text;
  v_direction text;
  v_episode_key text;
  v_event_id uuid;
  v_version text;
  v_closed_bar timestamptz;
  v_previous_direction text;
  v_previous_closed_bar timestamptz;
  v_previous_episode_key text;
  v_inserted integer;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception 'B4 event object is required';
  end if;
  v_symbol := nullif(btrim(p_event->>'symbol'), '');
  v_direction := p_event->>'direction';
  v_episode_key := nullif(btrim(p_event->>'episode_key'), '');
  v_version := p_event->>'version';
  if v_symbol is null or char_length(v_symbol) > 32 then
    raise exception 'invalid B4 shadow symbol';
  end if;
  if v_direction not in ('BULLISH', 'BEARISH') then
    raise exception 'unsupported B4 shadow direction';
  end if;
  if v_version <> 'hy-b4-shadow-v1' or v_episode_key is null then
    raise exception 'invalid B4 shadow event identity';
  end if;
  if nullif(p_event->>'event_id', '') is null
     or nullif(p_event->>'market_timestamp', '') is null then
    raise exception 'B4 event id and market timestamp are required';
  end if;
  v_event_id := (p_event->>'event_id')::uuid;
  v_closed_bar := (p_event->>'market_timestamp')::timestamptz;

  insert into public.hy_b4_shadow_feature_state (symbol, version)
  values (v_symbol, v_version)
  on conflict (symbol) do nothing;

  select current_direction, last_evaluated_closed_bar, current_episode_key
    into v_previous_direction, v_previous_closed_bar, v_previous_episode_key
    from public.hy_b4_shadow_feature_state
   where symbol = v_symbol
   for update;

  if v_previous_closed_bar is not null and v_closed_bar < v_previous_closed_bar then
    return jsonb_build_object('result', 'STALE_OBSERVATION', 'event_id', null);
  end if;
  if v_previous_closed_bar is not null and v_closed_bar = v_previous_closed_bar then
    if v_previous_direction = v_direction and v_previous_episode_key = v_episode_key then
      return jsonb_build_object('result', 'SAME_BAR_RETRY', 'event_id', v_event_id);
    end if;
    raise exception 'B4 same-bar transition invariant failure';
  end if;

  if v_previous_direction = v_direction then
    update public.hy_b4_shadow_feature_state
       set last_evaluated_closed_bar = v_closed_bar,
           current_episode_key = v_episode_key,
           updated_at = now()
     where symbol = v_symbol;
    return jsonb_build_object('result', 'DUPLICATE_TRUE', 'event_id', v_event_id);
  end if;

  insert into public.hy_shadow_signal_events (
    event_id, episode_key, experiment, version, created_at, market_timestamp,
    pit_available_at, symbol, direction, alert_type, family, hypothesis,
    feature_version, cutoff_version, perpetual_price, premium_value,
    price_change_value, premium_change_value, price_percentile,
    premium_change_percentile, funding_state, mark_index_basis_state,
    market_regime, volatility_bucket, liquidity_bucket, calendar_period,
    data_completeness, pit_status, dedup_state, shadow_status, control_status,
    control_event_id, control_match_key
  ) values (
    v_event_id,
    v_episode_key,
    p_event->>'experiment',
    v_version,
    (p_event->>'created_at')::timestamptz,
    v_closed_bar,
    (p_event->>'pit_available_at')::timestamptz,
    v_symbol,
    v_direction,
    p_event->>'alert_type',
    p_event->>'family',
    p_event->>'hypothesis',
    p_event->>'feature_version',
    p_event->>'cutoff_version',
    (p_event->>'perpetual_price')::numeric,
    (p_event->>'premium_value')::numeric,
    (p_event->>'price_change_value')::numeric,
    (p_event->>'premium_change_value')::numeric,
    (p_event->>'price_percentile')::numeric,
    (p_event->>'premium_change_percentile')::numeric,
    p_event->'funding_state',
    p_event->'mark_index_basis_state',
    p_event->>'market_regime',
    p_event->>'volatility_bucket',
    p_event->>'liquidity_bucket',
    p_event->>'calendar_period',
    p_event->>'data_completeness',
    p_event->>'pit_status',
    p_event->>'dedup_state',
    p_event->>'shadow_status',
    p_event->>'control_status',
    nullif(p_event->>'control_event_id', ''),
    p_event->>'control_match_key'
  ) on conflict (episode_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select event_id into v_event_id
      from public.hy_shadow_signal_events
     where episode_key = v_episode_key;
    return jsonb_build_object('result', 'DUPLICATE_TRUE', 'event_id', v_event_id);
  end if;

  update public.hy_b4_shadow_feature_state
     set current_direction = v_direction,
         last_evaluated_closed_bar = v_closed_bar,
         current_episode_key = v_episode_key,
         updated_at = now()
   where symbol = v_symbol;
  return jsonb_build_object('result', 'NEW_EVENT', 'event_id', v_event_id);
end;
$$;

alter table public.hy_b4_shadow_feature_state enable row level security;
alter table public.hy_b4_shadow_runtime_state enable row level security;
alter table public.hy_b4_shadow_control_candidates enable row level security;

revoke all on table
  public.hy_b4_shadow_feature_state,
  public.hy_b4_shadow_runtime_state,
  public.hy_b4_shadow_control_candidates
from public, anon, authenticated;

grant select, insert, update on table public.hy_b4_shadow_feature_state to service_role;
grant select, insert, update on table public.hy_b4_shadow_runtime_state to service_role;
grant select, insert, update on table public.hy_b4_shadow_control_candidates to service_role;

revoke all on function public.hy_b4_shadow_transition_episode(text, text, timestamptz, text, text)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_transition_episode(text, text, timestamptz, text, text)
to service_role;

revoke all on function public.hy_b4_shadow_upsert_feature_state(text, text, timestamptz, jsonb)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_upsert_feature_state(text, text, timestamptz, jsonb)
to service_role;

revoke all on function public.hy_b4_shadow_transition_and_insert(jsonb)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_transition_and_insert(jsonb)
to service_role;
