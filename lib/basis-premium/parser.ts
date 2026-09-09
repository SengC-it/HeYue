import {
  BINANCE_KLINE_COLUMNS,
  type BasisPremiumFamily,
  type BasisPremiumKline,
  type BasisPremiumResolution,
  type KlineParseResult,
} from "./types";

const RESOLUTION_MS: Record<BasisPremiumResolution, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

export function resolutionMilliseconds(resolution: BasisPremiumResolution): number {
  return RESOLUTION_MS[resolution];
}

function numeric(value: string | undefined): number {
  return value === undefined || value.trim() === "" ? Number.NaN : Number(value.trim());
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isPremiumFamily(family: BasisPremiumFamily): boolean {
  return family === "PREMIUM_INDEX";
}

function looksLikeHeader(cells: string[]): boolean {
  return cells[0]?.trim().toLowerCase().includes("open") === true
    || cells.some((cell) => cell.trim().toLowerCase() === "open_time");
}

function parseRow(cells: string[], family: BasisPremiumFamily, stepMs: number): BasisPremiumKline | null {
  if (cells.length < BINANCE_KLINE_COLUMNS.length) return null;
  const values = cells.slice(0, BINANCE_KLINE_COLUMNS.length).map(numeric);
  const [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, numberOfTrades,
    takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore] = values;
  if (![openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, numberOfTrades,
    takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore].every(isFiniteNumber)) return null;
  if (!Number.isInteger(openTime) || openTime < 0 || openTime % stepMs !== 0) return null;
  if (!Number.isInteger(closeTime) || closeTime < openTime) return null;
  if (volume < 0 || quoteAssetVolume < 0 || numberOfTrades < 0
    || !Number.isInteger(numberOfTrades)
    || takerBuyBaseAssetVolume < 0 || takerBuyQuoteAssetVolume < 0) return null;
  if (isPremiumFamily(family)) {
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  } else {
    if ([open, high, low, close].some((value) => value <= 0)) return null;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  }
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime,
    quoteAssetVolume,
    numberOfTrades,
    takerBuyBaseAssetVolume,
    takerBuyQuoteAssetVolume,
    ignore,
  };
}

export function parseBinanceKlineCsv(
  input: string,
  options: { family: BasisPremiumFamily; resolution: BasisPremiumResolution },
): KlineParseResult {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const rows: BasisPremiumKline[] = [];
  const issues: string[] = [];
  const stepMs = resolutionMilliseconds(options.resolution);
  const seen = new Set<number>();
  let rawRowCount = 0;
  let invalidRowCount = 0;
  let invalidTimestampCount = 0;
  let invalidPriceCount = 0;
  let invalidVolumeCount = 0;
  let duplicateTimestampCount = 0;
  let outOfOrderCount = 0;
  let cadenceBreakCount = 0;
  let boundaryViolationCount = 0;
  let previousTimestamp: number | null = null;
  const firstCells = lines[0]?.split(",") ?? [];
  const dataLines = looksLikeHeader(firstCells) ? lines.slice(1) : lines;

  for (const [index, line] of dataLines.entries()) {
    rawRowCount += 1;
    const cells = line.split(",").map((cell) => cell.trim());
    const row = parseRow(cells, options.family, stepMs);
    if (row === null) {
      invalidRowCount += 1;
      const values = cells.slice(0, BINANCE_KLINE_COLUMNS.length).map(numeric);
      const [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, numberOfTrades,
        takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume] = values;
      if (!Number.isInteger(openTime) || openTime < 0 || openTime % stepMs !== 0
        || !Number.isInteger(closeTime) || closeTime < openTime) invalidTimestampCount += 1;
      const priceValues = [open, high, low, close];
      const priceInvalid = priceValues.some((value) => !isFiniteNumber(value))
        || (!isPremiumFamily(options.family) && priceValues.some((value) => value <= 0))
        || (isPremiumFamily(options.family)
          && priceValues.every(isFiniteNumber)
          && (high < Math.max(open, close, low) || low > Math.min(open, close, high)));
      if (priceInvalid) invalidPriceCount += 1;
      if (![volume, quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume]
        .every((value) => isFiniteNumber(value) && value >= 0)) invalidVolumeCount += 1;
      issues.push(`INVALID_ROW:${index + 1}`);
      continue;
    }
    if (row.closeTime < row.openTime + stepMs - 1) {
      boundaryViolationCount += 1;
      issues.push(`PARTIAL_BAR:${index + 1}`);
      continue;
    }
    if (previousTimestamp !== null) {
      if (row.openTime < previousTimestamp) outOfOrderCount += 1;
      if (row.openTime - previousTimestamp !== stepMs) cadenceBreakCount += 1;
    }
    previousTimestamp = row.openTime;
    if (seen.has(row.openTime)) {
      duplicateTimestampCount += 1;
      issues.push(`DUPLICATE_TIMESTAMP:${index + 1}`);
      continue;
    }
    seen.add(row.openTime);
    rows.push(row);
  }

  return {
    rows,
    rawRowCount,
    invalidRowCount,
    invalidTimestampCount,
    invalidPriceCount,
    invalidVolumeCount,
    duplicateTimestampCount,
    outOfOrderCount,
    cadenceBreakCount,
    boundaryViolationCount,
    schemaFields: [...BINANCE_KLINE_COLUMNS],
    issues,
  };
}
