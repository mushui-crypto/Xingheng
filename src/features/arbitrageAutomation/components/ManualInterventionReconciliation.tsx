import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import React from "react";
import { Button } from "../../../components/ui/Button";
import type {
  AutomationExecutionReconciliationPreview,
  AutomationPositionGroup,
  AutomationResidualAssessment,
} from "../model/controlConsoleTypes";
import type { ManualReconciliationState } from "../model/manualReconciliationState";
import {
  ScrollTable,
  StatusTag,
  formatDate,
  formatMoney,
  tableCellClass,
  tableHeadClass,
  tableHeaderCellClass,
} from "./AutomationConsoleShared";

export function ManualInterventionReconciliation({
  group,
  onFinalize,
  onReconcile,
  state,
}: {
  group: AutomationPositionGroup;
  onFinalize: (group: AutomationPositionGroup, report: AutomationExecutionReconciliationPreview) => void;
  onReconcile: (group: AutomationPositionGroup) => void;
  state: ManualReconciliationState<AutomationExecutionReconciliationPreview>;
}) {
  const report = state.phase === "success" ? state.report : null;
  const busy = state.phase === "loading" || state.phase === "finalizing";

  return (
    <section className="border-b border-white/10" aria-label={`${group.label} 人工成交对账`}>
      <header className="flex flex-col gap-3 border-b border-white/10 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-white">人工成交对账</h3>
            <StatusTag tone="warning">策略记录待核对</StatusTag>
            {report ? (
              <StatusTag tone={report.authoritativeState.stale ? "danger" : "success"}>
                {report.authoritativeState.stale ? "交易所最新数据已过期" : "交易所最新数据已读取"}
              </StatusTag>
            ) : null}
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-muted">
            策略记录只保留执行历史，不代表交易所当前持仓。资金占用与净 Delta 仅在本次重新核对交易所账户成功且数据未过期后计算。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => onReconcile(group)}
            type="button"
            variant="secondary"
          >
            <RefreshCw className={state.phase === "loading" ? "animate-spin" : ""} size={15} />
            {state.phase === "loading" ? "正在对账" : "重新对账"}
          </Button>
          <Button
            disabled={busy || !report?.canFinalize}
            onClick={() => report && onFinalize(group, report)}
            type="button"
            variant="danger"
          >
            {state.phase === "finalizing" ? "正在结案" : "确认人工处理完成"}
          </Button>
        </div>
      </header>

      {state.phase === "idle" ? (
        <ReconciliationState
          description="尚未取得本次交易所最新数据。旧策略数量不会作为当前真实持仓展示。"
          icon={<ShieldAlert size={18} />}
          title="等待重新对账"
        />
      ) : null}
      {state.phase === "loading" ? (
        <ReconciliationState
          description="正在读取交易所现货、永续、当前委托和产品最小交易约束；旧结果已撤下。"
          icon={<RefreshCw className="animate-spin" size={18} />}
          title="正在获取最新状态"
        />
      ) : null}
      {state.phase === "finalizing" ? (
        <ReconciliationState
          description="服务端正在第二次核对交易所账户。前端不会直接关闭策略记录，也不会发送交易所订单。"
          icon={<RefreshCw className="animate-spin" size={18} />}
          title="正在确认人工结案"
        />
      ) : null}
      {state.phase === "error" ? (
        <ReconciliationState
          description={state.error ?? "未取得交易所最新状态，请稍后重新核对。"}
          error
          icon={<AlertTriangle size={18} />}
          title="对账结果不可用"
        />
      ) : null}
      {report ? <ReconciliationReport group={group} report={report} /> : null}
    </section>
  );
}

