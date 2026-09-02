import { getHyEnvironment } from "@/lib/config";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  emptySignalMessage,
  getScannerHealth,
  getStrategyObservationHealth,
} from "@/lib/dashboard/health";

export const dynamic = "force-dynamic";

const operatingRules = [
  { label: "行情来源", value: "Binance USDT-M 公共行情" },
  { label: "执行边界", value: "仅提醒，由你人工决定交易" },
  { label: "风险输出", value: "理论入场、止损、止盈与评分" },
  { label: "账户权限", value: "不接入账户密钥，不自动下单" },
];

interface RecentSignal {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strategy_family: string;
  primary_timeframe: string;
  score: number;
  market_regime: string;
  entry_price: number;
  stop_price: number;
  take_profit_price: number;
  reward_risk: number;
  status: string;
  valid_until: string;
  created_at: string;
}

interface LatestScan {
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  universe_size: number;
  scanned_symbols: number;
  candidate_count: number;
  emailed_count: number;
  started_at: string;
  finished_at: string | null;
}

interface StrategySnapshot {
  version: string;
  status: "DRAFT" | "PAPER" | "ACTIVE" | "RETIRED";
  created_at: string;
}

interface PaperTrade {
  status: string;
  net_pnl_usdt: number | null;
}

interface LatestDiagnostics {
  global_regime: string | null;
  filter_funnel: unknown;
  symbol_diagnostics: unknown;
  created_at: string;
}

interface DashboardData {
  signals: RecentSignal[];
  latestScan: LatestScan | null;
  strategy: StrategySnapshot | null;
  deploymentStage: string;
  exchangeOrdersEnabled: boolean;
  paperTrades: PaperTrade[];
  hasQualifiedSignal: boolean;
  hasForwardSample: boolean;
  latestDiagnostics: LatestDiagnostics | null;
  starvationHours: number;
  timezone: string;
}

