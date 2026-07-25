import { useMemo, useState } from "react";
import React from "react";
import { LogOut } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import type {
  AutomationExecutionReconciliationPreview,
  AutomationPositionGroup,
  AutomationPositionMode,
} from "../model/controlConsoleTypes";
import type { ManualReconciliationState } from "../model/manualReconciliationState";
import {
  ConsoleSection,
  ScrollTable,
  StatusTag,
  SummaryMetric,
  formatDate,
  formatMoney,
  pnlTone,
  tableCellClass,
  tableHeadClass,
  tableHeaderCellClass,
  venueLabel,
} from "./AutomationConsoleShared";
import {
  ManualInterventionReconciliation,
  authoritativeSummary,
} from "./ManualInterventionReconciliation";

type PositionFilter = "all" | AutomationPositionMode;

export function AutomationPositions({
  groups,
  onClose,
  onFinalizeReconciliation = () => undefined,
  onReconcile = () => undefined,
  reconciliationStates = {},
  writableVenues,
}: {
  groups: AutomationPositionGroup[];
  onClose: (positionId: string) => Promise<void>;
  onFinalizeReconciliation?: (
    group: AutomationPositionGroup,
    report: AutomationExecutionReconciliationPreview,
  ) => void;
  onReconcile?: (group: AutomationPositionGroup) => void;
  reconciliationStates?: Record<string, ManualReconciliationState<AutomationExecutionReconciliationPreview>>;
  writableVenues?: AutomationPositionGroup["venue"][];
}) {
  const [filter, setFilter] = useState<PositionFilter>("all");
  const visible = useMemo(() => filter === "all" ? groups : groups.filter((group) => group.mode === filter), [filter, groups]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-y border-white/10 py-3" role="group" aria-label="持仓模式筛选">
        {(["all", "live", "shadow"] as PositionFilter[]).map((value) => <button aria-pressed={filter === value} className={`min-h-10 border px-4 text-sm font-semibold transition ${filter === value ? "border-white bg-white text-black" : "border-white/20 text-muted hover:border-white/50 hover:text-white"}`} key={value} onClick={() => setFilter(value)} type="button">{value === "all" ? "全部" : value === "live" ? "真实" : "Shadow"}</button>)}
      </div>
      {visible.length === 0 ? <div className="border border-white/15 px-5 py-14 text-center"><p className="text-sm font-medium text-white">当前没有{filter === "live" ? "真实" : "Shadow"}策略组合</p><p className="mt-2 text-xs text-muted">持仓为空时不会使用账户总 PnL 作为替代数据。</p></div> : visible.map((group) => (
        <PositionGroup
          canClose={writableVenues?.includes(group.venue) ?? true}
          group={group}
          key={group.id}
          onClose={onClose}
          onFinalizeReconciliation={onFinalizeReconciliation}
          onReconcile={onReconcile}
          reconciliationState={reconciliationStates[group.id]?.scope === reconciliationScope(group)
            ? reconciliationStates[group.id]
            : restoredReconciliationState(group)}
        />
      ))}
    </div>
  );
}

