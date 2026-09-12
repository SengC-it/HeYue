-- Expire alert opportunities when their validity window closes. Expiry is a
-- state transition with an auditable event, not a silent cleanup delete.

alter table public.bca_signals
  drop constraint if exists cs_signals_status_check;
alter table public.bca_signals
  drop constraint if exists bca_signals_status_check;
alter table public.bca_signals
  add constraint bca_signals_status_check
  check (status in ('ACTIVE', 'REPLACED', 'BUDGET_BLOCKED', 'MANUALLY_CLOSED', 'EXPIRED'));

alter table public.bca_signal_events
  drop constraint if exists cs_signal_events_event_type_check;
alter table public.bca_signal_events
  drop constraint if exists bca_signal_events_event_type_check;
alter table public.bca_signal_events
  add constraint bca_signal_events_event_type_check
  check (event_type in ('CREATED', 'REPLACED', 'EMAIL_QUEUED', 'EMAIL_SENT', 'EMAIL_FAILED', 'BUDGET_BLOCKED', 'EXPIRED', 'ERROR'));

create index if not exists bca_signals_symbol_source_timestamp_idx
  on public.bca_signals (symbol, source_data_timestamp desc);

create or replace function public.bca_expire_signals(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.bca_signals
    set status = 'EXPIRED',
        updated_at = now()
    where status = 'ACTIVE'
      and valid_until <= p_now
    returning id
  )
  insert into public.bca_signal_events (signal_id, event_type, payload)
  select id, 'EXPIRED', jsonb_build_object('expired_at', p_now)
  from expired;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.bca_expire_signals(timestamptz)
from public, anon, authenticated;
grant execute on function public.bca_expire_signals(timestamptz)
to service_role;
