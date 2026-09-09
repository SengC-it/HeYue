export const reasonCodeOrder = [
  "TREND_ALIGNED",
  "MOMENTUM_UP",
  "MOMENTUM_DOWN",
  "MOMENTUM_STABILIZING",
  "VOLUME_CONFIRMATION",
  "FUNDING_CONTEXT_SUPPORTIVE",
  "FUNDING_EXTREME_NEGATIVE",
  "FUNDING_EXTREME_POSITIVE",
  "OI_RISING",
  "OI_FALLING",
  "PRICE_UP_OI_UP",
  "PRICE_UP_OI_DOWN",
  "PRICE_DOWN_OI_UP",
  "PRICE_DOWN_OI_DOWN",
  "LIQUIDITY_OK",
  "LOW_LIQUIDITY",
  "LIQUIDITY_BLOCKED",
  "HIGH_VOLATILITY",
  "OI_ABNORMAL",
  "BREADTH_FRAGILE",
  "REGIME_CONFLICT",
  "UNKNOWN_REGIME",
  "DATA_DEGRADED",
  "DATA_BLOCKED",
  "PIT_INVALID",
  "TREND_UP",
  "TREND_DOWN",
  "RANGE",
  "HIGH_VOL",
  "NO_TRADE",
] as const;

const reasonOrder = new Map<string, number>(reasonCodeOrder.map((code, index) => [code, index]));

export function stableReasonCodes(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const unique = new Set(groups.flat());
  return [...unique].sort((left, right) => {
    const leftOrder = reasonOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = reasonOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right);
  });
}

export function reasonExplanation(code: string): string {
  const explanations: Record<string, string> = {
    TREND_ALIGNED: "局部趋势与高周期趋势一致",
    MOMENTUM_UP: "动量处于上行观察区间",
    MOMENTUM_DOWN: "动量处于下行观察区间",
    MOMENTUM_STABILIZING: "动量出现稳定迹象",
    VOLUME_CONFIRMATION: "成交量提供参与度确认",
    FUNDING_CONTEXT_SUPPORTIVE: "Funding 提供方向性上下文",
    FUNDING_EXTREME_NEGATIVE: "Funding 处于极端负值区域",
    FUNDING_EXTREME_POSITIVE: "Funding 处于极端正值区域",
    OI_RISING: "Open Interest 上升",
    OI_FALLING: "Open Interest 下降",
    PRICE_UP_OI_UP: "价格上升且 Open Interest 上升",
    PRICE_UP_OI_DOWN: "价格上升且 Open Interest 下降",
    PRICE_DOWN_OI_UP: "价格下降且 Open Interest 上升",
    PRICE_DOWN_OI_DOWN: "价格下降且 Open Interest 下降",
    LIQUIDITY_OK: "流动性状态可用",
    LOW_LIQUIDITY: "流动性偏薄",
    LIQUIDITY_BLOCKED: "流动性状态阻断方向性观察",
    HIGH_VOLATILITY: "波动处于高风险状态",
    OI_ABNORMAL: "Open Interest 变化异常",
    BREADTH_FRAGILE: "市场广度脆弱或集中",
    REGIME_CONFLICT: "趋势与市场状态存在冲突",
    UNKNOWN_REGIME: "市场状态证据不足",
    DATA_DEGRADED: "输入数据质量降级",
    DATA_BLOCKED: "输入数据质量阻断",
    PIT_INVALID: "输入时间水位不满足 PIT-safe",
    TREND_UP: "市场状态偏向上行趋势",
    TREND_DOWN: "市场状态偏向下行趋势",
    RANGE: "市场方向性不足，处于区间状态",
    HIGH_VOL: "市场处于高波动状态",
    NO_TRADE: "引擎不生成方向性观察",
  };
  return explanations[code] ?? code;
}
