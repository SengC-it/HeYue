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
  funding_bucket text not null check (funding_bucket in ('NEGATIVE', 'NEUTRAL', 'POSITIVE')),
  mark_index_basis_bucket text not null check (mark_index_basis_bucket in ('EXTREME_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'EXTREME_POSITIVE')),
  source text not null check (source = 'B4_NON_EVENT'),
  created_at timestamptz not null default now(),
  unique (symbol, market_timestamp),
  check (pit_available_at >= market_timestamp)
);

create index hy_b4_shadow_control_candidates_match_idx
  on public.hy_b4_shadow_control_candidates (
    symbol, calendar_period, market_regime, volatility_bucket,
    liquidity_bucket, funding_bucket, mark_index_basis_bucket,
    pit_available_at desc
  );

-- Control-B is without-replacement within each direction-specific matching
-- pass. One control may therefore be claimed once by BULLISH and once by
-- BEARISH, while one event can have at most one control claim.
create table public.hy_b4_shadow_control_claims (
  control_event_id uuid not null references public.hy_b4_shadow_control_candidates(control_event_id) on delete restrict,
  direction text not null check (direction in ('BULLISH', 'BEARISH')),
  event_id uuid not null references public.hy_shadow_signal_events(event_id) on delete restrict,
  claimed_at timestamptz not null default now(),
  primary key (control_event_id, direction),
  unique (event_id)
);

create index hy_b4_shadow_control_claims_event_idx
  on public.hy_b4_shadow_control_claims (event_id);

-- Durable Control-B outcome evidence. The origin is the control observation,
-- not the matched signal event, and the unique key makes each horizon idempotent.
create table public.hy_b4_shadow_control_outcomes (
  control_event_id uuid not null,
  direction text not null check (direction in ('BULLISH', 'BEARISH')),
  horizon_hours smallint not null check (horizon_hours in (1, 4, 12, 24)),
  future_observation_timestamp timestamptz not null,
  future_available_at timestamptz not null,
  reference_price numeric(30, 12) not null check (reference_price > 0),
  future_price numeric(30, 12) not null check (future_price > 0),
  signed_return numeric(30, 18) not null,
  max_favorable_move numeric(30, 18) not null,
  max_adverse_move numeric(30, 18) not null,
  pit_safe boolean not null check (pit_safe),
  outcome_status text not null check (outcome_status = 'MATURED'),
  calculation_version text not null check (calculation_version = 'hy-b4-shadow-v1'),
  created_at timestamptz not null default now(),
  primary key (control_event_id, direction, horizon_hours),
  foreign key (control_event_id, direction)
    references public.hy_b4_shadow_control_claims(control_event_id, direction)
    on delete restrict,
  check (future_available_at >= future_observation_timestamp)
);

create index hy_b4_shadow_control_outcomes_due_idx
  on public.hy_b4_shadow_control_outcomes (future_observation_timestamp, control_event_id);

create table public.hy_b4_shadow_context_staging (
  context_group_key text not null,
  market_timestamp timestamptz not null,
  symbol text not null check (char_length(btrim(symbol)) between 1 and 32),
  expected_symbols text[] not null check (cardinality(expected_symbols) > 0),
  pit_available_at timestamptz not null,
  reference_price numeric(30, 12) not null check (reference_price > 0),
  quote_volume_mean numeric(30, 12) not null check (quote_volume_mean >= 0),
  four_hour_return numeric(30, 18) not null,
  volatility_value numeric(30, 18) not null check (volatility_value >= 0),
  volatility_bucket text not null check (volatility_bucket in ('LOW', 'NORMAL', 'HIGH')),
  funding_bucket text not null check (funding_bucket in ('NEGATIVE', 'NEUTRAL', 'POSITIVE')),
  mark_index_basis_bucket text not null check (mark_index_basis_bucket in ('EXTREME_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'EXTREME_POSITIVE')),
  observation jsonb not null check (jsonb_typeof(observation) = 'object'),
  created_at timestamptz not null default now(),
  primary key (context_group_key, market_timestamp, symbol)
);

create table public.hy_b4_shadow_context_finalized (
  context_group_key text not null,
  market_timestamp timestamptz not null,
  expected_symbols text[] not null,
  market_regime text not null check (market_regime in ('UP', 'DOWN', 'RANGE')),
  context_rows jsonb not null check (jsonb_typeof(context_rows) = 'array'),
  finalized_at timestamptz not null default now(),
  primary key (context_group_key, market_timestamp)
);

create index hy_b4_shadow_context_staging_timestamp_idx
  on public.hy_b4_shadow_context_staging (context_group_key, market_timestamp, symbol);
create index hy_b4_shadow_context_finalized_timestamp_idx
  on public.hy_b4_shadow_context_finalized (market_timestamp desc);

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
  v_control_status text := 'CONTROL_UNAVAILABLE';
  v_control_event_id uuid;
  v_control_match_key text;
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
  v_control_match_key := concat_ws('|',
    v_symbol,
    p_event->>'calendar_period',
    p_event->>'market_regime',
    p_event->>'volatility_bucket',
    p_event->>'liquidity_bucket',
    p_event->'funding_state'->>'bucket',
    p_event->'mark_index_basis_state'->>'bucket'
  );

  insert into public.hy_b4_shadow_feature_state (symbol, version)
  values (v_symbol, v_version)
  on conflict (symbol) do nothing;

  select current_direction, last_evaluated_closed_bar, current_episode_key
    into v_previous_direction, v_previous_closed_bar, v_previous_episode_key
    from public.hy_b4_shadow_feature_state
   where symbol = v_symbol
   for update;

  if v_previous_closed_bar is not null and v_closed_bar < v_previous_closed_bar then
    return jsonb_build_object('result', 'STALE_OBSERVATION', 'event_id', null,
      'control_status', v_control_status, 'control_event_id', null,
      'control_match_key', v_control_match_key);
  end if;
  if v_previous_closed_bar is not null and v_closed_bar = v_previous_closed_bar then
    if v_previous_direction = v_direction and v_previous_episode_key = v_episode_key then
      return jsonb_build_object('result', 'SAME_BAR_RETRY', 'event_id', v_event_id,
        'control_status', v_control_status, 'control_event_id', null,
        'control_match_key', v_control_match_key);
    end if;
    raise exception 'B4 same-bar transition invariant failure';
  end if;

  if v_previous_direction = v_direction then
    update public.hy_b4_shadow_feature_state
       set last_evaluated_closed_bar = v_closed_bar,
           current_episode_key = v_episode_key,
           updated_at = now()
     where symbol = v_symbol;
    return jsonb_build_object('result', 'DUPLICATE_TRUE', 'event_id', v_event_id,
      'control_status', v_control_status, 'control_event_id', null,
      'control_match_key', v_control_match_key);
  end if;

  select control_event_id
    into v_control_event_id
    from public.hy_b4_shadow_control_candidates
   where symbol = v_symbol
     and calendar_period = p_event->>'calendar_period'
     and market_regime = p_event->>'market_regime'
     and volatility_bucket = p_event->>'volatility_bucket'
     and liquidity_bucket = p_event->>'liquidity_bucket'
     and funding_bucket = p_event->'funding_state'->>'bucket'
     and mark_index_basis_bucket = p_event->'mark_index_basis_state'->>'bucket'
     and not exists (
       select 1 from public.hy_b4_shadow_control_claims claim
        where claim.control_event_id = hy_b4_shadow_control_candidates.control_event_id
          and claim.direction = v_direction
     )
     and pit_available_at <= (p_event->>'created_at')::timestamptz
     and market_timestamp <= v_closed_bar
   order by pit_available_at desc, market_timestamp desc, control_event_id
   for update skip locked
   limit 1;
  if v_control_event_id is not null then
    v_control_status := 'AVAILABLE';
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
    v_control_status,
    v_control_event_id,
    v_control_match_key
  ) on conflict (episode_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select event_id into v_event_id
      from public.hy_shadow_signal_events
     where episode_key = v_episode_key;
    return jsonb_build_object('result', 'DUPLICATE_TRUE', 'event_id', v_event_id,
      'control_status', v_control_status, 'control_event_id', v_control_event_id,
      'control_match_key', v_control_match_key);
  end if;

  if v_control_event_id is not null then
    insert into public.hy_b4_shadow_control_claims (control_event_id, direction, event_id)
    values (v_control_event_id, v_direction, v_event_id);
  end if;

  update public.hy_b4_shadow_feature_state
     set current_direction = v_direction,
         last_evaluated_closed_bar = v_closed_bar,
         current_episode_key = v_episode_key,
         updated_at = now()
   where symbol = v_symbol;
  return jsonb_build_object('result', 'NEW_EVENT', 'event_id', v_event_id,
    'control_status', v_control_status, 'control_event_id', v_control_event_id,
    'control_match_key', v_control_match_key);
end;
$$;

-- Durable cross-sectional staging. A batch may only contribute PIT-safe
-- primitives; the finalized rows are immutable evidence for one full universe.
create or replace function public.hy_b4_shadow_stage_and_finalize(
  p_context_group_key text,
  p_market_timestamp timestamptz,
  p_symbol text,
  p_expected_symbols text[],
  p_observation jsonb,
  p_pit_available_at timestamptz,
  p_reference_price numeric,
  p_quote_volume_mean numeric,
  p_four_hour_return numeric,
  p_volatility_value numeric,
  p_volatility_bucket text,
  p_funding_bucket text,
  p_mark_index_basis_bucket text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expected text[];
  v_rows jsonb;
  v_median numeric;
begin
  if nullif(btrim(p_context_group_key), '') is null
     or p_market_timestamp is null
     or p_symbol is null
     or p_expected_symbols is null
     or cardinality(p_expected_symbols) = 0
     or cardinality(p_expected_symbols) < 2
     or not (p_symbol = any(p_expected_symbols))
     or jsonb_typeof(p_observation) <> 'object'
     or p_pit_available_at < p_market_timestamp
     or p_reference_price <= 0
     or p_quote_volume_mean < 0
     or p_volatility_value < 0
     or p_volatility_bucket not in ('LOW', 'NORMAL', 'HIGH')
     or p_funding_bucket not in ('NEGATIVE', 'NEUTRAL', 'POSITIVE')
     or p_mark_index_basis_bucket not in ('EXTREME_NEGATIVE', 'NEGATIVE', 'NEUTRAL', 'POSITIVE', 'EXTREME_POSITIVE') then
    raise exception 'invalid B4 context staging payload';
  end if;

  v_expected := array(select distinct value from unnest(p_expected_symbols) value order by value);
  perform pg_advisory_xact_lock(hashtext(p_context_group_key || '|' || p_market_timestamp::text));

  -- A context group is one frozen universe snapshot. If another batch arrives
  -- with a different universe, retain the staged evidence but fail closed.
  if exists (
    select 1 from public.hy_b4_shadow_context_staging
     where context_group_key = p_context_group_key
       and market_timestamp = p_market_timestamp
       and expected_symbols <> v_expected
  ) then
    return jsonb_build_object('status', 'WAITING', 'context_rows', '[]'::jsonb);
  end if;

  insert into public.hy_b4_shadow_context_staging (
    context_group_key, market_timestamp, symbol, expected_symbols,
    pit_available_at, reference_price, quote_volume_mean, four_hour_return,
    volatility_value, volatility_bucket, funding_bucket,
    mark_index_basis_bucket, observation
  ) values (
    p_context_group_key, p_market_timestamp, p_symbol, v_expected,
    p_pit_available_at, p_reference_price, p_quote_volume_mean, p_four_hour_return,
    p_volatility_value, p_volatility_bucket, p_funding_bucket,
    p_mark_index_basis_bucket, p_observation
  ) on conflict (context_group_key, market_timestamp, symbol) do update
    set expected_symbols = excluded.expected_symbols,
        pit_available_at = excluded.pit_available_at,
        reference_price = excluded.reference_price,
        quote_volume_mean = excluded.quote_volume_mean,
        four_hour_return = excluded.four_hour_return,
        volatility_value = excluded.volatility_value,
        volatility_bucket = excluded.volatility_bucket,
        funding_bucket = excluded.funding_bucket,
        mark_index_basis_bucket = excluded.mark_index_basis_bucket,
        observation = excluded.observation;

  if exists (
    select 1 from public.hy_b4_shadow_context_finalized
     where context_group_key = p_context_group_key and market_timestamp = p_market_timestamp
  ) then
    if (select expected_symbols from public.hy_b4_shadow_context_finalized
         where context_group_key = p_context_group_key and market_timestamp = p_market_timestamp) <> v_expected then
      return jsonb_build_object('status', 'WAITING', 'context_rows', '[]'::jsonb);
    end if;
    select context_rows into v_rows
      from public.hy_b4_shadow_context_finalized
     where context_group_key = p_context_group_key and market_timestamp = p_market_timestamp;
    return jsonb_build_object('status', 'FINALIZED', 'context_rows', v_rows);
  end if;

  if (select count(*) from public.hy_b4_shadow_context_staging
       where context_group_key = p_context_group_key and market_timestamp = p_market_timestamp) <> cardinality(v_expected)
      or exists (
       select 1 from unnest(v_expected) expected(symbol)
        where not exists (
          select 1 from public.hy_b4_shadow_context_staging staged
           where staged.context_group_key = p_context_group_key
             and staged.market_timestamp = p_market_timestamp
             and staged.symbol = expected.symbol
         )
      )
      or exists (
        select 1 from public.hy_b4_shadow_context_staging staged
         where staged.context_group_key = p_context_group_key
           and staged.market_timestamp = p_market_timestamp
           and staged.expected_symbols <> v_expected
      ) then
    return jsonb_build_object('status', 'WAITING', 'context_rows', '[]'::jsonb);
  end if;

  select percentile_cont(0.5) within group (order by four_hour_return)
    into v_median
    from public.hy_b4_shadow_context_staging
   where context_group_key = p_context_group_key and market_timestamp = p_market_timestamp;

  select jsonb_agg(
    jsonb_set(
      jsonb_set(
        jsonb_set(observation, '{market_regime}', to_jsonb(
          case when v_median > 0.005 then 'UP' when v_median < -0.005 then 'DOWN' else 'RANGE' end
        )),
        '{liquidity_percentile}', to_jsonb((
          (
            (select count(*)::numeric from public.hy_b4_shadow_context_staging peer
              where peer.context_group_key = staged.context_group_key
                and peer.market_timestamp = staged.market_timestamp
                and peer.quote_volume_mean < staged.quote_volume_mean)
            + ((select count(*)::numeric from public.hy_b4_shadow_context_staging peer
              where peer.context_group_key = staged.context_group_key
                and peer.market_timestamp = staged.market_timestamp
                and peer.quote_volume_mean = staged.quote_volume_mean) - 1) / 2
          ) / (cardinality(v_expected) - 1)
        ))
      ),
      '{liquidity_bucket}', to_jsonb(case
        when (
          (
            (select count(*)::numeric from public.hy_b4_shadow_context_staging peer
              where peer.context_group_key = staged.context_group_key
                and peer.market_timestamp = staged.market_timestamp
                and peer.quote_volume_mean < staged.quote_volume_mean)
            + ((select count(*)::numeric from public.hy_b4_shadow_context_staging peer
              where peer.context_group_key = staged.context_group_key
                and peer.market_timestamp = staged.market_timestamp
                and peer.quote_volume_mean = staged.quote_volume_mean) - 1) / 2
          ) / (cardinality(v_expected) - 1)
        ) <= 0.33 then 'LOW'
        when (
          (
            (select count(*)::numeric from public.hy_b4_shadow_context_staging peer
              where peer.context_group_key = staged.context_group_key
                and peer.market_timestamp = staged.market_timestamp
                and peer.quote_volume_mean < staged.quote_volume_mean)
            + ((select count(*)::numeric from public.hy_b4_shadow_context_staging peer
              where peer.context_group_key = staged.context_group_key
                and peer.market_timestamp = staged.market_timestamp
                and peer.quote_volume_mean = staged.quote_volume_mean) - 1) / 2
          ) / (cardinality(v_expected) - 1)
        ) <= 0.66 then 'NORMAL'
        else 'HIGH' end)
    ) order by symbol
  ) into v_rows
    from public.hy_b4_shadow_context_staging staged
   where context_group_key = p_context_group_key and market_timestamp = p_market_timestamp;

  insert into public.hy_b4_shadow_context_finalized (
    context_group_key, market_timestamp, expected_symbols, market_regime, context_rows
  ) values (
    p_context_group_key, p_market_timestamp, v_expected,
    case when v_median > 0.005 then 'UP' when v_median < -0.005 then 'DOWN' else 'RANGE' end,
    v_rows
  ) on conflict (context_group_key, market_timestamp) do nothing;

  return jsonb_build_object('status', 'FINALIZED', 'context_rows', v_rows);
end;
$$;

-- Return only due, missing signal event/horizon work items. Pair-level
-- keyset pagination prevents completed historical rows from starving newer
-- maturity work.
create or replace function public.hy_b4_shadow_pending_signal_maturity(
  p_evaluated_at timestamptz,
  p_after_market_timestamp timestamptz default null,
  p_after_event_id uuid default null,
  p_after_horizon_hours smallint default 0,
  p_limit integer default 100
)
returns table (event_id uuid, horizon_hours smallint, market_timestamp timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select event.event_id, horizon.horizon_hours, event.market_timestamp
    from public.hy_shadow_signal_events event
    cross join lateral unnest(array[1, 4, 12, 24]::smallint[]) horizon(horizon_hours)
   where event.market_timestamp + horizon.horizon_hours * interval '1 hour' <= p_evaluated_at
     and not exists (
       select 1 from public.hy_shadow_signal_outcomes outcome
        where outcome.event_id = event.event_id
          and outcome.horizon_hours = horizon.horizon_hours
     )
     and (
       p_after_market_timestamp is null
       or event.market_timestamp > p_after_market_timestamp
       or (event.market_timestamp = p_after_market_timestamp and (
         p_after_event_id is null
         or event.event_id > p_after_event_id
         or (event.event_id = p_after_event_id and horizon.horizon_hours > p_after_horizon_hours)
       ))
     )
   order by event.market_timestamp, event.event_id, horizon.horizon_hours
   limit greatest(1, least(coalesce(p_limit, 100), 5000));
$$;

-- Control-B uses the same pair-level pending contract, but its horizon starts
-- from the control observation timestamp and is keyed by direction.
create or replace function public.hy_b4_shadow_pending_control_maturity(
  p_evaluated_at timestamptz,
  p_after_market_timestamp timestamptz default null,
  p_after_control_event_id uuid default null,
  p_after_direction text default null,
  p_after_horizon_hours smallint default 0,
  p_limit integer default 100
)
returns table (
  control_event_id uuid,
  direction text,
  event_id uuid,
  symbol text,
  market_timestamp timestamptz,
  pit_available_at timestamptz,
  reference_price numeric,
  horizon_hours smallint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select candidate.control_event_id,
         claim.direction,
         claim.event_id,
         candidate.symbol,
         candidate.market_timestamp,
         candidate.pit_available_at,
         candidate.reference_price,
         horizon.horizon_hours
    from public.hy_b4_shadow_control_claims claim
    join public.hy_b4_shadow_control_candidates candidate
      on candidate.control_event_id = claim.control_event_id
    cross join lateral unnest(array[1, 4, 12, 24]::smallint[]) horizon(horizon_hours)
   where candidate.market_timestamp + horizon.horizon_hours * interval '1 hour' <= p_evaluated_at
     and not exists (
       select 1 from public.hy_b4_shadow_control_outcomes outcome
        where outcome.control_event_id = claim.control_event_id
          and outcome.direction = claim.direction
          and outcome.horizon_hours = horizon.horizon_hours
     )
     and (
       p_after_market_timestamp is null
       or candidate.market_timestamp > p_after_market_timestamp
       or (candidate.market_timestamp = p_after_market_timestamp and (
         p_after_control_event_id is null
         or candidate.control_event_id > p_after_control_event_id
         or (candidate.control_event_id = p_after_control_event_id and (
           p_after_direction is null
           or claim.direction > p_after_direction
           or (claim.direction = p_after_direction and horizon.horizon_hours > p_after_horizon_hours)
         ))
       ))
     )
   order by candidate.market_timestamp, candidate.control_event_id, claim.direction, horizon.horizon_hours
   limit greatest(1, least(coalesce(p_limit, 100), 5000));
$$;

-- R6.3 readiness shape only. Future performance columns deliberately remain
-- NULL until a separately approved outcome analysis is run.
create or replace function public.hy_b4_shadow_metric_readiness()
returns table (
  eligible_events bigint,
  matched_events bigint,
  matching_coverage numeric,
  signal_1h_precision numeric,
  control_1h_precision numeric,
  incremental_precision_lift numeric,
  bullish_count bigint,
  bearish_count bigint,
  future_performance_not_calculated boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*) filter (where event.data_completeness = 'COMPLETE' and event.pit_status = 'PASS')::bigint,
         count(*) filter (where event.control_status = 'AVAILABLE')::bigint,
         case when count(*) = 0 then null else (count(*) filter (where event.control_status = 'AVAILABLE'))::numeric / count(*) end,
         null::numeric,
         null::numeric,
         null::numeric,
         count(*) filter (where event.direction = 'BULLISH')::bigint,
         count(*) filter (where event.direction = 'BEARISH')::bigint,
         true
    from public.hy_shadow_signal_events event;
$$;

alter table public.hy_b4_shadow_feature_state enable row level security;
alter table public.hy_b4_shadow_runtime_state enable row level security;
alter table public.hy_b4_shadow_control_candidates enable row level security;
alter table public.hy_b4_shadow_control_claims enable row level security;
alter table public.hy_b4_shadow_control_outcomes enable row level security;
alter table public.hy_b4_shadow_context_staging enable row level security;
alter table public.hy_b4_shadow_context_finalized enable row level security;

revoke all on table
  public.hy_b4_shadow_feature_state,
  public.hy_b4_shadow_runtime_state,
  public.hy_b4_shadow_control_candidates,
  public.hy_b4_shadow_control_claims,
  public.hy_b4_shadow_control_outcomes,
  public.hy_b4_shadow_context_staging,
  public.hy_b4_shadow_context_finalized
from public, anon, authenticated;

grant select, insert, update on table public.hy_b4_shadow_feature_state to service_role;
grant select, insert, update on table public.hy_b4_shadow_runtime_state to service_role;
grant select, insert, update on table public.hy_b4_shadow_control_candidates to service_role;
grant select, insert on table public.hy_b4_shadow_control_claims to service_role;
grant select, insert on table public.hy_b4_shadow_control_outcomes to service_role;
grant select, insert, update on table public.hy_b4_shadow_context_staging to service_role;
grant select on table public.hy_b4_shadow_context_finalized to service_role;

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

revoke all on function public.hy_b4_shadow_stage_and_finalize(text, timestamptz, text, text[], jsonb, timestamptz, numeric, numeric, numeric, numeric, text, text, text)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_stage_and_finalize(text, timestamptz, text, text[], jsonb, timestamptz, numeric, numeric, numeric, numeric, text, text, text)
to service_role;

revoke all on function public.hy_b4_shadow_pending_signal_maturity(timestamptz, timestamptz, uuid, smallint, integer)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_pending_signal_maturity(timestamptz, timestamptz, uuid, smallint, integer)
to service_role;

revoke all on function public.hy_b4_shadow_pending_control_maturity(timestamptz, timestamptz, uuid, text, smallint, integer)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_pending_control_maturity(timestamptz, timestamptz, uuid, text, smallint, integer)
to service_role;

revoke all on function public.hy_b4_shadow_metric_readiness()
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_metric_readiness()
to service_role;
