import { createHash } from "node:crypto";

export const R71A_REPORT_VERSION = "hy-r7.1a-v1";
export const R71A_CANDIDATE_ID = "HY-R7-FORWARD-CANDIDATE-A";
export const R71A_FORWARD_MIN_CALENDAR_DAYS = 30;
export const R71A_FORWARD_MIN_MATURED_TRADES = 100;
export const R71A_EARLY_KILL_MIN_TRADES = 30;
export const R71A_HISTORICAL_DD_TOLERANCE = 0.092414;

export interface ForwardPaperTradeEvidence {
  symbol: string;
  side: string;
  strategyFamily: string;
  strategyVersion: string;
  entryTime: string;
  exitTime: string;
  status: string;
  netPnlUsdt: number;
  rMultiple: number;
  exitReason: string;
}

export interface ProductionEvidenceSnapshot {
  schemaVersion: string;
  source: string;
  projectRef: string;
  observedAt: string;
  finalOosBoundary: string;
  strategy: {
    version: string;
    strategyFamily: string;
    parameters: Record<string, unknown>;
    status: string;
  };
  forwardPaperTrades: ForwardPaperTradeEvidence[];
  runtimeSafety: {
    strategySource: string;
    strategyStage: string;
    strategyVersion: string;
    paperTradingEnabled: boolean;
    dryRun: boolean;
    exchangeCredentialsConfigured: boolean;
    autoTrading: boolean;
    b4ShadowEnabled: boolean;
    b4EmailSent: number;
  };
}

export interface FrozenFailureSetEvidence {
  rowCount: number;
  uniqueNotificationIds: number;
  uniqueSignalIds: number;
  allSent: boolean;
  allAuditClassified: boolean;
  rows: Record<string, string>[];
}

export interface ForwardMetrics {
  maturedTrades: number;
  wins: number;
  losses: number;
  netPnlUsdt: number;
  expectancyUsdt: number;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownUsdt: number;
  maxDrawdownPercent: number;
  firstEntryTime: string | null;
  lastExitTime: string | null;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function canonicalCsvText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      records.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    records.push(row);
  }
  const headers = records.shift() ?? [];
  return records.filter((items) => items.some((item) => item.length > 0)).map((items) => (
    Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ""]))
  ));
}

export function validateFrozenFailureSet(csvText: string): FrozenFailureSetEvidence {
  const rows = parseCsv(csvText);
  const notificationIds = new Set(rows.map((row) => row.notification_id));
  const signalIds = new Set(rows.map((row) => row.signal_id));
  if (rows.length !== 37) throw new Error(`Frozen failure set must contain exactly 37 rows; received ${rows.length}`);
  if (notificationIds.size !== 37 || signalIds.size !== 37) throw new Error("Frozen failure set IDs must be unique");
  if (rows.some((row) => row.notification_status !== "SENT")) throw new Error("Frozen failure set contains a non-SENT notification");
  if (rows.some((row) => row.failure_set_classification !== "KNOWN_FAILURE_AUDIT")) {
    throw new Error("Frozen failure set contains a non-audit row");
  }
  return {
    rowCount: rows.length,
    uniqueNotificationIds: notificationIds.size,
    uniqueSignalIds: signalIds.size,
    allSent: true,
    allAuditClassified: true,
    rows,
  };
}

export function calculateForwardMetrics(rows: readonly ForwardPaperTradeEvidence[]): ForwardMetrics {
  const matured = rows.filter((row) => row.exitTime && Number.isFinite(row.netPnlUsdt));
  const ordered = [...matured].sort((left, right) => Date.parse(left.exitTime) - Date.parse(right.exitTime));
  let equity = 10_000;
  let peak = equity;
  let maxDrawdownUsdt = 0;
  for (const row of ordered) {
    equity += row.netPnlUsdt;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const positive = matured.filter((row) => row.netPnlUsdt > 0);
  const negative = matured.filter((row) => row.netPnlUsdt < 0);
  const grossProfit = positive.reduce((sum, row) => sum + row.netPnlUsdt, 0);
  const grossLoss = Math.abs(negative.reduce((sum, row) => sum + row.netPnlUsdt, 0));
  const netPnlUsdt = matured.reduce((sum, row) => sum + row.netPnlUsdt, 0);
  return {
    maturedTrades: matured.length,
    wins: positive.length,
    losses: negative.length,
    netPnlUsdt: round(netPnlUsdt),
    expectancyUsdt: round(matured.length === 0 ? 0 : netPnlUsdt / matured.length),
    totalR: round(matured.reduce((sum, row) => sum + row.rMultiple, 0)),
    profitFactor: grossLoss === 0 ? null : round(grossProfit / grossLoss),
    maxDrawdownUsdt: round(maxDrawdownUsdt),
    maxDrawdownPercent: round(maxDrawdownUsdt / 10_000),
    firstEntryTime: ordered.length === 0 ? null : ordered[0].entryTime,
    lastExitTime: ordered.length === 0 ? null : ordered.at(-1)?.exitTime ?? null,
  };
}

export function calculateCalendarDays(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("Forward evidence dates are invalid");
  return round(elapsed / (24 * 60 * 60 * 1000));
}

export function classifyForwardGate(input: {
  calendarDays: number;
  metrics: ForwardMetrics;
}): {
  calendarDaysRequirementMet: boolean;
  maturedTradesRequirementMet: boolean;
  economicRequirementsMet: boolean;
  earlyKill: boolean;
  gateStatus: "OPEN_INSUFFICIENT_SAMPLE" | "FAILED_EARLY" | "PASSED";
} {
  const calendarDaysRequirementMet = input.calendarDays >= R71A_FORWARD_MIN_CALENDAR_DAYS;
  const maturedTradesRequirementMet = input.metrics.maturedTrades >= R71A_FORWARD_MIN_MATURED_TRADES;
  const economicRequirementsMet = input.metrics.netPnlUsdt > 0
    && input.metrics.expectancyUsdt > 0
    && (input.metrics.profitFactor === null || input.metrics.profitFactor >= 1.2)
    && input.metrics.totalR > 0
    && input.metrics.maxDrawdownPercent <= R71A_HISTORICAL_DD_TOLERANCE;
  const earlyKill = input.metrics.maturedTrades >= R71A_EARLY_KILL_MIN_TRADES
    && input.metrics.netPnlUsdt < 0
    && input.metrics.profitFactor !== null
    && input.metrics.profitFactor < 0.9
    && input.metrics.expectancyUsdt < 0;
  return {
    calendarDaysRequirementMet,
    maturedTradesRequirementMet,
    economicRequirementsMet,
    earlyKill,
    gateStatus: earlyKill
      ? "FAILED_EARLY"
      : calendarDaysRequirementMet && maturedTradesRequirementMet && economicRequirementsMet
        ? "PASSED"
        : "OPEN_INSUFFICIENT_SAMPLE",
  };
}

export function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
