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
set search_path = public
as $$
declare
  previous_direction text;
begin
  if p_version <> 'hy-b4-shadow-v1' then
    raise exception 'unsupported B4 shadow version';
  end if;
  if p_direction is not null and p_direction not in ('BULLISH', 'BEARISH') then
    raise exception 'unsupported B4 shadow direction';
  end if;

  insert into public.hy_b4_shadow_feature_state (
    symbol, version, current_direction, last_evaluated_closed_bar,
    current_episode_key
  ) values (
    p_symbol, p_version, null, null, null
  )
  on conflict (symbol) do nothing;

  select current_direction
    into previous_direction
    from public.hy_b4_shadow_feature_state
   where symbol = p_symbol
   for update;

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

alter table public.hy_b4_shadow_feature_state enable row level security;
alter table public.hy_b4_shadow_runtime_state enable row level security;

revoke all on table
  public.hy_b4_shadow_feature_state,
  public.hy_b4_shadow_runtime_state
from anon, authenticated;

grant select, insert, update on table public.hy_b4_shadow_feature_state to service_role;
grant select, insert, update on table public.hy_b4_shadow_runtime_state to service_role;

revoke all on function public.hy_b4_shadow_transition_episode(text, text, timestamptz, text, text)
from public, anon, authenticated;
grant execute on function public.hy_b4_shadow_transition_episode(text, text, timestamptz, text, text)
to service_role;