function PositionGroup({
  canClose,
  group,
  onClose,
  onFinalizeReconciliation,
  onReconcile,
  reconciliationState,
}: {
  canClose: boolean;
  group: AutomationPositionGroup;
  onClose: (positionId: string) => Promise<void>;
  onFinalizeReconciliation: (
    group: AutomationPositionGroup,
    report: AutomationExecutionReconciliationPreview,
  ) => void;
  onReconcile: (group: AutomationPositionGroup) => void;
  reconciliationState: ManualReconciliationState<AutomationExecutionReconciliationPreview>;
}) {
  const tone = group.mode === "live" ? "warning" : "info";
  const needsReconciliation = group.executionState === "manual_intervention"
    || group.executionState === "partial_closed"
    || group.executionState === "reconciled"
    || reconciliationState.report !== null;
  const report = reconciliationState.phase === "success" ? reconciliationState.report : null;
  const currentSummary = report ? authoritativeSummary(report) : null;
  const authoritativeRequired = group.executionState === "manual_intervention"
    || group.executionState === "partial_closed";
  return (
    <ConsoleSection
      title={group.label}
      description={`${group.strategyId} · 开始于 ${formatDate(group.openedAt)}`}
      actions={<><StatusTag tone={tone}>{group.mode === "live" ? "真实" : "Shadow"}</StatusTag><StatusTag tone={group.status === "attention" ? "danger" : group.status === "hedged" ? "success" : "neutral"}>{positionStatus(group.status)}</StatusTag>{group.mode === "live" && group.status !== "closed" ? canClose ? <Button className="min-h-9 px-3 py-2 text-xs" onClick={() => void onClose(group.id)} type="button" variant="danger"><LogOut size={14} />退出对冲组合</Button> : <StatusTag tone="warning">当前阶段无平台代理退出</StatusTag> : null}</>}
    >
      <section className="grid overflow-hidden border-b border-white/10 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${group.label} 摘要`}>
        <SummaryMetric
          detail={authoritativeRequired ? "仅使用未过期的交易所权威快照" : undefined}
          label={authoritativeRequired ? "权威资金占用" : "资金占用"}
          value={authoritativeRequired ? (currentSummary ? formatMoney(currentSummary.capitalUsedUsd) : "-") : formatMoney(group.capitalUsedUsd)}
        />
        <SummaryMetric
          detail={authoritativeRequired ? "策略记录不会冒充当前真实持仓" : undefined}
          label={authoritativeRequired ? "权威净 Delta" : "净 Delta"}
          value={authoritativeRequired ? (currentSummary ? formatMoney(currentSummary.netDeltaUsd, true) : "-") : formatMoney(group.netDeltaUsd, true)}
          tone={authoritativeRequired
            ? (currentSummary ? pnlTone(-Math.abs(currentSummary.netDeltaUsd)) : undefined)
            : pnlTone(-Math.abs(group.netDeltaUsd))}
        />
        <SummaryMetric label="基差" value={group.basisBps === null ? "-" : `${group.basisBps.toFixed(2)} bps`} />
        <SummaryMetric label="净 PnL" value={formatMoney(group.netPnl, true)} detail={`Funding ${formatMoney(group.fundingPnl, true)} · Fees ${formatMoney(-group.fees)}`} tone={pnlTone(group.netPnl)} />
      </section>
      {needsReconciliation ? (
        <ManualInterventionReconciliation
          group={group}
          onFinalize={onFinalizeReconciliation}
          onReconcile={onReconcile}
          state={reconciliationState}
        />
      ) : null}
      {group.legs.length > 0 ? (
        <ScrollTable minWidth={1500}>
          <thead className={tableHeadClass}><tr>{["市场侧", "交易所", "品种", "数量", "均价", "Mark", "名义", "未实现", "已实现", "Funding", "手续费", "滑点", "净 PnL", "强平距离"].map((header) => <th className={tableHeaderCellClass} key={header}>{header}</th>)}</tr></thead>
          <tbody>{group.legs.map((leg) => {
            const legNetPnl = leg.unrealizedPnl + leg.realizedPnl + leg.fundingPnl - leg.fees - leg.slippage;
            return <tr key={`${leg.venue}:${leg.symbol}:${leg.side}`}><td className={tableCellClass}><StatusTag tone={leg.side === "long" ? "success" : "danger"}>{leg.marketType === "spot" ? "现货侧" : "永续侧"}</StatusTag></td><td className={tableCellClass}>{venueLabel(leg.venue)}</td><td className={`${tableCellClass} font-mono text-white`}>{leg.symbol}</td><td className={`${tableCellClass} font-mono`}>{leg.quantity.toLocaleString("en-US", { maximumFractionDigits: 8 })}</td><td className={`${tableCellClass} font-mono`}>{leg.entryPrice.toFixed(2)}</td><td className={`${tableCellClass} font-mono`}>{leg.markPrice.toFixed(2)}</td><td className={`${tableCellClass} font-mono`}>{formatMoney(leg.notionalUsd)}</td><td className={`${tableCellClass} font-mono`}>{formatMoney(leg.unrealizedPnl, true)}</td><td className={`${tableCellClass} font-mono`}>{formatMoney(leg.realizedPnl, true)}</td><td className={`${tableCellClass} font-mono`}>{formatMoney(leg.fundingPnl, true)}</td><td className={`${tableCellClass} font-mono`}>{formatMoney(-leg.fees)}</td><td className={`${tableCellClass} font-mono`}>{formatMoney(-leg.slippage)}</td><td className={`${tableCellClass} font-mono font-semibold ${legNetPnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>{formatMoney(legNetPnl, true)}</td><td className={`${tableCellClass} font-mono`}>{leg.liquidationDistancePercent === null ? "不适用" : `${leg.liquidationDistancePercent.toFixed(1)}%`}</td></tr>;
          })}</tbody>
        </ScrollTable>
      ) : <p className="px-5 py-8 text-sm text-muted">该历史批次已经退出，当前没有活动仓位。</p>}
      <div className="border-t border-white/10">
        <div className="px-4 py-3 sm:px-5"><h3 className="text-sm font-semibold text-white">订单、成交与 Funding 历史</h3><p className="mt-1 text-xs text-muted">仅显示归属于当前 strategy batch 的事件。</p></div>
        <ScrollTable minWidth={860}>
          <thead className={tableHeadClass}><tr><th className={tableHeaderCellClass}>时间</th><th className={tableHeaderCellClass}>类型</th><th className={tableHeaderCellClass}>交易所</th><th className={tableHeaderCellClass}>品种</th><th className={tableHeaderCellClass}>状态</th><th className={tableHeaderCellClass}>数量</th><th className={tableHeaderCellClass}>价格</th></tr></thead>
          <tbody>{group.history.map((event) => <tr key={event.id}><td className={tableCellClass}>{formatDate(event.occurredAt)}</td><td className={tableCellClass}>{historyType(event.type)}</td><td className={tableCellClass}>{venueLabel(event.venue)}</td><td className={`${tableCellClass} font-mono`}>{event.symbol}</td><td className={tableCellClass}>{event.status}</td><td className={`${tableCellClass} font-mono`}>{event.quantity ?? "-"}</td><td className={`${tableCellClass} font-mono`}>{event.price?.toFixed(2) ?? "-"}</td></tr>)}</tbody>
        </ScrollTable>
      </div>
    </ConsoleSection>
  );
}

function restoredReconciliationState(
  group: AutomationPositionGroup,
): ManualReconciliationState<AutomationExecutionReconciliationPreview> {
  const scope = reconciliationScope(group);
  return group.reconciliation
    ? {
        scope,
        phase: "success",
        requestId: null,
        report: group.reconciliation,
        error: null,
      }
    : {
        scope,
        phase: "idle",
        requestId: null,
        report: null,
        error: null,
      };
}

function reconciliationScope(group: AutomationPositionGroup) {
  return `${group.venue}:${group.accountId}:${group.reconciliationId ?? group.id}`;
}

function positionStatus(value: AutomationPositionGroup["status"]) { return ({ opening: "建仓中", hedged: "已对冲", closing: "退出中", closed: "已关闭", attention: "需要处理" } as const)[value]; }
function historyType(value: AutomationPositionGroup["history"][number]["type"]) { return ({ order: "订单", fill: "成交", funding: "Funding", close: "退出" } as const)[value]; }