function ReconciliationReport({
  group,
  report,
}: {
  group: AutomationPositionGroup;
  report: AutomationExecutionReconciliationPreview;
}) {
  const authoritative = report.authoritativeState;
  const summary = authoritativeSummary(report);
  return (
    <div className="space-y-0">
      <div className="grid gap-px bg-white/10 sm:grid-cols-2 xl:grid-cols-4">
        <ReconciliationMetric label="记录状态" value={executionStateLabel(report.recordedState)} />
        <ReconciliationMetric
          label="交易所最新数据"
          value={authoritative.stale ? "已过期，不可用于当前摘要" : formatDate(authoritative.snapshotAt)}
        />
        <ReconciliationMetric
          label="实际资金占用"
          value={summary ? formatMoney(summary.capitalUsedUsd) : "-"}
        />
        <ReconciliationMetric
          label="当前净 Delta"
          value={summary ? formatMoney(summary.netDeltaUsd, true) : "-"}
        />
      </div>

      <div className="grid min-w-0 border-t border-white/10 lg:grid-cols-2">
        <section className="min-w-0 border-b border-white/10 p-4 lg:border-b-0 lg:border-r lg:p-5">
          <h4 className="text-sm font-semibold text-white">策略记录</h4>
          <p className="mt-1 text-xs leading-5 text-muted">历史执行记录，等待核对交易所最新状态；不作为当前真实持仓。</p>
          <div className="mt-3 space-y-2">
            {group.legs.length ? group.legs.map((leg) => (
              <div className="flex items-center justify-between gap-4 text-xs" key={`${leg.marketType}:${leg.symbol}`}>
                <span className="text-muted">{leg.marketType === "spot" ? "现货侧记录" : "永续侧记录"}</span>
                <span className="font-mono text-slate-200">{formatQuantity(leg.quantity)} XAUT</span>
              </div>
            )) : <p className="text-xs text-muted">策略记录中没有活动持仓数量。</p>}
          </div>
        </section>
        <section className="min-w-0 p-4 lg:p-5">
          <h4 className="text-sm font-semibold text-white">交易所最新状态</h4>
          <p className="mt-1 text-xs leading-5 text-muted">
            当前委托 {authoritative.openOrders.total} 笔（现货 {authoritative.openOrders.spot} · 永续 {authoritative.openOrders.perpetual}）
          </p>
          <div className="mt-3 space-y-2">
            <AuthoritativeLegRow label="现货侧" quantity={authoritative.legs.spot.quantityXaut} />
            <AuthoritativeLegRow label="永续侧" quantity={authoritative.legs.perpetual.quantityXaut} />
          </div>
        </section>
      </div>

      <ScrollTable minWidth={920}>
        <thead className={tableHeadClass}>
          <tr>
            {["市场侧", "实际数量", "可用数量", "Mark", "与记录差异", "可交易残余", "不可交易小额余额"].map((header) => (
              <th className={tableHeaderCellClass} key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <ResidualRow
            diff={report.legDiffs.spotQuantityXaut}
            dust={report.dustResidual.spot}
            label="现货侧"
            leg={authoritative.legs.spot}
            tradable={report.tradableResidual.spot}
          />
          <ResidualRow
            diff={report.legDiffs.perpetualQuantityXaut}
            dust={report.dustResidual.perpetual}
            label="永续侧"
            leg={authoritative.legs.perpetual}
            tradable={report.tradableResidual.perpetual}
          />
        </tbody>
      </ScrollTable>

      <footer className="border-t border-white/10 px-4 py-4 sm:px-5">
        {report.blockingReasons.length ? (
          <div className="flex items-start gap-3 text-sm text-amber-100" role="status">
            <AlertTriangle className="mt-0.5 shrink-0" size={17} />
            <div>
              <p className="font-semibold">仍不能人工结案</p>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100/80">
                {report.blockingReasons.map((reason) => <li key={reason}>• {reason}</li>)}
              </ul>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 text-sm text-emerald-100" role="status">
            <CheckCircle2 className="mt-0.5 shrink-0" size={17} />
            <div>
              <p className="font-semibold">服务端允许申请人工结案</p>
              <p className="mt-1 text-xs leading-5 text-emerald-100/75">
                点击结案后仍需 TOTP；服务端会再次读取交易所状态，结果可能因新委托、残余或快照变化而被阻断。
              </p>
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

function ResidualRow({
  diff,
  dust,
  label,
  leg,
  tradable,
}: {
  diff: number;
  dust: AutomationResidualAssessment | null;
  label: string;
  leg: AutomationExecutionReconciliationPreview["authoritativeState"]["legs"]["spot"];
  tradable: AutomationResidualAssessment | null;
}) {
  return (
    <tr>
      <td className={tableCellClass}>{label}</td>
      <td className={`${tableCellClass} font-mono`}>{formatQuantity(leg.quantityXaut)} XAUT</td>
      <td className={`${tableCellClass} font-mono`}>{leg.freeQuantityXaut === null ? "-" : `${formatQuantity(leg.freeQuantityXaut)} XAUT`}</td>
      <td className={`${tableCellClass} font-mono`}>{leg.markPrice === null ? "-" : formatMoney(leg.markPrice)}</td>
      <td className={`${tableCellClass} font-mono`}>{formatSignedQuantity(diff)} XAUT</td>
      <td className={tableCellClass}>{tradable ? <ResidualDetail residual={tradable} /> : "无"}</td>
      <td className={tableCellClass}>{dust ? <ResidualDetail dust residual={dust} /> : "无"}</td>
    </tr>
  );
}

function ResidualDetail({
  dust = false,
  residual,
}: {
  dust?: boolean;
  residual: AutomationResidualAssessment;
}) {
  return (
    <span className="block min-w-48 text-xs leading-5">
      <span className={dust ? "text-amber-100" : "text-red-200"}>
        {dust ? "不可交易小额余额" : "仍有可交易残余"}：{formatQuantity(residual.quantityXaut)} XAUT · {formatMoney(residual.notionalUsd)}
      </span>
      <span className="block text-[11px] text-muted">
        minQty {formatQuantity(residual.minOrderQty)} · minNotional {formatMoney(residual.minNotionalUsd)} · stepSize {formatQuantity(residual.qtyStep)}
      </span>
    </span>
  );
}

function ReconciliationState({
  description,
  error = false,
  icon,
  title,
}: {
  description: string;
  error?: boolean;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div
      className={`flex min-h-36 flex-col items-center justify-center px-5 py-8 text-center ${error ? "text-red-100" : "text-slate-200"}`}
      role={error ? "alert" : "status"}
    >
      {icon}
      <strong className="mt-3 text-sm">{title}</strong>
      <p className="mt-2 max-w-2xl text-xs leading-5 text-muted">{description}</p>
    </div>
  );
}

function ReconciliationMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-[#101010] px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 break-words font-mono text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function AuthoritativeLegRow({ label, quantity }: { label: string; quantity: number }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-white">{formatQuantity(quantity)} XAUT</span>
    </div>
  );
}

export function authoritativeSummary(report: AutomationExecutionReconciliationPreview) {
  if (report.authoritativeState.stale || report.authoritativeState.status !== "ok") return null;
  const { perpetual, spot } = report.authoritativeState.legs;
  if (
    (spot.quantityXaut > 0 && spot.markPrice === null)
    || (perpetual.quantityXaut > 0 && perpetual.markPrice === null)
  ) return null;
  const spotNotional = spot.quantityXaut * (spot.markPrice ?? 0);
  const perpetualNotional = perpetual.quantityXaut * (perpetual.markPrice ?? 0);
  return {
    capitalUsedUsd: spotNotional + perpetualNotional,
    netDeltaUsd: spotNotional - perpetualNotional,
  };
}

function executionStateLabel(value: AutomationExecutionReconciliationPreview["recordedState"]) {
  return ({
    accepted: "已接受",
    opening_spot: "正在建立现货侧",
    opening_perpetual: "正在建立永续侧",
    partial_closed: "已部分退出",
    hedged: "已对冲",
    compensating: "安全补偿中",
    reconciled: "已对账结案",
    closed: "已关闭",
    failed: "执行失败",
    manual_intervention: "需要人工处理",
    unknown: "未知",
  } as const)[value];
}

function formatQuantity(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatSignedQuantity(value: number) {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatQuantity(value)}`;
}
