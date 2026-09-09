import type { Candle } from "../core/types";
import type {
  OpportunityDirection,
  OpportunityEvent,
  ReplayEvaluation,
  ReplayHorizon,
} from "./types";

const REPLAY_HORIZONS: ReadonlyArray<[ReplayHorizon, number]> = [
  ["4h", 4],
  ["12h", 12],
  ["24h", 24],
];

export function replayOpportunityEvent(
  event: OpportunityEvent,
  candles: readonly Candle[],
): ReplayEvaluation[] {
  if (event.signal_type !== "LONG_WATCH" && event.signal_type !== "SHORT_WATCH") return [];
  const direction: OpportunityDirection = event.signal_type === "LONG_WATCH" ? "LONG" : "SHORT";
  const ordered = [...candles].sort((left, right) => left.closeTime - right.closeTime);
  const currentIndex = lastIndexAtOrBefore(ordered, Date.parse(event.observed_at));
  return REPLAY_HORIZONS.map(([horizon, hours]) => evaluateHorizon(
    event,
    direction,
    ordered,
    currentIndex,
    horizon,
    hours,
  ));
}

function evaluateHorizon(
  event: OpportunityEvent,
  direction: OpportunityDirection,
  candles: Candle[],
  currentIndex: number,
  horizon: ReplayHorizon,
  hours: number,
): ReplayEvaluation {
  const eventTime = Date.parse(event.observed_at);
  const evaluationEnd = eventTime + hours * 60 * 60 * 1000;
  const base = {
    opportunity_event_id: event.opportunity_event_id,
    horizon,
    evaluation_start: event.observed_at,
    evaluation_end: new Date(evaluationEnd).toISOString(),
    future_price: null,
    raw_return: null,
    aligned_return: null,
    max_favorable_move: null,
    max_adverse_move: null,
    time_to_mfe_hours: null,
    replay_status: "NOT_EVALUABLE" as const,
    price_source_timestamp: null,
    calculation_version: "hy-r4.15-v1" as const,
    pit_safe: true as const,
  } satisfies ReplayEvaluation;
  const current = candles[currentIndex];
  if (!current || current.closeTime > eventTime || event.reference_price <= 0) return base;
  const endIndex = firstIndexAtOrAfter(candles, evaluationEnd, currentIndex + 1);
  if (endIndex === -1) return base;
  const window = candles.slice(currentIndex + 1, endIndex + 1)
    .filter((candle) => candle.closeTime > eventTime && candle.closeTime <= evaluationEnd);
  const future = candles[endIndex];
  if (!future || window.length === 0 || future.close <= 0) return base;

  const maxHigh = Math.max(...window.map((candle) => candle.high));
  const minLow = Math.min(...window.map((candle) => candle.low));
  const favorable = direction === "LONG"
    ? Math.max(0, maxHigh / event.reference_price - 1)
    : Math.max(0, event.reference_price / minLow - 1);
  const adverse = direction === "LONG"
    ? Math.max(0, 1 - minLow / event.reference_price)
    : Math.max(0, maxHigh / event.reference_price - 1);
  const rawReturn = future.close / event.reference_price - 1;
  const alignedReturn = direction === "LONG" ? rawReturn : -rawReturn;
  const favorableCandle = direction === "LONG"
    ? window.find((candle) => candle.high === maxHigh)
    : window.find((candle) => candle.low === minLow);
  return {
    ...base,
    future_price: future.close,
    raw_return: rawReturn,
    aligned_return: alignedReturn,
    max_favorable_move: favorable,
    max_adverse_move: adverse,
    time_to_mfe_hours: favorableCandle
      ? Math.max(0, (favorableCandle.closeTime - eventTime) / (60 * 60 * 1000))
      : null,
    replay_status: "COMPLETE",
    price_source_timestamp: new Date(future.closeTime).toISOString(),
  };
}

function firstIndexAtOrAfter(candles: Candle[], timestamp: number, start: number): number {
  let low = Math.max(0, start);
  let high = candles.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle]!.closeTime >= timestamp) {
      answer = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  return answer;
}

function lastIndexAtOrBefore(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle]!.closeTime <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return answer;
}
