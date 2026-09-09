import type {
  ConfirmationBundle,
  ConfirmationDirection,
  ConfirmationSource,
  OpportunityConfirmation,
  OpportunityDirection,
  OpportunityEventObservation,
} from "./types";
import type { EntryContext } from "./types";

export function buildConfirmationBundle(
  observation: OpportunityEventObservation,
  direction: OpportunityDirection,
  entryContext: EntryContext,
): ConfirmationBundle {
  const features = observation.input.features;
  const expected = direction === "LONG" ? "UP" : "DOWN";
  const signal = observation.directional_signals[direction];
  const confirmations: OpportunityConfirmation[] = [];
  const supportingSources = new Set<ConfirmationSource>();
  let sequence = 0;

  const add = (
    code: string,
    source: ConfirmationSource,
    relation: ConfirmationDirection,
    observedValue: number | string | boolean | null,
    criterion: string,
  ): void => {
    confirmations.push({
      confirmation_id: `confirmation:${observation.symbol}:${direction}:${sequence}:${code}`,
      code,
      source,
      direction: relation,
      observed_value: observedValue,
      criterion,
      source_timestamp: features.source_timestamp,
      freshness: features.data_quality === "PASS" ? "FRESH" : "STALE",
    });
    if (relation === "SUPPORTS") supportingSources.add(source);
    sequence += 1;
  };

  if (
    observation.input.market_regime === (direction === "LONG" ? "BULL" : "BEAR")
    && features.trend.direction === expected
    && features.trend.higher_timeframe_direction === expected
    && features.trend.aligned
  ) {
    add("TREND_ALIGNED", "TREND", "SUPPORTS", true, "Local and higher-timeframe trend point in the watch direction.");
  } else {
    add("REGIME_CONFLICT", "TREND", "CONFLICTS", false, "Trend or market regime does not agree with the watch direction.");
  }

  const momentumSupports = direction === "LONG"
    ? features.momentum.direction === "UP" || features.momentum.stabilizing
    : features.momentum.direction === "DOWN" || features.momentum.stabilizing;
  if (momentumSupports) {
    add(
      direction === "LONG" ? "MOMENTUM_UP" : "MOMENTUM_DOWN",
      "MOMENTUM",
      "SUPPORTS",
      features.momentum.direction,
      "Momentum agrees with or is stabilizing toward the watch direction.",
    );
  }

  if (features.volume.confirming && features.volume.relative >= 1) {
    add("VOLUME_CONFIRMATION", "VOLUME", "SUPPORTS", features.volume.relative, "Volume confirms participation in the observed move.");
  }

  if (signal?.event.reason_codes.includes("FUNDING_CONTEXT_SUPPORTIVE")) {
    add("FUNDING_CONTEXT_SUPPORTIVE", "FUNDING", "SUPPORTS", features.funding_state.percentile, "Funding is retained as directional context, not a standalone trigger.");
  }

  if (
    features.open_interest_state.direction !== "FLAT"
    && features.open_interest_state.price_direction === expected
    && !features.open_interest_state.abnormal
  ) {
    add(
      features.open_interest_state.direction === "UP" ? "OI_RISING" : "OI_FALLING",
      "OPEN_INTEREST",
      "SUPPORTS",
      features.open_interest_state.change_percent,
      "Open Interest and price direction provide non-abnormal participation context.",
    );
  }

  if (features.liquidity_state.state === "OK") {
    add("LIQUIDITY_OK", "LIQUIDITY", "SUPPORTS", features.liquidity_state.spread_bps, "Liquidity input is available and not blocked.");
  } else {
    add("LIQUIDITY_BLOCKED", "LIQUIDITY", "CONFLICTS", features.liquidity_state.state, "Liquidity is not eligible for a directional watch.");
  }

  const breadthSupports = direction === "LONG"
    ? features.market_breadth.advancing_ratio >= 0.5 && features.market_breadth.trend_agreement >= 0.5
    : features.market_breadth.advancing_ratio <= 0.5 && features.market_breadth.trend_agreement >= 0.5;
  if (breadthSupports && !features.market_breadth.fragile) {
    add(
      direction === "LONG" ? "TREND_UP" : "TREND_DOWN",
      "BREADTH",
      "SUPPORTS",
      features.market_breadth.advancing_ratio,
      "Market breadth agrees with the local watch direction and is not marked fragile.",
    );
  } else if (features.market_breadth.fragile) {
    add("BREADTH_FRAGILE", "BREADTH", "CONFLICTS", true, "Market breadth is fragile or concentrated.");
  }

  if (entryContext.pattern !== "NONE") {
    add(entryContext.pattern, "PRICE", "SUPPORTS", entryContext.pattern, "A closed-candle price structure provides the entry-context transition.");
  }

  if (features.volatility.shock || features.volatility.percentile >= 85) {
    add("HIGH_VOLATILITY", "DATA_QUALITY", "CONFLICTS", features.volatility.percentile, "Volatility is too unstable for a clean directional confirmation.");
  }
  if (features.data_quality !== "PASS") {
    add(
      features.data_quality === "BLOCKED" ? "DATA_BLOCKED" : "DATA_DEGRADED",
      "DATA_QUALITY",
      "CONFLICTS",
      features.data_quality,
      "Input quality is not fully available at the observation timestamp.",
    );
  }

  const blockingConflict = confirmations.some((confirmation) => (
    confirmation.direction === "CONFLICTS"
    && [
      "REGIME_CONFLICT",
      "LIQUIDITY_BLOCKED",
      "HIGH_VOLATILITY",
      "DATA_BLOCKED",
      "DATA_DEGRADED",
    ].includes(confirmation.code)
  ));
  const signature = [
    entryContext.pattern,
    ...confirmations
      .filter((confirmation) => confirmation.direction === "SUPPORTS")
      .map((confirmation) => confirmation.code)
      .sort(),
  ].join("|");
  return {
    confirmations,
    supporting_sources: [...supportingSources],
    signature,
    qualifying: entryContext.pattern !== "NONE"
      && supportingSources.size >= 3
      && !blockingConflict,
  };
}

