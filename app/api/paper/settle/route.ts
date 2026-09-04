import { NextRequest, NextResponse } from "next/server";
import { BinancePublicClient } from "@/lib/binance/public-client";
import { getServerConfig } from "@/lib/config";
import { sendSystemAlertEmail } from "@/lib/notifications/email";
import { settleOpenPaperTrades } from "@/lib/services/paper-trading";
import { expireSignals, recordSystemEvent } from "@/lib/services/signal-repository";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (supabase) {
      try {
        await recordSystemEvent(supabase, {
          eventType: "DATABASE_ERROR",
          severity: "ERROR",
          component: "paper_settlement",
          message,
        });
      } catch {
        // Preserve the original settlement error.
      }
    }
    if (config) {
      try {
        await sendSystemAlertEmail(config, { component: "paper_settlement", message });
      } catch {
        // Preserve the original settlement error.
      }
    }
    return NextResponse.json({ ok: false, error: "paper_settlement_failed" }, { status: 500 });
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
