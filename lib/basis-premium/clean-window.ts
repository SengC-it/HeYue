export const R58C_CONTAMINATED_WINDOW = {
  start: Date.parse("2024-08-09T00:00:00.000Z"),
  endExclusive: Date.parse("2026-08-10T00:00:00.000Z"),
  startIso: "2024-08-09T00:00:00.000Z",
  endIso: "2026-08-09T23:59:59.999Z",
} as const;

export const R59_CLEAN_DISCOVERY_WINDOW = {
  start: Date.parse("2023-01-01T00:00:00.000Z"),
  endExclusive: Date.parse("2024-08-09T00:00:00.000Z"),
  startIso: "2023-01-01T00:00:00.000Z",
  endIso: "2024-08-08T23:59:59.999Z",
} as const;

export const R59_RESERVED_HOLDOUT = {
  start: Date.parse("2026-08-10T00:00:00.000Z"),
  startIso: "2026-08-10T00:00:00.000Z",
} as const;

export function overlapsR58CContaminatedWindow(start: number, endExclusive: number): boolean {
  return start < R58C_CONTAMINATED_WINDOW.endExclusive
    && endExclusive > R58C_CONTAMINATED_WINDOW.start;
}

export function assertCleanWindow(start: number, endExclusive: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || endExclusive <= start) {
    throw new Error("Clean window must have finite, increasing timestamps.");
  }
  if (overlapsR58CContaminatedWindow(start, endExclusive)) {
    throw new Error(
      `Window overlaps invalidated R5.8C range ${R58C_CONTAMINATED_WINDOW.startIso} to ${R58C_CONTAMINATED_WINDOW.endIso}.`,
    );
  }
}

export function overlapsR59ReservedHoldout(start: number, endExclusive: number): boolean {
  return endExclusive > R59_RESERVED_HOLDOUT.start;
}

/**
 * Guard used by the clean-window foundation and future authoritative runners.
 * The exact error codes are part of the research-governance contract.
 */
export function assertR59DiscoveryWindow(start: number, endExclusive: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive) || endExclusive <= start) {
    throw new Error("INVALID_DISCOVERY_WINDOW");
  }
  if (overlapsR58CContaminatedWindow(start, endExclusive)) {
    throw new Error("CONTAMINATED_WINDOW_FORBIDDEN");
  }
  if (overlapsR59ReservedHoldout(start, endExclusive)) {
    throw new Error("RESERVED_HOLDOUT_FORBIDDEN");
  }
}
