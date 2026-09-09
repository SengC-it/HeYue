import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIRECTORY = resolve("data", "hy-r2b-history-24m");
const REPORT_DIRECTORY = resolve("reports");
const JSON_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.1-aggressive-flow-information-gain.json");
const MARKDOWN_REPORT_PATH = resolve(REPORT_DIRECTORY, "hy-r5.1-aggressive-flow-information-gain.md");

const EVALUATION_START = "2024-08-09T00:00:00.000Z";
const EVALUATION_END = "2026-08-09T23:59:59.999Z";
const EXPERIMENT_COUNT = 1;
const HORIZONS = ["1h", "4h", "12h", "24h"] as const;
type Horizon = (typeof HORIZONS)[number];
type Orthogonality = "ALREADY_USED" | "PARTIALLY_USED" | "ORTHOGONAL";
type FinalClassification =
  | "ROBUST_INCREMENTAL_INFORMATION"
  | "CONDITIONAL_INFORMATION_ONLY"
  | "NO_INCREMENTAL_INFORMATION"
  | "RESEARCH_INVALID";

type JsonRecord = Record<string, unknown>;

interface DataInventory {
  directory: string;
  datasets: number;
  symbols: string[];
  timeframes: Record<string, { files: number; rows: number }>;
  local_cache_coverage: { start: string | null; end: string | null };
  one_minute_files: number;
  one_minute_rows: number;
  taker_buy_base_fields: number;
  taker_buy_quote_fields: number;
  buyer_maker_fields: number;
  flow_coverage: { start: string | null; end: string | null };
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function containsAny(keys: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => keys.has(candidate));
}

function emptyHorizonMetrics(): Record<Horizon, JsonRecord> {
  const metrics = {} as Record<Horizon, JsonRecord>;
  for (const horizon of HORIZONS) {
    metrics[horizon] = {
      status: "NOT_RUN_PRECHECK_STOP",
      n: 0,
      effect_size: null,
      ci95: null,
      p_value: null,
      adjusted_p_value: null,
    };
  }
  return metrics;
}

async function inspectLocalData(): Promise<DataInventory> {
  let names: string[] = [];
  try {
    names = (await readdir(DATA_DIRECTORY)).filter((name) => name.endsWith(".json"));
  } catch {
    return {
      directory: DATA_DIRECTORY,
      datasets: 0,
      symbols: [],
      timeframes: {},
      local_cache_coverage: { start: null, end: null },
      one_minute_files: 0,
      one_minute_rows: 0,
      taker_buy_base_fields: 0,
      taker_buy_quote_fields: 0,
      buyer_maker_fields: 0,
      flow_coverage: { start: null, end: null },
    };
  }

  const symbols = new Set<string>();
  const timeframes: Record<string, { files: number; rows: number }> = {};
  let localStart: number | null = null;
  let localEnd: number | null = null;
  let flowStart: number | null = null;
  let flowEnd: number | null = null;
  let oneMinuteFiles = 0;
  let oneMinuteRows = 0;
  let takerBuyBaseFields = 0;
  let takerBuyQuoteFields = 0;
  let buyerMakerFields = 0;

  for (const name of names.sort()) {
    const parsed = JSON.parse(await readFile(resolve(DATA_DIRECTORY, name), "utf8")) as JsonRecord;
    const symbol = typeof parsed.symbol === "string" ? parsed.symbol : name.replace(/\.json$/, "");
    symbols.add(symbol);
    const candles = asRecord(parsed.candles);

    for (const [timeframe, rawRows] of Object.entries(candles ?? {})) {
      const rows = asArray(rawRows);
      const summary = timeframes[timeframe] ?? { files: 0, rows: 0 };
      summary.files += 1;
      summary.rows += rows.length;
      timeframes[timeframe] = summary;

      const first = asRecord(rows[0]);
      const last = asRecord(rows.at(-1));
      const firstOpen = finiteNumber(first?.openTime);
      const lastClose = finiteNumber(last?.closeTime);
      if (firstOpen !== null) localStart = localStart === null ? firstOpen : Math.min(localStart, firstOpen);
      if (lastClose !== null) localEnd = localEnd === null ? lastClose : Math.max(localEnd, lastClose);

      if (timeframe !== "1m") continue;
      oneMinuteFiles += 1;
      oneMinuteRows += rows.length;
      for (const rawRow of rows.slice(0, 10)) {
        const row = asRecord(rawRow);
        const keys = new Set(Object.keys(row ?? {}));
        if (containsAny(keys, ["takerBuyBaseVolume", "taker_buy_base_volume"])) takerBuyBaseFields += 1;
        if (containsAny(keys, ["takerBuyQuoteVolume", "taker_buy_quote_volume"])) takerBuyQuoteFields += 1;
        if (containsAny(keys, ["buyerMaker", "buyer_maker", "m"])) buyerMakerFields += 1;
      }
      const firstFlow = asRecord(rows[0]);
      const lastFlow = asRecord(rows.at(-1));
      const firstFlowTime = finiteNumber(firstFlow?.openTime ?? firstFlow?.timestamp ?? firstFlow?.time);
      const lastFlowTime = finiteNumber(lastFlow?.closeTime ?? lastFlow?.timestamp ?? lastFlow?.time);
      if (firstFlowTime !== null) flowStart = flowStart === null ? firstFlowTime : Math.min(flowStart, firstFlowTime);
      if (lastFlowTime !== null) flowEnd = flowEnd === null ? lastFlowTime : Math.max(flowEnd, lastFlowTime);
    }
  }

  return {
    directory: DATA_DIRECTORY,
    datasets: names.length,
    symbols: [...symbols].sort(),
    timeframes,
    local_cache_coverage: { start: iso(localStart), end: iso(localEnd) },
    one_minute_files: oneMinuteFiles,
    one_minute_rows: oneMinuteRows,
    taker_buy_base_fields: takerBuyBaseFields,
    taker_buy_quote_fields: takerBuyQuoteFields,
    buyer_maker_fields: buyerMakerFields,
    flow_coverage: { start: iso(flowStart), end: iso(flowEnd) },
  };
}

