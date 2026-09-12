import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerConfig } from "@/lib/config";
import { BinancePublicClient, mapWithConcurrency } from "@/lib/binance/public-client";
import {
  B4_SHADOW_INTERVAL_MS,
  B4_SHADOW_UNIVERSE_SYMBOLS,
  B4_LIVE_CONTEXT_RAW_BAR_REQUIREMENT,
  B4_LIVE_RAW_BAR_REQUIREMENT,
  activeB4ShadowSymbolsAt,
  b4ShadowBatchSymbols,
  b4ShadowClosedHourTimestamp,
  b4ShadowContextGroupKey,
  resolveB4ShadowUniverse,
  buildB4LiveObservation,
  calculateB4FourHourReturn,
  calculateB4Volatility,
  matureB4ShadowControlOutcomes,
  matureB4ShadowOutcomes,
  meanB4QuoteVolume,
  runB4ShadowSidecar,
} from "@/lib/signal-engine";
import type { B4LivePrimitive } from "@/lib/signal-engine/b4-live-features";
import {
  finalizeB4ShadowContext,
  getFinalizedB4ShadowContext,
  getStagedB4ShadowContexts,
  stageB4ShadowContext,
} from "./b4-shadow-context-repository";
import {
  createB4ShadowControlOutcome,
  createB4ShadowSignalOutcome,
  listB4ShadowControlEventsForMaturity,
  listB4ShadowSignalEventsForMaturity,
  persistB4ShadowControlCandidate,
  persistB4ShadowEventAndTransition,
} from "./b4-shadow-repository";
import {
  getB4ShadowFeatureStates,
  transitionB4ShadowEpisode,
  upsertB4ShadowFeatureState,
  upsertB4ShadowRuntimeState,
} from "./b4-shadow-runtime-repository";

export type B4ShadowCollectionStatus = "DISABLED" | "CONTEXT_INCOMPLETE" | "WAITING" | "FINALIZED" | "FAILED";

export interface B4ShadowCollectionResult {
  status: B4ShadowCollectionStatus;
  universeVersion: string;
  expectedSymbols: number;
  batchNumber: number;
  batchCount: number;
  closedMarketTimestamp: string;
  contextGroupKey: string;
  stagedSymbols: string[];
  networkFetches: number;
  skippedNetworkFetches: number;
  eventsGenerated: number;
  emailsSent: 0;
  errors: Array<{ symbol?: string; stage: string; message: string }>;
}

