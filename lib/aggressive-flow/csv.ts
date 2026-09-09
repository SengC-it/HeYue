import { toFlowKline } from "./features";
import { validateFlowKline } from "./validation";
import type { ParsedFlowFile, RawFlowKline } from "./types";

interface ColumnIndexes {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  numberOfTrades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

const DEFAULT_COLUMNS: ColumnIndexes = {
  openTime: 0,
  open: 1,
  high: 2,
  low: 3,
  close: 4,
  volume: 5,
  closeTime: 6,
  quoteVolume: 7,
  numberOfTrades: 8,
  takerBuyBaseVolume: 9,
  takerBuyQuoteVolume: 10,
};

function normalizeHeader(value: string): string {
  return value.trim().replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumn(headers: string[], names: readonly string[], fallback: number): number {
  const normalized = headers.map(normalizeHeader);
  const index = normalized.findIndex((header) => names.includes(header));
  return index >= 0 ? index : fallback;
}

function columnsFromHeader(headers: string[]): ColumnIndexes {
  return {
    openTime: findColumn(headers, ["opentime"], DEFAULT_COLUMNS.openTime),
    open: findColumn(headers, ["open"], DEFAULT_COLUMNS.open),
    high: findColumn(headers, ["high"], DEFAULT_COLUMNS.high),
    low: findColumn(headers, ["low"], DEFAULT_COLUMNS.low),
    close: findColumn(headers, ["close"], DEFAULT_COLUMNS.close),
    volume: findColumn(headers, ["volume"], DEFAULT_COLUMNS.volume),
    closeTime: findColumn(headers, ["closetime"], DEFAULT_COLUMNS.closeTime),
    quoteVolume: findColumn(headers, ["quoteassetvolume", "quotevolume"], DEFAULT_COLUMNS.quoteVolume),
    numberOfTrades: findColumn(headers, ["numberoftrades", "trades"], DEFAULT_COLUMNS.numberOfTrades),
    takerBuyBaseVolume: findColumn(
      headers,
      ["takerbuybaseassetvolume", "takerbuybasevolume"],
      DEFAULT_COLUMNS.takerBuyBaseVolume,
    ),
    takerBuyQuoteVolume: findColumn(
      headers,
      ["takerbuyquoteassetvolume", "takerbuyquotevolume"],
      DEFAULT_COLUMNS.takerBuyQuoteVolume,
    ),
  };
}

function numericCell(cells: string[], index: number): number | null {
  const value = Number(cells[index]);
  return Number.isFinite(value) ? value : null;
}

function parseRawRow(cells: string[], columns: ColumnIndexes): RawFlowKline | null {
  const values = {
    openTime: numericCell(cells, columns.openTime),
    open: numericCell(cells, columns.open),
    high: numericCell(cells, columns.high),
    low: numericCell(cells, columns.low),
    close: numericCell(cells, columns.close),
    volume: numericCell(cells, columns.volume),
    closeTime: numericCell(cells, columns.closeTime),
    quoteVolume: numericCell(cells, columns.quoteVolume),
    numberOfTrades: numericCell(cells, columns.numberOfTrades),
    takerBuyBaseVolume: numericCell(cells, columns.takerBuyBaseVolume),
    takerBuyQuoteVolume: numericCell(cells, columns.takerBuyQuoteVolume),
  };
  if (Object.values(values).some((value) => value === null)) return null;
  return values as RawFlowKline;
}

export function parseBinanceKlineCsv(input: string): ParsedFlowFile {
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], rawRowCount: 0, malformedRowCount: 0, invalidRowCount: 0, errors: [], headerDetected: false };
  }
  const firstCells = lines[0]!.split(",");
  const headerDetected = normalizeHeader(firstCells[0] ?? "") === "opentime";
  const columns = headerDetected ? columnsFromHeader(firstCells) : DEFAULT_COLUMNS;
  const dataLines = headerDetected ? lines.slice(1) : lines;
  const rows = [] as ParsedFlowFile["rows"];
  const errors: string[] = [];
  let malformedRowCount = 0;
  let invalidRowCount = 0;
  dataLines.forEach((line, index) => {
    const cells = line.split(",");
    const raw = parseRawRow(cells, columns);
    if (raw === null) {
      malformedRowCount += 1;
      if (errors.length < 20) errors.push(`row ${index + 1}: MALFORMED`);
      return;
    }
    const flowRow = toFlowKline(raw);
    const rowErrors = validateFlowKline(flowRow);
    if (rowErrors.length > 0) {
      invalidRowCount += 1;
      if (errors.length < 20) errors.push(`row ${index + 1}: ${rowErrors.join(",")}`);
      return;
    }
    rows.push(flowRow);
  });
  return {
    rows,
    rawRowCount: dataLines.length,
    malformedRowCount,
    invalidRowCount,
    errors,
    headerDetected,
  };
}
