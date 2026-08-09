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

const serverEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  STRATEGY_ADMIN_SECRET: z.string().min(1).optional(),
  BINANCE_API_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  GMAIL_SMTP_HOST: z.string().default("smtp.gmail.com"),
  GMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  GMAIL_SMTP_USER: z.string().email().optional(),
  GMAIL_SMTP_APP_PASSWORD: z.string().min(1).optional(),
  GMAIL_RECIPIENT: z.string().email().optional(),
  CS_DEFAULT_TIMEZONE: z.string().default("Asia/Shanghai"),
  CS_SCAN_TIMEFRAMES: z.string().default("15m,1h,4h"),
  CS_TOP_SYMBOLS: z.coerce.number().int().positive().default(10),
  CS_SCAN_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  CS_MAX_EMAILS_PER_SCAN: z.coerce.number().int().positive().default(6),
  CS_MIN_SIGNAL_SCORE: z.coerce.number().min(0).max(100).default(80),
  CS_SIGNAL_SIDE_FILTER: z.enum(["BOTH", "LONG", "SHORT"]).default("SHORT"),
  CS_SIGNAL_STRATEGY_FAMILY: z.enum(["ALL", "TREND", "BREAKOUT", "MEAN_REVERSION"]).default("TREND"),
  CS_STRATEGY_VERSION: z.string().min(1).default("hy-paper-candidate-v2"),
  CS_STRATEGY_SOURCE: z.enum(["ENV", "DB"]).default("DB"),
  CS_STRATEGY_STAGE: z.enum(["PAPER", "ACTIVE"]).default("PAPER"),
  CS_PAPER_APPROVAL_MIN_OOS_SIGNALS: z.coerce.number().int().positive().default(20),
  CS_STRATEGY_APPROVAL_MIN_PF: z.coerce.number().positive().default(1.2),
  CS_STRATEGY_APPROVAL_MIN_OOS_SIGNALS: z.coerce.number().int().nonnegative().default(200),
  CS_STRATEGY_APPROVAL_MAX_DRAWDOWN_PERCENT: z.coerce.number().positive().default(12),
  CS_STRATEGY_ENTRY_MODE: z.enum(["DEFAULT", "TREND_PULLBACK", "BREAKOUT_RETEST", "RANGE_RECLAIM"]).default("TREND_PULLBACK"),
  CS_STRATEGY_STOP_ATR_MULTIPLIER: z.coerce.number().positive().default(0.75),
  CS_STRATEGY_REWARD_RISK: z.coerce.number().positive().default(2),
  CS_STRICT_REGIME_ALIGNMENT: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  CS_GLOBAL_REGIME_ALIGNMENT: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  CS_GLOBAL_REFERENCE_SYMBOL: z.string().min(1).default("BTCUSDT"),
  CS_GLOBAL_REFERENCE_TIMEFRAME: z.enum(["1h", "4h"]).default("4h"),
  CS_SIGNAL_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(24),
  CS_MAX_EXECUTION_COST_RISK_FRACTION: optionalNonNegativeNumber,
  CS_STRATEGY_RISK_PER_TRADE_USDT: optionalPositiveNumber,
  CS_STRATEGY_MAX_POSITION_NOTIONAL_USDT: optionalPositiveNumber,
  CS_REQUEST_CONCURRENCY: z.coerce.number().int().positive().default(5),
  CS_MARGIN_USDT: z.coerce.number().positive().default(100),
  CS_PER_SIGNAL_RISK_CAP_USDT: z.coerce.number().positive().default(50),
  CS_DAILY_RISK_BUDGET_USDT: z.coerce.number().positive().default(600),
  CS_ASSUMED_LEVERAGE: z.coerce.number().positive().default(20),
  CS_NEW_EMAIL_DAILY_CAP: z.coerce.number().int().positive().default(10),
  CS_MAX_HOLD_HOURS: z.coerce.number().positive().default(48),
  CS_INITIAL_PAPER_CAPITAL_USDT: z.coerce.number().positive().default(10000),
  CS_PAPER_TRADING_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  CS_PAPER_EXIT_AB_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  CS_PAPER_EXIT_AB_REWARD_RISK: z.coerce.number().positive().default(2.5),
  CS_PAPER_TAKER_FEE_RATE: z.coerce.number().nonnegative().default(0.0004),
  CS_PAPER_SLIPPAGE_BPS: z.coerce.number().nonnegative().default(2),
  CS_PAPER_SETTLEMENT_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  CS_MICROSTRUCTURE_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  CS_MICROSTRUCTURE_DEPTH_LIMIT: z.coerce.number().int().refine(
    (value) => [5, 10, 20, 50, 100, 500, 1000].includes(value),
    "CS_MICROSTRUCTURE_DEPTH_LIMIT must be one of Binance's supported depth limits",
  ).default(20),
  CS_MICROSTRUCTURE_TRADE_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
  CS_DRY_RUN: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
});

