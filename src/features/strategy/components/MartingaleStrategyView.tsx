import { useEffect, useMemo, useReducer, useState } from "react";
import { fetchMartingaleForwardReport } from "../../../api/strategy";
import {
  buildMartingaleMarkerEvents,
  martingaleExitMarkerId,
  martingaleFillMarkerId,
} from "../lib/martingaleChart";
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
  MartingaleCompletedGroup,
  MartingaleFill,
  MartingaleForwardReport,
  MartingaleGroup,
  MartingaleOpenGroup,
  MartingaleSymbol,
} from "../model/martingaleTypes";
import {
  initialMartingaleRequestState,
  martingaleRequestReducer,
} from "../model/martingaleRequestState";
import type { StrategyChartFocusRequest } from "./StrategyTradeChart";
import { StrategyTradeChart } from "./StrategyTradeChart";
import { StrategyErrorState, StrategyLoadingState } from "./StrategyPanels";
import { FixedGridStrategyView } from "./FixedGridStrategyView";

const martingaleRefreshMs = 60_000;
const symbols: MartingaleSymbol[] = ["BTCUSDT", "ETHUSDT"];

export function MartingaleStrategyView() {
  const [variant, setVariant] = useState<"fixed-grid" | "classic">("fixed-grid");
  return (
    <div className="xh-strategy-martingale-view" role="tabpanel" aria-label="马丁网格 Paper">
      <div className="xh-strategy-variant-switch" role="tablist" aria-label="马丁网格策略版本">
        <button type="button" role="tab" aria-selected={variant === "fixed-grid"} className={variant === "fixed-grid" ? "is-active" : ""} onClick={() => setVariant("fixed-grid")}>固定价差 12 层 V3</button>
        <button type="button" role="tab" aria-selected={variant === "classic"} className={variant === "classic" ? "is-active" : ""} onClick={() => setVariant("classic")}>经典指标网格 V1</button>
      </div>
      {variant === "fixed-grid" ? <FixedGridStrategyView /> : <ClassicMartingaleStrategyView />}
    </div>
  );
}

function ClassicMartingaleStrategyView() {
  const [request, dispatch] = useReducer(martingaleRequestReducer, initialMartingaleRequestState);
  const [symbol, setSymbol] = useState<MartingaleSymbol>("BTCUSDT");
  const [focusRequest, setFocusRequest] = useState<StrategyChartFocusRequest>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let active = true;
    const load = () => {
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      dispatch({ type: "start" });
      void fetchMartingaleForwardReport(nextController.signal)
        .then((report) => {
          if (active) dispatch({ type: "success", report });
        })
        .catch((reason) => {
          if (active && !nextController.signal.aborted) {
            dispatch({
              type: "failure",
              message: reason instanceof Error ? reason.message : "马丁网格 Paper 报告加载失败。",
            });
          }
        });
    };
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, martingaleRefreshMs);
    const handleVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const report = request.report?.status === "unavailable" ? null : request.report;
  const groups = useMemo(() => report ? [
    ...report.openGroups.filter((group) => group.symbol === symbol),
    ...report.recentCompletedGroups.filter((group) => group.symbol === symbol),
  ] : [], [report, symbol]);
  const openGroup = report?.openGroups.find((group) => group.symbol === symbol) ?? null;
  const completedGroups = report?.recentCompletedGroups.filter((group) => group.symbol === symbol) ?? [];
  const markerSignature = useMemo(() => JSON.stringify(groups), [groups]);
  const fallbackTime = openGroup?.entryTime
    ?? completedGroups.at(-1)?.entryTime
    ?? report?.dataQuality.symbols[symbol].through
    ?? report?.through
    ?? null;

  const locate = (centerTime: string | null, markerId: string | null) => {
    if (!centerTime) return;
    setFocusRequest((current) => ({ centerTime, markerId, revision: (current?.revision ?? 0) + 1 }));
  };
  const handleSymbolChange = (nextSymbol: MartingaleSymbol) => {
    setSymbol(nextSymbol);
    setFocusRequest(null);
  };
  const unavailableMessage = request.report?.warnings.includes("no_report")
    ? "等待马丁网格 Paper 报告。"
    : "马丁网格 Paper 报告暂不可用。";

  return (
    <div className="xh-strategy-martingale-classic">
      <MartingaleRouteSummary report={report} loading={request.loading} />
      <SymbolSwitch active={symbol} onChange={handleSymbolChange} />
      <StrategyTradeChart
        mode="martingale"
        contextState={request.loading ? "loading" : request.error || !report ? "unavailable" : "ready"}
        symbol={symbol}
        candleSource="martingale"
        markerDataCount={groups.length}
        markerDataSignature={markerSignature}
        buildMarkerEvents={(interval) => buildMartingaleMarkerEvents(groups, interval)}
        fallbackTime={fallbackTime}
        focusRequest={focusRequest}
        description={`Binance USD-M · ${symbol} · 马丁网格 Paper / 自动真实订单关闭`}
      />
      {request.loading ? <StrategyLoadingState /> : request.error ? <StrategyErrorState message={request.error} /> : !report ? (
        <section className="xh-strategy-state" role="status"><strong>等待策略报告</strong><p>{unavailableMessage}</p></section>
      ) : (
        <>
          <MartingaleObservation report={report} />
          <MartingaleSymbolMetrics report={report} symbol={symbol} />
          <MartingaleWorkerPanel report={report} symbol={symbol} />
          <MartingaleOpenGroupPanel group={openGroup} maximumLayers={report.configuration.maximumLayers} onLocate={locate} />
          <MartingaleCompletedGroups groups={completedGroups} onLocate={locate} />
          <MartingaleConfigPanel report={report} />
        </>
      )}
    </div>
  );
}