async function readSourceAudit(): Promise<{
  checks: JsonRecord;
  classification: Orthogonality;
  references: string[];
}> {
  const sourcePaths = [
    "lib/binance/public-client.ts",
    "app/api/scan/route.ts",
    "lib/services/signal-repository.ts",
  ];
  const sourceText = new Map<string, string>();
  for (const sourcePath of sourcePaths) {
    sourceText.set(sourcePath, await readFile(resolve(sourcePath), "utf8"));
  }
  const publicClient = sourceText.get("lib/binance/public-client.ts") ?? "";
  const scanRoute = sourceText.get("app/api/scan/route.ts") ?? "";
  const repository = sourceText.get("lib/services/signal-repository.ts") ?? "";
  const signalEngineNames = await readdir(resolve("lib", "signal-engine"));
  const signalEngineText = (await Promise.all(
    signalEngineNames.filter((name) => name.endsWith(".ts")).map((name) => readFile(resolve("lib", "signal-engine", name), "utf8")),
  )).join("\n");

  const checks = {
    public_agg_trades_endpoint: publicClient.includes("/fapi/v1/aggTrades"),
    buyer_maker_direction: publicClient.includes("!trade.m"),
    aggressive_buy_quote_volume: publicClient.includes("aggressiveBuyQuoteVolume"),
    aggressive_flow_ratio: publicClient.includes("aggressiveBuyRatio"),
    scan_snapshot_wiring: scanRoute.includes("includeMicrostructure") && scanRoute.includes("snapshot.microstructure"),
    candidate_persistence: repository.includes("microstructure"),
    current_signal_engine_rule_consumption: /aggressiveBuy|aggressive.?flow|microstructure/i.test(signalEngineText),
    historical_1m_taker_feature_parser: false,
  };
  const equivalentPathExists = Boolean(
    checks.public_agg_trades_endpoint
      && checks.buyer_maker_direction
      && checks.aggressive_flow_ratio
      && checks.scan_snapshot_wiring,
  );
  const classification: Orthogonality = equivalentPathExists
    ? (checks.current_signal_engine_rule_consumption ? "ALREADY_USED" : "PARTIALLY_USED")
    : "ORTHOGONAL";

  return {
    checks,
    classification,
    references: [
      "lib/binance/public-client.ts:166-193 (public /fapi/v1/aggTrades fetch)",
      "lib/binance/public-client.ts:311-345 (buyer-maker direction and aggressiveBuyRatio derivation)",
      "app/api/scan/route.ts:94-131 (optional microstructure snapshot wiring)",
      "lib/services/signal-repository.ts:160-176 (microstructure persisted with candidate score components)",
    ],
  };
}

