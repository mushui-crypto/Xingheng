import type { StrategyForwardReport, StrategyForwardTrade } from "../model/types";
import { strategyConfigDefaults, strategyObservationDefaults } from "../model/constants";
import {
  formatAverageR,
  formatExitReason,
  formatProfitFactor,
  formatStrategyDateTime,
  formatStrategyMoney,
  formatStrategyPercent,
  formatStrategyPeriod,
  formatStrategyPrice,
  strategyNumberTone,
} from "../lib/formatters";

export function StrategyPageHeader({ error, loading, report }: { error: boolean; loading: boolean; report: StrategyForwardReport | null }) {
  const gateReached = report?.observationGate.reached ?? false;
  const unavailable = error || report?.status === "unavailable";
  const statusLabel = loading ? "状态加载中" : unavailable ? "等待 Paper 报告" : gateReached ? "等待人工复核" : "Paper 观察中";
  return (
    <header className="xh-strategy-header">
      <div>
        <h1>策略交易</h1>
        <p>Binance Paper 前向观察</p>
      </div>
      <div className="xh-strategy-statuses" aria-label="策略执行状态">
        <span className={loading || unavailable ? "is-unavailable" : gateReached ? "is-review" : "is-observing"}>{statusLabel}</span>
        <span className="is-disabled">自动下单关闭</span>
      </div>
    </header>
  );
}

export function StrategyLoadingState() {
  return (
    <div className="xh-strategy-loading" aria-busy="true" aria-label="策略报告加载中">
      <div className="xh-strategy-loading-line is-wide" />
      <div className="xh-strategy-loading-line" />
      <div className="xh-strategy-loading-grid">
        {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
      </div>
      <div className="xh-strategy-loading-panel" />
    </div>
  );
}

export function StrategyErrorState({ message }: { message: string }) {
  return (
    <section className="xh-strategy-state is-error" role="alert">
      <strong>策略报告加载失败</strong>
      <p>{message}</p>
    </section>
  );
}

export function ObservationProgress({ report }: { report: StrategyForwardReport | null }) {
  const minimumDays = report?.observationGate.minimumDays ?? strategyObservationDefaults.minimumDays;
  const minimumTrades = report?.observationGate.minimumCompletedTrades ?? strategyObservationDefaults.minimumCompletedTrades;
  const elapsedDays = Math.max(0, report?.elapsedDays ?? 0);
  const completedTrades = Math.max(0, report?.metrics.tradeCount ?? 0);
  const dayProgress = Math.min(100, elapsedDays / minimumDays * 100);
  const tradeProgress = Math.min(100, completedTrades / minimumTrades * 100);

  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-progress-title">
      <div className="xh-strategy-panel-header">
        <div>
          <h2 id="strategy-progress-title">观察进度</h2>
          <p>累计 60 天或 50 笔已完成交易，任一达到后进入人工复核。</p>
        </div>
        <time dateTime={report?.forwardStart ?? strategyObservationDefaults.forwardStartIso}>
          开始 {formatStrategyDateTime(report?.forwardStart ?? strategyObservationDefaults.forwardStartIso)}
        </time>
      </div>
      <div className="xh-strategy-progress-grid">
        <ProgressMetric
          label="累计天数"
          progress={dayProgress}
          value={report ? `${elapsedDays.toFixed(1)} / ${minimumDays} 天` : `— / ${minimumDays} 天`}
        />
        <ProgressMetric
          label="已完成交易"
          progress={tradeProgress}
          value={report ? `${completedTrades} / ${minimumTrades} 笔` : `— / ${minimumTrades} 笔`}
        />
      </div>
    </section>
  );
}

export function StrategyWorkerPanel({ report }: { report: StrategyForwardReport | null }) {
  const worker = report?.worker;
  const stale = Boolean(worker?.enabled && worker.lastCompletedCandleAt && Date.now() - Date.parse(worker.lastCompletedCandleAt) > 15 * 60 * 1000);
  const failed = Boolean(worker?.consecutiveFailures || worker?.lastError);
  const state = !worker
    ? { label: "等待 Worker 状态", tone: "is-unavailable" }
    : !worker.enabled
      ? { label: "自动 Paper 已暂停", tone: "is-paused" }
      : worker.running
        ? { label: "自动 Paper 检查中", tone: "is-running" }
        : failed
          ? { label: "自动 Paper 更新失败", tone: "is-error" }
          : stale
            ? { label: "数据推进延迟", tone: "is-stale" }
            : { label: "自动 Paper 运行中", tone: "is-healthy" };

  return (
    <section className="xh-strategy-panel xh-strategy-worker" aria-labelledby="strategy-worker-title">
      <div className="xh-strategy-panel-header">
        <div>
          <h2 id="strategy-worker-title">自动 Paper 状态</h2>
          <p>自动更新研究报告，不连接交易接口，不产生订单。</p>
        </div>
        <span className={`xh-strategy-worker-state ${state.tone}`} role="status" aria-live="polite">{state.label}</span>
      </div>
      <dl className="xh-strategy-detail-list">
        <Detail label="最后成功更新" value={formatStrategyDateTime(worker?.lastSuccessAt)} />
        <Detail label="数据推进至" value={formatStrategyDateTime(worker?.lastCompletedCandleAt)} />
        <Detail label="最近检查" value={formatStrategyDateTime(worker?.lastAttemptAt)} />
        <Detail label="下次检查" value={worker?.enabled ? formatStrategyDateTime(worker.nextCheckAt) : "—"} />
        <Detail label="连续失败" value={worker ? `${worker.consecutiveFailures} 次` : "—"} tone={failed ? "is-negative" : ""} />
        <Detail label="执行边界" value="Paper only · 自动订单关闭" />
      </dl>
      {worker?.lastError ? <p className="xh-strategy-worker-alert" role="alert">{worker.lastError}</p> : null}
      {stale && !failed ? <p className="xh-strategy-worker-alert is-stale" role="status">最新 5m 已收盘K线超过 15 分钟未推进。</p> : null}
    </section>
  );
}

