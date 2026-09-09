import type {
  DirectionLifecycleState,
  MarketStatusLifecycleState,
  OpportunityEventState,
  RiskLifecycleState,
  SymbolOpportunityEventState,
} from "./types";

export function createOpportunityEventState(): OpportunityEventState {
  return { symbols: new Map() };
}

export function getSymbolOpportunityEventState(
  state: OpportunityEventState,
  symbol: string,
): SymbolOpportunityEventState {
  const existing = state.symbols.get(symbol);
  if (existing) return existing;
  const created: SymbolOpportunityEventState = {
    long: createDirectionState(),
    short: createDirectionState(),
    risk: createRiskState(),
    market_status: createMarketStatusState(),
  };
  state.symbols.set(symbol, created);
  return created;
}

export function startDirectionSetup(
  state: DirectionLifecycleState,
  symbol: string,
  direction: "LONG" | "SHORT",
  timestamp: number,
): void {
  state.episode_number += 1;
  state.episode_id = `${symbol}:${direction}:${state.episode_number}`;
  state.lifecycle = "SETUP";
  state.setup_started_at = timestamp;
  state.active_event_id = null;
  state.active_started_at = null;
  state.last_seen_at = timestamp;
  state.last_confirmation_signature = null;
}

export function markDirectionActive(
  state: DirectionLifecycleState,
  eventId: string,
  timestamp: number,
  confirmationSignature: string,
): void {
  state.lifecycle = "ACTIVE";
  state.active_event_id = eventId;
  state.active_started_at = timestamp;
  state.last_seen_at = timestamp;
  state.last_confirmation_signature = confirmationSignature;
}

export function markDirectionInvalidated(
  state: DirectionLifecycleState,
  timestamp: number,
  expired: boolean,
): void {
  state.lifecycle = expired ? "EXPIRED" : "INVALIDATED";
  state.active_event_id = null;
  state.active_started_at = null;
  state.setup_started_at = null;
  state.last_seen_at = timestamp;
  state.last_confirmation_signature = null;
}

export function updateDirectionSeen(state: DirectionLifecycleState, timestamp: number): void {
  state.last_seen_at = timestamp;
}

export function transitionRiskState(
  state: RiskLifecycleState,
  highRisk: boolean,
  timestamp: number,
  emittedScore: number | null,
  eventId: string | null,
  transitionNumber?: number,
): void {
  state.high_risk = highRisk;
  state.last_seen_at = timestamp;
  if (eventId !== null) state.active_event_id = eventId;
  if (emittedScore !== null) state.last_emitted_risk_score = emittedScore;
  if (transitionNumber !== undefined) state.transition_number = transitionNumber;
  if (!highRisk) state.active_event_id = null;
}

export function transitionMarketStatus(
  state: MarketStatusLifecycleState,
  status: MarketStatusLifecycleState["last_status"],
  timestamp: number,
): number {
  state.last_status = status;
  state.last_seen_at = timestamp;
  state.transition_number += 1;
  return state.transition_number;
}

function createDirectionState(): DirectionLifecycleState {
  return {
    lifecycle: "NO_SETUP",
    episode_number: 0,
    episode_id: null,
    setup_started_at: null,
    active_event_id: null,
    active_started_at: null,
    last_seen_at: null,
    last_confirmation_signature: null,
  };
}

function createRiskState(): RiskLifecycleState {
  return {
    high_risk: false,
    transition_number: 0,
    last_emitted_risk_score: null,
    active_event_id: null,
    last_seen_at: null,
  };
}

function createMarketStatusState(): MarketStatusLifecycleState {
  return {
    last_status: null,
    last_seen_at: null,
    transition_number: 0,
  };
}
