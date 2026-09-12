-- HY-R6.2D.1 B4 production persistence and runtime remediation.
-- Additive hotfix only. Do not apply to Production in the Draft PR phase.
-- The already-applied R6.2C migration body remains immutable; this migration
-- aligns its local filename separately and replaces only the affected RPC.

alter table public.hy_b4_shadow_runtime_state
  add column if not exists observation_started_at timestamptz;

-- Atomically begin a formal observation epoch. An active epoch is immutable
-- across concurrent batches and retries; a prior failed/disabled row with no
-- epoch may be re-armed only by a later, explicit activation.
create or replace function public.hy_b4_shadow_begin_observation(
  p_started_at timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_at timestamptz := coalesce(p_started_at, now());
  v_enabled boolean;
  v_status text;
  v_observation_started_at timestamptz;
begin
  insert into public.hy_b4_shadow_runtime_state (
    singleton_key, enabled, version, status, warmup_ready, observation_started_at
  ) values (
    'B4', true, 'hy-b4-shadow-v1', 'WARMING_UP', false, v_requested_at
  ) on conflict (singleton_key) do nothing;

  select enabled, status, observation_started_at
    into v_enabled, v_status, v_observation_started_at
    from public.hy_b4_shadow_runtime_state
   where singleton_key = 'B4'
   for update;

  if not found then
    raise exception 'B4 runtime state could not be initialized';
  end if;

  if v_observation_started_at is null or not v_enabled or v_status = 'DISABLED' then
    update public.hy_b4_shadow_runtime_state
       set enabled = true,
           status = 'WARMING_UP',
           warmup_ready = false,
           observation_started_at = coalesce(v_observation_started_at, v_requested_at),
           updated_at = now()
     where singleton_key = 'B4'
     returning observation_started_at into v_observation_started_at;
  end if;

  return v_observation_started_at;
end;
$$;

-- Rollback/flag-false is durable and preserves all counters, timestamps, and
-- last failure evidence for post-incident review.
create or replace function public.hy_b4_shadow_mark_disabled()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.hy_b4_shadow_runtime_state (
    singleton_key, enabled, version, status, warmup_ready, observation_started_at
  ) values (
    'B4', false, 'hy-b4-shadow-v1', 'DISABLED', false, null
  ) on conflict (singleton_key) do update
    set enabled = false,
        status = 'DISABLED',
        warmup_ready = false,
        observation_started_at = null,
        updated_at = now();
end;
$$;

-- Replaced canonical event boundary. The explicit UUID-to-text cast fixes the
-- Production schema contract while retaining atomic event, claim, and episode
-- state changes in one transaction.
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
  v_pit_available_at timestamptz;
  v_observation_started_at timestamptz;
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
     or nullif(p_event->>'market_timestamp', '') is null
     or nullif(p_event->>'pit_available_at', '') is null
     or nullif(p_event->>'created_at', '') is null then
    raise exception 'B4 event timestamps and id are required';
  end if;
  v_event_id := (p_event->>'event_id')::uuid;
  v_closed_bar := (p_event->>'market_timestamp')::timestamptz;
  v_pit_available_at := (p_event->>'pit_available_at')::timestamptz;
  if v_pit_available_at < v_closed_bar then
    raise exception 'B4 event PIT availability precedes market timestamp';
  end if;
  v_control_match_key := concat_ws('|',
    v_symbol,
    p_event->>'calendar_period',
    p_event->>'market_regime',
    p_event->>'volatility_bucket',
    p_event->>'liquidity_bucket',
    p_event->'funding_state'->>'bucket',
    p_event->'mark_index_basis_state'->>'bucket'
  );

  -- No event or episode state mutation is allowed before the observation
  -- became PIT-available after the formal activation epoch.
  select observation_started_at
    into v_observation_started_at
    from public.hy_b4_shadow_runtime_state
   where singleton_key = 'B4'
     and enabled = true
     and status <> 'DISABLED'
   for update;
  if v_observation_started_at is null or v_pit_available_at < v_observation_started_at then
    return jsonb_build_object('result', 'PRE_OBSERVATION', 'event_id', null,
      'control_status', v_control_status, 'control_event_id', null,
      'control_match_key', v_control_match_key);
  end if;

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
     and pit_available_at >= v_observation_started_at
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
    v_pit_available_at,
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
    v_control_event_id::text,
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

revoke all on function public.hy_b4_shadow_begin_observation(timestamptz)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_begin_observation(timestamptz)
to service_role;

revoke all on function public.hy_b4_shadow_mark_disabled()
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_mark_disabled()
to service_role;

revoke all on function public.hy_b4_shadow_transition_and_insert(jsonb)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_transition_and_insert(jsonb)
to service_role;