export async function collectB4ShadowBatch(input: {
  client: BinancePublicClient;
  supabase: SupabaseClient;
  config: ServerConfig;
  batchNumber: number;
  now?: number;
}): Promise<B4ShadowCollectionResult> {
  const now = input.now ?? Date.now();
  const closedTimestamp = b4ShadowClosedHourTimestamp(now);
  const closedMarketTimestamp = new Date(closedTimestamp).toISOString();
  const contextGroupKey = b4ShadowContextGroupKey(closedTimestamp);
  const errors: B4ShadowCollectionResult["errors"] = [];
  const resolution = resolveB4ShadowUniverse(await input.client.getUniverse(), closedTimestamp);
  const expectedSymbols = activeB4ShadowSymbolsAt(closedTimestamp);
  const batchCount = Math.max(1, Math.ceil(expectedSymbols.length / input.config.HY_SCAN_BATCH_SIZE));
  if (input.batchNumber >= batchCount) throw new Error("B4 batch is outside the frozen universe");
  if (resolution.status !== "READY") {
    return {
      status: "CONTEXT_INCOMPLETE",
      universeVersion: resolution.version,
      expectedSymbols: expectedSymbols.length,
      batchNumber: input.batchNumber,
      batchCount,
      closedMarketTimestamp,
      contextGroupKey,
      stagedSymbols: [],
      networkFetches: 0,
      skippedNetworkFetches: 0,
      eventsGenerated: 0,
      emailsSent: 0,
      errors: [{ stage: "b4_universe", message: resolution.reason ?? "frozen B4 universe incomplete" }],
    };
  }

  const existingFinalized = await getFinalizedB4ShadowContext(input.supabase, {
    contextGroupKey,
    marketTimestamp: closedMarketTimestamp,
    expectedSymbols,
  });
  if (existingFinalized) {
    return evaluateFinalizedContext(input, existingFinalized.observations, {
      expectedSymbols,
      batchNumber: input.batchNumber,
      batchCount,
      closedMarketTimestamp,
      contextGroupKey,
      networkFetches: 0,
      skippedNetworkFetches: expectedSymbols.length,
      errors,
    });
  }

  const batchSymbols = b4ShadowBatchSymbols(expectedSymbols, input.batchNumber, input.config.HY_SCAN_BATCH_SIZE);
  const staged = await getStagedB4ShadowContexts(input.supabase, {
    contextGroupKey,
    marketTimestamp: closedMarketTimestamp,
    symbols: expectedSymbols,
  });
  const featureStates = await getB4ShadowFeatureStates(input.supabase, expectedSymbols);
  const stagedObservations = new Map(staged);
  let networkFetches = 0;
  let skippedNetworkFetches = 0;
  const featureUpdates: Array<{
    symbol: string;
    lastEvaluatedClosedBar: string;
    rollingPrimitives: readonly B4LivePrimitive[];
  }> = [];

  await mapWithConcurrency(batchSymbols.map((symbol) => resolution.instruments.find((item) => item.symbol === symbol)!), input.config.HY_REQUEST_CONCURRENCY, async (instrument) => {
    if (stagedObservations.has(instrument.symbol)) {
      skippedNetworkFetches += 1;
      return;
    }
    const priorState = featureStates.get(instrument.symbol);
    if (priorState?.lastEvaluatedClosedBar === closedMarketTimestamp) {
      // Durable state says this hour has already been evaluated. Do not
      // refetch it; absent staged evidence keeps the context fail-closed.
      skippedNetworkFetches += 1;
      return;
    }
    try {
      networkFetches += 1;
      const incremental = priorState !== undefined && priorState.rollingPrimitives.length >= 721;
      const requestLimit = incremental ? B4_LIVE_CONTEXT_RAW_BAR_REQUIREMENT : B4_LIVE_RAW_BAR_REQUIREMENT;
      let history = await input.client.getB4LiveHistory(instrument.symbol, closedTimestamp + B4_SHADOW_INTERVAL_MS, requestLimit);
      history = { ...history, storedPrimitiveHistory: priorState?.rollingPrimitives };
      let result = buildB4LiveObservation(history, closedTimestamp + B4_SHADOW_INTERVAL_MS, {
        marketRegime: "UNKNOWN",
        volatilityBucket: calculateB4Volatility(history.priceBars).bucket,
        liquidityBucket: "UNKNOWN",
        volatilityValue: calculateB4Volatility(history.priceBars).value,
      });
      if (result.historyMode === "GAP") {
        networkFetches += 1;
        history = await input.client.getB4LiveHistory(instrument.symbol, closedTimestamp + B4_SHADOW_INTERVAL_MS, B4_LIVE_RAW_BAR_REQUIREMENT);
        result = buildB4LiveObservation({ ...history, storedPrimitiveHistory: undefined }, closedTimestamp + B4_SHADOW_INTERVAL_MS, {
          marketRegime: "UNKNOWN",
          volatilityBucket: calculateB4Volatility(history.priceBars).bucket,
          liquidityBucket: "UNKNOWN",
          volatilityValue: calculateB4Volatility(history.priceBars).value,
        });
      }
      if (result.status !== "READY") {
        errors.push({ symbol: instrument.symbol, stage: "b4_live_features", message: `B4 feature status ${result.status}` });
        return;
      }
      const volatility = calculateB4Volatility(history.priceBars);
      const quoteVolumeMean = meanB4QuoteVolume(history.priceBars);
      const fourHourReturn = calculateB4FourHourReturn(history.priceBars);
      if (volatility.value === null || quoteVolumeMean === null || fourHourReturn === null) {
        errors.push({ symbol: instrument.symbol, stage: "b4_context", message: "B4 hourly context is incomplete" });
        return;
      }
      await stageB4ShadowContext(input.supabase, {
        contextGroupKey,
        marketTimestamp: closedMarketTimestamp,
        expectedSymbols,
        observation: result.observation,
        fourHourReturn,
        quoteVolumeMean,
        volatilityValue: volatility.value,
      });
      stagedObservations.set(instrument.symbol, {
        symbol: instrument.symbol,
        observation: result.observation,
        quoteVolumeMean,
        fourHourReturn,
        volatilityValue: volatility.value,
      });
      if (result.historyMode !== "UNCHANGED") {
        featureUpdates.push({
          symbol: instrument.symbol,
          lastEvaluatedClosedBar: result.observation.market_timestamp,
          rollingPrimitives: result.nextPrimitiveHistory,
        });
      }
    } catch (error) {
      errors.push({ symbol: instrument.symbol, stage: "b4_live_features", message: errorMessage(error) });
    }
  });

  await Promise.all(featureUpdates.map((state) => upsertB4ShadowFeatureState(input.supabase, state)));
  const finalized = await finalizeB4ShadowContext(input.supabase, {
    contextGroupKey,
    marketTimestamp: closedMarketTimestamp,
    expectedSymbols,
  });
  if (finalized.status !== "FINALIZED") {
    return {
      status: errors.length > 0 ? "CONTEXT_INCOMPLETE" : "WAITING",
      universeVersion: resolution.version,
      expectedSymbols: expectedSymbols.length,
      batchNumber: input.batchNumber,
      batchCount,
      closedMarketTimestamp,
      contextGroupKey,
      stagedSymbols: [...stagedObservations.keys()].sort(),
      networkFetches,
      skippedNetworkFetches,
      eventsGenerated: 0,
      emailsSent: 0,
      errors,
    };
  }
  return evaluateFinalizedContext(input, finalized.observations, {
    expectedSymbols,
    batchNumber: input.batchNumber,
    batchCount,
    closedMarketTimestamp,
    contextGroupKey,
    networkFetches,
    skippedNetworkFetches,
    errors,
  });
}

