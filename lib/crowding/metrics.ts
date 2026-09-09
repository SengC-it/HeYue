import { BINANCE_METRICS_FIELDS } from "./types";
import type {
  BinanceMetricsField,
  CrowdingMetricsObservation,
  MetricsParseResult,
  MetricsSchemaAudit,
} from "./types";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function parseTimestamp(value: string): number {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const timestamp = Number(normalized);
    return Number.isFinite(timestamp) ? timestamp : Number.NaN;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return Date.parse(normalized.replace(" ", "T") + "Z");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return Date.parse(normalized + "T00:00:00.000Z");
  }
  return Date.parse(normalized);
}

function parseNumber(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return Number.NaN;
  return Number(value.trim());
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function splitLine(line: string, delimiter: "\t" | ","): string[] {
  return line.split(delimiter).map((field) => field.trim());
}

function schemaAudit(headers: string[], delimiter: "\t" | "," | null): MetricsSchemaAudit {
  const required = new Set<string>(BINANCE_METRICS_FIELDS);
  return {
    delimiter: delimiter === "\t" ? "TAB" : delimiter === "," ? "COMMA" : "UNKNOWN",
    headers,
    missingFields: BINANCE_METRICS_FIELDS.filter((field) => !headers.includes(field)),
    extraFields: headers.filter((field) => !required.has(field)),
  };
}

function observationFromFields(
  fields: Record<string, string>,
  expectedSymbol: string | undefined,
  lineNumber: number,
): { observation: CrowdingMetricsObservation | null; issues: string[] } {
  const issues: string[] = [];
  const timestamp = parseTimestamp(fields.create_time ?? "");
  const symbol = fields.symbol?.trim() ?? "";
  const openInterest = parseNumber(fields.sum_open_interest);
  const openInterestValue = parseNumber(fields.sum_open_interest_value);
  const topTraderAccountRatio = parseNumber(fields.count_toptrader_long_short_ratio);
  const topTraderPositionRatio = parseNumber(fields.sum_toptrader_long_short_ratio);
  const globalAccountRatio = parseNumber(fields.count_long_short_ratio);
  const takerLongShortRatio = parseNumber(fields.sum_taker_long_short_vol_ratio);

  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp % FIVE_MINUTES_MS !== 0) {
    issues.push(`INVALID_TIMESTAMP:${lineNumber}`);
  }
  if (symbol === "" || (expectedSymbol !== undefined && symbol !== expectedSymbol)) {
    issues.push(`SYMBOL_MISMATCH:${lineNumber}`);
  }
  if (!isPositiveFinite(openInterest) || !isPositiveFinite(openInterestValue)) {
    issues.push(`INVALID_OPEN_INTEREST:${lineNumber}`);
  }
  if (![topTraderAccountRatio, topTraderPositionRatio, globalAccountRatio, takerLongShortRatio].every(isPositiveFinite)) {
    issues.push(`INVALID_RATIO_OR_ZERO_DENOMINATOR:${lineNumber}`);
  }
  if (issues.length > 0) return { observation: null, issues };

  return {
    observation: {
      timestamp,
      symbol,
      openInterest,
      openInterestValue,
      topTraderAccountRatio,
      topTraderPositionRatio,
      globalAccountRatio,
      takerLongShortRatio,
    },
    issues,
  };
}

export function parseBinanceMetricsCsv(
  csv: string,
  options: { expectedSymbol?: string; maxRows?: number } = {},
): MetricsParseResult {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const headerLine = lines[0]?.replace(/^\uFEFF/, "") ?? "";
  const delimiter: "\t" | "," | null = headerLine.includes("\t")
    ? "\t"
    : headerLine.includes(",")
      ? ","
      : null;
  const headers = delimiter === null ? [] : splitLine(headerLine, delimiter);
  const schema = schemaAudit(headers, delimiter);
  const issues: string[] = [];

  if (lines.length === 0) issues.push("EMPTY_FILE");
  if (schema.missingFields.length > 0) issues.push("SCHEMA_MISSING_REQUIRED_FIELD");
  if (delimiter === null && lines.length > 0) issues.push("UNKNOWN_DELIMITER");
  if (schema.missingFields.length > 0 || delimiter === null) {
    return { schema, observations: [], issues };
  }

  const observations: CrowdingMetricsObservation[] = [];
  const seenTimestamps = new Set<number>();
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  for (const [index, line] of lines.slice(1, 1 + maxRows).entries()) {
    const lineNumber = index + 2;
    const fields = splitLine(line, delimiter).reduce<Record<string, string>>((result, value, fieldIndex) => {
      const header = headers[fieldIndex];
      if (header !== undefined) result[header] = value;
      return result;
    }, {});
    if (Object.keys(fields).length !== headers.length) {
      issues.push(`MALFORMED_ROW:${lineNumber}`);
      continue;
    }
    const parsed = observationFromFields(fields, options.expectedSymbol, lineNumber);
    issues.push(...parsed.issues);
    if (parsed.observation === null) continue;
    if (seenTimestamps.has(parsed.observation.timestamp)) {
      issues.push(`DUPLICATE_TIMESTAMP:${lineNumber}`);
      continue;
    }
    seenTimestamps.add(parsed.observation.timestamp);
    observations.push(parsed.observation);
  }

  return { schema, observations, issues };
}

export { FIVE_MINUTES_MS };
