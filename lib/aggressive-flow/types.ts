export interface RawFlowKline {
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

export interface FlowKline extends RawFlowKline {
  takerSellBaseVolume: number;
  takerSellQuoteVolume: number;
  flowImbalance: number | null;
}

export interface ParsedFlowFile {
  rows: FlowKline[];
  rawRowCount: number;
  malformedRowCount: number;
  invalidRowCount: number;
  errors: string[];
  headerDetected: boolean;
}

export interface MinuteSequenceValidation {
  expectedMinutes: number;
  availableMinutes: number;
  coveragePercent: number;
  duplicateTimestampCount: number;
  outOfOrderCount: number;
  gapCount: number;
  boundaryViolationCount: number;
}

export interface ClosedFlowAggregate {
  rowCount: number;
  buyQuoteVolume: number;
  sellQuoteVolume: number;
  totalQuoteVolume: number;
  flowImbalance: number | null;
}

export interface PitWindow {
  startTime: number;
  endTimeExclusive: number;
  asOf: number;
}
