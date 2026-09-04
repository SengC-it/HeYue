import { NextRequest, NextResponse } from "next/server";
import { getServerConfig } from "@/lib/config";
import { activateStrategyVersion } from "@/lib/services/strategy-repository";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const config = getServerConfig();
    if (!isAuthorized(request, config.HY_STRATEGY_ADMIN_SECRET)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = await request.json() as { version?: unknown; targetStatus?: unknown };
    if (typeof body.version !== "string" || body.version.trim() === "") {
      return NextResponse.json({ ok: false, error: "version is required" }, { status: 400 });
    }

    const targetStatus = body.targetStatus === "PAPER" ? "PAPER" : "ACTIVE";
    const result = await activateStrategyVersion(getSupabaseAdmin(), {
      version: body.version.trim(),
      targetStatus,
      gate: {
        minProfitFactor: config.HY_STRATEGY_APPROVAL_MIN_PF,
        minOutOfSampleSignals: targetStatus === "PAPER"
          ? config.HY_PAPER_APPROVAL_MIN_OOS_SIGNALS
          : config.HY_STRATEGY_APPROVAL_MIN_OOS_SIGNALS,
        maxDrawdownPercent: config.HY_STRATEGY_APPROVAL_MAX_DRAWDOWN_PERCENT,
      },
    });
    return NextResponse.json({ ok: true, result });
  } catch {
    return NextResponse.json({
      ok: false,
      error: "strategy_activation_failed",
    }, { status: 500 });
  }
}

function isAuthorized(request: NextRequest, expectedSecret?: string): boolean {
  if (!expectedSecret) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === expectedSecret || request.headers.get("x-strategy-admin-secret") === expectedSecret;
}
