import type {
  MarketBreadthFeature,
  MarketBreadthFeatureInput,
  MarketBreadthMember,
} from "./types";

const DEFAULT_TOP_UNIVERSE_SIZE = 10;
const DEFAULT_MINIMUM_MEMBERS = 3;
const DEFAULT_DIRECTION_THRESHOLD = 0.001;

export function calculateMarketBreadthFeature(
  input: MarketBreadthFeatureInput,
): MarketBreadthFeature {
  const topUniverseSize = Math.max(1, Math.floor(input.top_universe_size ?? DEFAULT_TOP_UNIVERSE_SIZE));
  const minimumMembers = Math.max(1, Math.floor(input.minimum_members ?? DEFAULT_MINIMUM_MEMBERS));
  const directionThreshold = Math.max(0, input.direction_threshold ?? DEFAULT_DIRECTION_THRESHOLD);
  const validMembers = input.members.filter((member) => (
    member.source_timestamp <= input.as_of
    && Number.isFinite(member.price_return_24h)
  ));
  const futureMemberPoints = input.members.filter((member) => member.source_timestamp > input.as_of).length;
  const totalSymbols = input.members.length;
  const validSymbols = validMembers.length;
  const up = validMembers.filter((member) => member.price_return_24h > directionThreshold).length;
  const down = validMembers.filter((member) => member.price_return_24h < -directionThreshold).length;
  const flat = validSymbols - up - down;
  const advancingRatio = validSymbols > 0 ? up / validSymbols : null;
  const decliningRatio = validSymbols > 0 ? down / validSymbols : null;
  const flatRatio = validSymbols > 0 ? flat / validSymbols : null;
  const topMembers = [...validMembers]
    .filter((member) => finiteNonNegative(member.quote_volume_24h))
    .sort((left, right) => right.quote_volume_24h! - left.quote_volume_24h!)
    .slice(0, topUniverseSize);
  const topUniverseStrength = topMembers.length > 0
    ? topMembers.reduce((total, member) => total + member.price_return_24h, 0) / topMembers.length
    : null;
  const enoughMembers = validSymbols >= minimumMembers;
  const dominantRatio = Math.max(advancingRatio ?? 0, decliningRatio ?? 0);
  const directionalBalance = Math.abs((advancingRatio ?? 0) - (decliningRatio ?? 0)) * 100;
  const topStrengthScore = topUniverseStrength === null
    ? 0
    : clamp(Math.abs(topUniverseStrength) / 0.01 * 100);
  const breadthScore = enoughMembers
    ? round(clamp(directionalBalance * 0.65 + topStrengthScore * 0.35))
    : null;
  const direction = advancingRatio !== null && advancingRatio > decliningRatio! && advancingRatio > flatRatio!
    ? "UP"
    : decliningRatio !== null && decliningRatio > advancingRatio! && decliningRatio > flatRatio!
      ? "DOWN"
      : "FLAT";
  return {
    timestamp: new Date(input.as_of).toISOString(),
    advancing_ratio: advancingRatio === null ? null : round(advancingRatio),
    declining_ratio: decliningRatio === null ? null : round(decliningRatio),
    flat_ratio: flatRatio === null ? null : round(flatRatio),
    valid_symbols: validSymbols,
    total_symbols: totalSymbols,
    top_universe_size: topMembers.length,
    top_universe_strength: topUniverseStrength === null ? null : round(topUniverseStrength),
    top_universe_symbols: topMembers.map((member) => member.symbol),
    breadth_score: breadthScore,
    direction,
    status: breadthStatus(
      breadthScore,
      dominantRatio,
      direction,
      topUniverseStrength,
    ),
    future_member_points_ignored: futureMemberPoints,
    source_timestamp: validMembers.length > 0
      ? new Date(Math.max(...validMembers.map((member) => member.source_timestamp))).toISOString()
      : null,
    pit_safe: true,
  };
}

function breadthStatus(
  score: number | null,
  dominantRatio: number,
  direction: MarketBreadthFeature["direction"],
  topStrength: number | null,
): MarketBreadthFeature["status"] {
  if (score === null || topStrength === null) return "BLOCKED";
  const topAgrees = direction === "UP"
    ? topStrength > 0
    : direction === "DOWN" ? topStrength < 0 : false;
  if (dominantRatio >= 0.65 && topAgrees && Math.abs(topStrength) >= 0.0025) return "STRONG";
  if (dominantRatio < 0.45 || !topAgrees) return "WEAK";
  return "NORMAL";
}

function finiteNonNegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
