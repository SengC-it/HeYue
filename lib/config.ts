import { z } from "zod";
import { createRuntimeStrategyPolicy, type RuntimeStrategyPolicy } from "@/lib/core/runtime-strategy";

const optionalPositiveNumber = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().positive().optional(),
);

const optionalNonNegativeNumber = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().nonnegative().optional(),
);

const booleanEnv = (defaultValue: string) => z
  .string()
  .default(defaultValue)
  .transform((value) => value.toLowerCase() === "true");

const hyEnvironmentNames = [
  "HY_SUPABASE_URL",
  "HY_SUPABASE_SERVICE_ROLE_KEY",
  "HY_SUPABASE_SECRET_KEY",
  "HY_CRON_SECRET",
  "HY_STRATEGY_ADMIN_SECRET",
  "HY_BINANCE_API_BASE_URL",
  "HY_BINANCE_REQUEST_DELAY_MS",
  "HY_GMAIL_SMTP_HOST",
  "HY_GMAIL_SMTP_PORT",
  "HY_GMAIL_SMTP_USER",
  "HY_GMAIL_SMTP_APP_PASSWORD",
  "HY_GMAIL_RECIPIENT",
  "HY_DEFAULT_TIMEZONE",
  "HY_SCAN_TIMEFRAMES",
  "HY_TOP_SYMBOLS",
  "HY_SCAN_BATCH_SIZE",
  "HY_MAX_EMAILS_PER_SCAN",
  "HY_MIN_SIGNAL_SCORE",
  "HY_SIGNAL_SIDE_FILTER",
  "HY_SIGNAL_STRATEGY_FAMILY",
  "HY_STRATEGY_VERSION",
  "HY_STRATEGY_SOURCE",
  "HY_STRATEGY_STAGE",
  "HY_PAPER_APPROVAL_MIN_OOS_SIGNALS",
  "HY_STRATEGY_APPROVAL_MIN_PF",
  "HY_STRATEGY_APPROVAL_MIN_OOS_SIGNALS",
  "HY_STRATEGY_APPROVAL_MAX_DRAWDOWN_PERCENT",
  "HY_STRATEGY_ENTRY_MODE",
  "HY_STRATEGY_STOP_ATR_MULTIPLIER",
  "HY_STRATEGY_REWARD_RISK",
  "HY_STRICT_REGIME_ALIGNMENT",
  "HY_GLOBAL_REGIME_ALIGNMENT",
  "HY_GLOBAL_REFERENCE_SYMBOL",
  "HY_GLOBAL_REFERENCE_TIMEFRAME",
  "HY_SIGNAL_COOLDOWN_HOURS",
  "HY_SIGNAL_STARVATION_HOURS",
  "HY_MAX_EXECUTION_COST_RISK_FRACTION",
  "HY_STRATEGY_RISK_PER_TRADE_USDT",
  "HY_STRATEGY_MAX_POSITION_NOTIONAL_USDT",
  "HY_REQUEST_CONCURRENCY",
  "HY_MARGIN_USDT",
  "HY_PER_SIGNAL_RISK_CAP_USDT",
  "HY_DAILY_RISK_BUDGET_USDT",
  "HY_ASSUMED_LEVERAGE",
  "HY_NEW_EMAIL_DAILY_CAP",
  "HY_MAX_HOLD_HOURS",
  "HY_INITIAL_PAPER_CAPITAL_USDT",
  "HY_PAPER_TRADING_ENABLED",
  "HY_PAPER_EXIT_AB_ENABLED",
  "HY_PAPER_EXIT_AB_REWARD_RISK",
  "HY_PAPER_TAKER_FEE_RATE",
  "HY_PAPER_SLIPPAGE_BPS",
  "HY_PAPER_SETTLEMENT_BATCH_SIZE",
  "HY_MICROSTRUCTURE_ENABLED",
  "HY_MICROSTRUCTURE_DEPTH_LIMIT",
  "HY_MICROSTRUCTURE_TRADE_LIMIT",
  "HY_DRY_RUN",
  "HY_OPTIMIZER_DATA_DIR",
  "HY_VALIDATION_SYMBOL_COUNT",
  "HY_VALIDATION_SYMBOLS",
  "HY_VALIDATION_FOCUS",
  "HY_VALIDATION_END_TIME",
  "HY_VALIDATION_MIN_SCORE",
  "HY_VALIDATION_FEE_RATE",
  "HY_VALIDATION_SLIPPAGE_BPS",
  "HY_VALIDATION_CONCURRENCY",
  "HY_VALIDATION_INTER_SYMBOL_DELAY_MS",
  "HY_VALIDATION_OFFLINE",
  "HY_VALIDATION_VARIANT_IDS",
  "HY_VALIDATION_ROLLING_SCORE",
  "HY_VALIDATION_ROLLING_STOP_ATR",
  "HY_VALIDATION_DAILY_LOSS_LIMIT_USDT",
  "HY_VALIDATION_CALIBRATION_BUCKET_SIZE",
  "HY_VALIDATION_CALIBRATION_MIN_SAMPLES",
  "HY_VALIDATION_CALIBRATION_MIN_NET_R",
  "HY_VALIDATION_CALIBRATION_PRIOR_WEIGHT",
  "HY_VALIDATION_CALIBRATION_GROUP_FAMILY",
  "HY_VALIDATION_ROLLING_COOLDOWN_HOURS",
  "HY_VALIDATION_ROLLING_COST_RISK",
  "HY_VALIDATION_ROLLING_ENTRY_INTERVAL_HOURS",
  "HY_VALIDATION_ROLLING_ENTRY_MODE",
  "HY_VALIDATION_ROLLING_SIDE",
  "HY_VALIDATION_ROLLING_REWARD_RISK",
  "HY_VALIDATION_ROLLING_MAX_HOLD_HOURS",
  "HY_VALIDATION_ROLLING_FAMILY",
  "HY_BACKTEST_SYMBOL_COUNT",
  "HY_BACKTEST_SYMBOLS",
  "HY_BACKTEST_SIDE_FILTER",
  "HY_BACKTEST_STRATEGY_FAMILY",
  "HY_BACKTEST_MIN_SCORE",
  "HY_BACKTEST_FEE_RATE",
  "HY_BACKTEST_SLIPPAGE_BPS",
  "HY_BACKTEST_CONCURRENCY",
  "HY_HISTORY_SYMBOLS",
  "HY_HISTORY_DAYS",
  "HY_HISTORY_TIMEFRAMES",
  "HY_HISTORY_CONCURRENCY",
] as const;