async function evaluateFinalizedContext(
  input: Pick<Parameters<typeof collectB4ShadowBatch>[0], "supabase" | "client" | "config">,
  observations: readonly import("@/lib/signal-engine/b4-shadow-types").B4ShadowObservation[],
  metadata: {
    expectedSymbols: readonly string[];
    batchNumber: number;
    batchCount: number;
    closedMarketTimestamp: string;
    contextGroupKey: string;
    networkFetches: number;
    skippedNetworkFetches: number;
    errors: B4ShadowCollectionResult["errors"];
  },
): Promise<B4ShadowCollectionResult> {
  const sidecar = await runB4ShadowSidecar({
    enabled: true,
    observations,
    persistAndTransition: (event) => persistB4ShadowEventAndTransition(input.supabase, event),
    persistControlCandidate: (observation) => persistB4ShadowControlCandidate(input.supabase, observation),
    syncEpisodeState: (observation, direction, episodeKey) => transitionB4ShadowEpisode(input.supabase, {
      symbol: observation.symbol,
      direction,
      marketTimestamp: observation.market_timestamp,
      episodeKey,
    }),
  });
  const evaluatedAt = new Date().toISOString();
  try {
    const events = await listB4ShadowSignalEventsForMaturity(input.supabase, evaluatedAt);
    const controls = await listB4ShadowControlEventsForMaturity(input.supabase, evaluatedAt);
    await matureB4ShadowOutcomes({
      events,
      evaluatedAt,
      fetchFutureObservation: (event, horizon) => input.client.getClosedB4FutureObservation(
        event.symbol,
        Date.parse(event.market_timestamp),
        Date.parse(event.market_timestamp) + horizon * B4_SHADOW_INTERVAL_MS,
        Date.parse(evaluatedAt),
      ),
      persistOutcome: (outcome) => createB4ShadowSignalOutcome(input.supabase, outcome),
    });
    await matureB4ShadowControlOutcomes({
      controls,
      evaluatedAt,
      fetchFutureObservation: (control, horizon) => input.client.getClosedB4FutureObservation(
        control.symbol,
        Date.parse(control.market_timestamp),
        Date.parse(control.market_timestamp) + horizon * B4_SHADOW_INTERVAL_MS,
        Date.parse(evaluatedAt),
      ),
      persistOutcome: (outcome) => createB4ShadowControlOutcome(input.supabase, outcome),
    });
  } catch (error) {
    metadata.errors.push({ stage: "b4_outcome_maturity", message: errorMessage(error) });
  }
  const diagnostics = metadata.errors.length > 0
    ? { ...sidecar.diagnostics, status: "DEGRADED" as const }
    : sidecar.diagnostics;
  try {
    await upsertB4ShadowRuntimeState(input.supabase, diagnostics, {
      lastClosedBarEvaluated: metadata.closedMarketTimestamp,
      lastError: metadata.errors.at(-1)?.message ?? null,
    });
  } catch (error) {
    metadata.errors.push({ stage: "b4_runtime_state", message: errorMessage(error) });
  }
  return {
    status: metadata.errors.length > 0 ? "FAILED" : "FINALIZED",
    universeVersion: "hy-b4-shadow-universe-v1",
    expectedSymbols: metadata.expectedSymbols.length,
    batchNumber: metadata.batchNumber,
    batchCount: metadata.batchCount,
    closedMarketTimestamp: metadata.closedMarketTimestamp,
    contextGroupKey: metadata.contextGroupKey,
    stagedSymbols: observations.map((observation) => observation.symbol).sort(),
    networkFetches: metadata.networkFetches,
    skippedNetworkFetches: metadata.skippedNetworkFetches,
    eventsGenerated: sidecar.events.length,
    emailsSent: 0,
    errors: [...metadata.errors, ...sidecar.errors.map((error) => ({ symbol: error.symbol, stage: "b4_sidecar", message: error.message }))],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function b4CollectorBatchCount(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("B4 batch size must be positive");
  return Math.ceil(B4_SHADOW_UNIVERSE_SYMBOLS.length / batchSize);
}
