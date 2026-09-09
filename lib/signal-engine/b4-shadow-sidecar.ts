import type { MarketSnapshot } from "@/lib/core/types";
import { B4ShadowEngine } from "./b4-shadow";
import {
  B4_SHADOW_VERSION,
  type B4ShadowDiagnostics,
  type B4ShadowDirection,
  type B4ShadowObservation,
  type B4ShadowSignalEvent,
} from "./b4-shadow-types";

export type B4ShadowSidecarStatus = "DISABLED" | "WARMING_UP" | "READY" | "DEGRADED" | "FAILED";

export interface B4ShadowHealthDiagnostics {
  enabled: boolean;
  version: typeof B4_SHADOW_VERSION;
  status: B4ShadowSidecarStatus;
  lastEvaluatedAt: string | null;
  eligibleSymbols: string[];
  conditionsEvaluated: number;
  eventsGenerated: number;
  longWatch: number;
  shortWatch: number;
  duplicatesSuppressed: number;
  dataIncomplete: number;
  pitFailures: number;
  emailSent: 0;
}

export interface B4ShadowSidecarResult {
  status: B4ShadowSidecarStatus;
  events: B4ShadowSignalEvent[];
  errors: Array<{ symbol?: string; message: string }>;
  diagnostics: B4ShadowHealthDiagnostics;
}

export interface B4ShadowSidecarOptions {
  enabled: boolean;
  observations: readonly B4ShadowObservation[];
  persistEvent?: (event: B4ShadowSignalEvent) => Promise<unknown>;
  /** Durable compare-and-transition; the database is canonical across invocations. */
  claimEpisode?: (event: B4ShadowSignalEvent) => Promise<boolean>;
  /** Persist both TRUE and FALSE transitions so a later episode can re-arm. */
  syncEpisodeState?: (
    observation: B4ShadowObservation,
    direction: B4ShadowDirection | null,
    episodeKey: string | null,
  ) => Promise<boolean>;
  episodeState?: Map<string, B4ShadowDirection | null>;
}

let latestDiagnostics = disabledDiagnostics();

/**
 * Run the B4 path as an observability sidecar. It never throws into the
 * scanner and has no email, notification, or exchange execution dependency.
 */
export async function runB4ShadowSidecar(
  options: B4ShadowSidecarOptions,
): Promise<B4ShadowSidecarResult> {
  if (!options.enabled) {
    latestDiagnostics = disabledDiagnostics();
    return { status: "DISABLED", events: [], errors: [], diagnostics: latestDiagnostics };
  }

  const engine = new B4ShadowEngine({
    enabled: true,
    episodeState: options.episodeState,
  });
  const events: B4ShadowSignalEvent[] = [];
  const errors: Array<{ symbol?: string; message: string }> = [];
  let persistenceFailure = false;
  let durableDuplicateCount = 0;
  for (const observation of options.observations) {
    let evaluation;
    try {
      evaluation = engine.evaluate(observation);
    } catch (error) {
      errors.push({ symbol: observation.symbol, message: errorMessage(error) });
      continue;
    }
    if (evaluation.event !== null) {
      try {
        if (options.persistEvent) await options.persistEvent(evaluation.event);
        const isNewEpisode = options.syncEpisodeState
          ? await options.syncEpisodeState(observation, evaluation.direction, evaluation.event.episode_key)
          : options.claimEpisode
            ? await options.claimEpisode(evaluation.event)
            : true;
        if (isNewEpisode) events.push(evaluation.event);
        else durableDuplicateCount += 1;
      } catch (error) {
        persistenceFailure = true;
        errors.push({ symbol: observation.symbol, message: errorMessage(error) });
      }
    } else if (options.syncEpisodeState) {
      try {
        await options.syncEpisodeState(observation, evaluation.direction, null);
      } catch (error) {
        persistenceFailure = true;
        errors.push({ symbol: observation.symbol, message: errorMessage(error) });
      }
    }
  }

  const diagnostics = healthDiagnostics(engine.diagnostics(), errors.length > 0, persistenceFailure, durableDuplicateCount);
  latestDiagnostics = diagnostics;
  return {
    status: diagnostics.status,
    events,
    errors,
    diagnostics,
  };
}