export function MartingalePageHeader() {
  return (
    <header className="xh-strategy-header">
      <div><h1>策略交易</h1><p>Binance USD-M BTC/ETH · 5x 隔离风险模型</p></div>
      <div className="xh-strategy-statuses" aria-label="马丁网格策略执行状态">
        <span className="is-observing">Paper only</span>
        <span className="is-review">V1 资格未通过 · V3 待验证</span>
        <span className="is-disabled">自动真实订单关闭</span>
      </div>
    </header>
  );
}

function MartingaleRouteSummary({ loading, report }: { loading: boolean; report: MartingaleForwardReport | null }) {
  const review = report?.observationGate.reached ?? false;
  return (
    <section className="xh-strategy-panel xh-strategy-martingale-summary" aria-labelledby="martingale-summary-title">
      <div className="xh-strategy-panel-header">
        <div><h2 id="martingale-summary-title">马丁网格 Paper</h2><p>历史资格未通过，当前仅保留自动 Paper 实验记录，不作为历史合格候选。</p></div>
        <span className={`xh-strategy-worker-state ${loading || !report ? "is-unavailable" : review ? "is-stale" : "is-healthy"}`} role="status">
          {loading ? "报告加载中" : !report ? "等待报告" : review ? "等待人工复核" : "Paper 收集中"}
        </span>
      </div>
    </section>
  );
}

function SymbolSwitch({ active, onChange }: { active: MartingaleSymbol; onChange: (symbol: MartingaleSymbol) => void }) {
  return (
    <div className="xh-strategy-symbol-switch" role="group" aria-label="马丁网格品种">
      {symbols.map((symbol) => (
        <button key={symbol} type="button" aria-pressed={active === symbol} className={active === symbol ? "is-active" : ""} onClick={() => onChange(symbol)}>
          {symbol === "BTCUSDT" ? "BTC / USDT" : "ETH / USDT"}
        </button>
      ))}
    </div>
  );
}

function MartingaleObservation({ report }: { report: MartingaleForwardReport }) {
  const days = Math.max(0, report.elapsedDays);
  const groups = Math.max(0, report.metrics.completedGroups);
  const dayTarget = report.observationGate.minimumDays;
  const groupTarget = report.observationGate.minimumCompletedGroups;
  return (
    <section className="xh-strategy-panel" aria-labelledby="martingale-observation-title">
      <div className="xh-strategy-panel-header">
        <div><h2 id="martingale-observation-title">观察门槛</h2><p>累计 {dayTarget} 天或 {groupTarget} 个完成组，任一达到后人工复核。</p></div>
        <time dateTime={report.forwardStart ?? undefined}>开始 {formatStrategyDateTime(report.forwardStart)}</time>
      </div>
      <div className="xh-strategy-progress-grid">
        <Progress label="累计天数" value={`${days.toFixed(1)} / ${dayTarget} 天`} percent={days / dayTarget * 100} />
        <Progress label="完成网格组" value={`${groups} / ${groupTarget} 组`} percent={groups / groupTarget * 100} />
      </div>
    </section>
  );
}

function Progress({ label, percent, value }: { label: string; percent: number; value: string }) {
  return <div className="xh-strategy-progress-item"><div><span>{label}</span><strong>{value}</strong></div><div className="xh-strategy-progress-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div></div>;
}

