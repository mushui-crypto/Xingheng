import type { FormEvent, ReactNode } from "react";
import type { StrategyHistoryReport, StrategyForwardTrade } from "../model/types";
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
import { StrategyErrorState, StrategyLoadingState } from "./StrategyPanels";

export type StrategyView = "forward" | "history" | "martingale";
export type StrategyHistoryRange = "2024_2025" | "2026" | "all" | "custom";

type HistoryViewProps = {
  chart: ReactNode;
  report: StrategyHistoryReport | null;
  loading: boolean;
  error: string;
  range: StrategyHistoryRange;
  customFrom: string;
  customTo: string;
  customError: string;
  canGoPrevious: boolean;
  onRangeChange: (range: StrategyHistoryRange) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  onApplyCustom: () => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
  onLocateTrade: (trade: StrategyForwardTrade) => void;
};

export function StrategyViewTabs({ active, onChange }: { active: StrategyView; onChange: (view: StrategyView) => void }) {
  return (
    <div className="xh-strategy-view-tabs" role="tablist" aria-label="策略报告类型">
      <button type="button" role="tab" aria-selected={active === "forward"} className={active === "forward" ? "is-active" : ""} onClick={() => onChange("forward")}>
        前向 Paper
      </button>
      <button type="button" role="tab" aria-selected={active === "history"} className={active === "history" ? "is-active" : ""} onClick={() => onChange("history")}>
        历史回测
      </button>
      <button type="button" role="tab" aria-selected={active === "martingale"} className={active === "martingale" ? "is-active" : ""} onClick={() => onChange("martingale")}>
        马丁网格 Paper
      </button>
    </div>
  );
}

export function StrategyHistoryView(props: HistoryViewProps) {
  const availableReport = props.report?.status === "available" ? props.report : null;
  return (
    <div className="xh-strategy-history-view" role="tabpanel" aria-label="历史回测">
      {props.chart}
      <HistoryRangePanel {...props} report={availableReport} />
      {props.error ? <StrategyErrorState message={props.error} /> : null}
      {props.loading ? <StrategyLoadingState /> : (
        <>
          <HistoryMetricsPanel report={availableReport} />
          <HistoryContextPanel report={availableReport} />
          <HistoryTradesPanel
            report={availableReport}
            canGoPrevious={props.canGoPrevious}
            onNextPage={props.onNextPage}
            onPreviousPage={props.onPreviousPage}
            onLocateTrade={props.onLocateTrade}
          />
        </>
      )}
    </div>
  );
}

function HistoryRangePanel(props: HistoryViewProps & { report: StrategyHistoryReport | null }) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    props.onApplyCustom();
  };
  const options: Array<{ key: StrategyHistoryRange; label: string }> = [
    { key: "2024_2025", label: "2024–2025" },
    { key: "2026", label: "2026 至冻结点" },
    { key: "all", label: "全部" },
    { key: "custom", label: "自定义" },
  ];
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-history-range-title">
      <div className="xh-strategy-panel-header">
        <div>
          <h2 id="strategy-history-range-title">历史回测区间</h2>
          <p>按入场时间归属已完成的回测交易；不代表当前仓位或真实成交。</p>
        </div>
        <span className="xh-strategy-backtest-label">回测数据</span>
      </div>
      <div className="xh-strategy-range-options" aria-label="历史回测时间范围">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={props.range === option.key ? "is-active" : ""}
            aria-pressed={props.range === option.key}
            onClick={() => props.onRangeChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {props.range === "custom" ? (
        <form className="xh-strategy-custom-range" onSubmit={handleSubmit}>
          <label>开始日期<input type="date" value={props.customFrom} onChange={(event) => props.onCustomFromChange(event.target.value)} /></label>
          <label>结束日期<input type="date" value={props.customTo} onChange={(event) => props.onCustomToChange(event.target.value)} /></label>
          <button type="submit">应用区间</button>
          {props.customError ? <p role="alert">{props.customError}</p> : null}
        </form>
      ) : null}
      {props.report?.warnings.includes("range_clamped") ? <p className="xh-strategy-range-warning" role="status">请求区间已按可用历史数据范围调整。</p> : null}
    </section>
  );
}

