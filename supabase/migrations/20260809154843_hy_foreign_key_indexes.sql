-- Cover foreign keys used by deletes and joins. This migration is required for
-- databases where the HeYue baseline was installed before these indexes were
-- folded into the clean baseline.
create index if not exists hy_signals_scan_run_id_idx
  on public.hy_signals (scan_run_id);

create index if not exists hy_signals_replaced_by_idx
  on public.hy_signals (replaced_by);

create index if not exists hy_notifications_signal_id_idx
  on public.hy_notifications (signal_id);
