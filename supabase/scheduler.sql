-- Supabase Cron -> Vercel scan endpoint.
-- Run this only after the Vercel deployment URL and CRON_SECRET are stored in Vault.
-- This file intentionally uses only hy_* job names and does not alter existing jobs.
--
-- One-time setup (replace values before running):
-- select vault.create_secret('https://<your-vercel-domain>/api/scan', 'hy_scan_url');
-- select vault.create_secret('<same value as Vercel CRON_SECRET>', 'hy_cron_secret');
--
-- The validated paper candidate scans one top-10 batch every 15 minutes.
-- If the universe or batch size changes, update this schedule deliberately.

-- Paper settlement uses a separate endpoint so every scan batch does not
-- repeat the same Binance history requests. Store its URL separately:
-- select vault.create_secret('https://<your-vercel-domain>/api/paper/settle', 'hy_paper_settle_url');

select cron.schedule(
  'hy-paper-settle',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'hy_paper_settle_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'hy_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'hy-scan-batch-0',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'hy_scan_url') || '?batch=0',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'hy_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
