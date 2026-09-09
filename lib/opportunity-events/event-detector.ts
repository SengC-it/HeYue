import {
  buildConfirmationBundle,
  buildRiskConfirmations,
  buildStatusConfirmation,
} from "./confirmation";
import { buildEntryContext, hasEntryContext } from "./entry-context";
import {
  createDirectionEpisodeId,
  createOpportunityEventId,
  createTransitionEventId,
  isStatusTransition,
  riskTransitionKind,
} from "./deduplication";
import {
  findDirectionInvalidation,
  validateOpportunityObservation,
} from "./invalidation";
import {
  getSymbolOpportunityEventState,
  markDirectionActive,
  markDirectionInvalidated,
  startDirectionSetup,
  transitionMarketStatus,
  transitionRiskState,
  updateDirectionSeen,
} from "./lifecycle";
import type {
  DirectionLifecycleState,
  OpportunityDirection,
  OpportunityEvent,
  OpportunityEventEngineResult,
  OpportunityEventObservation,
  OpportunityEventPolicy,
  OpportunityEventState,
  OpportunityInvalidation,
} from "./types";
import { defaultOpportunityEventPolicy } from "./types";

export function processOpportunityObservation(
  observation: OpportunityEventObservation,
  state: OpportunityEventState,
  policy: OpportunityEventPolicy = defaultOpportunityEventPolicy,
): OpportunityEventEngineResult {
  const symbolState = getSymbolOpportunityEventState(state, observation.symbol);
  const pit = validateOpportunityObservation(observation);
  if (!pit.pit_safe) return rejectPitObservation(observation, symbolState, policy);

  const events: OpportunityEvent[] = [];
  const invalidations: OpportunityInvalidation[] = [];
  processMarketStatus(observation, symbolState, events);
  processRiskWarning(observation, symbolState, policy, events);
  processDirection(observation, symbolState, "LONG", policy, events, invalidations);
  processDirection(observation, symbolState, "SHORT", policy, events, invalidations);
  return { events, invalidations, pit_rejected: false };
}

function processDirection(
  observation: OpportunityEventObservation,
  symbolState: ReturnType<typeof getSymbolOpportunityEventState>,
  direction: OpportunityDirection,
  policy: OpportunityEventPolicy,
  events: OpportunityEvent[],
  invalidations: OpportunityInvalidation[],
): void {
  const state = direction === "LONG" ? symbolState.long : symbolState.short;
  const signal = observation.directional_signals[direction];
  const candidatePresent = isDirectionalCandidate(observation, direction, signal, policy);
  const entryContext = buildEntryContext(observation, direction);
  const confirmations = buildConfirmationBundle(observation, direction, entryContext);
  const invalidation = findDirectionInvalidation(
    observation,
    direction,
    state,
    candidatePresent,
    policy,
  );
  if (invalidation) {
    invalidations.push(invalidation);
    markDirectionInvalidated(state, observation.timestamp, invalidation.code === "OBSERVATION_EXPIRED");
    return;
  }
  if (!candidatePresent || signal === undefined) return;

  if (state.lifecycle === "NO_SETUP" || state.lifecycle === "INVALIDATED" || state.lifecycle === "EXPIRED") {
    startDirectionSetup(state, observation.symbol, direction, observation.timestamp);
    return;
  }
  updateDirectionSeen(state, observation.timestamp);
  if (state.lifecycle !== "SETUP" || !confirmations.qualifying || !hasEntryContext(entryContext)) return;

  const episodeId = state.episode_id;
  if (episodeId === null) return;
  const eventId = createOpportunityEventId(episodeId);
  const event = createDirectionalEvent(
    observation,
    direction,
    signal,
    entryContext,
    confirmations.confirmations,
    eventId,
    episodeId,
    policy,
  );
  markDirectionActive(state, eventId, observation.timestamp, confirmations.signature);
  events.push(event);
}

