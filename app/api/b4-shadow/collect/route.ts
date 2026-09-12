import { NextRequest, NextResponse } from "next/server";
import { BinancePublicClient } from "@/lib/binance/public-client";
import { getServerConfig } from "@/lib/config";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { collectB4ShadowBatch } from "@/lib/services/b4-shadow-collector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return runCollection(request);
}

export async function POST(request: NextRequest) {
  return runCollection(request);
}

async function runCollection(request: NextRequest): Promise<NextResponse> {
  try {
    const config = getServerConfig();
    if (!isAuthorized(request, config.HY_CRON_SECRET)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    if (!config.HY_B4_SHADOW_ENABLED) {
      return NextResponse.json({
        ok: true,
        status: "DISABLED",
        reason: "HY_B4_SHADOW_ENABLED is false",
        emailsSent: 0,
      });
    }
    const batchNumber = parseBatchNumber(request.nextUrl.searchParams.get("batch"));
    const client = new BinancePublicClient(
      config.HY_BINANCE_API_BASE_URL,
      undefined,
      config.HY_BINANCE_REQUEST_DELAY_MS,
    );
    const result = await collectB4ShadowBatch({
      client,
      supabase: getSupabaseAdmin(),
      config,
      batchNumber,
    });
    const status = result.status === "FAILED" ? 503 : result.status === "CONTEXT_INCOMPLETE" ? 503 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      emailsSent: 0,
    }, { status: 503 });
  }
}

function isAuthorized(request: NextRequest, expectedSecret?: string): boolean {
  if (!expectedSecret) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === expectedSecret || request.headers.get("x-cron-secret") === expectedSecret;
}

function parseBatchNumber(value: string | null): number {
  if (value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("batch must be a non-negative integer");
  return parsed;
}
