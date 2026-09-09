import type {
  MarketStatusLifecycleState,
  OpportunityEventPolicy,
  RiskLifecycleState,
} from "./types";
import type { SignalEngineSignal } from "../signal-engine";

export function createDirectionEpisodeId(
  symbol: string,
  direction: "LONG" | "SHORT",
  episodeNumber: number,
): string {
  return symbol + ":" + direction + ":" + episodeNumber;
}

export function createOpportunityEventId(episodeId: string): string {
  return "opportunity:" + episodeId;
}

export function createTransitionEventId(
  symbol: string,
  eventType: "RISK_WARNING" | "MARKET_STATUS",
  transitionNumber: number,
): string {
  return "opportunity:" + symbol + ":" + eventType + ":" + transitionNumber;
}

export function isNewConfirmation(
  previousSignature: string | null,
  currentSignature: string,
): boolean {
  return previousSignature === null || previousSignature !== currentSignature;
}

export function riskTransitionKind(
  state: RiskLifecycleState,
  signal: SignalEngineSignal | null,
  policy: OpportunityEventPolicy,
): "NONE" | "INITIAL" | "UPGRADE" {
  if (signal === null) return "NONE";
  if (!state.high_risk) return "INITIAL";
  if (
    state.last_emitted_risk_score !== null
    && signal.scores.risk_level_score >= state.last_emitted_risk_score + policy.risk_escalation_delta
  ) return "UPGRADE";
  return "NONE";
}

export function isStatusTransition(
  state: MarketStatusLifecycleState,
  status: MarketStatusLifecycleState["last_status"],
): boolean {
  return state.last_status !== null && state.last_status !== status;
}
