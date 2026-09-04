-- Allow one paper signal to be evaluated under multiple exit profiles.
-- This is paper-only shadow accounting; it does not create exchange orders.

alter table public.bca_paper_trades
  add column if not exists exit_profile text not null default 'PRIMARY_2R';

alter table public.bca_paper_trades
  drop constraint if exists bca_paper_trades_signal_id_key;

alter table public.bca_paper_trades
  add constraint bca_paper_trades_signal_exit_profile_key
  unique (signal_id, exit_profile);

alter table public.bca_paper_trades
  add constraint bca_paper_trades_exit_profile_check
  check (exit_profile in ('PRIMARY_2R', 'AB_2_5R'));

create index if not exists bca_paper_trades_profile_status_idx
  on public.bca_paper_trades (exit_profile, status, entry_time desc);