function processRiskWarning(
  observation: OpportunityEventObservation,
  symbolState: ReturnType<typeof getSymbolOpportunityEventState>,
  policy: OpportunityEventPolicy,
  events: OpportunityEvent[],
): void {
  const signal = isRiskSignalMaterial(observation.risk_warning, policy)
    ? observation.risk_warning
    : null;
  const kind = riskTransitionKind(symbolState.risk, signal, policy);
  if (kind === "NONE") {
    if (signal === null) {
      symbolState.risk.high_risk = false;
      symbolState.risk.active_event_id = null;
    }
    symbolState.risk.last_seen_at = observation.timestamp;
    return;
  }
  const transitionNumber = symbolState.risk.transition_number + 1;
  const eventId = createTransitionEventId(observation.symbol, "RISK_WARNING", transitionNumber);
  const event = createRiskEvent(observation, signal!, kind, eventId, transitionNumber);
  transitionRiskState(
    symbolState.risk,
    true,
    observation.timestamp,
    signal!.scores.risk_level_score,
    eventId,
    transitionNumber,
  );
  events.push(event);
}

function processMarketStatus(
  observation: OpportunityEventObservation,
  symbolState: ReturnType<typeof getSymbolOpportunityEventState>,
  events: OpportunityEvent[],
): void {
  const statusState = symbolState.market_status;
  if (statusState.last_status === null) {
    statusState.last_status = observation.scores.market_status;
    statusState.last_seen_at = observation.timestamp;
    return;
  }
  if (!isStatusTransition(statusState, observation.scores.market_status)) {
    statusState.last_seen_at = observation.timestamp;
    return;
  }
  const transitionNumber = transitionMarketStatus(statusState, observation.scores.market_status, observation.timestamp);
  events.push(createStatusEvent(observation, transitionNumber));
}

function isDirectionalCandidate(
  observation: OpportunityEventObservation,
  direction: OpportunityDirection,
  signal: OpportunityEventObservation["directional_signals"][OpportunityDirection],
  policy: OpportunityEventPolicy,
): boolean {
  if (!signal || signal.signal_type !== (direction === "LONG" ? "LONG_WATCH" : "SHORT_WATCH")) return false;
  const expectedStatus = direction === "LONG" ? "TREND_UP" : "TREND_DOWN";
  const expectedRegime = direction === "LONG" ? "BULL" : "BEAR";
  return observation.scores.market_status === expectedStatus
    && observation.input.market_regime === expectedRegime
    && observation.input.features.data_quality === "PASS"
    && observation.input.features.liquidity_state.state === "OK"
    && !observation.input.features.volatility.shock
    && observation.scores.pit_safe
    && signal.opportunity_score >= policy.minimum_directional_opportunity_score
    && signal.scores.confidence >= policy.minimum_directional_confidence
    && signal.scores.risk_level_score <= policy.maximum_directional_risk_score;
}

function isRiskSignalMaterial(
  signal: OpportunityEventObservation["risk_warning"],
  policy: OpportunityEventPolicy,
): signal is NonNullable<OpportunityEventObservation["risk_warning"]> {
  return signal !== null
    && (signal.scores.risk_level_score >= policy.risk_transition_min_score
      || signal.event.reason_codes.length > 0);
}

function createDirectionalEvent(
  observation: OpportunityEventObservation,
  direction: OpportunityDirection,
  signal: NonNullable<OpportunityEventObservation["directional_signals"][OpportunityDirection]>,
  entryContext: ReturnType<typeof buildEntryContext>,
  confirmations: ReturnType<typeof buildConfirmationBundle>["confirmations"],
  eventId: string,
  episodeId: string,
  policy: OpportunityEventPolicy,
): OpportunityEvent {
  return freezeEvent({
    opportunity_event_id: eventId,
    episode_id: episodeId,
    event_kind: "INITIAL",
    signal_type: direction === "LONG" ? "LONG_WATCH" : "SHORT_WATCH",
    symbol: observation.symbol,
    observed_at: new Date(observation.timestamp).toISOString(),
    source_watermark: observation.input.features.source_timestamp,
    market_regime: observation.input.market_regime,
    market_status: observation.scores.market_status,
    opportunity_score: signal.opportunity_score,
    quality_score: signal.event.quality_score,
    risk_score: signal.scores.risk_level_score,
    confidence: signal.scores.confidence,
    reason_codes: [...signal.event.reason_codes],
    human_explanation: signal.event.human_explanation
      + " Opportunity context confirmed by a closed-candle structure; this remains a manual observation.",
    lifecycle_status: "CONFIRMED",
    expires_at: new Date(observation.timestamp + policy.active_ttl_ms).toISOString(),
    reference_price: signal.event.reference_price,
    entry_context: entryContext,
    confirmations: [...confirmations],
    invalidations: [],
    replay_evaluations: [],
    supersedes_event_id: null,
  });
}

