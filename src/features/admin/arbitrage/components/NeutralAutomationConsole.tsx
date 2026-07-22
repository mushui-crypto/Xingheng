import { AlertTriangle, CheckCircle2, Eye, ShieldCheck, WifiOff, XCircle } from "lucide-react";
import React from "react";
import { Card } from "../../../../components/ui/Card";
import { connectorAvailabilityLabel, executionSafetyLabel } from "../model/neutralAutomationState";
import type { NeutralAutomationStateName, NeutralAutomationStatus } from "../model/types";

type ReportProps = { report: NeutralAutomationStatus };

export function NeutralAutomationConsole({ report }: ReportProps) {
  const safety = executionSafetyLabel(report);
  const connectorAvailability = connectorAvailabilityLabel(report);
  return (
    <div className="xh-neutral-console">
      <section className="xh-neutral-safety" aria-label="Phase A 执行边界">
        <SafetyItem icon={<Eye size={18} />} label="运行模式" value="Shadow" />
        <SafetyItem icon={<ShieldCheck size={18} />} label="真实交易" value="关闭" />
        <SafetyItem
          icon={safety.safe ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          label={safety.label}
          tone={safety.safe ? "safe" : "danger"}
          value={safety.detail}
        />
      </section>

      <section className="xh-neutral-summary" aria-label="RWA Shadow 摘要">
        <SummaryItem label="策略" value="Bybit XAUT 现货 + 永续" />
        <SummaryItem label="阶段" value="Phase A · 私有只读" />
        <SummaryItem label="状态机" value={stateLabel(report.state)} tone={report.status} />
        <SummaryItem label="服务状态" value={statusLabel(report.status)} tone={report.status} />
        <SummaryItem label="网络" value={report.network === "mainnet" ? "Bybit Mainnet · 只读" : report.network} />
        <SummaryItem
          label="Connector"
          value={connectorAvailability.label}
          tone={connectorAvailability.available ? "observing" : "fault"}
        />
      </section>

      <div className="xh-neutral-grid">
        <Card className="xh-neutral-card">
          <SectionHeading title="Connector 与权限" status={report.connector.stale ? "fault" : report.status} />
          <MetricList rows={[
            ["连接状态", report.connector.connected ? "已连接" : "未连接"],
            ["账户模式", accountModeLabel(report.connector.accountMode)],
            ["Connector", report.connector.readonly ? "只读" : "异常"],
            ["读取权限", yesNo(report.connector.permissions.read)],
            ["交易权限", yesNo(report.connector.permissions.trade)],
            ["提现权限", yesNo(report.connector.permissions.withdraw)],
            ["快照状态", report.connector.stale ? "已陈旧" : "新鲜"],
            ["检查时间", dateTime(report.connector.checkedAt)],
          ]} />
          <div className="xh-neutral-capabilities" aria-label="只读能力">
            {report.connector.capabilities.map((capability) => <span key={capability}>{capabilityLabel(capability)}</span>)}
          </div>
          {report.connector.message ? <p className="xh-neutral-note">{connectorMessage(report.connector.message)}</p> : null}
          {report.connector.errorCategory ? <p className="xh-neutral-error-category">错误类别：{report.connector.errorCategory}</p> : null}
        </Card>

        <Card className="xh-neutral-card">
          <SectionHeading title="Shadow 决策" status={report.status} />
          <MetricList rows={[
            ["动作", shadowActionLabel(report.shadow.action)],
            ["生成时间", dateTime(report.shadow.generatedAt)],
            ["目标市场", `${report.shadow.target.venue.toUpperCase()} · ${report.shadow.target.spotSymbol}`],
            ["目标名义金额", money(report.shadow.target.notionalUsd)],
            ["Provider 写入", report.shadow.wouldSendProviderWrite ? "异常" : "不会发送"],
          ]} />
          <p className="xh-neutral-decision-reason">{shadowReason(report.shadow.reason)}</p>
          <ul className="xh-neutral-gates" aria-label="Shadow 门禁结果">
            {report.shadow.gateChecks.map((gate) => (
              <li className={gate.passed ? "is-passed" : "is-blocked"} key={gate.name}>
                {gate.passed ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                <div>
                  <strong>{gateLabel(gate.name)}</strong>
                  <span>{gateMessage(gate.name, gate.passed, gate.message)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="xh-neutral-card">
        <SectionHeading title="账户只读快照" status={report.connector.stale ? "fault" : report.status} />
        <div className="xh-neutral-account-sections">
          <DataSection title="余额" count={report.account.balances.length}>
            <ReadonlyTable
              columns={["资产", "钱包余额", "可用余额"]}
              empty="暂无余额快照。"
              rows={report.account.balances.map((item) => [item.asset, number(item.walletBalance), number(item.available)])}
            />
          </DataSection>
          <DataSection title="费率" count={report.account.fees.length}>
            <ReadonlyTable
              columns={["品种", "现货 Taker", "永续 Taker"]}
              empty="暂无费率快照。"
              rows={report.account.fees.map((item) => [item.symbol, bps(item.spotTakerBps), bps(item.perpTakerBps)])}
            />
          </DataSection>
          <DataSection title="产品规格" count={report.account.instruments.length}>
            <ReadonlyTable
              columns={["品种", "类型", "状态", "最小数量", "数量步长", "最小名义"]}
              empty="暂无产品规格。"
              rows={report.account.instruments.map((item) => [
                item.symbol,
                item.kind === "spot" ? "现货" : "永续",
                instrumentStatusLabel(item.status),
                number(item.minOrderQty),
                number(item.qtyStep),
                money(item.minNotionalUsd),
              ])}
            />
          </DataSection>
          <DataSection title="订单" count={report.account.orders.length}>
            <ReadonlyTable
              columns={["订单 ID", "品种", "方向", "状态", "数量", "已成交", "更新时间"]}
              empty="暂无只读订单。"
              rows={report.account.orders.map((item) => [
                item.orderId,
                item.symbol,
                sideLabel(item.side),
                orderStatusLabel(item.status),
                number(item.quantity),
                number(item.filledQuantity),
                dateTime(item.updatedAt),
              ])}
            />
          </DataSection>
          <DataSection title="成交" count={report.account.fills.length}>
            <ReadonlyTable
              columns={["成交 ID", "订单 ID", "品种", "方向", "价格", "数量", "费用", "时间"]}
              empty="暂无只读成交。"
              rows={report.account.fills.map((item) => [
                item.fillId,
                item.orderId ?? "-",
                item.symbol,
                sideLabel(item.side),
                number(item.price),
                number(item.quantity),
                item.fee === null ? "-" : `${number(item.fee)} ${item.feeAsset ?? ""}`.trim(),
                dateTime(item.timestamp),
              ])}
            />
          </DataSection>
          <DataSection title="仓位" count={report.account.positions.length}>
            <ReadonlyTable
              columns={["品种", "方向", "数量", "名义价值", "开仓价", "标记价", "强平距离", "更新时间"]}
              empty="暂无只读仓位。"
              rows={report.account.positions.map((item) => [
                item.symbol,
                positionSideLabel(item.side),
                number(item.quantity),
                money(item.notionalUsd),
                number(item.entryPrice),
                number(item.markPrice),
                percent(item.liquidationDistancePercent),
                dateTime(item.updatedAt),
              ])}
            />
          </DataSection>
        </div>
      </Card>

      <div className="xh-neutral-grid">
        <Card className="xh-neutral-card">
          <SectionHeading title="恢复与审计" status={report.status} />
          <MetricList rows={[
            ["恢复来源", report.recovery.source === "provider_snapshot" ? "Provider 权威快照" : report.recovery.source],
            ["快照恢复", yesNo(report.recovery.restoredFromSnapshot)],
            ["最近快照", dateTime(report.recovery.lastSnapshotAt)],
            ["审计事件", String(report.audit.latest.length)],
          ]} />
          <ReadonlyTable
            columns={["时间", "事件", "状态", "摘要", "错误类别"]}
            empty="暂无审计摘要。"
            rows={report.audit.latest.map((item) => [
              dateTime(item.occurredAt),
              item.eventType,
              stateLabel(item.state),
              item.summary,
              item.errorCategory ?? "-",
            ])}
          />
        </Card>

        <Card className="xh-neutral-card">
          <SectionHeading title="告警与边界" status={report.warnings.length > 0 ? "fault" : report.status} />
          {report.warnings.length > 0 ? (
            <ul className="xh-neutral-warnings">
              {report.warnings.map((warning) => <li key={warning}><AlertTriangle size={15} />{warningLabel(warning)}</li>)}
            </ul>
          ) : <p className="xh-neutral-empty">当前没有额外告警。</p>}
          <div className="xh-neutral-boundary">
            <WifiOff size={17} />
            <p>本页不接触 API Key 或 Secret，不直接访问交易所私有 API，不提供启停、下单、撤单、补腿、调仓或资金操作。</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SafetyItem({ icon, label, tone = "safe", value }: { icon: React.ReactNode; label: string; tone?: "safe" | "danger"; value: string }) {
  return <div className={`xh-neutral-safety-item is-${tone}`}>{icon}<div><span>{label}</span><strong>{value}</strong></div></div>;
}

function SummaryItem({ label, tone, value }: { label: string; tone?: NeutralAutomationStatus["status"]; value: string }) {
  return <div className={`xh-neutral-summary-item ${tone ? `is-${tone}` : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function SectionHeading({ status, title }: { status: NeutralAutomationStatus["status"]; title: string }) {
  return <div className="xh-neutral-section-heading"><h2>{title}</h2><span className={`is-${status}`}>{statusLabel(status)}</span></div>;
}

function MetricList({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="xh-neutral-metrics">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function DataSection({ children, count, title }: { children: React.ReactNode; count: number; title: string }) {
  return <section className="xh-neutral-data-section"><header><h3>{title}</h3><span>{count}</span></header>{children}</section>;
}

function ReadonlyTable({ columns, empty, rows }: { columns: string[]; empty: string; rows: string[][] }) {
  if (rows.length === 0) return <p className="xh-neutral-empty">{empty}</p>;
  return (
    <div className="xh-neutral-table-wrap">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${row[0]}:${index}`}>{row.map((cell, cellIndex) => <td key={`${columns[cellIndex]}:${cellIndex}`} title={cell}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function stateLabel(value: NeutralAutomationStateName) {
  return ({ disabled: "已禁用", observing: "Shadow 观察中", armed: "已准备", opening: "建仓中", hedged: "已对冲", rebalancing: "再平衡中", closing: "退出中", fault: "故障关闭", manual_intervention: "需要人工处理" } as Record<NeutralAutomationStateName, string>)[value];
}
function statusLabel(value: NeutralAutomationStatus["status"]) { return value === "observing" ? "观察中" : value === "fault" ? "故障关闭" : "已禁用"; }
function shadowActionLabel(value: NeutralAutomationStatus["shadow"]["action"]) { return ({ observe: "观察", would_open: "模拟建仓", would_close: "模拟退出", hold: "保持", blocked: "已阻断" } as const)[value]; }
function accountModeLabel(value: NeutralAutomationStatus["connector"]["accountMode"]) { return value === "uta" ? "统一账户 UTA" : value === "classic" ? "经典账户" : "未知"; }
function yesNo(value: boolean) { return value ? "是" : "否"; }
function sideLabel(value: "buy" | "sell") { return value === "buy" ? "买入" : "卖出"; }
function positionSideLabel(value: "long" | "short") { return value === "long" ? "多头" : "空头"; }
function instrumentStatusLabel(value: "trading" | "paused" | "unknown") { return value === "trading" ? "交易中" : value === "paused" ? "暂停" : "未知"; }
function orderStatusLabel(value: NeutralAutomationStatus["account"]["orders"][number]["status"]) { return ({ new: "新委托", partially_filled: "部分成交", filled: "已成交", cancelled: "已取消", rejected: "已拒绝", unknown: "未知" } as const)[value]; }
function capabilityLabel(value: string) { return ({ connectivity: "连通性", account_mode: "账户模式", balances: "余额", fees: "费率", instrument_specs: "产品规格", orders: "订单", fills: "成交", positions: "仓位" } as Record<string, string>)[value] ?? value; }
function gateLabel(value: string) { return ({ phase_a_shadow_only: "仅限 Phase A Shadow", global_execution_disabled: "全局执行关闭", connector_readonly: "Connector 只读", fresh_provider_snapshot: "Provider 快照新鲜" } as Record<string, string>)[value] ?? value; }
function gateMessage(name: string, passed: boolean, fallback: string) { return ({ phase_a_shadow_only: "只评估 Shadow 决策，不发送 Provider 写请求。", global_execution_disabled: "全局真实执行保持关闭。", connector_readonly: "Connector 不具备交易或提现权限。", fresh_provider_snapshot: passed ? "Provider 只读快照可用于 Shadow 评估。" : "Provider 只读快照不可用或已陈旧。" } as Record<string, string>)[name] ?? fallback; }
function shadowReason(value: string) { return value === "Strategy is disabled or kill switch is active; Phase A remains read-only." ? "策略开关关闭或急停生效；Phase A 保持只读。" : value === "Provider read state is unavailable or stale; Phase A is fail-closed." ? "Provider 只读状态不可用或已陈旧；Phase A 已故障关闭。" : value === "Shadow criteria can be evaluated, but real execution remains disabled." ? "当前可评估 Shadow 条件，但真实执行仍保持关闭。" : value; }
function connectorMessage(value: string) { return value === "Bybit read-only connector is not configured." ? "Bybit 只读 Connector 尚未配置。" : value; }
function warningLabel(value: string) { return ({ "Kill switch is active; no real execution can be armed.": "急停处于开启状态，真实执行不能进入准备状态。", "Strategy switch is disabled.": "策略开关已关闭。", "Global real execution is disabled.": "全局真实执行已关闭。", "Provider read state is stale or unavailable; fail-closed.": "Provider 只读状态已陈旧或不可用，系统保持故障关闭。", "Bybit read-only connector is not configured.": "Bybit 只读 Connector 尚未配置。" } as Record<string, string>)[value] ?? value; }
function number(value: number | null) { return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "-"; }
function money(value: number | null) { return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT` : "-"; }
function bps(value: number | null) { return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} bps` : "-"; }
function percent(value: number | null) { return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%` : "-"; }
function dateTime(value: number | null) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-"; }