export type HyEnvName = typeof hyEnvironmentNames[number];
export type HyEnvironment = Partial<Record<HyEnvName, string>>;
type EnvironmentSource = Record<string, string | undefined>;

const unprefixedLegacyAliases: Partial<Record<HyEnvName, readonly string[]>> = {
  HY_SUPABASE_URL: ["SUPABASE_URL"],
  HY_SUPABASE_SERVICE_ROLE_KEY: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
  HY_SUPABASE_SECRET_KEY: ["SUPABASE_SECRET_KEY"],
  HY_CRON_SECRET: ["CRON_SECRET"],
  HY_STRATEGY_ADMIN_SECRET: ["STRATEGY_ADMIN_SECRET"],
  HY_BINANCE_API_BASE_URL: ["BINANCE_API_BASE_URL"],
  HY_BINANCE_REQUEST_DELAY_MS: ["BINANCE_REQUEST_DELAY_MS"],
  HY_GMAIL_SMTP_HOST: ["GMAIL_SMTP_HOST"],
  HY_GMAIL_SMTP_PORT: ["GMAIL_SMTP_PORT"],
  HY_GMAIL_SMTP_USER: ["GMAIL_SMTP_USER"],
  HY_GMAIL_SMTP_APP_PASSWORD: ["GMAIL_SMTP_APP_PASSWORD"],
  HY_GMAIL_RECIPIENT: ["GMAIL_RECIPIENT"],
};

const warnedLegacyNames = new Set<string>();

/**
 * Resolve one canonical HeYue variable. Legacy names are intentionally kept
 * here, and nowhere else, while Production environment variables migrate.
 */
export function readHyEnv(
  name: HyEnvName,
  environment: EnvironmentSource = process.env,
): string | undefined {
  const canonicalValue = environment[name];
  if (canonicalValue !== undefined) return canonicalValue;

  const legacyNames = [
    `CS_${name.slice("HY_".length)}`,
    ...(unprefixedLegacyAliases[name] ?? []),
  ];
  for (const legacyName of legacyNames) {
    const legacyValue = environment[legacyName];
    if (legacyValue !== undefined) {
      warnLegacyConfiguration(legacyName);
      return legacyValue;
    }
  }
  return undefined;
}

export function getHyEnvironment(environment: EnvironmentSource = process.env): HyEnvironment {
  return Object.fromEntries(
    hyEnvironmentNames.map((name) => [name, readHyEnv(name, environment)]),
  ) as HyEnvironment;
}

