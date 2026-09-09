import type { SignalEngineInput, SignalEngineRunResult } from "./types";
import { runSignalEngine } from "./signal-engine";

/**
 * Execute the intelligence rules without Supabase writes or delivery calls.
 * This is the only runner used by the R4.8 MVP implementation.
 */
export function runSignalEngineDryRun(
  input: SignalEngineInput,
  idFactory?: () => string,
): Promise<SignalEngineRunResult> {
  return runSignalEngine(input, { dryRun: true, idFactory });
}
