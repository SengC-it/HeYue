import {
  BINANCE_ONE_MINUTE_CLOSE_OFFSET_MS,
  MINUTE_MS,
  calculateFlowImbalance,
} from "./features";
import type { FlowKline, MinuteSequenceValidation } from "./types";

export function validateFlowKline(row: FlowKline): string[] {
  const errors: string[] = [];
  const numericValues = [
    row.openTime,
    row.open,
    row.high,
    row.low,
    row.close,
    row.volume,
    row.closeTime,
    row.quoteVolume,
    row.numberOfTrades,
    row.takerBuyBaseVolume,
    row.takerBuyQuoteVolume,
  ];
  if (numericValues.some((value) => !Number.isFinite(value))) errors.push("NON_FINITE_VALUE");
  if (!Number.isInteger(row.openTime) || row.openTime < 0) errors.push("INVALID_OPEN_TIME");
  if (!Number.isInteger(row.closeTime) || row.closeTime <= row.openTime) errors.push("INVALID_CLOSE_TIME");
  if (row.closeTime - row.openTime !== BINANCE_ONE_MINUTE_CLOSE_OFFSET_MS) errors.push("INVALID_ONE_MINUTE_BOUNDARY");
  if (row.openTime % MINUTE_MS !== 0) errors.push("UNALIGNED_OPEN_TIME");
  if (row.open <= 0 || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.low <= 0) {
    errors.push("INVALID_OHLC");
  }
  if (row.volume < 0) errors.push("NEGATIVE_VOLUME");
  if (row.quoteVolume < 0) errors.push("NEGATIVE_QUOTE_VOLUME");
  if (!Number.isInteger(row.numberOfTrades) || row.numberOfTrades < 0) errors.push("INVALID_TRADE_COUNT");
  if (row.takerBuyBaseVolume < 0) errors.push("NEGATIVE_TAKER_BUY_BASE");
  if (row.takerBuyQuoteVolume < 0) errors.push("NEGATIVE_TAKER_BUY_QUOTE");
  if (row.takerBuyBaseVolume > row.volume) errors.push("TAKER_BUY_BASE_EXCEEDS_TOTAL");
  if (row.takerBuyQuoteVolume > row.quoteVolume) errors.push("TAKER_BUY_QUOTE_EXCEEDS_TOTAL");
  if (row.takerSellBaseVolume < 0) errors.push("NEGATIVE_DERIVED_SELL_BASE");
  if (row.takerSellQuoteVolume < 0) errors.push("NEGATIVE_DERIVED_SELL_QUOTE");
  const expectedImbalance = calculateFlowImbalance(row.takerBuyQuoteVolume, row.takerSellQuoteVolume);
  if (row.flowImbalance !== expectedImbalance && !(row.flowImbalance === null && expectedImbalance === null)) {
    errors.push("NON_DETERMINISTIC_FLOW_IMBALANCE");
  }
  return errors;
}

export function expectedMinuteCount(startTime: number, endTimeExclusive: number): number {
  if (endTimeExclusive <= startTime) return 0;
  return Math.ceil((endTimeExclusive - startTime) / MINUTE_MS);
}

export function validateMinuteSequence(
  rows: FlowKline[],
  startTime: number,
  endTimeExclusive: number,
): MinuteSequenceValidation {
  const expected = expectedMinuteCount(startTime, endTimeExclusive);
  let duplicateTimestampCount = 0;
  let outOfOrderCount = 0;
  let boundaryViolationCount = 0;
  let previousTimestamp: number | null = null;
  const selected = rows
    .filter((row) => row.openTime >= startTime && row.openTime < endTimeExclusive)
    .map((row) => row.openTime);
  const uniqueSelected = [...new Set(selected)].sort((left, right) => left - right);
  for (const row of rows) {
    if (previousTimestamp !== null) {
      if (row.openTime === previousTimestamp) duplicateTimestampCount += 1;
      if (row.openTime < previousTimestamp) outOfOrderCount += 1;
    }
    previousTimestamp = row.openTime;
  }
  for (const timestamp of uniqueSelected) {
    if (timestamp % MINUTE_MS !== 0) boundaryViolationCount += 1;
  }

  let gapCount = 0;
  if (uniqueSelected.length > 0) {
    const first = uniqueSelected[0]!;
    const last = uniqueSelected.at(-1)!;
    if (first > startTime) gapCount += Math.floor((first - startTime) / MINUTE_MS);
    if (last < endTimeExclusive - MINUTE_MS) gapCount += Math.floor((endTimeExclusive - MINUTE_MS - last) / MINUTE_MS);
    for (let index = 1; index < uniqueSelected.length; index += 1) {
      const delta = uniqueSelected[index]! - uniqueSelected[index - 1]!;
      if (delta > MINUTE_MS) gapCount += Math.floor(delta / MINUTE_MS) - 1;
    }
  } else {
    gapCount = expected;
  }

  const availableMinutes = uniqueSelected.length;
  return {
    expectedMinutes: expected,
    availableMinutes,
    coveragePercent: expected === 0 ? 100 : availableMinutes / expected * 100,
    duplicateTimestampCount,
    outOfOrderCount,
    gapCount,
    boundaryViolationCount,
  };
}
