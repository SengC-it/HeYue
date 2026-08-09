import {
  atr,
  bollinger,
  closes,
  donchian,
  ema,
  latest,
  rsi,
  volumeRatio,
} from "./indicators";
import { classifyRegime } from "./market-regime";
import type {
  Candle,
  MarketSnapshot,
  MarketRegime,
  ScoreComponents,
  Side,
  StrategyCandidate,
  Timeframe,
} from "./types";

export type EntryMode = "DEFAULT" | "TREND_PULLBACK" | "BREAKOUT_RETEST" | "RANGE_RECLAIM";

export interface StrategyParams {
  entryMode?: EntryMode;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  atrPeriod: number;
  stopAtrMultiplier: number;
  breakoutPeriod: number;
  breakoutVolumeRatio: number;
  meanReversionRsiLow: number;
  meanReversionRsiHigh: number;
  bollingerPeriod: number;
  bollingerDeviation: number;
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  entryMode: "DEFAULT",
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  stopAtrMultiplier: 0.25,
  breakoutPeriod: 20,
  breakoutVolumeRatio: 1.15,
  meanReversionRsiLow: 35,
  meanReversionRsiHigh: 65,
  bollingerPeriod: 20,
  bollingerDeviation: 2,
};

export function generateCandidates(
  snapshot: MarketSnapshot,
  params: StrategyParams = DEFAULT_STRATEGY_PARAMS,
): StrategyCandidate[] {
  const primary = snapshot.candles["15m"];
  if (!primary || primary.length < Math.max(params.emaSlow + 5, 80)) return [];

  const regime = classifyRegime(snapshot.candles["4h"] ?? snapshot.candles["1h"] ?? []);
  if (params.entryMode === "TREND_PULLBACK") {
    const candidate = trendPullbackCandidate(snapshot, primary, regime, params);
    return candidate ? [candidate] : [];
  }
  if (params.entryMode === "BREAKOUT_RETEST") {
    const candidate = breakoutRetestCandidate(snapshot, primary, regime, params);
    return candidate ? [candidate] : [];
  }
  if (params.entryMode === "RANGE_RECLAIM") {
    const candidate = rangeReclaimCandidate(snapshot, primary, regime, params);
    return candidate ? [candidate] : [];
  }

  const candidates: StrategyCandidate[] = [];
  const trend = trendCandidate(snapshot, primary, regime, params);
  const breakout = breakoutCandidate(snapshot, primary, regime, params);
  const meanReversion = meanReversionCandidate(snapshot, primary, regime, params);

  if (trend) candidates.push(trend);
  if (breakout) candidates.push(breakout);
  if (meanReversion) candidates.push(meanReversion);
  return candidates;
}

function trendPullbackCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const values = closes(candles);
  const fastValues = ema(values, params.emaFast);
  const slowValues = ema(values, params.emaSlow);
  const atrValues = atr(candles, params.atrPeriod);
  const fast = latest(fastValues);
  const slow = latest(slowValues);
  const momentum = latest(rsi(values, params.rsiPeriod));
  const currentAtr = latest(atrValues);
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const oneHour = snapshot.candles["1h"] ?? [];
  const fourHour = snapshot.candles["4h"] ?? [];
  const oneHourFast = latest(ema(closes(oneHour), params.emaFast));
  const fourHourFast = latest(ema(closes(fourHour), params.emaFast));

  if (
    !current ||
    !previous ||
    fast === null ||
    slow === null ||
    momentum === null ||
    currentAtr === null
  ) {
    return null;
  }

  const oneHourClose = oneHour.at(-1)?.close;
  const fourHourClose = fourHour.at(-1)?.close;
  const longAlignment = [
    current.close > fast && fast > slow,
    oneHourClose === undefined || oneHourFast === null || oneHourClose > oneHourFast,
    fourHourClose === undefined || fourHourFast === null || fourHourClose > fourHourFast,
  ].filter(Boolean).length;
  const shortAlignment = [
    current.close < fast && fast < slow,
    oneHourClose === undefined || oneHourFast === null || oneHourClose < oneHourFast,
    fourHourClose === undefined || fourHourFast === null || fourHourClose < fourHourFast,
  ].filter(Boolean).length;
  if (longAlignment < 3 && shortAlignment < 3) return null;

  const lookbackStart = Math.max(params.emaSlow + 1, candles.length - 4);
  const longPulledBack = candles.slice(lookbackStart, -1).some((candle, offset) => {
    const index = lookbackStart + offset;
    const fastAt = fastValues[index];
    const atrAt = atrValues[index];
    return fastAt !== null
      && atrAt !== null
      && candle.low <= fastAt + atrAt * 0.35
      && candle.close >= fastAt - atrAt * 0.15;
  });
  const shortPulledBack = candles.slice(lookbackStart, -1).some((candle, offset) => {
    const index = lookbackStart + offset;
    const fastAt = fastValues[index];
    const atrAt = atrValues[index];
    return fastAt !== null
      && atrAt !== null
      && candle.high >= fastAt - atrAt * 0.35
      && candle.close <= fastAt + atrAt * 0.15;
  });
  const longConfirmed = current.close > current.open && current.close > previous.close && current.close > fast;
  const shortConfirmed = current.close < current.open && current.close < previous.close && current.close < fast;
  const longSignal = longAlignment === 3 && longPulledBack && longConfirmed;
  const shortSignal = shortAlignment === 3 && shortPulledBack && shortConfirmed;
  if (!longSignal && !shortSignal) return null;

  const side: Side = longSignal ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? recentLow(candles, 6) - currentAtr * params.stopAtrMultiplier
    : recentHigh(candles, 6) + currentAtr * params.stopAtrMultiplier;

  return {
    strategyFamily: "TREND",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "HIGH",
    scoreComponents: {
      trendAlignment: 1,
      momentum: side === "LONG"
        ? clamp01((momentum - 48) / 28)
        : clamp01((52 - momentum) / 28),
      structure: clamp01(1 - Math.abs(current.close - fast) / (currentAtr * 1.5)),
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: regimeFit(side, regime),
      dataQuality: dataQuality(candles.length + oneHour.length + fourHour.length),
    },
    rationale: [
      "Three-timeframe trend alignment",
      "Prior candle touched the fast EMA zone",
      "Current candle confirms the pullback direction",
    ],
  };
}

function breakoutRetestCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const channels = donchian(candles, params.breakoutPeriod);
  const ratios = volumeRatio(candles, params.breakoutPeriod);
  const previous = candles.at(-2);
  const current = candles.at(-1);
  const previousChannel = channels.at(-2);
  const previousVolumeRatio = ratios.at(-2) ?? null;
  const currentAtr = latest(atr(candles, params.atrPeriod));
  if (
    !previous ||
    !current ||
    !previousChannel ||
    previousChannel.upper === null ||
    previousChannel.lower === null ||
    previousVolumeRatio === null ||
    currentAtr === null
  ) {
    return null;
  }

  const longBreakout = previous.close > previousChannel.upper
    && previousVolumeRatio >= params.breakoutVolumeRatio;
  const shortBreakout = previous.close < previousChannel.lower
    && previousVolumeRatio >= params.breakoutVolumeRatio;
  const tolerance = currentAtr * 0.35;
  const longRetest = current.low <= previousChannel.upper + tolerance
    && current.low >= previousChannel.upper - currentAtr
    && current.close > previousChannel.upper
    && current.close > current.open;
  const shortRetest = current.high >= previousChannel.lower - tolerance
    && current.high <= previousChannel.lower + currentAtr
    && current.close < previousChannel.lower
    && current.close < current.open;
  const longSignal = longBreakout && longRetest;
  const shortSignal = shortBreakout && shortRetest;
  if (!longSignal && !shortSignal) return null;

  const side: Side = longSignal ? "LONG" : "SHORT";
  const breakoutLevel = side === "LONG" ? previousChannel.upper : previousChannel.lower;
  const stopReferencePrice = side === "LONG"
    ? Math.min(breakoutLevel, recentLow(candles, 5) - currentAtr * params.stopAtrMultiplier)
    : Math.max(breakoutLevel, recentHigh(candles, 5) + currentAtr * params.stopAtrMultiplier);
  const trendFit = regimeFit(side, regime);

  return {
    strategyFamily: "BREAKOUT",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "MEDIUM",
    scoreComponents: {
      trendAlignment: trendFit,
      momentum: clamp01((previousVolumeRatio - 0.8) / 1.2),
      structure: clamp01(1 - Math.abs(current.close - breakoutLevel) / (currentAtr * 1.5)),
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: trendFit,
      dataQuality: dataQuality(candles.length),
    },
    rationale: [
      "Previous candle broke the Donchian level with volume",
      "Current candle retested the level and reclaimed it",
    ],
  };
}

function rangeReclaimCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  if (regime !== "RANGE") return null;
  const values = closes(candles);
  const bands = bollinger(values, params.bollingerPeriod, params.bollingerDeviation).at(-1);
  const momentum = latest(rsi(values, params.rsiPeriod));
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const current = candles.at(-1);
  if (
    !current ||
    !bands ||
    bands.upper === null ||
    bands.lower === null ||
    momentum === null ||
    currentAtr === null
  ) {
    return null;
  }

  const longSignal = current.low <= bands.lower
    && current.close > bands.lower
    && current.close > current.open
    && momentum <= params.meanReversionRsiLow + 10;
  const shortSignal = current.high >= bands.upper
    && current.close < bands.upper
    && current.close < current.open
    && momentum >= params.meanReversionRsiHigh - 10;
  if (!longSignal && !shortSignal) return null;

  const side: Side = longSignal ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? recentLow(candles, 5) - currentAtr * params.stopAtrMultiplier
    : recentHigh(candles, 5) + currentAtr * params.stopAtrMultiplier;

  return {
    strategyFamily: "MEAN_REVERSION",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "HIGH",
    scoreComponents: {
      trendAlignment: 0.5,
      momentum: side === "LONG"
        ? clamp01((params.meanReversionRsiLow + 10 - momentum) / 25)
        : clamp01((momentum - (params.meanReversionRsiHigh - 10)) / 25),
      structure: 0.9,
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: 1,
      dataQuality: dataQuality(candles.length),
    },
    rationale: [
      "Range regime",
      "Price pierced a Bollinger band and reclaimed it",
      "Reversal candle confirmed by RSI",
    ],
  };
}

function trendCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const values = closes(candles);
  const fast = latest(ema(values, params.emaFast));
  const slow = latest(ema(values, params.emaSlow));
  const momentum = latest(rsi(values, params.rsiPeriod));
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const oneHour = snapshot.candles["1h"] ?? [];
  const fourHour = snapshot.candles["4h"] ?? [];
  const oneHourFast = latest(ema(closes(oneHour), params.emaFast));
  const fourHourFast = latest(ema(closes(fourHour), params.emaFast));
  const latestClose = values.at(-1);

  if (
    fast === null ||
    slow === null ||
    momentum === null ||
    currentAtr === null ||
    latestClose === undefined
  ) {
    return null;
  }

  const oneHourClose = oneHour.at(-1)?.close;
  const fourHourClose = fourHour.at(-1)?.close;
  const longAlignment = [
    latestClose > fast && fast > slow,
    oneHourClose === undefined || oneHourFast === null || oneHourClose > oneHourFast,
    fourHourClose === undefined || fourHourFast === null || fourHourClose > fourHourFast,
  ].filter(Boolean).length;
  const shortAlignment = [
    latestClose < fast && fast < slow,
    oneHourClose === undefined || oneHourFast === null || oneHourClose < oneHourFast,
    fourHourClose === undefined || fourHourFast === null || fourHourClose < fourHourFast,
  ].filter(Boolean).length;

  if (longAlignment < 2 && shortAlignment < 2) return null;

  const side: Side = longAlignment >= shortAlignment ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? recentLow(candles, 6) - currentAtr * params.stopAtrMultiplier
    : recentHigh(candles, 6) + currentAtr * params.stopAtrMultiplier;

  return {
    strategyFamily: "TREND",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: latestClose,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "HIGH",
    scoreComponents: trendScore({
      side,
      alignment: Math.max(longAlignment, shortAlignment),
      momentum,
      close: latestClose,
      fast,
      atr: currentAtr,
      regime,
      snapshot,
      sampleCount: candles.length + oneHour.length + fourHour.length,
    }),
    rationale: [
      `${side === "LONG" ? "15m 价格站上" : "15m 价格跌破"} EMA${params.emaFast}/EMA${params.emaSlow}`,
      `多周期趋势一致度 ${Math.max(longAlignment, shortAlignment)}/3`,
      `RSI(${params.rsiPeriod})=${momentum.toFixed(1)}`,
    ],
  };
}

function breakoutCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const channels = donchian(candles, params.breakoutPeriod);
  const ratios = volumeRatio(candles, params.breakoutPeriod);
  const currentChannel = channels.at(-1);
  const currentVolumeRatio = latest(ratios);
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const current = candles.at(-1);
  if (
    !current ||
    !currentChannel ||
    currentChannel.upper === null ||
    currentChannel.lower === null ||
    currentVolumeRatio === null ||
    currentAtr === null
  ) {
    return null;
  }

  const longBreakout = current.close > currentChannel.upper && currentVolumeRatio >= params.breakoutVolumeRatio;
  const shortBreakout = current.close < currentChannel.lower && currentVolumeRatio >= params.breakoutVolumeRatio;
  if (!longBreakout && !shortBreakout) return null;

  const side: Side = longBreakout ? "LONG" : "SHORT";
  const breakoutDistance = side === "LONG"
    ? current.close - currentChannel.upper
    : currentChannel.lower - current.close;
  const stopReferencePrice = side === "LONG"
    ? Math.min(currentChannel.upper, recentLow(candles, 5) - currentAtr * params.stopAtrMultiplier)
    : Math.max(currentChannel.lower, recentHigh(candles, 5) + currentAtr * params.stopAtrMultiplier);
  const trendFit = regimeFit(side, regime);

  return {
    strategyFamily: "BREAKOUT",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h", "4h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "MEDIUM",
    scoreComponents: {
      trendAlignment: trendFit,
      momentum: clamp01((currentVolumeRatio - 0.8) / 1.2),
      // A breakout that is already far beyond the level has worse entry
      // quality. Volume confirms the breakout; structure should measure
      // whether the fill is still close enough to the level to manage risk.
      structure: clamp01(1 - breakoutDistance / (currentAtr * 1.5)),
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: trendFit,
      dataQuality: dataQuality(candles.length),
    },
    rationale: [
      `${params.breakoutPeriod} 根 K 线通道突破`,
      `成交量约为近期均值 ${currentVolumeRatio.toFixed(2)} 倍`,
      `市场状态 ${regime}`,
    ],
  };
}