function MartingaleSymbolMetrics({ report, symbol }: { report: MartingaleForwardReport; symbol: MartingaleSymbol }) {
  const metrics = report.diagnostics.bySymbol[symbol];
  return (
    <section className="xh-strategy-panel" aria-labelledby="martingale-metrics-title">
      <div className="xh-strategy-panel-header"><div><h2 id="martingale-metrics-title">{symbol} 观察结果</h2><p>标的指标随当前 BTC / ETH 选择切换；组合PF与回撤单独列示。</p></div></div>
      <div className="xh-strategy-table-wrap" role="region" aria-label={`${symbol}马丁网格指标，可横向滚动`} tabIndex={0}>
        <table className="xh-strategy-table is-martingale-metrics">
          <thead><tr><th>标的</th><th>信号</th><th>完成组</th><th>成交层数</th><th>已实现净盈亏</th><th>当前组</th></tr></thead>
          <tbody><tr><td>{symbol}</td><td>{metrics.signals}</td><td>{metrics.completedGroups}</td><td>{metrics.totalFills}</td><td className={strategyNumberTone(metrics.realizedNetPnl)}>{formatStrategyMoney(metrics.realizedNetPnl)}</td><td>{metrics.openGroup ? "持有中" : "无"}</td></tr></tbody>
        </table>
      </div>
      <dl className="xh-strategy-detail-list xh-strategy-martingale-combined">
        <Detail label="组合PF" value={formatProfitFactor(report.metrics.profitFactor, report.metrics.completedGroups)} />
        <Detail label="组合平均R" value={formatAverageR(report.metrics.averageR)} tone={strategyNumberTone(report.metrics.averageR)} />
        <Detail label="标记最大回撤" value={formatStrategyPercent(report.metrics.maxMarkToMarketDrawdownFraction)} />
        <Detail label="组合未实现盈亏" value={formatStrategyMoney(report.metrics.unrealizedPnl)} tone={strategyNumberTone(report.metrics.unrealizedPnl)} />
        <Detail label="当前权益" value={`${formatPlainMoney(report.metrics.currentEquity)} USDT`} />
        <Detail label="累计费用" value={formatPlainMoney(report.metrics.fees)} />
      </dl>
    </section>
  );
}

function MartingaleWorkerPanel({ report, symbol }: { report: MartingaleForwardReport; symbol: MartingaleSymbol }) {
  const worker = report.worker;
  const completedAt = worker?.lastCompletedCandleAt[symbol] ?? null;
  const stale = Boolean(worker?.enabled && completedAt && Date.now() - Date.parse(completedAt) > 20 * 60 * 1000);
  const failed = Boolean(worker?.consecutiveFailures || worker?.lastError);
  const state = !worker ? ["等待 Worker 状态", "is-unavailable"] : !worker.enabled ? ["自动 Paper 已暂停", "is-paused"] : worker.running ? ["自动 Paper 检查中", "is-running"] : failed ? ["自动 Paper 更新失败", "is-error"] : stale ? ["数据推进延迟", "is-stale"] : ["自动 Paper 运行中", "is-healthy"];
  const quality = report.dataQuality.symbols[symbol];
  return (
    <div className="xh-strategy-runtime-grid">
      <section className="xh-strategy-panel" aria-labelledby="martingale-worker-title">
        <div className="xh-strategy-panel-header"><div><h2 id="martingale-worker-title">自动 Paper 状态</h2><p>自动更新本地报告，不连接交易接口。</p></div><span className={`xh-strategy-worker-state ${state[1]}`} role="status">{state[0]}</span></div>
        <dl className="xh-strategy-detail-list">
          <Detail label="最后成功" value={formatStrategyDateTime(worker?.lastSuccessAt)} />
          <Detail label={`${symbol}推进至`} value={formatStrategyDateTime(completedAt)} />
          <Detail label="最近检查" value={formatStrategyDateTime(worker?.lastAttemptAt)} />
          <Detail label="下次检查" value={formatStrategyDateTime(worker?.nextCheckAt)} />
          <Detail label="连续失败" value={worker ? `${worker.consecutiveFailures} 次` : "—"} tone={failed ? "is-negative" : ""} />
          <Detail label="执行边界" value="Paper only · 自动真实订单关闭" />
        </dl>
        {worker?.lastError ? <p className="xh-strategy-worker-alert" role="alert">{workerErrorLabel(worker.lastError)}</p> : null}
        {stale && !failed ? <p className="xh-strategy-worker-alert is-stale" role="status">当前标的已收盘5m K线超过20分钟未推进。</p> : null}
      </section>
      <section className="xh-strategy-panel" aria-labelledby="martingale-quality-title">
        <div className="xh-strategy-panel-header"><div><h2 id="martingale-quality-title">{symbol} 数据质量</h2></div></div>
        <dl className="xh-strategy-detail-list">
          <Detail label="来源" value="Binance Futures Public REST" />
          <Detail label="周期" value={report.dataQuality.interval} />
          <Detail label="K线数量" value={quality.candleCount.toLocaleString("en-US")} />
          <Detail label="缺口" value={`${quality.missingBarCount} 根`} tone={quality.missingBarCount ? "is-negative" : ""} />
          <Detail label="数据截至" value={formatStrategyDateTime(quality.through)} />
          <Detail label="报告更新" value={formatStrategyDateTime(report.dataQuality.updatedAt)} />
        </dl>
      </section>
    </div>
  );
}