function HistoryMetricsPanel({ report }: { report: StrategyHistoryReport | null }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-history-metrics-title">
      <div className="xh-strategy-panel-header">
        <div>
          <h2 id="strategy-history-metrics-title">历史绩效</h2>
          <p>{report ? `可用区间 ${formatDateRange(report.availableRange.from, report.availableRange.to)}` : "等待历史报告"}</p>
        </div>
      </div>
      <div className="xh-strategy-table-wrap" role="region" aria-label="历史绩效表格，可横向滚动" tabIndex={0}>
        <table className="xh-strategy-table is-metrics">
          <thead><tr><th>区间</th><th>交易数</th><th>净收益</th><th>PF</th><th>平均R</th><th>最大回撤</th></tr></thead>
          <tbody>
            {report ? (
              <tr>
                <td>{formatDateRange(report.requestedRange.from, report.requestedRange.to)}</td>
                <td>{report.metrics.tradeCount}</td>
                <td className={strategyNumberTone(report.metrics.netPnl)}>{formatStrategyMoney(report.metrics.netPnl)}</td>
                <td>{formatProfitFactor(report.metrics.profitFactor, report.metrics.tradeCount)}</td>
                <td className={strategyNumberTone(report.metrics.averageR)}>{formatAverageR(report.metrics.averageR)}</td>
                <td>{formatStrategyPercent(report.metrics.maxDrawdownFraction)}</td>
              </tr>
            ) : <tr><td className="xh-strategy-table-empty" colSpan={6}>尚无历史回测报告</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoryContextPanel({ report }: { report: StrategyHistoryReport | null }) {
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-history-context-title">
      <div className="xh-strategy-panel-header"><div><h2 id="strategy-history-context-title">历史数据口径</h2></div></div>
      <dl className="xh-strategy-detail-list">
        <Detail label="来源" value={report ? formatHistorySource(report.dataQuality.source) : "—"} />
        <Detail label="数据周期" value={report?.dataQuality.interval ?? "—"} />
        <Detail label="数据截至" value={formatStrategyDateTime(report?.dataThrough)} />
        <Detail label="更新时间" value={formatStrategyDateTime(report?.dataQuality.updatedAt)} />
        <Detail label="K线数量" value={report ? report.dataQuality.candleCount.toLocaleString("en-US") : "—"} />
        <Detail label="数据缺口" value={report ? `${report.dataQuality.missingBarCount} 根` : "—"} tone={report?.dataQuality.missingBarCount ? "is-negative" : ""} />
      </dl>
      <details className="xh-strategy-assumptions">
        <summary>查看研究简化条件</summary>
        <div>
          <span>历史资金费率忽略</span>
          <span>Mark Price / 动态档位 / 跳空暂时忽略</span>
          <span>100x 设置 · 全仓 · 初始保证金 2%</span>
          <span>Paper only · 自动订单关闭</span>
        </div>
      </details>
    </section>
  );
}

function HistoryTradesPanel({ report, canGoPrevious, onLocateTrade, onNextPage, onPreviousPage }: {
  report: StrategyHistoryReport | null;
  canGoPrevious: boolean;
  onLocateTrade: (trade: StrategyForwardTrade) => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
}) {
  const trades = report?.completedTrades ?? [];
  return (
    <section className="xh-strategy-panel" aria-labelledby="strategy-history-trades-title">
      <div className="xh-strategy-panel-header">
        <div>
          <h2 id="strategy-history-trades-title">历史回测交易</h2>
          <p>{report ? `当前区间共 ${report.pagination.total} 笔，按入场时间归属` : "等待历史报告"}</p>
        </div>
        <span className="xh-strategy-backtest-label">非当前持仓 · 非真实成交</span>
      </div>
      <div className="xh-strategy-table-wrap" role="region" aria-label="历史回测交易明细，可横向滚动" tabIndex={0}>
        <table className="xh-strategy-table is-history-trades">
          <thead>
            <tr><th>定位</th><th>类型</th><th>方向</th><th>信号时间</th><th>入场时间</th><th>出场时间</th><th>入场价</th><th>出场价</th><th>止损</th><th>目标</th><th>净盈亏</th><th>R</th><th>费用</th><th>退出原因</th></tr>
          </thead>
          <tbody>
            {trades.length ? trades.map((trade) => <HistoryTradeRow key={tradeKey(trade)} trade={trade} onLocateTrade={onLocateTrade} />) : (
              <tr><td className="xh-strategy-table-empty" colSpan={14}>{report ? "当前区间已完成回测交易为 0" : "尚无历史回测报告"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {report ? (
        <div className="xh-strategy-pagination">
          <span>已显示 {trades.length} / {report.pagination.total} 笔</span>
          <div>
            <button type="button" onClick={onPreviousPage} disabled={!canGoPrevious}>上一页</button>
            <button type="button" onClick={onNextPage} disabled={!report.pagination.hasMore || !report.pagination.nextCursor}>下一页</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function HistoryTradeRow({ onLocateTrade, trade }: { onLocateTrade: (trade: StrategyForwardTrade) => void; trade: StrategyForwardTrade }) {
  return (
    <tr>
      <td>
        <button
          type="button"
          className="xh-strategy-locate-trade"
          onClick={() => onLocateTrade(trade)}
          aria-label={`在K线上定位${formatStrategyDateTime(trade.entryTime)}的回测交易`}
        >
          定位
        </button>
      </td>
      <td><span className="xh-strategy-backtest-label">回测交易</span></td>
      <td className={trade.side === "long" ? "is-positive" : trade.side === "short" ? "is-negative" : ""}>{formatSide(trade.side)}</td>
      <td>{formatStrategyDateTime(trade.signalTime)}</td>
      <td>{formatStrategyDateTime(trade.entryTime)}</td>
      <td>{formatStrategyDateTime(trade.exitTime)}</td>
      <td>{formatStrategyPrice(trade.entryPrice)}</td>
      <td>{formatStrategyPrice(trade.exitPrice)}</td>
      <td>{formatStrategyPrice(trade.stopPrice)}</td>
      <td>{formatStrategyPrice(trade.targetPrice)}</td>
      <td className={strategyNumberTone(trade.netPnl)}>{formatStrategyMoney(trade.netPnl)}</td>
      <td className={strategyNumberTone(trade.rMultiple)}>{formatAverageR(trade.rMultiple)}</td>
      <td>{formatFee(trade.fees)}</td>
      <td>{formatExitReason(trade.exitReason)}</td>
    </tr>
  );
}

function Detail({ label, tone = "", value }: { label: string; tone?: string; value: string }) {
  return <div><dt>{label}</dt><dd className={tone}>{value}</dd></div>;
}

function formatDateRange(from: string | null, to: string | null) {
  if (!from) return "—";
  return formatStrategyPeriod(`${from}T00:00:00Z`, to ? `${to}T00:00:00Z` : null);
}

function formatHistorySource(value: string) {
  return value === "binance_vision_usdm" ? "Binance Vision USD-M" : value;
}

function formatSide(side: StrategyForwardTrade["side"]) {
  return side === "long" ? "做多" : side === "short" ? "做空" : "—";
}

function formatFee(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tradeKey(trade: StrategyForwardTrade) {
  return `${trade.signalTime ?? "signal"}-${trade.entryTime ?? "entry"}-${trade.exitTime ?? "exit"}`;
}