export default async function HomePage() {
  const dashboard = await getDashboardData();
  const scannerHealth = getScannerHealth(dashboard.latestScan);
  const observationHealth = getStrategyObservationHealth({
    createdAt: dashboard.strategy?.created_at ?? null,
    hasQualifiedSignal: dashboard.hasQualifiedSignal,
    hasForwardSample: dashboard.hasForwardSample,
    starvationHours: dashboard.starvationHours,
    scannerHealthy: scannerHealth.status === "HEALTHY",
  });
  const paperSummary = summarizePaperTrades(dashboard.paperTrades);
  const deploymentStage = dashboard.deploymentStage || dashboard.strategy?.status || "PAPER";

  return (
    <main className="shell">
      <section className="hero">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">合</span>
          <div>
            <p className="brand-name">HeYue</p>
            <p className="brand-caption">CONTRACT SIGNAL OBSERVATORY</p>
          </div>
        </div>

        <div className="hero-copy">
          <p className="eyebrow">BINANCE FUTURES · SIGNALS, NOT ORDERS</p>
          <h1>合约信号<br />观察站</h1>
          <p className="lede">
            用经过验证的规则持续扫描合约机会，输出可解释评分与理论止盈止损。系统只负责提醒，交易决定始终由你掌握。
          </p>
        </div>

        <div className="runtime-strip" aria-label="部署安全状态">
          <span className={`runtime-dot ${scannerHealth.tone}`} aria-hidden="true" />
          <strong>{deploymentStage} 观察运行</strong>
          <span>Scanner {scannerHealth.label}</span>
          <span>策略观察 {observationHealth.label}</span>
          <span>邮件提醒</span>
          <span>{dashboard.exchangeOrdersEnabled ? "交易接口已启用" : "禁止自动下单"}</span>
        </div>
      </section>

      <section className="operations-panel" aria-labelledby="operations-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LIVE OPERATIONS</p>
            <h2 id="operations-title">系统运行状态</h2>
          </div>
          <span className={`health-badge ${scannerHealth.tone}`}>Scanner Health · {scannerHealth.label}</span>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="metric-label">最近扫描</span>
            <strong>{dashboard.latestScan ? formatDate(dashboard.latestScan.started_at, dashboard.timezone) : "等待首次运行"}</strong>
            <small>{dashboard.latestScan?.status ?? "NO DATA"}</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">本轮覆盖</span>
            <strong>{dashboard.latestScan ? `${dashboard.latestScan.scanned_symbols} / ${dashboard.latestScan.universe_size}` : "—"}</strong>
            <small>深度扫描 / 合约池</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">本轮候选</span>
            <strong>{dashboard.latestScan?.candidate_count ?? 0}</strong>
            <small>{dashboard.latestScan?.emailed_count ?? 0} 封信号邮件</small>
          </article>
          <article className="metric-card">
            <span className="metric-label">策略观察健康</span>
            <strong>{observationHealth.label}</strong>
            <small>{observationHealth.status === "STARVED" ? `${observationHealth.observedHours.toFixed(0)}h · 阈值 ${dashboard.starvationHours}h` : dashboard.strategy?.version ?? deploymentStage}</small>
          </article>
        </div>
        <div className="diagnostic-strip">
          <span>最新全局状态：<strong>{dashboard.latestDiagnostics?.global_regime ?? "诊断数据积累中"}</strong></span>
          <span>主要阻断：<strong>{diagnosticRejectionStage(dashboard.latestDiagnostics?.symbol_diagnostics) ?? "诊断数据积累中"}</strong></span>
          <span>诊断时间：<strong>{dashboard.latestDiagnostics ? formatDate(dashboard.latestDiagnostics.created_at, dashboard.timezone) : "—"}</strong></span>
        </div>
      </section>

      <section className="rules-grid" aria-label="HeYue 系统边界">
        {operatingRules.map((rule, index) => (
          <article className="rule-card" key={rule.label}>
            <span className="rule-index">0{index + 1}</span>
            <p>{rule.label}</p>
            <strong>{rule.value}</strong>
          </article>
        ))}
      </section>

      <section className="signal-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">QUALIFIED SIGNALS</p>
            <h2>最近的候选信号</h2>
          </div>
          <span className="panel-count">{dashboard.signals.length} 条</span>
        </div>

        {dashboard.signals.length === 0 ? (
          <div className="empty-state">
            {(() => {
              const message = emptySignalMessage(scannerHealth, observationHealth);
              return <><strong>{message.title}</strong><p>{message.body}</p></>;
            })()}
          </div>
        ) : (
          <div className="signal-list">
            {dashboard.signals.map((signal) => (
              <article className="signal-row" key={signal.id}>
                <div className="signal-main">
                  <div className="signal-title">
                    <strong>{signal.symbol}</strong>
                    <span className={`side-badge ${signal.side.toLowerCase()}`}>{signal.side}</span>
                    <span className="muted-label">{signal.strategy_family}</span>
                  </div>
                  <p>{signal.primary_timeframe} · {signal.market_regime} · {formatDate(signal.created_at, dashboard.timezone)}</p>
                </div>
                <div className="signal-score">
                  <strong>{Number(signal.score).toFixed(1)}</strong>
                  <span>评分</span>
                </div>
                <div className="signal-prices">
                  <span>入场 {formatPrice(signal.entry_price)}</span>
                  <span>止损 {formatPrice(signal.stop_price)}</span>
                  <span>止盈 {formatPrice(signal.take_profit_price)} · {Number(signal.reward_risk).toFixed(1)}R</span>
                </div>
                <span className={`signal-status ${signal.status.toLowerCase()}`}>{signal.status}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="paper-panel" aria-labelledby="paper-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PAPER OBSERVATION</p>
            <h2 id="paper-title">纸面交易样本</h2>
          </div>
          <span className="panel-count">最近 {dashboard.paperTrades.length} 笔</span>
        </div>
        <div className="paper-grid">
          <div><span>样本数</span><strong>{dashboard.paperTrades.length}</strong></div>
          <div><span>未平仓</span><strong>{paperSummary.openCount}</strong></div>
          <div><span>已结算胜率</span><strong>{paperSummary.closedCount ? `${paperSummary.winRate.toFixed(1)}%` : "—"}</strong></div>
          <div><span>近期净盈亏</span><strong className={paperSummary.netPnl >= 0 ? "positive" : "negative"}>{formatPnl(paperSummary.netPnl)}</strong></div>
        </div>
        <p className="paper-note">PAPER 数据仅用于上线观察和策略复核，不代表未来收益，也不会触发真实交易。</p>
      </section>

      <footer className="site-footer">
        <div>
          <span className="footer-brand">HeYue</span>
          <p>每 15 分钟扫描一次 · Alert-only · Manual execution</p>
        </div>
        <a href="/api/health" className="outline-button">查看健康检查</a>
      </footer>
    </main>
  );
}

async function getDashboardData(): Promise<DashboardData> {
  const environment = getHyEnvironment();
  const configuredStarvationHours = Number(environment.HY_SIGNAL_STARVATION_HOURS ?? 168);
  const starvationHours = Number.isFinite(configuredStarvationHours) && configuredStarvationHours > 0
    ? configuredStarvationHours
    : 168;
  const timezone = environment.HY_DEFAULT_TIMEZONE ?? "Asia/Shanghai";

  try {
    const supabase = getSupabaseAdmin();
    const [signalsResult, scanResult, strategyResult, settingsResult, paperResult] = await Promise.all([
      supabase
        .from("hy_signals")
        .select("id,symbol,side,strategy_family,primary_timeframe,score,market_regime,entry_price,stop_price,take_profit_price,reward_risk,status,valid_until,created_at")
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("hy_scan_runs")
        .select("status,universe_size,scanned_symbols,candidate_count,emailed_count,started_at,finished_at")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("hy_strategy_versions")
        .select("version,status,created_at")
        .in("status", ["PAPER", "ACTIVE"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("hy_app_settings")
        .select("setting_value")
        .eq("setting_key", "deployment_mode")
        .maybeSingle(),
      supabase
        .from("hy_paper_trades")
        .select("status,net_pnl_usdt")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    const error = signalsResult.error ?? scanResult.error ?? strategyResult.error ?? settingsResult.error ?? paperResult.error;
    if (error) throw error;

    const setting = settingsResult.data?.setting_value as { stage?: string; exchange_orders_enabled?: boolean } | undefined;
    const strategy = strategyResult.data as StrategySnapshot | null;
    let hasQualifiedSignal = false;
    let hasForwardSample = false;
    if (strategy?.version) {
      const [qualifiedResult, forwardResult] = await Promise.all([
        supabase
          .from("hy_signals")
          .select("id")
          .eq("strategy_version", strategy.version)
          .limit(1),
        supabase
          .from("hy_paper_trades")
          .select("id")
          .eq("strategy_version", strategy.version)
          .limit(1),
      ]);
      if (qualifiedResult.error) throw qualifiedResult.error;
      if (forwardResult.error) throw forwardResult.error;
      hasQualifiedSignal = (qualifiedResult.data?.length ?? 0) > 0;
      hasForwardSample = (forwardResult.data?.length ?? 0) > 0;
    }

    let latestDiagnostics: LatestDiagnostics | null = null;
    const diagnosticsQuery = supabase
      .from("hy_scan_diagnostics")
      .select("global_regime,filter_funnel,symbol_diagnostics,created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (strategy?.version) diagnosticsQuery.eq("strategy_version", strategy.version);
    const diagnosticsResult = await diagnosticsQuery.maybeSingle();
    if (diagnosticsResult.error) {
      console.warn("HeYue scan diagnostics are not available yet; using the dashboard fallback.");
    } else {
      latestDiagnostics = diagnosticsResult.data as LatestDiagnostics | null;
    }

    return {
      signals: (signalsResult.data ?? []) as RecentSignal[],
      latestScan: scanResult.data as LatestScan | null,
      strategy,
      deploymentStage: setting?.stage ?? "PAPER",
      exchangeOrdersEnabled: setting?.exchange_orders_enabled === true,
      paperTrades: (paperResult.data ?? []) as PaperTrade[],
      hasQualifiedSignal,
      hasForwardSample,
      latestDiagnostics,
      starvationHours,
      timezone,
    };
  } catch (error) {
    console.warn("HeYue dashboard data is unavailable until Supabase is configured.", error);
    return {
      signals: [],
      latestScan: null,
      strategy: null,
      deploymentStage: "PAPER",
      exchangeOrdersEnabled: false,
      paperTrades: [],
      hasQualifiedSignal: false,
      hasForwardSample: false,
      latestDiagnostics: null,
      starvationHours,
      timezone,
    };
  }
}

function summarizePaperTrades(trades: PaperTrade[]) {
  const closed = trades.filter((trade) => trade.status !== "OPEN");
  const wins = closed.filter((trade) => Number(trade.net_pnl_usdt) > 0).length;
  const netPnl = closed.reduce((sum, trade) => sum + Number(trade.net_pnl_usdt ?? 0), 0);

  return {
    openCount: trades.length - closed.length,
    closedCount: closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    netPnl,
  };
}

function formatPrice(value: number): string {
  return Number(value).toLocaleString("en-US", { maximumSignificantDigits: 8 });
}

function formatPnl(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} USDT`;
}

function formatDate(value: string, timezone: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function diagnosticRejectionStage(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const counts = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const diagnostic = item as Record<string, unknown>;
    if (diagnostic.finalStatus !== "REJECTED" || typeof diagnostic.rejectionStage !== "string") continue;
    counts.set(diagnostic.rejectionStage, (counts.get(diagnostic.rejectionStage) ?? 0) + 1);
  }
  const stageOrder = [
    "MARKET_DATA",
    "NO_RAW_CANDIDATE",
    "SCORE",
    "SIDE",
    "STRATEGY_FAMILY",
    "LOCAL_REGIME",
    "GLOBAL_REGIME",
    "RISK_PLAN",
    "SINGLE_RISK_CAP",
    "EXECUTION_COST",
    "COOLDOWN",
    "CLAIM_REJECTED",
    "EMAIL_NOT_ALLOWED",
  ];
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || stageOrder.indexOf(left[0]) - stageOrder.indexOf(right[0]))
    .at(0)?.[0] ?? null;
}