const serverEnvSchema = z.object({
  HY_SUPABASE_URL: z.string().url(),
  HY_SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  HY_SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  HY_CRON_SECRET: z.string().min(1).optional(),
  HY_STRATEGY_ADMIN_SECRET: z.string().min(1).optional(),
  HY_BINANCE_API_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  HY_BINANCE_REQUEST_DELAY_MS: z.coerce.number().nonnegative().default(0),
  HY_GMAIL_SMTP_HOST: z.string().default("smtp.gmail.com"),
  HY_GMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  HY_GMAIL_SMTP_USER: z.string().email().optional(),
  HY_GMAIL_SMTP_APP_PASSWORD: z.string().min(1).optional(),
  HY_GMAIL_RECIPIENT: z.string().email().optional(),
  HY_DEFAULT_TIMEZONE: z.string().default("Asia/Shanghai"),
  HY_SCAN_TIMEFRAMES: z.string().default("15m,1h,4h"),
  HY_TOP_SYMBOLS: z.coerce.number().int().positive().default(10),
  HY_SCAN_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  HY_MAX_EMAILS_PER_SCAN: z.coerce.number().int().positive().default(6),
  HY_MIN_SIGNAL_SCORE: z.coerce.number().min(0).max(100).default(80),
  HY_SIGNAL_SIDE_FILTER: z.enum(["BOTH", "LONG", "SHORT"]).default("SHORT"),
  HY_SIGNAL_STRATEGY_FAMILY: z.enum(["ALL", "TREND", "BREAKOUT", "MEAN_REVERSION"]).default("TREND"),
  HY_STRATEGY_VERSION: z.string().min(1).default("hy-paper-candidate-v2"),
  HY_STRATEGY_SOURCE: z.enum(["ENV", "DB"]).default("DB"),
  HY_STRATEGY_STAGE: z.enum(["PAPER", "ACTIVE"]).default("PAPER"),
  HY_PAPER_APPROVAL_MIN_OOS_SIGNALS: z.coerce.number().int().positive().default(20),
  HY_STRATEGY_APPROVAL_MIN_PF: z.coerce.number().positive().default(1.2),
  HY_STRATEGY_APPROVAL_MIN_OOS_SIGNALS: z.coerce.number().int().nonnegative().default(200),
  HY_STRATEGY_APPROVAL_MAX_DRAWDOWN_PERCENT: z.coerce.number().positive().default(12),
  HY_STRATEGY_ENTRY_MODE: z.enum(["DEFAULT", "TREND_PULLBACK", "BREAKOUT_RETEST", "RANGE_RECLAIM"]).default("TREND_PULLBACK"),
  HY_STRATEGY_STOP_ATR_MULTIPLIER: z.coerce.number().positive().default(0.75),
  HY_STRATEGY_REWARD_RISK: z.coerce.number().positive().default(2),
  HY_STRICT_REGIME_ALIGNMENT: booleanEnv("true"),
  HY_GLOBAL_REGIME_ALIGNMENT: booleanEnv("true"),
  HY_GLOBAL_REFERENCE_SYMBOL: z.string().min(1).default("BTCUSDT"),
  HY_GLOBAL_REFERENCE_TIMEFRAME: z.enum(["1h", "4h"]).default("4h"),
  HY_SIGNAL_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(24),
  HY_SIGNAL_STARVATION_HOURS: z.coerce.number().positive().default(168),
  HY_MAX_EXECUTION_COST_RISK_FRACTION: optionalNonNegativeNumber,
  HY_STRATEGY_RISK_PER_TRADE_USDT: optionalPositiveNumber,
  HY_STRATEGY_MAX_POSITION_NOTIONAL_USDT: optionalPositiveNumber,
  HY_REQUEST_CONCURRENCY: z.coerce.number().int().positive().default(5),
  HY_MARGIN_USDT: z.coerce.number().positive().default(100),
  HY_PER_SIGNAL_RISK_CAP_USDT: z.coerce.number().positive().default(50),
  HY_DAILY_RISK_BUDGET_USDT: z.coerce.number().positive().default(600),
  HY_ASSUMED_LEVERAGE: z.coerce.number().positive().default(20),
  HY_NEW_EMAIL_DAILY_CAP: z.coerce.number().int().positive().default(10),
  HY_MAX_HOLD_HOURS: z.coerce.number().positive().default(48),
  HY_INITIAL_PAPER_CAPITAL_USDT: z.coerce.number().positive().default(10000),
  HY_PAPER_TRADING_ENABLED: booleanEnv("true"),
  HY_PAPER_EXIT_AB_ENABLED: booleanEnv("false"),
  HY_PAPER_EXIT_AB_REWARD_RISK: z.coerce.number().positive().default(2.5),
  HY_PAPER_TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  HY_PAPER_SLIPPAGE_BPS: z.coerce.number().nonnegative().default(2),
  HY_PAPER_SETTLEMENT_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  HY_MICROSTRUCTURE_ENABLED: booleanEnv("false"),
  HY_MICROSTRUCTURE_DEPTH_LIMIT: z.coerce.number().int().refine(
    (value) => [5, 10, 20, 50, 100, 500, 1000].includes(value),
    "HY_MICROSTRUCTURE_DEPTH_LIMIT must be one of Binance's supported depth limits",
  ).default(20),
  HY_MICROSTRUCTURE_TRADE_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
  HY_DRY_RUN: booleanEnv("true"),
});

