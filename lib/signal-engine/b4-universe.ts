import type { Instrument } from "@/lib/core/types";

export const B4_SHADOW_UNIVERSE_VERSION = "hy-b4-shadow-universe-v1" as const;
export const B4_SHADOW_UNIVERSE_SOURCE_COMMIT = "7bb10067df78a1d7cb11e6ab06643fb44dc8e400" as const;
export const B4_SHADOW_UNIVERSE_SOURCE_RUNNER_BLOB = "5dc0672ecc60a8b68299237a2d9a534f1c05f317" as const;
export const B4_SHADOW_UNIVERSE_SOURCE_CUTOFF_BLOB = "6ec0c67651332a1bf8e56beaed0411d7970f4856" as const;
export const B4_SHADOW_UNIVERSE_SOURCE_FEATURE_HASH = "bbdaab9e4cba4c22e50471d538d808fca992e812aaff60a0fc3f70af6020cf51" as const;
export const B4_SHADOW_UNIVERSE_SOURCE_ARTIFACT = "data/raw/hy-r5.10a-b4-holdout/artifacts/holdout-dataset-manifest.json" as const;
export const B4_SHADOW_UNIVERSE_SOURCE_ARTIFACT_SHA256 = "5d7db5391d6950ce6a7937f7f1b81ee8979ca595c59fc5120fc2dace1ff73adf" as const;
export const B4_SHADOW_UNIVERSE_HASH = "833894b120a52fbf2e68ca9fc46b5d5607bc4db3e0aacc7e40106492c29c56f3" as const;
export const B4_SHADOW_LIFECYCLE_SOURCE = "data/raw/hy-r5.2b-flow/listing-evidence.json" as const;
export const B4_SHADOW_LIFECYCLE_END = "2100-12-25T08:00:00.000Z" as const;
export const B4_SHADOW_HOUR_MS = 3_600_000 as const;

/** Exact sorted eligible universe frozen by the R5.10A B4 holdout. */
export const B4_SHADOW_UNIVERSE_SYMBOLS = [
  "1000BONKUSDT", "1000CATUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "AAVEUSDT", "ADAUSDT",
  "ARCUSDT", "AVAXUSDT", "BANKUSDT", "BEATUSDT", "BNBUSDT", "BTCUSDT", "COOKIEUSDT",
  "COTIUSDT", "DEXEUSDT", "DODOXUSDT", "DOGEUSDT", "ENAUSDT", "EPICUSDT", "ETHUSDT",
  "FILUSDT", "GWEIUSDT", "HEIUSDT", "HOMEUSDT", "HYPEUSDT", "ICPUSDT", "INJUSDT",
  "IOTXUSDT", "LINKUSDT", "LTCUSDT", "NEARUSDT", "ONDOUSDT", "PAXGUSDT", "PENGUUSDT",
  "PUMPUSDT", "SAGAUSDT", "SIRENUSDT", "SKYAIUSDT", "SOLUSDT", "SUIUSDT", "SYNUSDT",
  "TAOUSDT", "TRXUSDT", "TSTUSDT", "UNIUSDT", "WLDUSDT", "XLMUSDT", "XMRUSDT", "XRPUSDT",
] as const;

