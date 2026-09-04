export interface StrategyApprovalGate {
  minProfitFactor: number;
  minOutOfSampleSignals: number;
  maxDrawdownPercent: number;
}

export interface StrategyApprovalMetrics {
  netPnlUsdt: number;
  profitFactor: number;
  signals: number;
  maxDrawdownPercent: number;
}

export function extractStrategyApprovalMetrics(metrics: unknown): StrategyApprovalMetrics | null {
  if (!isRecord(metrics)) return null;
  const outOfSample = isRecord(metrics.out_of_sample)
    ? metrics.out_of_sample
    : isRecord(metrics.outOfSample)
      ? metrics.outOfSample
      : null;
  if (!outOfSample) return null;

  const netPnlUsdt = readNumber(outOfSample.netPnlUsdt ?? outOfSample.net_pnl_usdt);
  const profitFactor = readNumber(outOfSample.profitFactor ?? outOfSample.profit_factor);
  const signals = readNumber(outOfSample.trades ?? outOfSample.signals);
  const maxDrawdownPercent = readNumber(
    outOfSample.maxDrawdownPercent ?? outOfSample.max_drawdown_percent,
  );

  if (
    netPnlUsdt === null
    || profitFactor === null
    || signals === null
    || maxDrawdownPercent === null
  ) {
    return null;
  }

  return { netPnlUsdt, profitFactor, signals, maxDrawdownPercent };
}

export function passesStrategyApprovalGate(
  metrics: unknown,
  gate: StrategyApprovalGate,
): boolean {
  const extracted = extractStrategyApprovalMetrics(metrics);
  return Boolean(
    extracted
    && extracted.netPnlUsdt > 0
    && extracted.profitFactor >= gate.minProfitFactor
    && extracted.signals >= gate.minOutOfSampleSignals
    && extracted.maxDrawdownPercent <= gate.maxDrawdownPercent,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