export type ServerConfig = z.infer<typeof serverEnvSchema> & {
  supabaseServiceKey: string;
  scanTimeframes: string[];
  strategy: RuntimeStrategyPolicy;
};

export function getServerConfig(environment: EnvironmentSource = process.env): ServerConfig {
  const parsed = serverEnvSchema.parse(getHyEnvironment(environment));
  const supabaseServiceKey = parsed.HY_SUPABASE_SERVICE_ROLE_KEY ?? parsed.HY_SUPABASE_SECRET_KEY;

  if (!supabaseServiceKey) {
    throw new Error("Missing HY_SUPABASE_SERVICE_ROLE_KEY");
  }

  return {
    ...parsed,
    supabaseServiceKey,
    scanTimeframes: parsed.HY_SCAN_TIMEFRAMES.split(",")
      .map((timeframe) => timeframe.trim())
      .filter(Boolean),
    strategy: createRuntimeStrategyPolicy({
      version: parsed.HY_STRATEGY_VERSION,
      entryMode: parsed.HY_STRATEGY_ENTRY_MODE,
      stopAtrMultiplier: parsed.HY_STRATEGY_STOP_ATR_MULTIPLIER,
      minScore: parsed.HY_MIN_SIGNAL_SCORE,
      sideFilter: parsed.HY_SIGNAL_SIDE_FILTER,
      strategyFamily: parsed.HY_SIGNAL_STRATEGY_FAMILY,
      requireRegimeAlignment: parsed.HY_STRICT_REGIME_ALIGNMENT,
      riskPolicy: {
        marginUsdt: parsed.HY_MARGIN_USDT,
        leverage: parsed.HY_ASSUMED_LEVERAGE,
        singleSignalRiskCapUsdt: parsed.HY_PER_SIGNAL_RISK_CAP_USDT,
        dailyRiskBudgetUsdt: parsed.HY_DAILY_RISK_BUDGET_USDT,
        maxHoldHours: parsed.HY_MAX_HOLD_HOURS,
        rewardRisk: parsed.HY_STRATEGY_REWARD_RISK,
        riskPerTradeUsdt: parsed.HY_STRATEGY_RISK_PER_TRADE_USDT,
        maxPositionNotionalUsdt: parsed.HY_STRATEGY_MAX_POSITION_NOTIONAL_USDT,
      },
      cooldownHours: parsed.HY_SIGNAL_COOLDOWN_HOURS,
      maxExecutionCostRiskFraction: parsed.HY_MAX_EXECUTION_COST_RISK_FRACTION,
      takerFeeRate: parsed.HY_PAPER_TAKER_FEE_RATE,
      slippageBps: parsed.HY_PAPER_SLIPPAGE_BPS,
      globalRegimeAlignment: parsed.HY_GLOBAL_REGIME_ALIGNMENT,
      globalReferenceSymbol: parsed.HY_GLOBAL_REFERENCE_SYMBOL,
      globalReferenceTimeframe: parsed.HY_GLOBAL_REFERENCE_TIMEFRAME,
    }),
  };
}

function warnLegacyConfiguration(name: string): void {
  if (warnedLegacyNames.has(name)) return;
  warnedLegacyNames.add(name);
  if (name.startsWith("CS_")) {
    console.warn("legacy CS_* configuration detected");
    return;
  }
  console.warn("legacy unprefixed HeYue configuration detected");
}


export function isUsableRuntimeValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 && normalized !== "[SENSITIVE]" && normalized !== "[REDACTED]";
}
