import type { Candle } from "../core/types";
import type {
  EntryContext,
  EntryContextPattern,
  OpportunityDirection,
  OpportunityEventObservation,
} from "./types";

/**
 * Build a price-context snapshot from candles already closed by the observation time.
 * These are structural conditions, not new market indicators or execution levels.
 */
export function buildEntryContext(
  observation: OpportunityEventObservation,
  direction: OpportunityDirection,
): EntryContext {
  const current = observation.price_history.at(-1);
  const previous = observation.price_history.at(-2) ?? null;
  const lookback = observation.price_history.slice(-4, -1);
  const lookbackHigh = lookback.length > 0 ? Math.max(...lookback.map((candle) => candle.high)) : null;
  const lookbackLow = lookback.length > 0 ? Math.min(...lookback.map((candle) => candle.low)) : null;
  const referencePrice = current?.close ?? observation.input.reference_price;
  const currentOpen = current?.open ?? referencePrice;
  const currentHigh = current?.high ?? referencePrice;
  const currentLow = current?.low ?? referencePrice;
  const currentClose = current?.close ?? referencePrice;

  const currentBullish = currentClose > currentOpen;
  const currentBearish = currentClose < currentOpen;
  const pullbackReclaim = direction === "LONG"
    ? Boolean(
      previous
      && previous.close <= previous.open
      && currentBullish
      && currentClose > previous.high,
    )
    : Boolean(
      previous
      && previous.close >= previous.open
      && currentBearish
      && currentClose < previous.low,
    );
  const breakoutConfirmation = direction === "LONG"
    ? Boolean(lookbackHigh !== null && currentBullish && currentClose > lookbackHigh)
    : Boolean(lookbackLow !== null && currentBearish && currentClose < lookbackLow);
  const supportOrResistanceInteraction = direction === "LONG"
    ? Boolean(
      previous
      && lookbackLow !== null
      && currentLow <= lookbackLow
      && currentClose > previous.close
      && currentBullish,
    )
    : Boolean(
      previous
      && lookbackHigh !== null
      && currentHigh >= lookbackHigh
      && currentClose < previous.close
      && currentBearish,
    );

  const pattern = selectPattern(
    direction,
    pullbackReclaim,
    breakoutConfirmation,
    supportOrResistanceInteraction,
  );
  return {
    direction,
    reference_price: referencePrice,
    pattern,
    pullback_reclaim: pullbackReclaim,
    breakout_confirmation: breakoutConfirmation,
    support_or_resistance_interaction: supportOrResistanceInteraction,
    market_regime: observation.input.market_regime,
    market_status: observation.scores.market_status,
    price_structure: {
      current_open: currentOpen,
      current_high: currentHigh,
      current_low: currentLow,
      current_close: currentClose,
      previous_close: previous?.close ?? null,
      lookback_high: lookbackHigh,
      lookback_low: lookbackLow,
    },
    source_timestamp: observation.input.features.source_timestamp,
    data_quality: observation.input.features.data_quality,
    pit_safe: true,
  };
}

function selectPattern(
  direction: OpportunityDirection,
  pullbackReclaim: boolean,
  breakoutConfirmation: boolean,
  supportOrResistanceInteraction: boolean,
): EntryContextPattern {
  if (pullbackReclaim) return "PULLBACK_RECLAIM";
  if (breakoutConfirmation) return "BREAKOUT_CONFIRMATION";
  if (supportOrResistanceInteraction) {
    return direction === "LONG" ? "SUPPORT_INTERACTION" : "RESISTANCE_INTERACTION";
  }
  return "NONE";
}

export function hasEntryContext(context: EntryContext): boolean {
  return context.pattern !== "NONE";
}

export function isClosedCandle(candle: Candle, timestamp: number): boolean {
  return Number.isFinite(candle.closeTime) && candle.closeTime <= timestamp;
}
