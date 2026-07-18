import { Activity, AlertTriangle, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import { fetchAdminRealTradingOperations, type AdminRealTradingMetric, type AdminRealTradingOperationsStatus } from "../../api/realTrading";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import {
  adminRealTradingOperationsReducer,
  initialAdminRealTradingOperationsState,
} from "../../features/admin/realTrading/model/operationsState";

const operationsPollingIntervalMs = 15_000;

export function AdminRealTradingOperationsPage() {
  const [state, dispatch] = useReducer(adminRealTradingOperationsReducer, initialAdminRealTradingOperationsState);
  const requestRef = useRef<AbortController | null>(null);

  const load = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    dispatch({ type: "started" });
    try {
      const report = await fetchAdminRealTradingOperations(controller.signal);
      if (!controller.signal.aborted) dispatch({ type: "succeeded", report });
    } catch (error) {
      if (!controller.signal.aborted) {
        dispatch({ type: "failed", error: error instanceof Error ? error.message : "真实交易运维状态加载失败。" });
      }
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), operationsPollingIntervalMs);
    return () => {
      window.clearInterval(timer);
      requestRef.current?.abort();
    };
  }, []);

  const report = state.report;
  return (
    <div className="xh-page xh-operations-page">
      <header className="xh-page-header">
        <div>
          <div className="xh-operations-eyebrow">HYPERLIQUID TESTNET · READ ONLY</div>
          <h1 className="xh-title">真实交易运维</h1>
          <p className="xh-subtitle">仅展示对账、用户流、风控与审计聚合，不提供重放、强制完成或订单操作。</p>
        </div>
        <Button disabled={state.loading} onClick={() => void load()} type="button" variant="secondary">
          <RefreshCw className={state.loading ? "animate-spin" : ""} size={15} />
          刷新
        </Button>
      </header>

      {state.loading ? <OperationsState title="正在读取 Testnet 运维状态" /> : null}
      {state.error ? <OperationsState error title="运维状态加载失败" description={state.error} onRetry={() => void load()} /> : null}
      {report ? (
        <>
          <section className="xh-operations-summary" aria-label="真实交易运维摘要">
            <OperationsSummary icon={<Activity size={18} />} label="总体状态" value={statusLabel(report.status)} tone={report.status} />
            <OperationsSummary icon={<ShieldCheck size={18} />} label="网络" value="Hyperliquid Testnet" />
            <OperationsSummary icon={<RefreshCw size={18} />} label="待对账" value={metricText(report.operations.pendingCount)} />
            <OperationsSummary icon={<AlertTriangle size={18} />} label="人工核对" value={metricText(report.operations.manualReviewPendingCount)} tone={Number(report.operations.manualReviewPendingCount) > 0 ? "degraded" : "ok"} />
          </section>

          <div className="xh-operations-grid">
            <Card className="xh-operations-card">
              <SectionHeading title="对账 Worker" status={report.reconciliation.status ?? report.status} />
              <MetricGrid rows={[
                ["运行", booleanLabel(report.reconciliation.running)],
                ["启用", booleanLabel(report.reconciliation.enabled)],
                ["连续失败", valueText(report.reconciliation.consecutiveFailures)],
                ["扫描 Pending", valueText(report.reconciliation.lastScannedPending)],
                ["已恢复 Request", valueText(report.reconciliation.lastRecoveredRequests)],
                ["最近成功", dateTime(report.reconciliation.lastSuccessAt)],
                ["下次检查", dateTime(report.reconciliation.nextCheckAt)],
                ["新鲜度", report.reconciliation.stale ? "已陈旧" : "正常"],
              ]} />
              {report.reconciliation.lastError ? <p className="xh-operations-error" role="alert">{report.reconciliation.lastError}</p> : null}
            </Card>

            <Card className="xh-operations-card">
              <SectionHeading title="风险与在途" status={report.risk.status ?? report.status} />
              <MetricGrid rows={[
                ["在途动作", valueText(report.risk.inFlightCount)],
                ["在途名义金额", moneyText(report.risk.inFlightNotional)],
                ["最高杠杆", report.risk.limits ? `${report.risk.limits.maxLeverage}x` : "-"],
                ["单笔 / 权益", report.risk.limits ? percentText(report.risk.limits.maxOrderNotionalEquityRatio) : "-"],
                ["总敞口 / 权益", report.risk.limits ? percentText(report.risk.limits.maxTotalNotionalEquityRatio) : "-"],
                ["最大当前委托", valueText(report.risk.limits?.maxOpenOrders)],
              ]} />
            </Card>

            <Card className="xh-operations-card">
              <SectionHeading title="Pending 与审计" status={report.status} />
              <MetricGrid rows={[
                ["自动核对", metricText(report.operations.autoRecoverablePendingCount)],
                ["人工核对", metricText(report.operations.manualReviewPendingCount)],
                ["缺少审计", metricText(report.operations.idempotencyPendingWithoutAuditCount ?? 0)],
                ["最早提交", dateTime(report.operations.oldestPendingSubmittedAt)],
                ["最久等待", durationText(report.operations.oldestPendingAgeMs)],
                ["更新时间", dateTime(report.generatedAt)],
              ]} />
              <AuditCleanup value={report.operations.auditCleanup} />
            </Card>

            <Card className="xh-operations-card">
              <SectionHeading title="用户流" status={report.userStreams.status ?? report.status} />
              <MetricGrid rows={[
                ["活跃流", valueText(report.userStreams.activeStreamCount)],
                ["活跃用户", valueText(report.userStreams.activeUserCount)],
                ["容量上限", valueText(report.userStreams.maxStreamCount)],
              ]} />
              <StreamTable streams={report.userStreams.streams ?? []} />
            </Card>
          </div>

          <Card className="xh-operations-card">
            <SectionHeading title="近 24 小时动作结果" status={report.status} />
            <RecentCounts rows={report.operations.recentCounts} />
          </Card>
        </>
      ) : null}
    </div>
  );
}