function meanReversionCandidate(
  snapshot: MarketSnapshot,
  candles: Candle[],
  regime: MarketRegime,
  params: StrategyParams,
): StrategyCandidate | null {
  const values = closes(candles);
  const bands = bollinger(values, params.bollingerPeriod, params.bollingerDeviation).at(-1);
  const momentum = latest(rsi(values, params.rsiPeriod));
  const currentAtr = latest(atr(candles, params.atrPeriod));
  const current = candles.at(-1);
  if (
    !current ||
    !bands ||
    bands.upper === null ||
    bands.lower === null ||
    momentum === null ||
    currentAtr === null
  ) {
    return null;
  }

  const longReversion = current.close <= bands.lower && momentum <= params.meanReversionRsiLow;
  const shortReversion = current.close >= bands.upper && momentum >= params.meanReversionRsiHigh;
  if (!longReversion && !shortReversion) return null;

  const side: Side = longReversion ? "LONG" : "SHORT";
  const stopReferencePrice = side === "LONG"
    ? recentLow(candles, 5) - currentAtr * params.stopAtrMultiplier
    : recentHigh(candles, 5) + currentAtr * params.stopAtrMultiplier;

  return {
    strategyFamily: "MEAN_REVERSION",
    side,
    primaryTimeframe: "15m",
    confirmationTimeframes: ["1h"],
    entryPrice: current.close,
    stopReferencePrice,
    atr: currentAtr,
    marketRegime: regime,
    regimeDependency: "LOW",
    scoreComponents: {
      trendAlignment: 0.35,
      momentum: side === "LONG"
        ? clamp01((params.meanReversionRsiLow - momentum) / 25)
        : clamp01((momentum - params.meanReversionRsiHigh) / 25),
      structure: 0.82,
      liquidity: liquidityScore(snapshot.instrument.quoteVolume24h),
      volatility: volatilityScore(currentAtr / current.close),
      regimeFit: regime === "RANGE" || regime === "UNKNOWN" ? 0.9 : 0.55,
      dataQuality: dataQuality(candles.length),
    },
    rationale: [
      `价格触及布林带${side === "LONG" ? "下轨" : "上轨"}`,
      `RSI(${params.rsiPeriod})=${momentum.toFixed(1)}`,
      "使用反转策略，趋势行情中的失败风险较高",
    ],
  };
}

function trendScore(input: {
  side: Side;
  alignment: number;
  momentum: number;
  close: number;
  fast: number;
  atr: number;
  regime: MarketRegime;
  snapshot: MarketSnapshot;
  sampleCount: number;
}): ScoreComponents {
  const momentumScore = input.side === "LONG"
    ? clamp01((input.momentum - 48) / 32)
    : clamp01((52 - input.momentum) / 32);
  return {
    trendAlignment: input.alignment / 3,
    momentum: momentumScore,
    // Trend alignment and momentum already reward directional strength. Do
    // not also reward an overextended price; keep the entry score highest
    // near the fast-EMA decision zone and lower it as chase distance grows.
    structure: clamp01(1 - Math.abs(input.close - input.fast) / (input.atr * 2)),
    liquidity: liquidityScore(input.snapshot.instrument.quoteVolume24h),
    volatility: volatilityScore(input.atr / input.close),
    regimeFit: regimeFit(input.side, input.regime),
    dataQuality: dataQuality(input.sampleCount),
  };
}

function recentLow(candles: Candle[], period: number): number {
  return Math.min(...candles.slice(-period).map((candle) => candle.low));
}

function recentHigh(candles: Candle[], period: number): number {
  return Math.max(...candles.slice(-period).map((candle) => candle.high));
}

function liquidityScore(quoteVolume?: number): number {
  if (!quoteVolume || quoteVolume <= 0) return 0.35;
  return clamp01((Math.log10(quoteVolume) - 5) / 5);
}

function volatilityScore(atrPercent: number): number {
  if (!Number.isFinite(atrPercent)) return 0;
  return clamp01(1 - Math.abs(atrPercent - 0.012) / 0.025);
}

function regimeFit(side: Side, regime: MarketRegime): number {
  if (regime === "UNKNOWN") return 0.55;
  if (regime === "RANGE") return 0.6;
  if ((side === "LONG" && regime === "BULL") || (side === "SHORT" && regime === "BEAR")) return 1;
  return 0.25;
}

function dataQuality(sampleCount: number): number {
  return clamp01(sampleCount / 700);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
