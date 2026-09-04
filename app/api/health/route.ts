import { NextResponse } from "next/server";
import { getHyEnvironment, getServerConfig, isUsableRuntimeValue } from "@/lib/config";

export const runtime = "nodejs";

const service = "heyue-signal-scanner";
const mode = "alert-only";
const exchangeCredentialNames = [
  "HY_BINANCE_API_KEY",
  "HY_BINANCE_API_SECRET",
  "HY_BINANCE_SECRET_KEY",
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "BINANCE_SECRET_KEY",
] as const;

type RuntimeEnvironment = Record<string, string | undefined>;

export function getHealthAttestation(environment: RuntimeEnvironment = process.env) {
  const resolvedEnvironment = getHyEnvironment(environment);
  if (Object.values(resolvedEnvironment).some((value) => value !== undefined && !isUsableRuntimeValue(value))) {
    throw new Error("invalid runtime configuration");
  }

  const config = getServerConfig(environment);
  const requiredValues = [
    config.HY_SUPABASE_URL,
    config.supabaseServiceKey,
    config.HY_CRON_SECRET,
    config.HY_STRATEGY_ADMIN_SECRET,
    config.HY_GMAIL_SMTP_USER,
    config.HY_GMAIL_SMTP_APP_PASSWORD,
    config.HY_GMAIL_RECIPIENT,
  ];
  if (requiredValues.some((value) => !isUsableRuntimeValue(value))) {
    throw new Error("incomplete runtime configuration");
  }
  if (
    config.HY_STRATEGY_SOURCE !== "DB"
    || config.HY_STRATEGY_STAGE !== "PAPER"
    || !config.HY_STRATEGY_VERSION.startsWith("hy-")
    || !config.HY_PAPER_TRADING_ENABLED
    || config.HY_DRY_RUN
  ) {
    throw new Error("unsafe runtime configuration");
  }

  const exchangeCredentialsConfigured = exchangeCredentialNames.some((name) => {
    const value = environment[name];
    if (value === undefined || value.trim() === "") return false;
    if (!isUsableRuntimeValue(value)) throw new Error("invalid exchange credential configuration");
    return true;
  });
  if (exchangeCredentialsConfigured) {
    throw new Error("exchange credentials are not allowed");
  }

  return {
    ok: true,
    service,
    mode,
    safety: {
      strategySource: config.HY_STRATEGY_SOURCE,
      strategyStage: config.HY_STRATEGY_STAGE,
      strategyVersion: config.HY_STRATEGY_VERSION,
      paperTradingEnabled: config.HY_PAPER_TRADING_ENABLED,
      dryRun: config.HY_DRY_RUN,
      supabaseProjectRef: supabaseProjectRef(config.HY_SUPABASE_URL),
      exchangeCredentialsConfigured: false,
      autoTrading: false,
      canonicalEnvPrefix: "HY_",
      canonicalDbPrefix: "hy_",
    },
    timestamp: new Date().toISOString(),
  };
}

export function GET() {
  try {
    return NextResponse.json(getHealthAttestation());
  } catch {
    return NextResponse.json({
      ok: false,
      service,
      mode,
      error: "invalid_runtime_configuration",
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

function supabaseProjectRef(supabaseUrl: string): string {
  const hostname = new URL(supabaseUrl).hostname;
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(hostname);
  if (!match) throw new Error("invalid Supabase project URL");
  return match[1];
}