export type ServerConfig = z.infer<typeof serverEnvSchema> & {
  supabaseServiceKey: string;
  scanTimeframes: string[];
  strategy: RuntimeStrategyPolicy;
};

export function getServerConfig(): ServerConfig {
  const parsed = serverEnvSchema.parse(process.env);
  const supabaseServiceKey = parsed.SUPABASE_SERVICE_ROLE_KEY ?? parsed.SUPABASE_SECRET_KEY;

  if (!supabaseServiceKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY");
  }

  return {
    ...parsed,
    supabaseServiceKey,
    scanTimeframes: parsed.CS_SCAN_TIMEFRAMES.split(",")
      .map((timeframe) => timeframe.trim())
      .filter(Boolean),
    strategy: createRuntimeStrategyPolicy({
      version: parsed.CS_STRATEGY_VERSION,
      entryMode: parsed.CS_STRATEGY_ENTRY_MODE,
      stopAtrMultiplier: parsed.CS_STRATEGY_STOP_ATR_MULTIPLIER,
      minScore: parsed.CS_MIN_SIGNAL_SCORE,
      sideFilter: parsed.CS_SIGNAL_SIDE_FILTER,
      strategyFamily: parsed.CS_SIGNAL_STRATEGY_FAMILY,
      requireRegimeAlignment: parsed.CS_STRICT_REGIME_ALIGNMENT,
      riskPolicy: {
        marginUsdt: parsed.CS_MARGIN_USDT,
        leverage: parsed.CS_ASSUMED_LEVERAGE,
        singleSignalRiskCapUsdt: parsed.CS_PER_SIGNAL_RISK_CAP_USDT,
        dailyRiskBudgetUsdt: parsed.CS_DAILY_RISK_BUDGET_USDT,
        maxHoldHours: parsed.CS_MAX_HOLD_HOURS,
        rewardRisk: parsed.CS_STRATEGY_REWARD_RISK,
        riskPerTradeUsdt: parsed.CS_STRATEGY_RISK_PER_TRADE_USDT,
        maxPositionNotionalUsdt: parsed.CS_STRATEGY_MAX_POSITION_NOTIONAL_USDT,
      },
      cooldownHours: parsed.CS_SIGNAL_COOLDOWN_HOURS,
      maxExecutionCostRiskFraction: parsed.CS_MAX_EXECUTION_COST_RISK_FRACTION,
      takerFeeRate: parsed.CS_PAPER_TAKER_FEE_RATE,
      slippageBps: parsed.CS_PAPER_SLIPPAGE_BPS,
      globalRegimeAlignment: parsed.CS_GLOBAL_REGIME_ALIGNMENT,
      globalReferenceSymbol: parsed.CS_GLOBAL_REFERENCE_SYMBOL,
      globalReferenceTimeframe: parsed.CS_GLOBAL_REFERENCE_TIMEFRAME,
    }),
  };
}
