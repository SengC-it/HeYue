import type {
  DirectionLifecycleState,
  OpportunityEventObservation,
  OpportunityEventPolicy,
  OpportunityInvalidation,
  OpportunityDirection,
} from "./types";

export interface PitValidationResult {
  pit_safe: boolean;
  reason: string | null;
}

export function validateOpportunityObservation(observation: OpportunityEventObservation): PitValidationResult {
  const inputTimestamp = Date.parse(observation.input.timestamp);
  const sourceTimestamp = Date.parse(observation.input.features.source_timestamp);
  if (!Number.isFinite(observation.timestamp) || !Number.isFinite(inputTimestamp) || inputTimestamp !== observation.timestamp) {
    return { pit_safe: false, reason: "observation timestamp is not aligned with the engine input" };
  }
  if (!Number.isFinite(sourceTimestamp) || sourceTimestamp > observation.timestamp) {
    return { pit_safe: false, reason: "feature source timestamp is in the future" };
  }
  if (!observation.input.features.pit_safe || !observation.scores.pit_safe) {
    return { pit_safe: false, reason: "engine input is not marked PIT-safe" };
  }
  if (observation.price_history.some((candle) => !Number.isFinite(candle.closeTime) || candle.closeTime > observation.timestamp)) {
    return { pit_safe: false, reason: "price history contains a candle after the observation timestamp" };
  }
  return { pit_safe: true, reason: null };
}

export function findDirectionInvalidation(
  observation: OpportunityEventObservation,
  direction: OpportunityDirection,
  state: DirectionLifecycleState,
  candidatePresent: boolean,
  policy: OpportunityEventPolicy,
): OpportunityInvalidation | null {
  if (state.lifecycle !== "SETUP" && state.lifecycle !== "ACTIVE") return null;
  const pit = validateOpportunityObservation(observation);
  if (!pit.pit_safe) return createInvalidation(observation, state.active_event_id, "PIT_INVALID", "HARD", pit.reason ?? "PIT validation failed");

  const stateStartedAt = state.lifecycle === "SETUP" ? state.setup_started_at : state.active_started_at;
  const ttl = state.lifecycle === "SETUP" ? policy.setup_ttl_ms : policy.active_ttl_ms;
  if (stateStartedAt !== null && observation.timestamp - stateStartedAt >= ttl) {
    return createInvalidation(observation, state.active_event_id, "OBSERVATION_EXPIRED", "SOFT", direction + " observation episode exceeded its locked TTL");
  }
  if (!candidatePresent) {
    return createInvalidation(observation, state.active_event_id, "DIRECTION_CONFLICT", "SOFT", direction + " directional candidate is no longer present");
  }
  const expectedStatus = direction === "LONG" ? "TREND_UP" : "TREND_DOWN";
  if (observation.scores.market_status !== expectedStatus || observation.input.market_regime !== (direction === "LONG" ? "BULL" : "BEAR")) {
    return createInvalidation(observation, state.active_event_id, "REGIME_CHANGED", "HARD", direction + " market context no longer matches the event direction");
  }
  if (observation.scores.risk_level_score > policy.maximum_directional_risk_score) {
    return createInvalidation(observation, state.active_event_id, "RISK_ESCALATED", "HARD", "Risk level exceeded the locked directional observation limit");
  }
  if (observation.input.features.liquidity_state.state === "BLOCKED") {
    return createInvalidation(observation, state.active_event_id, "LIQUIDITY_BLOCKED", "HARD", "Liquidity became blocked for the directional observation");
  }
  if (observation.input.features.data_quality === "BLOCKED") {
    return createInvalidation(observation, state.active_event_id, "DATA_MISSING", "HARD", "Required input data became blocked");
  }
  return null;
}

function createInvalidation(
  observation: OpportunityEventObservation,
  eventId: string | null,
  code: OpportunityInvalidation["code"],
  severity: OpportunityInvalidation["severity"],
  explanation: string,
): OpportunityInvalidation {
  return {
    invalidation_id: "invalidation:" + observation.symbol + ":" + code + ":" + observation.timestamp,
    opportunity_event_id: eventId,
    code,
    severity,
    detected_at: new Date(observation.timestamp).toISOString(),
    source_timestamp: observation.input.features.source_timestamp,
    observed_value: observation.scores.risk_level_score,
    explanation,
  };
}
