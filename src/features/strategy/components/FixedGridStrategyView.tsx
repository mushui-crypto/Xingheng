import { useEffect, useMemo, useState } from "react";
import { fetchFixedGridForwardReport } from "../../../api/strategy";
import { buildMartingaleMarkerEvents } from "../lib/martingaleChart";
import {
  formatAverageR,
  formatExitReason,
  formatProfitFactor,
  formatStrategyDateTime,
  formatStrategyMoney,
  formatStrategyPercent,
  formatStrategyPrice,
  strategyNumberTone,
} from "../lib/formatters";
import type {
  FixedGridCompletedGroup,
  FixedGridForwardReport,
  FixedGridOpenGroup,
  FixedGridOrder,
  FixedGridWorkingPlan,
} from "../model/fixedGridTypes";
import type { MartingaleGroup, MartingaleSymbol } from "../model/martingaleTypes";
import type { StrategyChartPriceLevel } from "./StrategyTradeChart";
import { StrategyTradeChart } from "./StrategyTradeChart";
import { StrategyErrorState, StrategyLoadingState } from "./StrategyPanels";

const refreshMs = 60_000;
const symbols: MartingaleSymbol[] = ["BTCUSDT", "ETHUSDT"];

export function FixedGridStrategyView() {
  const [report, setReport] = useState<FixedGridForwardReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState<MartingaleSymbol>("BTCUSDT");

  useEffect(() => {
    let controller: AbortController | null = null;
    let active = true;
    const load = (initial: boolean) => {
      controller?.abort();
      controller = new AbortController();
      if (initial) setLoading(true);
      void fetchFixedGridForwardReport(controller.signal)
        .then((next) => {
          if (!active) return;
          setReport(next);
          setError("");
        })
        .catch((reason) => {
          if (active && !controller?.signal.aborted) setError(reason instanceof Error ? reason.message : "固定价差网格 Paper 报告加载失败。");
        })
        .finally(() => { if (active && initial) setLoading(false); });
    };
    load(true);
    const timer = window.setInterval(() => { if (!document.hidden) load(false); }, refreshMs);
    const handleVisibility = () => { if (!document.hidden) load(false); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const available = report?.status === "unavailable" ? null : report;
  const plan = available?.workingPlans.find((item) => item.symbol === symbol) ?? null;
  const open = available?.openGroups.find((item) => item.symbol === symbol) ?? null;
  const completed = available?.recentCompletedGroups.filter((item) => item.symbol === symbol) ?? [];
  const chartGroups = useMemo(() => toChartGroups(open, completed), [open, completed]);
  const priceLevels = useMemo(() => buildPriceLevels(plan, open, available, symbol), [plan, open, available, symbol]);
  const fallbackTime = open?.entryTime ?? plan?.confirmedAt ?? completed.at(-1)?.entryTime ?? available?.dataQuality.symbols[symbol].through ?? null;

  return (
    <div className="xh-strategy-fixed-grid">
      <section className="xh-strategy-panel xh-strategy-martingale-summary" aria-labelledby="fixed-grid-summary-title">
        <div className="xh-strategy-panel-header">
          <div><h2 id="fixed-grid-summary-title">固定价差趋势网格 V3 · 自动 Paper</h2><p>4h 结构定方向，1h 收盘突破确认；BTC 每层 200 点，ETH 每层 10 点。这里的挂单均为本地 Paper 计划，不是 Binance 订单。</p></div>
          <span className={`xh-strategy-worker-state ${available ? "is-healthy" : "is-unavailable"}`} role="status">{loading ? "报告加载中" : available ? "Paper 运行中" : "等待报告"}</span>
        </div>
      </section>

      <div className="xh-strategy-symbol-switch" role="group" aria-label="固定价差网格品种">
        {symbols.map((item) => <button key={item} type="button" aria-pressed={symbol === item} className={symbol === item ? "is-active" : ""} onClick={() => setSymbol(item)}>{item === "BTCUSDT" ? "BTC / USDT" : "ETH / USDT"}</button>)}
      </div>

      <StrategyTradeChart
        mode="martingale"
        contextState={loading ? "loading" : error || !available ? "unavailable" : "ready"}
        symbol={symbol}
        candleSource="martingale"
        markerDataCount={chartGroups.length}
        markerDataSignature={JSON.stringify(chartGroups)}
        buildMarkerEvents={(interval) => buildMartingaleMarkerEvents(chartGroups, interval)}
        fallbackTime={fallbackTime}
        focusRequest={null}
        priceLevels={priceLevels}
        description={`Binance USD-M · ${symbol} · 固定价差 12 层 Paper / 自动真实订单关闭`}
      />

      {loading ? <StrategyLoadingState /> : error ? <StrategyErrorState message={error} /> : !available ? (
        <section className="xh-strategy-state" role="status"><strong>等待固定价差网格报告</strong><p>{report?.warnings.includes("no_report") ? "Worker 首次生成报告后，这里会显示方向、挂单和成交。" : "报告暂时不可用，旧策略与真实交易不受影响。"}</p></section>
      ) : (
        <>
          <DirectionPanel report={available} symbol={symbol} plan={plan} open={open} />
          <OrderLadder plan={plan} open={open} symbol={symbol} />
          <RuntimePanel report={available} symbol={symbol} />
          <CompletedPanel groups={completed} />
          <ConfigPanel report={available} symbol={symbol} />
        </>
      )}
    </div>
  );
}

function DirectionPanel({ report, symbol, plan, open }: { report: FixedGridForwardReport; symbol: MartingaleSymbol; plan: FixedGridWorkingPlan | null; open: FixedGridOpenGroup | null }) {
  const direction = report.directions[symbol];
  const status = open ? "已有成交，网格组持仓中" : plan ? "Paper 限价单等待成交" : direction.status === "daily_locked" ? "当日亏损锁定" : "等待 4h / 1h 同向确认";
  return (
    <section className="xh-strategy-panel" aria-labelledby="fixed-grid-direction-title">
      <div className="xh-strategy-panel-header"><div><h2 id="fixed-grid-direction-title">方向判断与执行状态</h2><p>仅使用已收盘 K 线确认结构；中性状态不建立多空网格。</p></div><span className="xh-strategy-backtest-label">{status}</span></div>
      <dl className="xh-strategy-detail-list">
        <Detail label="4h 结构" value={biasLabel(direction.fourHourBias)} tone={sideTone(direction.fourHourBias)} />
        <Detail label="1h 确认" value={confirmationLabel(direction.oneHourConfirmation)} />
        <Detail label="执行方向" value={sideLabel(open?.side ?? plan?.side ?? null)} tone={sideTone(open?.side ?? plan?.side ?? null)} />
        <Detail label="确认锚点" value={formatStrategyPrice(open?.anchorPrice ?? plan?.anchorPrice ?? direction.anchorPrice)} />
        <Detail label="确认时间" value={formatStrategyDateTime(open?.confirmedAt ?? plan?.confirmedAt ?? direction.confirmedAt)} />
        <Detail label="计划失效" value={formatStrategyDateTime(plan?.expiresAt ?? direction.expiresAt)} />
      </dl>
    </section>
  );
}

function OrderLadder({ plan, open, symbol }: { plan: FixedGridWorkingPlan | null; open: FixedGridOpenGroup | null; symbol: MartingaleSymbol }) {
  const orders = open?.orders ?? plan?.orders ?? [];
  return (
    <section className="xh-strategy-panel" aria-labelledby="fixed-grid-orders-title">
      <div className="xh-strategy-panel-header"><div><h2 id="fixed-grid-orders-title">12 层 Paper 挂单与成交</h2><p>{orders.length ? `当前 ${orders.filter((order) => order.status === "working").length} 层待成交，${orders.filter((order) => order.status === "filled").length} 层已成交。` : "方向确认后才生成挂单；当前不会预挂双向网格。"}</p></div><span className="xh-strategy-backtest-label">本地模拟 · 非交易所委托</span></div>
      {open ? <dl className="xh-strategy-detail-list xh-fixed-grid-position-summary"><Detail label="平均成本" value={formatStrategyPrice(open.averageEntryPrice)} /><Detail label="标记价" value={formatStrategyPrice(open.markPrice)} /><Detail label="止盈" value={formatStrategyPrice(open.targetPrice)} tone="is-positive" /><Detail label="结构止损" value={formatStrategyPrice(open.stopPrice)} tone="is-negative" /><Detail label="计划风险" value={`${formatPlain(open.plannedRisk)} USDT`} /><Detail label="浮动盈亏" value={formatStrategyMoney(open.unrealizedPnl)} tone={strategyNumberTone(open.unrealizedPnl)} /></dl> : null}
      <div className="xh-strategy-table-wrap" role="region" aria-label={`${symbol}固定价差Paper挂单，可横向滚动`} tabIndex={0}>
        <table className="xh-strategy-table is-fixed-grid-orders">
          <thead><tr><th>层级</th><th>状态</th><th>挂单价</th><th>保证金占权益</th><th>名义价值</th><th>数量</th><th>成交时间</th></tr></thead>
          <tbody>{orders.length ? orders.map((order) => <OrderRow key={order.level} order={order} />) : <tr><td className="xh-strategy-table-empty" colSpan={7}>当前没有 Paper 挂单，等待高周期方向确认</td></tr>}</tbody>
        </table>
      </div>
    </section>
  );
}

function OrderRow({ order }: { order: FixedGridOrder }) {
  return <tr><td>第 {order.level} 层</td><td><span className={`xh-fixed-grid-order-status is-${order.status}`}>{orderStatusLabel(order.status)}</span></td><td>{formatStrategyPrice(order.price)}</td><td>{formatStrategyPercent(order.marginFraction, 3)}</td><td>{formatPlain(order.notional)} USDT</td><td>{formatQuantity(order.quantity)}</td><td>{formatStrategyDateTime(order.filledAt)}</td></tr>;
}

function RuntimePanel({ report, symbol }: { report: FixedGridForwardReport; symbol: MartingaleSymbol }) {
  const worker = report.worker;
  const metric = report.diagnostics.bySymbol[symbol];
  return (
    <div className="xh-strategy-runtime-grid">
      <section className="xh-strategy-panel" aria-labelledby="fixed-grid-runtime-title">
        <div className="xh-strategy-panel-header"><div><h2 id="fixed-grid-runtime-title">自动 Paper 状态</h2><p>每 5 分钟检查已收盘公开 K 线，不连接 Binance 交易接口。</p></div><span className={`xh-strategy-worker-state ${worker?.enabled && !worker.lastError ? "is-healthy" : worker?.lastError ? "is-error" : "is-unavailable"}`}>{worker?.running ? "检查中" : worker?.enabled ? "自动运行中" : "等待 Worker"}</span></div>
        <dl className="xh-strategy-detail-list"><Detail label="最后成功" value={formatStrategyDateTime(worker?.lastSuccessAt)} /><Detail label={`${symbol} 推进至`} value={formatStrategyDateTime(worker?.lastCompletedCandleAt[symbol])} /><Detail label="数据来源" value={dataSourceLabel(report.dataQuality.source)} /><Detail label="K线 / 缺口" value={`${report.dataQuality.symbols[symbol].candleCount.toLocaleString("en-US")} / ${report.dataQuality.symbols[symbol].missingBarCount} 根`} tone={report.dataQuality.symbols[symbol].missingBarCount ? "is-negative" : ""} /><Detail label="下次检查" value={formatStrategyDateTime(worker?.nextCheckAt)} /><Detail label="连续失败" value={worker ? `${worker.consecutiveFailures} 次` : "—"} tone={worker?.consecutiveFailures ? "is-negative" : ""} /><Detail label="确认数" value={metric.confirmations.toString()} /><Detail label="完成组" value={metric.completedGroups.toString()} /></dl>
      </section>
      <section className="xh-strategy-panel" aria-labelledby="fixed-grid-metrics-title">
        <div className="xh-strategy-panel-header"><div><h2 id="fixed-grid-metrics-title">组合观察指标</h2></div></div>
        <dl className="xh-strategy-detail-list"><Detail label="PF" value={formatProfitFactor(report.metrics.profitFactor, report.metrics.completedGroups)} /><Detail label="平均R" value={formatAverageR(report.metrics.averageR)} tone={strategyNumberTone(report.metrics.averageR)} /><Detail label="已实现净盈亏" value={formatStrategyMoney(report.metrics.realizedNetPnl)} tone={strategyNumberTone(report.metrics.realizedNetPnl)} /><Detail label="未实现盈亏" value={formatStrategyMoney(report.metrics.unrealizedPnl)} tone={strategyNumberTone(report.metrics.unrealizedPnl)} /><Detail label="最大标记回撤" value={formatStrategyPercent(report.metrics.maxMarkToMarketDrawdownFraction)} /><Detail label="累计费用" value={`${formatPlain(report.metrics.fees)} USDT`} /></dl>
      </section>
    </div>
  );
}

function CompletedPanel({ groups }: { groups: FixedGridCompletedGroup[] }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="fixed-grid-completed-title">
      <div className="xh-strategy-panel-header"><div><h2 id="fixed-grid-completed-title">最近完成组</h2><p>成交点与平仓点同步显示在上方 K 线上。</p></div><span className="xh-strategy-backtest-label">Paper 记录</span></div>
      <div className="xh-strategy-table-wrap" role="region" aria-label="固定价差最近完成组，可横向滚动" tabIndex={0}>
        <table className="xh-strategy-table is-fixed-grid-completed"><thead><tr><th>方向</th><th>入场</th><th>退出</th><th>成交层数</th><th>均价</th><th>退出价</th><th>净盈亏</th><th>R</th><th>原因</th></tr></thead><tbody>{groups.length ? groups.slice().reverse().map((group) => <tr key={group.id}><td className={sideTone(group.side)}>{sideLabel(group.side)}</td><td>{formatStrategyDateTime(group.entryTime)}</td><td>{formatStrategyDateTime(group.exitTime)}</td><td>{group.fills.length}</td><td>{formatStrategyPrice(group.averageEntryPrice)}</td><td>{formatStrategyPrice(group.exitPrice)}</td><td className={strategyNumberTone(group.netPnl)}>{formatStrategyMoney(group.netPnl)}</td><td>{formatAverageR(group.rMultiple)}</td><td>{formatExitReason(group.exitReason)}</td></tr>) : <tr><td className="xh-strategy-table-empty" colSpan={9}>当前标的尚无完成组</td></tr>}</tbody></table>
      </div>
    </section>
  );
}

function ConfigPanel({ report, symbol }: { report: FixedGridForwardReport; symbol: MartingaleSymbol }) {
  const config = report.configuration;
  return (
    <section className="xh-strategy-panel" aria-labelledby="fixed-grid-config-title">
      <div className="xh-strategy-panel-header"><div><h2 id="fixed-grid-config-title">冻结参数与边界</h2></div></div>
      <dl className="xh-strategy-config-grid"><Detail label="方向" value="4h HH/HL 或 LH/LL · 1h 突破确认" /><Detail label="固定价差" value={`${symbol === "BTCUSDT" ? "200" : "10"} USDT / 层`} /><Detail label="层数 / 倍率" value={`${config.maximumLayers} 层 · ${config.sizeMultiplier.toFixed(2)}x`} /><Detail label="杠杆 / 模式" value={`${config.leverageSelection}x · 隔离风险模型`} /><Detail label="累计保证金上限" value={formatStrategyPercent(config.cumulativeMarginFractionCap)} /><Detail label="单组计划风险上限" value={formatStrategyPercent(config.maximumGroupLossFraction)} /><Detail label="止盈" value={`${config.targetGridSteps} 个网格距离（按成交均价）`} /><Detail label="结构止损" value={`第 12 层外 ${config.stopBeyondLastGridSteps} 个网格`} /><Detail label="方向有效期" value={`${config.directionValidityHours} 小时`} /><Detail label="最长持有" value={`${Math.round(config.maximumHoldingMinutes / 60)} 小时`} /><Detail label="费用 / 滑点" value={`${formatStrategyPercent(config.takerFeeRate, 3)} / ${formatStrategyPercent(config.slippageRate, 2)}`} /><Detail label="执行边界" value="Paper only · 无 API key · 无真实订单" /></dl>
    </section>
  );
}

function buildPriceLevels(plan: FixedGridWorkingPlan | null, open: FixedGridOpenGroup | null, report: FixedGridForwardReport | null, symbol: MartingaleSymbol): StrategyChartPriceLevel[] {
  const source = open ?? plan;
  if (!source || !report) return [];
  const working = source.orders.filter((order) => order.status === "working");
  const levels: StrategyChartPriceLevel[] = working.map((order, index) => ({
    id: `order-${order.level}`,
    label: index === 0 ? `待成交 L${order.level}` : `L${order.level}`,
    price: order.price,
    color: source.side === "long" ? "#4f8f81" : "#a45a69",
    style: "dashed",
    axisLabelVisible: index === 0 || order.level === report.configuration.maximumLayers,
  }));
  if (open) {
    levels.push({ id: "average", label: "持仓均价", price: open.averageEntryPrice, color: "#b4bdc8", style: "solid" });
    levels.push({ id: "target", label: "Paper 止盈", price: open.targetPrice, color: "#52d8ad", style: "solid" });
    levels.push({ id: "stop", label: "结构止损", price: open.stopPrice, color: "#ff667f", style: "solid" });
  } else {
    const step = report.configuration.gridStepBySymbol[symbol];
    const stop = source.side === "long"
      ? source.anchorPrice - step * (report.configuration.maximumLayers + report.configuration.stopBeyondLastGridSteps)
      : source.anchorPrice + step * (report.configuration.maximumLayers + report.configuration.stopBeyondLastGridSteps);
    levels.push({ id: "anchor", label: "确认锚点", price: source.anchorPrice, color: "#8f99a5", style: "solid" });
    levels.push({ id: "stop", label: "计划结构止损", price: stop, color: "#ff667f", style: "solid" });
  }
  return levels;
}

function toChartGroups(open: FixedGridOpenGroup | null, completed: FixedGridCompletedGroup[]): MartingaleGroup[] {
  const openGroup: MartingaleGroup[] = open ? [{ ...open, signalTime: open.confirmedAt, nextGridPrice: open.orders.find((order) => order.status === "working")?.price ?? null }] : [];
  const completedGroups: MartingaleGroup[] = completed.map((group) => ({ ...group, signalTime: group.confirmedAt }));
  return [...openGroup, ...completedGroups];
}

function Detail({ label, tone = "", value }: { label: string; tone?: string; value: string }) { return <div><dt>{label}</dt><dd className={tone}>{value}</dd></div>; }
function biasLabel(value: "long" | "short" | "neutral") { return value === "long" ? "多头结构 HH + HL" : value === "short" ? "空头结构 LH + LL" : "中性 / 结构未完成"; }
function confirmationLabel(value: "long_break" | "short_break" | "none") { return value === "long_break" ? "已向上突破" : value === "short_break" ? "已向下突破" : "尚未确认"; }
function sideLabel(value: "long" | "short" | null) { return value === "long" ? "做多" : value === "short" ? "做空" : "不挂单"; }
function sideTone(value: "long" | "short" | "neutral" | null) { return value === "long" ? "is-positive" : value === "short" ? "is-negative" : ""; }
function orderStatusLabel(value: FixedGridOrder["status"]) { return value === "working" ? "待成交" : value === "filled" ? "已成交" : "已撤销"; }
function dataSourceLabel(value: FixedGridForwardReport["dataQuality"]["source"]) { return value === "binance_futures_public_rest" ? "Binance Futures Public REST" : "Binance Vision USD-M 日归档（延迟）"; }
function formatPlain(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"; }
function formatQuantity(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"; }
