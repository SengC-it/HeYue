-- Strategy versions are optimizer artifacts until an operator explicitly
-- activates one through the authenticated API route.

create or replace function public.bca_activate_strategy_version(
  p_version text,
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
  v_target public.bca_strategy_versions%rowtype;
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

  select * into v_target
  from public.bca_strategy_versions
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

  update public.bca_strategy_versions
  set status = 'RETIRED'
  where status = 'ACTIVE' and version <> p_version;

  update public.bca_strategy_versions
  set status = 'ACTIVE'
  where version = p_version;

  return jsonb_build_object(
    'version', p_version,
    'status', 'ACTIVE',
    'profit_factor', v_profit_factor,
    'out_of_sample_signals', v_signals,
    'max_drawdown_percent', v_max_drawdown
  );
end;
$$;

revoke execute on function public.bca_activate_strategy_version(text, numeric, integer, numeric)
from public, anon, authenticated;
grant execute on function public.bca_activate_strategy_version(text, numeric, integer, numeric)
to service_role;