function createRiskEvent(
  observation: OpportunityEventObservation,
  signal: NonNullable<OpportunityEventObservation["risk_warning"]>,
  kind: "INITIAL" | "UPGRADE",
  eventId: string,
  transitionNumber: number,
): OpportunityEvent {
  const confirmations = buildRiskConfirmations(observation, signal);
  return freezeEvent({
    opportunity_event_id: eventId,
    episode_id: observation.symbol + ":RISK:" + transitionNumber,
    event_kind: kind === "UPGRADE" ? "RISK_UPGRADE" : "RISK_TRANSITION",
    signal_type: "RISK_WARNING",
    symbol: observation.symbol,
    observed_at: new Date(observation.timestamp).toISOString(),
    source_watermark: observation.input.features.source_timestamp,
    market_regime: observation.input.market_regime,
    market_status: observation.scores.market_status,
    opportunity_score: 0,
    quality_score: signal.event.quality_score,
    risk_score: signal.scores.risk_level_score,
    confidence: signal.scores.confidence,
    reason_codes: [...signal.event.reason_codes],
    human_explanation: "风险状态发生显著变化；请人工复核当前市场和数据上下文，本条目不表达方向或执行动作。",
    lifecycle_status: "CREATED",
    expires_at: null,
    reference_price: signal.event.reference_price,
    entry_context: null,
    confirmations: [...confirmations],
    invalidations: [],
    replay_evaluations: [],
    supersedes_event_id: null,
  });
}

function createStatusEvent(
  observation: OpportunityEventObservation,
  transitionNumber: number,
): OpportunityEvent {
  const confirmations = buildStatusConfirmation(observation);
  return freezeEvent({
    opportunity_event_id: createTransitionEventId(observation.symbol, "MARKET_STATUS", transitionNumber),
    episode_id: observation.symbol + ":STATUS:" + transitionNumber,
    event_kind: "STATUS_TRANSITION",
    signal_type: "MARKET_STATUS",
    symbol: observation.symbol,
    observed_at: new Date(observation.timestamp).toISOString(),
    source_watermark: observation.input.features.source_timestamp,
    market_regime: observation.input.market_regime,
    market_status: observation.scores.market_status,
    opportunity_score: 0,
    quality_score: observation.scores.signal_quality_score,
    risk_score: observation.scores.risk_level_score,
    confidence: observation.scores.confidence,
    reason_codes: [observation.scores.market_status],
    human_explanation: "市场状态发生变化；这是描述性上下文，不是方向性或执行指令。",
    lifecycle_status: "CREATED",
    expires_at: null,
    reference_price: observation.input.reference_price,
    entry_context: null,
    confirmations: [...confirmations],
    invalidations: [],
    replay_evaluations: [],
    supersedes_event_id: null,
  });
}

function rejectPitObservation(
  observation: OpportunityEventObservation,
  symbolState: ReturnType<typeof getSymbolOpportunityEventState>,
  policy: OpportunityEventPolicy,
): OpportunityEventEngineResult {
  const invalidations: OpportunityInvalidation[] = [];
  for (const [direction, directionState] of [["LONG", symbolState.long], ["SHORT", symbolState.short]] as const) {
    const invalidation = findDirectionInvalidation(
      observation,
      direction,
      directionState,
      false,
      policy,
    );
    if (invalidation) {
      invalidations.push(invalidation);
      markDirectionInvalidated(directionState, observation.timestamp, false);
    }
  }
  return { events: [], invalidations, pit_rejected: true };
}

function freezeEvent(event: OpportunityEvent): OpportunityEvent {
  if (event.entry_context) {
    Object.freeze(event.entry_context.price_structure);
    Object.freeze(event.entry_context);
  }
  for (const confirmation of event.confirmations) Object.freeze(confirmation);
  Object.freeze(event.confirmations);
  Object.freeze(event.reason_codes);
  Object.freeze(event.invalidations);
  Object.freeze(event.replay_evaluations);
  return Object.freeze(event);
}