const ACTIVE_STARTS: Record<string, string> = {
  "1000BONKUSDT": "2023-11-22T14:00:00.000Z",
  "1000CATUSDT": "2024-10-21T12:30:00.000Z",
  "1000PEPEUSDT": "2023-05-05T00:00:00.000Z",
  "1000SHIBUSDT": "2021-05-10T07:00:00.000Z",
  AAVEUSDT: "2020-10-16T07:00:00.000Z",
  ADAUSDT: "2020-01-31T08:00:00.000Z",
  ARCUSDT: "2025-01-17T13:00:00.000Z",
  AVAXUSDT: "2020-09-23T07:00:00.000Z",
  BANKUSDT: "2025-04-18T18:30:00.000Z",
  BEATUSDT: "2025-11-12T12:15:00.000Z",
  BNBUSDT: "2020-02-10T08:00:00.000Z",
  BTCUSDT: "2019-09-08T17:55:00.000Z",
  COOKIEUSDT: "2025-01-07T11:30:00.000Z",
  COTIUSDT: "2021-03-09T07:00:00.000Z",
  DEXEUSDT: "2024-12-24T11:30:00.000Z",
  DODOXUSDT: "2023-08-08T12:00:00.000Z",
  DOGEUSDT: "2020-07-10T09:00:00.000Z",
  ENAUSDT: "2024-04-02T12:30:00.000Z",
  EPICUSDT: "2025-03-13T08:00:00.000Z",
  ETHUSDT: "2019-11-27T07:45:00.000Z",
  FILUSDT: "2020-10-16T06:00:00.000Z",
  GWEIUSDT: "2026-01-29T05:30:00.000Z",
  HEIUSDT: "2025-02-13T09:00:00.000Z",
  HOMEUSDT: "2025-06-10T11:30:00.000Z",
  HYPEUSDT: "2025-05-30T10:30:00.000Z",
  ICPUSDT: "2021-07-30T07:00:00.000Z",
  INJUSDT: "2022-08-16T07:00:00.000Z",
  IOTXUSDT: "2021-08-11T07:00:00.000Z",
  LINKUSDT: "2020-01-17T08:00:00.000Z",
  LTCUSDT: "2020-01-09T08:05:00.000Z",
  NEARUSDT: "2020-10-15T08:00:00.000Z",
  ONDOUSDT: "2024-01-20T13:00:00.000Z",
  PAXGUSDT: "2025-03-27T10:30:00.000Z",
  PENGUUSDT: "2024-12-17T16:15:00.000Z",
  SAGAUSDT: "2024-04-09T10:30:00.000Z",
  SIRENUSDT: "2025-03-22T09:00:00.000Z",
  SKYAIUSDT: "2025-05-13T09:45:00.000Z",
  SOLUSDT: "2020-09-14T07:00:00.000Z",
  SUIUSDT: "2023-05-03T00:00:00.000Z",
  SYNUSDT: "2024-08-16T12:30:00.000Z",
  TAOUSDT: "2024-04-11T14:30:00.000Z",
  TRXUSDT: "2020-01-15T08:05:00.000Z",
  TSTUSDT: "2025-02-09T13:00:00.000Z",
  UNIUSDT: "2020-09-18T07:00:00.000Z",
  WLDUSDT: "2023-07-24T12:00:00.000Z",
  XLMUSDT: "2020-01-20T08:00:00.000Z",
  XMRUSDT: "2020-02-03T08:00:00.000Z",
  XRPUSDT: "2020-01-06T08:20:00.000Z",
};

export interface B4ShadowLifecycleInterval {
  kind: "ACTIVE" | "RELAUNCHED";
  start: string;
  endExclusive: string;
}

export interface B4ShadowUniverseManifest {
  version: typeof B4_SHADOW_UNIVERSE_VERSION;
  symbols: readonly string[];
  sourceArtifact: typeof B4_SHADOW_UNIVERSE_SOURCE_ARTIFACT;
  sourceArtifactSha256: typeof B4_SHADOW_UNIVERSE_SOURCE_ARTIFACT_SHA256;
  sourceCommit: typeof B4_SHADOW_UNIVERSE_SOURCE_COMMIT;
  sourceRunnerBlobSha256: typeof B4_SHADOW_UNIVERSE_SOURCE_RUNNER_BLOB;
  sourceCutoffBlobSha256: typeof B4_SHADOW_UNIVERSE_SOURCE_CUTOFF_BLOB;
  featureSpecificationHash: typeof B4_SHADOW_UNIVERSE_SOURCE_FEATURE_HASH;
  universeHash: typeof B4_SHADOW_UNIVERSE_HASH;
  lifecycleSource: typeof B4_SHADOW_LIFECYCLE_SOURCE;
  activeRule: string;
}

export const B4_SHADOW_UNIVERSE_MANIFEST: B4ShadowUniverseManifest = {
  version: B4_SHADOW_UNIVERSE_VERSION,
  symbols: B4_SHADOW_UNIVERSE_SYMBOLS,
  sourceArtifact: B4_SHADOW_UNIVERSE_SOURCE_ARTIFACT,
  sourceArtifactSha256: B4_SHADOW_UNIVERSE_SOURCE_ARTIFACT_SHA256,
  sourceCommit: B4_SHADOW_UNIVERSE_SOURCE_COMMIT,
  sourceRunnerBlobSha256: B4_SHADOW_UNIVERSE_SOURCE_RUNNER_BLOB,
  sourceCutoffBlobSha256: B4_SHADOW_UNIVERSE_SOURCE_CUTOFF_BLOB,
  featureSpecificationHash: B4_SHADOW_UNIVERSE_SOURCE_FEATURE_HASH,
  universeHash: B4_SHADOW_UNIVERSE_HASH,
  lifecycleSource: B4_SHADOW_LIFECYCLE_SOURCE,
  activeRule: "Expected symbols are frozen R5.10A symbols whose listing interval contains the closed market timestamp; missing live data never removes an expected symbol.",
};

