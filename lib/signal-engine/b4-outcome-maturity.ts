import { calculateB4ShadowControlOutcome, calculateB4ShadowOutcome } from "./b4-shadow";
import type {
  B4ShadowControlEvent,
  B4ShadowControlOutcome,
  B4ShadowFutureObservation,
  B4ShadowOutcome,
  B4ShadowSignalEvent,
} from "./b4-shadow-types";
import { B4_SHADOW_INTERVAL_MS, B4_SHADOW_OUTCOME_HORIZONS } from "./b4-shadow-types";

export interface B4OutcomeMaturityOptions {
  events: readonly B4ShadowSignalEvent[];
  evaluatedAt: string;
  fetchFutureObservation: (
    event: B4ShadowSignalEvent,
    horizonHours: (typeof B4_SHADOW_OUTCOME_HORIZONS)[number],
  ) => Promise<B4ShadowFutureObservation | null>;
  persistOutcome: (outcome: B4ShadowOutcome) => Promise<unknown>;
}

export interface B4OutcomeMaturityResult {
  due: number;
  matured: number;
  notDue: number;
  unavailable: number;
}

export interface B4ControlOutcomeMaturityOptions {
  controls: readonly B4ShadowControlEvent[];
  evaluatedAt: string;
  fetchFutureObservation: (
    control: B4ShadowControlEvent,
    horizonHours: (typeof B4_SHADOW_OUTCOME_HORIZONS)[number],
  ) => Promise<B4ShadowFutureObservation | null>;
  persistOutcome: (outcome: B4ShadowControlOutcome) => Promise<unknown>;
}

export type B4ControlOutcomeMaturityResult = B4OutcomeMaturityResult;

/**
 * Mature only due horizons using a closed future observation whose PIT
 * availability is no later than evaluatedAt. Persistence is delegated to the
 * existing unique (event_id, horizon_hours) repository boundary.
 */
export async function matureB4ShadowOutcomes(
  options: B4OutcomeMaturityOptions,
): Promise<B4OutcomeMaturityResult> {
  const evaluatedAtMs = Date.parse(options.evaluatedAt);
  const result: B4OutcomeMaturityResult = { due: 0, matured: 0, notDue: 0, unavailable: 0 };
  for (const event of options.events) {
    const eventTime = Date.parse(event.market_timestamp);
    if (!Number.isFinite(eventTime) || !Number.isFinite(evaluatedAtMs)) continue;
    const horizons = event.pending_horizons ?? B4_SHADOW_OUTCOME_HORIZONS;
    for (const horizonHours of horizons) {
      const dueAt = eventTime + horizonHours * B4_SHADOW_INTERVAL_MS;
      if (dueAt > evaluatedAtMs) {
        result.notDue += 1;
        continue;
      }
      result.due += 1;
      const future = await options.fetchFutureObservation(event, horizonHours);
      if (!future) {
        result.unavailable += 1;
        continue;
      }
      const outcome = calculateB4ShadowOutcome(event, horizonHours, future, options.evaluatedAt);
      if (!outcome) {
        result.unavailable += 1;
        continue;
      }
      await options.persistOutcome(outcome);
      result.matured += 1;
    }
  }
  return result;
}

export async function matureB4ShadowControlOutcomes(
  options: B4ControlOutcomeMaturityOptions,
): Promise<B4ControlOutcomeMaturityResult> {
  const evaluatedAtMs = Date.parse(options.evaluatedAt);
  const result: B4ControlOutcomeMaturityResult = { due: 0, matured: 0, notDue: 0, unavailable: 0 };
  for (const control of options.controls) {
    const controlTime = Date.parse(control.market_timestamp);
    if (!Number.isFinite(controlTime) || !Number.isFinite(evaluatedAtMs)) continue;
    const horizons = control.pending_horizons ?? B4_SHADOW_OUTCOME_HORIZONS;
    for (const horizonHours of horizons) {
      const dueAt = controlTime + horizonHours * B4_SHADOW_INTERVAL_MS;
      if (dueAt > evaluatedAtMs) {
        result.notDue += 1;
        continue;
      }
      result.due += 1;
      const future = await options.fetchFutureObservation(control, horizonHours);
      if (!future) {
        result.unavailable += 1;
        continue;
      }
      const outcome = calculateB4ShadowControlOutcome(control, horizonHours, future, options.evaluatedAt);
      if (!outcome) {
        result.unavailable += 1;
        continue;
      }
      await options.persistOutcome(outcome);
      result.matured += 1;
    }
  }
  return result;
}