function ProgressMetric({ label, progress, value }: { label: string; progress: number; value: string }) {
  return (
    <div className="xh-strategy-progress-item">
      <div><span>{label}</span><strong>{value}</strong></div>
      <div className="xh-strategy-progress-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
    </div>
  );
}

export function StrategyMetricsTable({ report }: { report: StrategyForwardReport | null }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-metrics-title">
      <div className="xh-strategy-panel-header">
        <div>
          <h2 id="strategy-metrics-title">前向结果</h2>
          <p>只统计已完成交易；未平仓仓位不计入指标。</p>
        </div>
      </div>
      <div className="xh-strategy-table-wrap" role="region" aria-label="前向结果表格，可横向滚动" tabIndex={0}>
        <table className="xh-strategy-table is-metrics">
          <thead><tr><th>区间</th><th>交易数</th><th>净收益</th><th>PF</th><th>平均R</th><th>最大回撤</th></tr></thead>
          <tbody>
            {report ? (
              <tr>
                <td>{formatStrategyPeriod(report.forwardStart ?? strategyObservationDefaults.forwardStartIso, report.through)}</td>
                <td>{report.metrics.tradeCount}</td>
                <td className={strategyNumberTone(report.metrics.netPnl)}>{formatStrategyMoney(report.metrics.netPnl)}</td>
                <td>{formatProfitFactor(report.metrics.profitFactor, report.metrics.tradeCount)}</td>
                <td className={strategyNumberTone(report.metrics.averageR)}>{formatAverageR(report.metrics.averageR)}</td>
                <td>{formatStrategyPercent(report.metrics.maxDrawdownFraction)}</td>
              </tr>
            ) : (
              <tr><td className="xh-strategy-table-empty" colSpan={6}>尚无前向报告</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function StrategyConfigPanel({ report }: { report: StrategyForwardReport | null }) {
  const assumptions = report?.assumptions;
  const items = [
    ["市场", assumptions ? formatVenue(assumptions.venue, assumptions.symbol) : strategyConfigDefaults.venue],
    ["周期", `${strategyConfigDefaults.directionTimeframe} 方向 · ${strategyConfigDefaults.entryTimeframe} 入场`],
    ["杠杆设置", `${assumptions?.leverageSelection ?? strategyConfigDefaults.leverage}x`],
    ["保证金模式", assumptions?.marginMode === "cross" || !assumptions ? strategyConfigDefaults.marginMode : assumptions.marginMode],
    ["单次初始保证金", formatStrategyPercent(assumptions?.marginFraction ?? strategyConfigDefaults.initialMarginFraction, 0)],
    ["实际名义敞口", `约 ${assumptions?.effectiveNotionalEquityMultiple ?? strategyConfigDefaults.effectiveNotionalEquityMultiple}x`],
    ["同时持仓", `最多 ${strategyConfigDefaults.maximumConcurrentPositions} 个 BTC 仓位`],
    ["历史资金费率", "忽略"],
    ["Mark Price / 动态档位 / 跳空", "暂时忽略"],
    ["订单执行", "Paper only · 自动订单关闭"],
  ];
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-config-title">
      <div className="xh-strategy-panel-header"><div><h2 id="strategy-config-title">当前配置</h2></div></div>
      <dl className="xh-strategy-config-grid">
        {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </section>
  );
}

export function StrategyRuntimePanels({ report }: { report: StrategyForwardReport | null }) {
  return (
    <div className="xh-strategy-runtime-grid">
      <section className="xh-strategy-panel" aria-labelledby="strategy-quality-title">
        <div className="xh-strategy-panel-header"><div><h2 id="strategy-quality-title">数据质量</h2></div></div>
        <dl className="xh-strategy-detail-list">
          <Detail label="来源" value={report ? formatSource(report.dataQuality.source) : "—"} />
          <Detail label="周期" value={report?.dataQuality.interval ?? "—"} />
          <Detail label="K线数量" value={report ? report.dataQuality.candleCount.toLocaleString("en-US") : "—"} />
          <Detail label="缺口" value={report ? `${report.dataQuality.missingBarCount} 根` : "—"} tone={report?.dataQuality.missingBarCount ? "is-negative" : ""} />
          <Detail label="更新时间" value={formatStrategyDateTime(report?.dataQuality.updatedAt)} />
          <Detail label="信号数" value={report ? String(report.diagnostics.signals) : "—"} />
        </dl>
      </section>
      <CurrentPaperPosition trade={report?.openPosition ?? null} reportAvailable={Boolean(report)} />
    </div>
  );
}

function CurrentPaperPosition({ reportAvailable, trade }: { reportAvailable: boolean; trade: StrategyForwardTrade | null }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-position-title">
      <div className="xh-strategy-panel-header"><div><h2 id="strategy-position-title">当前 Paper 仓位</h2></div></div>
      {!reportAvailable ? <div className="xh-strategy-empty">等待前向报告</div> : !trade ? <div className="xh-strategy-empty">当前无持仓</div> : (
        <dl className="xh-strategy-detail-list">
          <Detail label="方向" value={trade.side === "long" ? "做多" : trade.side === "short" ? "做空" : "—"} tone={trade.side === "long" ? "is-positive" : trade.side === "short" ? "is-negative" : ""} />
          <Detail label="数量" value={formatStrategyQuantity(trade.quantity)} />
          <Detail label="入场价格" value={formatStrategyPrice(trade.entryPrice)} />
          <Detail label="止损 / 目标" value={`${formatStrategyPrice(trade.stopPrice)} / ${formatStrategyPrice(trade.targetPrice)}`} />
          <Detail label="入场时间" value={formatStrategyDateTime(trade.entryTime)} />
        </dl>
      )}
    </section>
  );
}

function Detail({ label, tone = "", value }: { label: string; tone?: string; value: string }) {
  return <div><dt>{label}</dt><dd className={tone}>{value}</dd></div>;
}

export function RecentStrategyTrades({ onLocateTrade, report }: {
  report: StrategyForwardReport | null;
  onLocateTrade: (trade: StrategyForwardTrade) => void;
}) {
  const trades = report?.recentCompletedTrades ?? [];
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-trades-title">
      <div className="xh-strategy-panel-header">
        <div><h2 id="strategy-trades-title">最近已完成交易</h2><p>{report ? `共 ${report.metrics.tradeCount} 笔已完成交易` : "等待前向报告"}</p></div>
      </div>
      <div className="xh-strategy-table-wrap" role="region" aria-label="最近已完成交易表格，可横向滚动" tabIndex={0}>
        <table className="xh-strategy-table is-trades">
          <thead><tr><th>定位</th><th>退出时间</th><th>方向</th><th>入场</th><th>退出</th><th>净收益</th><th>R</th><th>结果</th></tr></thead>
          <tbody>
            {trades.length ? trades.map((trade) => (
              <tr key={`${trade.signalTime ?? "signal"}-${trade.entryTime ?? "entry"}-${trade.exitTime ?? "open"}`}>
                <td><LocateTradeButton trade={trade} onLocateTrade={onLocateTrade} /></td>
                <td>{formatStrategyDateTime(trade.exitTime)}</td>
                <td className={trade.side === "long" ? "is-positive" : trade.side === "short" ? "is-negative" : ""}>{trade.side === "long" ? "做多" : trade.side === "short" ? "做空" : "—"}</td>
                <td>{formatStrategyPrice(trade.entryPrice)}</td>
                <td>{formatStrategyPrice(trade.exitPrice)}</td>
                <td className={strategyNumberTone(trade.netPnl)}>{formatStrategyMoney(trade.netPnl)}</td>
                <td className={strategyNumberTone(trade.rMultiple)}>{formatAverageR(trade.rMultiple)}</td>
                <td>{formatExitReason(trade.exitReason)}</td>
              </tr>
            )) : <tr><td className="xh-strategy-table-empty" colSpan={8}>{report ? "当前已完成交易为 0" : "尚无交易报告"}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LocateTradeButton({ onLocateTrade, trade }: { onLocateTrade: (trade: StrategyForwardTrade) => void; trade: StrategyForwardTrade }) {
  return (
    <button
      type="button"
      className="xh-strategy-locate-trade"
      onClick={() => onLocateTrade(trade)}
      aria-label={`在K线上定位${formatStrategyDateTime(trade.entryTime)}的交易`}
    >
      定位
    </button>
  );
}

function formatSource(value: string) {
  return value === "binance_futures_public_rest" ? "Binance Futures Public REST" : value;
}

function formatVenue(venue: string, symbol: string) {
  return venue === "binance_usdm_btcusdt_perpetual" ? `Binance USD-M ${symbol} 永续` : venue;
}

function formatStrategyQuantity(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
