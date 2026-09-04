export type HealthTone = "healthy" | "warning" | "danger";

export interface ScannerHealth {
  status: "NO_DATA" | "HEALTHY" | "WARNING" | "FAILED";
  label: string;
  tone: HealthTone;
}

export interface StrategyObservationHealth {
  status: "NO_STRATEGY" | "OBSERVING" | "HAS_FORWARD_SAMPLE" | "STARVED";
  label: string;
  tone: HealthTone;
  lastForwardActivityAt: string | null;
  inactivityHours: number;
}

export interface ScannerHealthInput {
  status: string;
  started_at: string;
}

export interface StrategyObservationHealthInput {
  createdAt: string | null;
  latestQualifiedSignalAt: string | null;
  latestPaperTradeAt: string | null;
  starvationHours: number;
  scannerHealthy?: boolean;
}

export function getScannerHealth(
  scan: ScannerHealthInput | null,
  now = Date.now(),
): ScannerHealth {
  if (!scan) return { status: "NO_DATA", label: "等待运行数据", tone: "warning" };
  if (scan.status === "FAILED") return { status: "FAILED", label: "扫描异常", tone: "danger" };

  const ageMinutes = (now - new Date(scan.started_at).getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > 35 || scan.status === "PARTIAL") {
    return { status: "WARNING", label: "需要检查", tone: "warning" };
  }
  return { status: "HEALTHY", label: "运行正常", tone: "healthy" };
}

export function getStrategyObservationHealth(
  input: StrategyObservationHealthInput,
  now = Date.now(),
): StrategyObservationHealth {
  if (!input.createdAt) {
    return {
      status: "NO_STRATEGY",
      label: "等待策略",
      tone: "warning",
      lastForwardActivityAt: null,
      inactivityHours: 0,
    };
  }

  const createdAt = new Date(input.createdAt).getTime();
  const qualifiedSignalAt = parseTimestamp(input.latestQualifiedSignalAt);
  const paperTradeAt = parseTimestamp(input.latestPaperTradeAt);
  const activityTimes = [createdAt, qualifiedSignalAt, paperTradeAt].filter((value): value is number => Number.isFinite(value));
  const lastActivity = activityTimes.length > 0 ? Math.max(...activityTimes) : now;
  const lastForwardActivityAt = Number.isFinite(lastActivity) ? new Date(lastActivity).toISOString() : null;
  const inactivityHours = Math.max(0, (now - lastActivity) / 3_600_000);
  const thresholdHours = Math.max(1, Number.isFinite(input.starvationHours) ? input.starvationHours : 168);

  if (input.scannerHealthy === false) {
    return { status: "OBSERVING", label: "等待扫描数据", tone: "warning", lastForwardActivityAt, inactivityHours };
  }

  if (paperTradeAt !== null && (now - paperTradeAt) / 3_600_000 < thresholdHours) {
    return { status: "HAS_FORWARD_SAMPLE", label: "已有前向样本", tone: "healthy", lastForwardActivityAt, inactivityHours };
  }
  if (inactivityHours >= thresholdHours) {
    return { status: "STARVED", label: "信号饥饿", tone: "warning", lastForwardActivityAt, inactivityHours };
  }
  return { status: "OBSERVING", label: "观察中", tone: "healthy", lastForwardActivityAt, inactivityHours };
}

export function emptySignalMessage(
  scanner: ScannerHealth,
  observation: StrategyObservationHealth,
): { title: string; body: string } {
  if (scanner.status === "FAILED") {
    return {
      title: "扫描服务异常，暂时无法判断候选状态。",
      body: "请先检查 Scanner Health；当前空列表不代表市场没有机会。",
    };
  }
  if (observation.status === "STARVED") {
    const inactivity = observation.inactivityHours >= 24
      ? `${(observation.inactivityHours / 24).toFixed(1)} 天`
      : `${observation.inactivityHours.toFixed(0)} 小时`;
    return {
      title: `扫描服务运行正常，但当前策略已连续 ${inactivity}无新前向样本。`,
      body: "策略观察已超过信号饥饿阈值；请结合诊断漏斗检查阻断阶段，不要把空列表解读为市场结论。",
    };
  }
  if (observation.status === "NO_STRATEGY") {
    return {
      title: "当前没有可展示的策略观察样本。",
      body: "策略配置或前向观察数据尚未就绪。",
    };
  }
  return {
    title: "当前没有可展示的合格信号。",
    body: "请结合 Scanner Health、策略观察状态和最新诊断漏斗判断原因；系统不会为了增加邮件数量而降低门槛。",
  };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
