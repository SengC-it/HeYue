import { NextRequest, NextResponse } from "next/server";
import { BinancePublicClient } from "@/lib/binance/public-client";
import { getServerConfig } from "@/lib/config";
import { sendSystemAlertEmail } from "@/lib/notifications/email";
import { settleOpenPaperTrades } from "@/lib/services/paper-trading";
import { countRecentFailures, expireSignals, recordSystemEvent } from "@/lib/services/signal-repository";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isTransientSupabaseError } from "@/lib/supabase/resilience";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How many consecutive settlement passes must fail against Supabase before the
 * out-of-band critical alert fires.
 *
 * The settle job runs every 15 minutes. Supabase occasionally returns a single
 * transient gateway timeout while the database is healthy; alerting on the
 * first one produced false "严重告警" emails. Requiring two consecutive failed
 * passes keeps the alert meaningful (a sustained outage still alerts within
 * ~30 minutes) without paging on a one-off blip.
 */
const FAILURE_ALERT_THRESHOLD = 2;
/** Look back far enough to span the required consecutive passes. */
const FAILURE_WINDOW_MINUTES = 45;

export async function POST(request: NextRequest) {
  return settle(request);
}

async function settle(request: NextRequest): Promise<NextResponse> {
  let supabase: ReturnType<typeof getSupabaseAdmin> | undefined;
  let config: ReturnType<typeof getServerConfig> | undefined;

  try {
    config = getServerConfig();
    if (!isAuthorized(request, config.HY_CRON_SECRET)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    if (!config.HY_PAPER_TRADING_ENABLED) {
      return NextResponse.json({ ok: true, skipped: true, reason: "paper_trading_disabled" });
    }

    supabase = getSupabaseAdmin();
    const expiredSignalCount = await expireSignals(supabase);
    const summary = await settleOpenPaperTrades(
      supabase,
      new BinancePublicClient(config.HY_BINANCE_API_BASE_URL, undefined, config.HY_BINANCE_REQUEST_DELAY_MS),
      {
        takerFeeRate: config.HY_PAPER_TAKER_FEE_RATE,
        slippageBps: config.HY_PAPER_SLIPPAGE_BPS,
        requestConcurrency: config.HY_REQUEST_CONCURRENCY,
        batchSize: config.HY_PAPER_SETTLEMENT_BATCH_SIZE,
      },
    );

    if (summary.errors.length > 0) {
      await recordSystemEvent(supabase, {
        eventType: "DATA_SOURCE_ERROR",
        severity: "WARNING",
        component: "paper_settlement",
        message: "Some paper trades could not be settled",
        details: summary,
      });
    }

    return NextResponse.json({ ok: true, expiredSignalCount, ...summary });
  } catch (error) {
    const message = errorMessage(error);
    // A transient Supabase blip that survived the retry layer is recorded but
    // does not page on its own; a genuinely persistent failure does. The
    // off-band SMTP alert only fires once the failure repeats across
    // consecutive passes, so an isolated gateway timeout stays quiet.
    const transient = isTransientSupabaseError(error);
    let consecutiveFailures = 1;
    if (supabase) {
      try {
        consecutiveFailures = (await countRecentFailures(
          supabase,
          "paper_settlement",
          FAILURE_WINDOW_MINUTES,
        )) + 1;
      } catch {
        // If the failure history is unreadable, assume this is persistent so a
        // real outage is not silently swallowed.
        consecutiveFailures = FAILURE_ALERT_THRESHOLD;
      }
      try {
        await recordSystemEvent(supabase, {
          eventType: "DATABASE_ERROR",
          severity: consecutiveFailures >= FAILURE_ALERT_THRESHOLD ? "ERROR" : "WARNING",
          component: "paper_settlement",
          message,
          details: { consecutiveFailures, transient },
        });
      } catch {
        // Preserve the original settlement error.
      }
    }
    const shouldAlert = consecutiveFailures >= FAILURE_ALERT_THRESHOLD;
    if (config && shouldAlert) {
      try {
        await sendSystemAlertEmail(config, { component: "paper_settlement", message });
      } catch {
        // Preserve the original settlement error.
      }
    }
    return NextResponse.json(
      { ok: false, error: "paper_settlement_failed", consecutiveFailures, alerted: shouldAlert },
      { status: 500 },
    );
  }
}

function isAuthorized(request: NextRequest, expectedSecret?: string): boolean {
  if (!expectedSecret) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === expectedSecret || request.headers.get("x-cron-secret") === expectedSecret;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