function MartingaleOpenGroupPanel({ group, maximumLayers, onLocate }: { group: MartingaleOpenGroup | null; maximumLayers: number; onLocate: (time: string | null, markerId: string | null) => void }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="martingale-open-title">
      <div className="xh-strategy-panel-header"><div><h2 id="martingale-open-title">当前网格组</h2><p>当前组只显示已实际发生的开仓与加仓层级，不预造平仓。</p></div></div>
      {!group ? <div className="xh-strategy-empty">等待符合条件的趋势回撤信号</div> : (
        <>
          <dl className="xh-strategy-config-grid">
            <Detail label="方向" value={sideLabel(group.side)} tone={sideTone(group.side)} />
            <Detail label="层数" value={`${group.fills.length} / ${maximumLayers}`} />
            <Detail label="平均成本" value={formatStrategyPrice(group.averageEntryPrice)} />
            <Detail label="标记价" value={formatStrategyPrice(group.markPrice)} />
            <Detail label="下一层" value={formatStrategyPrice(group.nextGridPrice)} />
            <Detail label="止盈" value={formatStrategyPrice(group.targetPrice)} />
            <Detail label="止损" value={formatStrategyPrice(group.stopPrice)} />
            <Detail label="浮动盈亏" value={formatStrategyMoney(group.unrealizedPnl)} tone={strategyNumberTone(group.unrealizedPnl)} />
            <Detail label="计划风险" value={formatPlainMoney(group.plannedRisk)} />
          </dl>
          <FillList group={group} onLocate={onLocate} />
        </>
      )}
    </section>
  );
}

