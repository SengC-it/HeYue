import { getSupabaseAdmin } from "@/lib/supabase/admin";

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
}

interface PaperTrade {
  status: string;
  net_pnl_usdt: number | null;
}

interface DashboardData {
  signals: RecentSignal[];
  latestScan: LatestScan | null;
  strategy: StrategySnapshot | null;
  deploymentStage: string;
  exchangeOrdersEnabled: boolean;
  paperTrades: PaperTrade[];
}

export default async function HomePage() {
  const dashboard = await getDashboardData();
  const runtime = getRuntimeStatus(dashboard.latestScan);
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
          <span className={`runtime-dot ${runtime.tone}`} aria-hidden="true" />
          <strong>{deploymentStage} 观察运行</strong>
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
          <span className={`health-badge ${runtime.tone}`}>{runtime.label}</span>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="metric-label">最近扫描</span>
            <strong>{dashboard.latestScan ? formatDate(dashboard.latestScan.started_at) : "等待首次运行"}</strong>
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
            <span className="metric-label">当前策略</span>
            <strong>{dashboard.strategy?.version ?? "等待配置"}</strong>
            <small>{dashboard.strategy?.status ?? deploymentStage}</small>
          </article>
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
            <strong>扫描正常，暂时没有符合条件的机会。</strong>
            <p>HeYue 不会为了增加邮件数量而降低评分与风险门槛。市场条件满足时，信号会自动保存并发送提醒。</p>
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
                  <p>{signal.primary_timeframe} · {signal.market_regime} · {formatDate(signal.created_at)}</p>
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
        .select("version,status")
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
    return {
      signals: (signalsResult.data ?? []) as RecentSignal[],
      latestScan: scanResult.data as LatestScan | null,
      strategy: strategyResult.data as StrategySnapshot | null,
      deploymentStage: setting?.stage ?? "PAPER",
      exchangeOrdersEnabled: setting?.exchange_orders_enabled === true,
      paperTrades: (paperResult.data ?? []) as PaperTrade[],
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
    };
  }
}

function getRuntimeStatus(scan: LatestScan | null): { label: string; tone: "healthy" | "warning" | "danger" } {
  if (!scan) return { label: "等待运行数据", tone: "warning" };
  if (scan.status === "FAILED") return { label: "扫描异常", tone: "danger" };

  const ageMinutes = (Date.now() - new Date(scan.started_at).getTime()) / 60_000;
  if (ageMinutes > 35 || scan.status === "PARTIAL") return { label: "需要检查", tone: "warning" };
  return { label: "运行正常", tone: "healthy" };
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

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: process.env.HY_DEFAULT_TIMEZONE ?? process.env.CS_DEFAULT_TIMEZONE ?? "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