function OperationsState({ description, error = false, onRetry, title }: { description?: string; error?: boolean; onRetry?: () => void; title: string }) {
  return <section className={`xh-operations-state ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}><strong>{title}</strong>{description ? <span>{description}</span> : null}{onRetry ? <Button onClick={onRetry} variant="secondary">重新加载</Button> : null}</section>;
}

function OperationsSummary({ icon, label, tone, value }: { icon: React.ReactNode; label: string; tone?: AdminRealTradingOperationsStatus; value: string }) {
  return <div className={`xh-operations-summary-item ${tone ? `is-${tone}` : ""}`}><span>{icon}{label}</span><strong>{value}</strong></div>;
}

function SectionHeading({ status, title }: { status: AdminRealTradingOperationsStatus; title: string }) {
  return <div className="xh-operations-section-heading"><h2>{title}</h2><span className={`is-${status}`}>{statusLabel(status)}</span></div>;
}

function MetricGrid({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="xh-operations-metrics">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function StreamTable({ streams }: { streams: NonNullable<import("../../api/realTrading").AdminRealTradingOperations["userStreams"]["streams"]> }) {
  if (streams.length === 0) return <p className="xh-operations-empty">暂无活跃用户流。</p>;
  return <div className="xh-operations-table-wrap"><table><thead><tr><th>地址</th><th>状态</th><th>用户</th><th>序列</th><th>最近事件</th></tr></thead><tbody>{streams.map((stream) => <tr key={`${stream.address}:${stream.sequence}`}><td>{stream.address}</td><td>{stream.stale ? "已陈旧" : stream.reconnecting ? "重连中" : stream.status}</td><td>{stream.userCount}</td><td>{stream.sequence}</td><td>{dateTime(stream.lastEventAt)}</td></tr>)}</tbody></table></div>;
}

function RecentCounts({ rows }: { rows: import("../../api/realTrading").AdminRealTradingOperations["operations"]["recentCounts"] }) {
  if (rows.length === 0) return <p className="xh-operations-empty">近 24 小时暂无交易动作结果。</p>;
  return <div className="xh-operations-table-wrap"><table><thead><tr><th>动作</th><th>结果</th><th>数量</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.actionType}:${row.outcome}`}><td>{row.actionType}</td><td>{outcomeLabel(row.outcome)}</td><td>{row.count}</td></tr>)}</tbody></table></div>;
}

function AuditCleanup({ value }: { value: import("../../api/realTrading").AdminRealTradingOperations["operations"]["auditCleanup"] }) {
  if (value === "unavailable") return <p className="xh-operations-empty">审计清理状态不可用。</p>;
  return <p className="xh-operations-footnote">审计保留 {value.retentionDays} 天 · 最近清理 {dateTime(value.lastMaintenanceAt)} · 删除 {value.lastDeletedRows} 行</p>;
}

function statusLabel(status: AdminRealTradingOperationsStatus) { return status === "ok" ? "正常" : status === "degraded" ? "降级" : "不可用"; }
function outcomeLabel(outcome: string) { return ({ accepted: "已受理", rejected: "已拒绝", partial: "部分完成", pending_reconciliation: "待对账" } as Record<string, string>)[outcome] ?? outcome; }
function booleanLabel(value?: boolean) { return value === undefined ? "-" : value ? "是" : "否"; }
function valueText(value?: number | null) { return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "-"; }
function metricText(value: AdminRealTradingMetric) { return typeof value === "number" ? value.toLocaleString("zh-CN") : "不可用"; }
function moneyText(value?: number | null) { return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-"; }
function percentText(value: number) { return `${(value * 100).toFixed(0)}%`; }
function dateTime(value?: number | null) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-"; }
function durationText(value?: number | null) { if (typeof value !== "number" || !Number.isFinite(value)) return "-"; const minutes = Math.floor(value / 60_000); return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`; }