export interface B4ShadowUniverseResolution {
  status: "READY" | "CONTEXT_INCOMPLETE";
  version: typeof B4_SHADOW_UNIVERSE_VERSION;
  symbols: string[];
  instruments: Instrument[];
  reason: string | null;
}

export function b4ShadowLifecycle(symbol: string): B4ShadowLifecycleInterval[] {
  if (symbol === "PUMPUSDT") {
    return [
      { kind: "ACTIVE", start: "2025-04-12T14:30:00.000Z", endExclusive: "2025-06-13T09:00:00.000Z" },
      { kind: "RELAUNCHED", start: "2025-07-10T07:30:00.000Z", endExclusive: B4_SHADOW_LIFECYCLE_END },
    ];
  }
  const start = ACTIVE_STARTS[symbol];
  return start ? [{ kind: "ACTIVE", start, endExclusive: B4_SHADOW_LIFECYCLE_END }] : [];
}

export function isB4ShadowSymbolActive(symbol: string, marketTimestamp: number | string): boolean {
  const timestamp = typeof marketTimestamp === "number" ? marketTimestamp : Date.parse(marketTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  return b4ShadowLifecycle(symbol).some((interval) => {
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.endExclusive);
    return timestamp >= start && timestamp < end;
  });
}

export function activeB4ShadowSymbolsAt(marketTimestamp: number | string): string[] {
  return B4_SHADOW_UNIVERSE_SYMBOLS.filter((symbol) => isB4ShadowSymbolActive(symbol, marketTimestamp));
}

export function b4ShadowClosedHourTimestamp(now = Date.now()): number {
  if (!Number.isFinite(now)) throw new Error("current time must be finite");
  return Math.floor(now / B4_SHADOW_HOUR_MS) * B4_SHADOW_HOUR_MS - B4_SHADOW_HOUR_MS;
}

export function b4ShadowContextGroupKey(closedMarketTimestamp: number | string): string {
  const timestamp = typeof closedMarketTimestamp === "number"
    ? closedMarketTimestamp
    : Date.parse(closedMarketTimestamp);
  if (!Number.isFinite(timestamp) || timestamp % B4_SHADOW_HOUR_MS !== 0) {
    throw new Error("B4 context timestamp must be a closed UTC hour");
  }
  return `${B4_SHADOW_UNIVERSE_VERSION}:${new Date(timestamp).toISOString()}`;
}

/**
 * Resolve the frozen universe against live exchange metadata. The expected
 * set is never derived from live rows, so a transient omission fails closed.
 */
export function resolveB4ShadowUniverse(
  liveInstruments: readonly Instrument[],
  closedMarketTimestamp: number | string,
): B4ShadowUniverseResolution {
  const symbols = activeB4ShadowSymbolsAt(closedMarketTimestamp);
  const bySymbol = new Map(liveInstruments.map((instrument) => [instrument.symbol, instrument]));
  const missing = symbols.filter((symbol) => {
    const instrument = bySymbol.get(symbol);
    return !instrument || instrument.status !== "TRADING" || instrument.contractType !== "PERPETUAL" || instrument.quoteAsset !== "USDT";
  });
  if (missing.length > 0) {
    return {
      status: "CONTEXT_INCOMPLETE",
      version: B4_SHADOW_UNIVERSE_VERSION,
      symbols,
      instruments: [],
      reason: `frozen B4 universe incomplete: ${missing.join(",")}`,
    };
  }
  return {
    status: "READY",
    version: B4_SHADOW_UNIVERSE_VERSION,
    symbols,
    instruments: symbols.map((symbol) => ({ ...bySymbol.get(symbol)! })),
    reason: null,
  };
}

export function b4ShadowBatchSymbols(symbols: readonly string[], batchNumber: number, batchSize: number): string[] {
  if (!Number.isInteger(batchNumber) || batchNumber < 0) throw new Error("batch number must be non-negative");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batch size must be positive");
  return symbols.slice(batchNumber * batchSize, (batchNumber + 1) * batchSize);
}