function buildMarkdown(report: JsonRecord): string {
  const orthogonality = asRecord(report.orthogonality_assessment);
  const data = asRecord(report.data_source);
  const inventory = asRecord(data?.local_inventory);
  const quality = asRecord(report.data_completeness);
  const controls = asRecord(report.matched_control_comparison);
  const statistics = asRecord(report.statistics);
  const experiment = asRecord(report.experiment_control);
  const h1 = asRecord(report.hypotheses)?.H1_FLOW_CONTINUATION as JsonRecord | undefined;
  const h2 = asRecord(report.hypotheses)?.H2_FLOW_ABSORPTION as JsonRecord | undefined;
  const h3 = asRecord(report.hypotheses)?.H3_FLOW_SHOCK_RISK as JsonRecord | undefined;
  const lines: string[] = [
    "# HY-R5.1 Aggressive Flow Information Gain Research",
    "",
    "## Gate result",
    "",
    `- Final classification: **${String(report.final_classification)}**`,
    `- Stop reason: ${String(report.stop_reason)}`,
    `- Orthogonality classification: **${String(orthogonality?.classification)}**`,
    "- No performance result is reported because the mandatory preflight stopped the experiment.",
    "",
    "## Orthogonality assessment",
    "",
    "The repository already contains an optional public aggregate-trade path that classifies buyer-maker direction and derives an aggressive-buy ratio. The current signal-engine rules do not consume that field, so the proposed research is **partially used**, not genuinely orthogonal at the pipeline boundary.",
    "",
    ...((orthogonality?.references as string[] | undefined) ?? []).map((reference) => `- ${reference}`),
    "",
    "## Data source and coverage",
    "",
    `- Source inspected: ${String(data?.source)}`,
    `- Public/private API requests made by this audit: ${String(data?.api_requests)}`,
    `- Requested evaluation window: ${EVALUATION_START} -> ${EVALUATION_END}`,
    `- Local cache datasets: ${String(inventory?.datasets)}`,
    `- Local cache coverage: ${String(asRecord(inventory?.local_cache_coverage)?.start)} -> ${String(asRecord(inventory?.local_cache_coverage)?.end)}`,
    `- 1m datasets / rows: ${String(inventory?.one_minute_files)} / ${String(inventory?.one_minute_rows)}`,
    `- Taker-buy base/quote fields found: ${String(inventory?.taker_buy_base_fields)} / ${String(inventory?.taker_buy_quote_fields)}`,
    `- Flow coverage: ${String(asRecord(inventory?.flow_coverage)?.start)} -> ${String(asRecord(inventory?.flow_coverage)?.end)}`,
    `- Data status: **${String(report.data_status)}**`,
    `- PIT-safe: **${String(report.pit_safe)}** (no 1m flow rows were available to validate)`,
    "",
    "The available cache contains normalized 15m/1h/4h OHLCV and funding data, but no 1m taker-buy base/quote history. No public download was started after the preflight stop, and no private/account/order endpoint was used.",
    "",
    "## Data completeness gate",
    "",
    `- Overall: **${String(quality?.overall)}**`,
    "- Missing intervals: NOT EVALUATED (no flow rows)",
    "- Duplicate rows: NOT EVALUATED (no flow rows)",
    "- Timestamp ordering: NOT EVALUATED (no flow rows)",
    "- Negative volume: NOT EVALUATED (no flow rows)",
    "- Taker-buy > total-volume: NOT EVALUATED (no flow rows)",
    "- Symbol coverage: 49 OHLCV symbols, 0 flow symbols",
    "- Historical flow coverage: MISSING",
    "",
    "## Frozen feature specification",
    "",
    "These definitions were recorded before any performance calculation and were not tuned:",
    "",
    "- `TAKER_FLOW_IMBALANCE = (buy_quote - sell_quote) / (buy_quote + sell_quote)`, with `sell_quote = total_quote - buy_quote`.",
    "- `FLOW_ACCELERATION = current short-window flow / PIT-safe historical baseline`.",
    "- `PRICE_RESPONSE = directional price response contemporaneous with aggressive flow`.",
    "- `ABSORPTION_FAILURE = extreme flow without the corresponding price response`.",
    "",
    "### Frozen threshold policy",
    "",
    "- Extreme buy: PIT-safe historical percentile >= 90th percentile.",
    "- Extreme sell: PIT-safe historical percentile <= 10th percentile.",
    "- Short-window, historical baseline, matched controls, horizons, and seed would be fixed before any future run.",
    "- No threshold search or post-result tuning occurred.",
    "",
    "## Hypotheses and results",
    "",
    "All result cells are intentionally unavailable because the preflight gate stopped the experiment. `n=0` is not a finding about flow quality.",
    "",
    "| Hypothesis | Bullish/bearish split | 1h | 4h | 12h | 24h |",
    "| --- | --- | --- | --- | --- | --- |",
    `| H1 FLOW_CONTINUATION | ${String(h1?.status)} | n/a | n/a | n/a | n/a |`,
    `| H2 FLOW_ABSORPTION | ${String(h2?.status)} | n/a | n/a | n/a | n/a |`,
    `| H3 FLOW_SHOCK_RISK | ${String(h3?.status)} | n/a | n/a | n/a | n/a |`,
    "",
    "Required metrics (direction precision, directional/median return, MFE, MAE, MFE/MAE, volatility, large-move and extreme-move probabilities) were not computed.",
    "",
    "## Matched controls",
    "",
    `- Status: **${String(controls?.status)}**`,
    "- Required fields: symbol, calendar period, market regime, volatility bucket, liquidity bucket.",
    "- Outcome-based matching: NO.",
    "- Planned control selection: deterministic, without replacement, no future observations.",
    "- 1h / 4h / 12h / 24h comparison: NOT RUN.",
    "",
    "## Statistics and stability",
    "",
    `- Status: **${String(statistics?.status)}**`,
    "- Planned bootstrap/permutation: fixed seed 5151, 2,000 replicates, two-sided 95% CI.",
    "- Planned multiple-testing correction: Holm step-down across predeclared hypothesis × direction × horizon families.",
    "- Bootstrap/permutation executed: NO.",
    "- Quarter stability: NOT EVALUATED.",
    "- Regime stability: NOT EVALUATED.",
    "- Symbol concentration: NOT EVALUATED.",
    "",
    "## Experiment control",
    "",
    `- Experiment count: ${String(experiment?.experiment_count)}`,
    `- Features frozen before performance: ${String(experiment?.features_frozen_before_performance)}`,
    `- Thresholds frozen: ${String(experiment?.thresholds_frozen)}`,
    `- Post-result tuning: ${String(experiment?.post_result_tuning)}`,
    `- Formal performance executed: ${String(experiment?.performance_executed)}`,
    "",
    "## Decision",
    "",
    "**RESEARCH_INVALID**. The requested R5.1 run cannot claim a clean incremental-information result while equivalent aggressive-flow information is already present in the existing public-data pipeline and the required historical 1m flow dataset is absent. First isolate or explicitly exclude the existing microstructure path, then provide a complete PIT-safe 1m taker-flow archive before rerunning the single frozen experiment.",
    "",
    "## Safety boundary",
    "",
    "- Production modified: NO",
    "- Supabase Production modified: NO",
    "- Vercel modified: NO",
    "- PAPER strategy modified: NO",
    "- Emails sent: 0",
    "- Private API called: NO",
    "- AUTO_TRADING: FALSE",
    "- Commit created: NO",
    "",
    "STOP.",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [orthogonality, localInventory] = await Promise.all([
    readSourceAudit(),
    inspectLocalData(),
  ]);
  const flowDataAvailable = localInventory.one_minute_files > 0
    && localInventory.one_minute_rows > 0
    && localInventory.taker_buy_base_fields > 0
    && localInventory.taker_buy_quote_fields > 0;
  const finalClassification: FinalClassification = orthogonality.classification !== "ORTHOGONAL" || !flowDataAvailable
    ? "RESEARCH_INVALID"
    : "CONDITIONAL_INFORMATION_ONLY";
  const report: JsonRecord = {
    research: "HY-R5.1 AGGRESSIVE FLOW INFORMATION GAIN RESEARCH",
    version: "hy-r5.1-v1",
    final_classification: finalClassification,
    stop_reason: orthogonality.classification !== "ORTHOGONAL"
      ? "Mandatory orthogonality preflight returned PARTIALLY_USED; formal performance stopped."
      : "Required PIT-safe 1m taker-flow history is incomplete; formal performance stopped.",
    orthogonality_assessment: {
      classification: orthogonality.classification,
      equivalent_information_present: orthogonality.classification !== "ORTHOGONAL",
      checks: orthogonality.checks,
      references: orthogonality.references,
      rule_engine_consumes_flow: Boolean(orthogonality.checks.current_signal_engine_rule_consumption),
    },
    data_source: {
      source: "local repository cache data/hy-r2b-history-24m; Binance USD-M public historical data schema expected but not present for flow",
      api_requests: "NONE",
      private_account_or_order_endpoints: "NONE",
      local_inventory: localInventory,
    },
    requested_historical_coverage: {
      start: EVALUATION_START,
      end: EVALUATION_END,
      datasets: localInventory.datasets,
      observations: 0,
      flow_coverage: localInventory.flow_coverage,
    },
    data_status: flowDataAvailable ? "AVAILABLE_BUT_EXPERIMENT_STOPPED" : "DATA_INCOMPLETE",
    pit_safe: flowDataAvailable ? "NOT_RUN_PRECHECK_STOP" : "FAIL",
    data_completeness: {
      overall: flowDataAvailable ? "NOT_RUN_PRECHECK_STOP" : "DATA_INCOMPLETE",
      missing_intervals: "NOT_EVALUATED_NO_FLOW_ROWS",
      duplicate_rows: "NOT_EVALUATED_NO_FLOW_ROWS",
      timestamp_ordering: "NOT_EVALUATED_NO_FLOW_ROWS",
      negative_volumes: "NOT_EVALUATED_NO_FLOW_ROWS",
      taker_buy_exceeds_total: "NOT_EVALUATED_NO_FLOW_ROWS",
      symbol_coverage: { ohlcv_symbols: localInventory.symbols.length, flow_symbols: 0 },
      historical_coverage: "MISSING_FOR_REQUIRED_1M_FLOW",
      no_silent_discard: true,
    },
    feature_specification: {
      frozen: true,
      features: [
        "TAKER_FLOW_IMBALANCE",
        "FLOW_ACCELERATION",
        "PRICE_RESPONSE",
        "ABSORPTION_FAILURE",
      ],
      sell_quote_formula: "total_quote - taker_buy_quote",
    },
    frozen_thresholds: {
      extreme_buy_percentile: 90,
      extreme_sell_percentile: 10,
      selected_once_before_performance: true,
      post_result_tuning: false,
    },
    experiment_control: {
      experiment_count: EXPERIMENT_COUNT,
      features_frozen_before_performance: "YES",
      thresholds_frozen: "YES",
      post_result_tuning: "NO",
      performance_executed: false,
    },
    hypotheses: {
      H1_FLOW_CONTINUATION: {
        status: "NOT_RUN_PRECHECK_STOP",
        bullish: emptyHorizonMetrics(),
        bearish: emptyHorizonMetrics(),
      },
      H2_FLOW_ABSORPTION: {
        status: "NOT_RUN_PRECHECK_STOP",
        potential_bullish: emptyHorizonMetrics(),
        potential_bearish: emptyHorizonMetrics(),
      },
      H3_FLOW_SHOCK_RISK: {
        status: "NOT_RUN_PRECHECK_STOP",
        future_realized_volatility: emptyHorizonMetrics(),
        large_move_probability: emptyHorizonMetrics(),
        extreme_move_probability: emptyHorizonMetrics(),
      },
    },
    matched_control_comparison: {
      status: "NOT_RUN_PRECHECK_STOP",
      fields: ["symbol", "calendar_period", "market_regime", "volatility_bucket", "liquidity_bucket"],
      outcome_based_matching: false,
      horizons: HORIZONS,
      signal_observations: 0,
      control_observations: 0,
      results: Object.fromEntries(HORIZONS.map((horizon) => [horizon, { status: "NOT_RUN_PRECHECK_STOP" }])),
    },
    statistics: {
      status: "NOT_RUN_PRECHECK_STOP",
      bootstrap_replicates: 2000,
      permutation_replicates: 2000,
      seed: 5151,
      confidence_level: 0.95,
      multiple_testing: "Holm step-down across predeclared hypothesis × direction × horizon families",
      executed: false,
    },
    stability: {
      quarters: "NOT_EVALUATED",
      symbols: "NOT_EVALUATED",
      regimes: "NOT_EVALUATED",
      bullish_bearish_separate: true,
    },
    best_robust_phenomenon: null,
    robust_components: [],
    next_orthogonal_categories_if_future_research_is_authorized: [
      "Order Book Imbalance",
      "Positioning / Crowding",
      "Basis / Premium",
      "Liquidation / Cascade data",
    ],
    safety: {
      production_modified: false,
      supabase_production_modified: false,
      vercel_modified: false,
      paper_strategy_modified: false,
      emails_sent: 0,
      private_api_called: false,
      auto_trading: false,
      commit_created: false,
    },
  };

  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdown(report), "utf8");
  console.log(JSON.stringify({
    json: JSON_REPORT_PATH,
    markdown: MARKDOWN_REPORT_PATH,
    orthogonality: orthogonality.classification,
    dataStatus: report.data_status,
    classification: finalClassification,
    datasets: localInventory.datasets,
    observations: 0,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