function MartingaleCompletedGroups({ groups, onLocate }: { groups: MartingaleCompletedGroup[]; onLocate: (time: string | null, markerId: string | null) => void }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="martingale-completed-title">
      <div className="xh-strategy-panel-header"><div><h2 id="martingale-completed-title">最近完成组</h2><p>{groups.length ? `当前标的最近 ${groups.length} 个完成组` : "等待符合条件的趋势回撤信号"}</p></div><span className="xh-strategy-backtest-label">Paper 记录 · 非真实成交</span></div>
      {!groups.length ? <div className="xh-strategy-empty">当前标的尚无完成组</div> : (
        <div className="xh-strategy-martingale-groups">
          {groups.slice().reverse().map((group) => (
            <article key={group.id ?? `${group.symbol}-${group.entryTime}`} className="xh-strategy-martingale-group">
              <div className="xh-strategy-martingale-group-row">
                <div><span>方向</span><strong className={sideTone(group.side)}>{sideLabel(group.side)}</strong></div>
                <div><span>层数</span><strong>{group.fills.length}</strong></div>
                <div><span>平均成本</span><strong>{formatStrategyPrice(group.averageEntryPrice)}</strong></div>
                <div><span>退出价</span><strong>{formatStrategyPrice(group.exitPrice)}</strong></div>
                <div><span>净盈亏</span><strong className={strategyNumberTone(group.netPnl)}>{formatStrategyMoney(group.netPnl)}</strong></div>
                <div><span>退出原因</span><strong>{formatExitReason(group.exitReason)}</strong></div>
                <div className="xh-strategy-martingale-actions">
                  <LocateButton label="定位开仓" disabled={!group.fills[0]?.time} onClick={() => onLocate(group.fills[0]?.time ?? group.entryTime, group.fills[0] ? martingaleFillMarkerId(group, group.fills[0], 0) : null)} />
                  <LocateButton label="定位平仓" disabled={!group.exitTime} onClick={() => onLocate(group.exitTime, martingaleExitMarkerId(group))} />
                </div>
              </div>
              <FillList group={group} onLocate={onLocate} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FillList({ group, onLocate }: { group: MartingaleGroup; onLocate: (time: string | null, markerId: string | null) => void }) {
  return (
    <details className="xh-strategy-martingale-fills">
      <summary>查看 {group.fills.length} 层成交</summary>
      <div className="xh-strategy-table-wrap" role="region" aria-label={`${group.symbol ?? "当前标的"}分层成交记录，可横向滚动`} tabIndex={0}>
        <table className="xh-strategy-table is-martingale-fills">
          <thead><tr><th>定位</th><th>层级</th><th>时间</th><th>成交价</th><th>数量</th><th>名义价值</th><th>费用</th></tr></thead>
          <tbody>{group.fills.map((fill, index) => <FillRow key={`${fill.level ?? index}-${fill.time ?? "time"}`} fill={fill} group={group} index={index} onLocate={onLocate} />)}</tbody>
        </table>
      </div>
    </details>
  );
}

function FillRow({ fill, group, index, onLocate }: { fill: MartingaleFill; group: MartingaleGroup; index: number; onLocate: (time: string | null, markerId: string | null) => void }) {
  return <tr><td><LocateButton label="定位" disabled={!fill.time} onClick={() => onLocate(fill.time, martingaleFillMarkerId(group, fill, index))} /></td><td>第 {fill.level ?? index + 1} 层</td><td>{formatStrategyDateTime(fill.time)}</td><td>{formatStrategyPrice(fill.price)}</td><td>{formatQuantity(fill.quantity)}</td><td>{formatPlainMoney(fill.notional)}</td><td>{formatPlainMoney(fill.fee)}</td></tr>;
}

function MartingaleConfigPanel({ report }: { report: MartingaleForwardReport }) {
  const config = report.configuration;
  const items: Array<[string, string]> = [
    ["市场", "Binance USD-M BTCUSDT / ETHUSDT"],
    ["周期", `${report.assumptions.trendInterval} 趋势 · ${report.assumptions.interval} 信号`],
    ["杠杆 / 模式", `${config.leverageSelection}x · 隔离风险模型`],
    ["每标的初始权益", `${formatPlainMoney(config.initialEquityPerSymbol)} USDT`],
    ["第一层保证金", formatStrategyPercent(config.baseMarginFraction)],
    ["每层倍率", `${config.sizeMultiplier.toFixed(2)}x`],
    ["最多层数", `${config.maximumLayers} 层`],
    ["网格距离", `${config.gridAtrMultiple} ATR 或 ${(config.minimumGridFraction * 100).toFixed(2)}%，取较宽`],
    ["计划损失上限", formatStrategyPercent(config.maximumGroupLossFraction)],
    ["最长持有", `${Math.round(config.maximumHoldingMinutes / 60)} 小时`],
    ["费用 / 滑点", `${formatStrategyPercent(config.takerFeeRate, 3)} / ${formatStrategyPercent(config.slippageRate, 2)}`],
    ["执行边界", "Paper only · 自动真实订单关闭"],
  ];
  return (
    <section className="xh-strategy-panel" aria-labelledby="martingale-config-title">
      <div className="xh-strategy-panel-header"><div><h2 id="martingale-config-title">冻结配置与简化条件</h2></div></div>
      <dl className="xh-strategy-config-grid">{items.map(([label, value]) => <Detail key={label} label={label} value={value} />)}</dl>
      <details className="xh-strategy-assumptions"><summary>查看研究边界</summary><div><span>历史资金费率忽略</span><span>Mark Price / 动态杠杆档位 / 真实清算忽略</span><span>每标的最多一个网格组</span><span>不需要 API key · 不产生真实订单</span></div></details>
    </section>
  );
}

function LocateButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return <button type="button" className="xh-strategy-locate-trade" disabled={disabled} onClick={onClick}>{label}</button>;
}

function Detail({ label, tone = "", value }: { label: string; tone?: string; value: string }) {
  return <div><dt>{label}</dt><dd className={tone}>{value}</dd></div>;
}

function sideLabel(side: MartingaleGroup["side"]) {
  return side === "long" ? "做多" : side === "short" ? "做空" : "—";
}

function sideTone(side: MartingaleGroup["side"]) {
  return side === "long" ? "is-positive" : side === "short" ? "is-negative" : "";
}

function formatPlainMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
}

function formatQuantity(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—";
}

function workerErrorLabel(value: NonNullable<MartingaleForwardReport["worker"]>["lastError"]) {
  return value === "source_unavailable" ? "公开行情暂时不可用。" : value === "data_gap" ? "K线存在缺口，旧报告已保留。" : value === "report_write_failed" ? "Paper 报告写入失败，旧报告已保留。" : value === "worker_failed" ? "自动 Paper 更新失败，旧报告已保留。" : "";
}