export function getB4ShadowHealthDiagnostics(enabled = false): B4ShadowHealthDiagnostics {
  if (!enabled) return disabledDiagnostics();
  return {
    ...latestDiagnostics,
    enabled: true,
    status: latestDiagnostics.status === "DISABLED" ? "WARMING_UP" : latestDiagnostics.status,
  };
}

/**
 * The existing snapshot contains public Mark/Index and Funding context, but
 * not the historical Premium-change rolling state required by B4. Returning
 * explicit nulls makes that boundary fail closed instead of creating a
 * signal from a substituted feature.
 */
export function buildB4ShadowObservationFromSnapshot(
  snapshot: MarketSnapshot,
  decisionTime = Date.now(),
): B4ShadowObservation {
  const microstructure = snapshot.microstructure;
  const marketTimestamp = new Date(snapshot.sourceTimestamp).toISOString();
  const calendar = new Date(snapshot.sourceTimestamp);
  const calendarPeriod = `${calendar.getUTCFullYear()}-${String(calendar.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    symbol: snapshot.instrument.symbol,
    market_timestamp: marketTimestamp,
    decision_timestamp: new Date(decisionTime).toISOString(),
    pit_available_at: marketTimestamp,
    perpetual_price: snapshot.tickerPrice,
    premium_value: null,
    price_change_value: null,
    premium_change_value: null,
    price_percentile: null,
    premium_change_percentile: null,
    funding_state: microstructure
      ? { funding_rate: microstructure.fundingRate, next_funding_time: microstructure.nextFundingTime }
      : null,
    mark_index_basis_state: microstructure
      ? {
        mark_price: microstructure.markPrice,
        index_price: microstructure.indexPrice,
        basis_bps: microstructure.markIndexBasisBps,
      }
      : null,
    mark_price: microstructure?.markPrice ?? null,
    index_price: microstructure?.indexPrice ?? null,
    market_regime: "UNKNOWN",
    volatility_bucket: "UNKNOWN",
    liquidity_bucket: "UNKNOWN",
    calendar_period: calendarPeriod,
    observation_closed: Number.isFinite(snapshot.sourceTimestamp) && snapshot.sourceTimestamp <= decisionTime,
    market_data_complete: false,
    rolling_history_ready: false,
    pit_safe: true,
  };
}

function healthDiagnostics(
  diagnostics: B4ShadowDiagnostics,
  hasErrors: boolean,
  persistenceFailure: boolean,
  durableDuplicateCount: number,
): B4ShadowHealthDiagnostics {
  const status: B4ShadowSidecarStatus = persistenceFailure
    ? "FAILED"
    : hasErrors
      ? "DEGRADED"
      : !diagnostics.rolling_history_ready
        ? "WARMING_UP"
        : "READY";
  return {
    enabled: diagnostics.enabled,
    version: diagnostics.version,
    status,
    lastEvaluatedAt: diagnostics.last_evaluation_at,
    eligibleSymbols: diagnostics.eligible_symbols,
    conditionsEvaluated: diagnostics.b4_conditions_evaluated,
    eventsGenerated: Math.max(0, diagnostics.shadow_events_generated - durableDuplicateCount),
    longWatch: diagnostics.long_watch_count,
    shortWatch: diagnostics.short_watch_count,
    duplicatesSuppressed: diagnostics.duplicates_suppressed + durableDuplicateCount,
    dataIncomplete: diagnostics.data_incomplete_count,
    pitFailures: diagnostics.pit_failures,
    emailSent: 0,
  };
}

function disabledDiagnostics(): B4ShadowHealthDiagnostics {
  return {
    enabled: false,
    version: B4_SHADOW_VERSION,
    status: "DISABLED",
    lastEvaluatedAt: null,
    eligibleSymbols: [],
    conditionsEvaluated: 0,
    eventsGenerated: 0,
    longWatch: 0,
    shortWatch: 0,
    duplicatesSuppressed: 0,
    dataIncomplete: 0,
    pitFailures: 0,
    emailSent: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
