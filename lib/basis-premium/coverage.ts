import type { CoverageSummary, LifecycleSpan } from "./types";
import { resolutionMilliseconds } from "./parser";
import type { BasisPremiumResolution } from "./types";

function ceilToStep(timestamp: number, stepMs: number): number {
  return Math.ceil(timestamp / stepMs) * stepMs;
}

export function expectedTimestamps(
  spans: LifecycleSpan[],
  startTime: number,
  endTimeExclusive: number,
  resolution: BasisPremiumResolution,
): number[] {
  const stepMs = resolutionMilliseconds(resolution);
  const output: number[] = [];
  for (const span of spans) {
    const start = Math.max(startTime, span.startTime);
    const end = Math.min(endTimeExclusive, span.endTimeExclusive);
    if (end <= start) continue;
    for (let timestamp = ceilToStep(start, stepMs); timestamp < end; timestamp += stepMs) output.push(timestamp);
  }
  return output;
}

export function isTimestampInLifecycle(timestamp: number, spans: LifecycleSpan[]): boolean {
  return spans.some((span) => timestamp >= span.startTime && timestamp < span.endTimeExclusive);
}

export function coverageForTimestamps(
  timestamps: Iterable<number>,
  spans: LifecycleSpan[],
  startTime: number,
  endTimeExclusive: number,
  resolution: BasisPremiumResolution,
): CoverageSummary {
  const expected = expectedTimestamps(spans, startTime, endTimeExclusive, resolution);
  const available = new Set<number>();
  for (const timestamp of timestamps) {
    if (timestamp >= startTime && timestamp < endTimeExclusive && isTimestampInLifecycle(timestamp, spans)) available.add(timestamp);
  }
  const missing = expected.filter((timestamp) => !available.has(timestamp));
  const stepMs = resolutionMilliseconds(resolution);
  const gapSamples: CoverageSummary["gapSamples"] = [];
  let gapStart: number | null = null;
  let previousMissing: number | null = null;
  const closeGap = (end: number) => {
    if (gapStart === null || previousMissing === null) return;
    gapSamples.push({ startTime: gapStart, endTimeExclusive: end, missing: Math.floor((end - gapStart) / stepMs) });
    gapStart = null;
    previousMissing = null;
  };
  for (const timestamp of missing) {
    if (gapStart === null) {
      gapStart = timestamp;
    } else if (timestamp !== previousMissing! + stepMs) {
      closeGap(previousMissing! + stepMs);
      gapStart = timestamp;
    }
    previousMissing = timestamp;
  }
  if (previousMissing !== null) closeGap(previousMissing + stepMs);
  const sortedAvailable = [...available].sort((left, right) => left - right);
  return {
    expected: expected.length,
    valid: available.size,
    missing: missing.length,
    coveragePercent: expected.length === 0 ? 100 : available.size / expected.length * 100,
    firstTimestamp: sortedAvailable[0] ?? null,
    lastTimestamp: sortedAvailable.at(-1) ?? null,
    gapRuns: gapSamples.length,
    gapSamples: gapSamples.slice(0, 20),
  };
}