export function buildRiskConfirmations(
  observation: OpportunityEventObservation,
  signal: NonNullable<OpportunityEventObservation["risk_warning"]>,
): readonly OpportunityConfirmation[] {
  return signal.event.reason_codes.map((code, index) => ({
    confirmation_id: "confirmation:" + observation.symbol + ":RISK:" + index + ":" + code,
    code,
    source: riskSourceFor(code),
    direction: "SUPPORTS",
    observed_value: signal.scores.risk_level_score,
    criterion: "An existing risk reason is present at the observation timestamp.",
    source_timestamp: observation.input.features.source_timestamp,
    freshness: observation.input.features.data_quality === "PASS" ? "FRESH" : "STALE",
  }));
}

export function buildStatusConfirmation(
  observation: OpportunityEventObservation,
): readonly OpportunityConfirmation[] {
  return [{
    confirmation_id: "confirmation:" + observation.symbol + ":STATUS:" + observation.timestamp,
    code: observation.scores.market_status,
    source: "BREADTH",
    direction: "SUPPORTS",
    observed_value: observation.scores.market_status,
    criterion: "The market status changed from the previous observed status.",
    source_timestamp: observation.input.features.source_timestamp,
    freshness: observation.input.features.data_quality === "PASS" ? "FRESH" : "STALE",
  }];
}

function riskSourceFor(code: string): ConfirmationSource {
  if (code.startsWith("FUNDING_")) return "FUNDING";
  if (code.startsWith("OI_")) return "OPEN_INTEREST";
  if (code.startsWith("LIQUIDITY_") || code === "LOW_LIQUIDITY") return "LIQUIDITY";
  if (code === "BREADTH_FRAGILE") return "BREADTH";
  if (code === "HIGH_VOLATILITY") return "DATA_QUALITY";
  return "DATA_QUALITY";
}
