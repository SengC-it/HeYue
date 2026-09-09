import type { ClosedFlowAggregate, FlowKline, PitWindow, RawFlowKline } from "./types";

export const MINUTE_MS = 60_000;
export const BINANCE_ONE_MINUTE_CLOSE_OFFSET_MS = MINUTE_MS - 1;

export function deriveTakerSellBaseVolume(totalBaseVolume: number, takerBuyBaseVolume: number): number {
  return totalBaseVolume - takerBuyBaseVolume;
}

export function deriveTakerSellQuoteVolume(totalQuoteVolume: number, takerBuyQuoteVolume: number): number {
  return totalQuoteVolume - takerBuyQuoteVolume;
}

export function calculateFlowImbalance(buyQuoteVolume: number, sellQuoteVolume: number): number | null {
  const denominator = buyQuoteVolume + sellQuoteVolume;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return (buyQuoteVolume - sellQuoteVolume) / denominator;
}

export function toFlowKline(raw: RawFlowKline): FlowKline {
  const takerSellBaseVolume = deriveTakerSellBaseVolume(raw.volume, raw.takerBuyBaseVolume);
  const takerSellQuoteVolume = deriveTakerSellQuoteVolume(raw.quoteVolume, raw.takerBuyQuoteVolume);
  return {
    ...raw,
    takerSellBaseVolume,
    takerSellQuoteVolume,
    flowImbalance: calculateFlowImbalance(raw.takerBuyQuoteVolume, takerSellQuoteVolume),
  };
}

export function pitSafeClosedRows(rows: FlowKline[], asOf: number): FlowKline[] {
  return rows.filter((row) => row.closeTime <= asOf);
}

export function aggregateClosedFlow(
  rows: FlowKline[],
  window: PitWindow,
): ClosedFlowAggregate {
  const eligible = rows.filter(
    (row) => row.openTime >= window.startTime
      && row.openTime < window.endTimeExclusive
      && row.closeTime <= window.asOf,
  );
  const buyQuoteVolume = eligible.reduce((total, row) => total + row.takerBuyQuoteVolume, 0);
  const sellQuoteVolume = eligible.reduce((total, row) => total + row.takerSellQuoteVolume, 0);
  const totalQuoteVolume = buyQuoteVolume + sellQuoteVolume;
  return {
    rowCount: eligible.length,
    buyQuoteVolume,
    sellQuoteVolume,
    totalQuoteVolume,
    flowImbalance: calculateFlowImbalance(buyQuoteVolume, sellQuoteVolume),
  };
}
