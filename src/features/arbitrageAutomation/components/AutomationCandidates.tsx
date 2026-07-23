import { CircleOff, FileCheck2 } from "lucide-react";
import React from "react";
import { Button } from "../../../components/ui/Button";
import type { AutomationCandidate, AutomationPreflightMode } from "../model/controlConsoleTypes";
import {
  ConsoleSection,
  ScrollTable,
  StatusTag,
  formatMoney,
  formatPercent,
  tableCellClass,
  tableHeadClass,
  tableHeaderCellClass,
  venueLabel,
} from "./AutomationConsoleShared";

export function AutomationCandidates({ candidates, onPreflight }: { candidates: AutomationCandidate[]; onPreflight: (candidate: AutomationCandidate, mode: AutomationPreflightMode) => void }) {
  const preflightCount = candidates.filter(canPreflightCandidate).length;
  const eligibleCount = candidates.filter((candidate) => candidate.canExecute && candidate.safetyEligible && candidate.automationEligible).length;
  return (
    <ConsoleSection
      title="候选与执行"
      description="安全门槛、自动策略条件和 adapter 接入状态独立呈现；任何预检仍以服务端实时校验为准。"
      actions={<div className="flex flex-wrap gap-2"><StatusTag tone={preflightCount > 0 ? "success" : "warning"}>可预检 {preflightCount} 个</StatusTag><StatusTag tone={eligibleCount > 0 ? "success" : "neutral"}>自动策略 {eligibleCount} 个</StatusTag></div>}
    >
      {candidates.length === 0 ? (
        <div className="flex min-h-52 flex-col items-center justify-center px-5 text-center"><CircleOff className="text-muted" size={24} /><p className="mt-3 text-sm font-medium text-white">暂无套利候选</p><p className="mt-2 max-w-lg text-xs leading-5 text-muted">等待公开行情与服务端门禁生成候选，本页不会伪造可执行机会。</p></div>
      ) : (
        <ScrollTable minWidth={1420}>
          <colgroup><col className="w-[100px]" /><col className="w-[110px]" /><col className="w-[220px]" /><col className="w-[220px]" /><col className="w-[110px]" /><col className="w-[110px]" /><col className="w-[100px]" /><col className="w-[130px]" /><col className="w-[250px]" /><col className="w-[130px]" /></colgroup>
          <thead className={tableHeadClass}><tr><th className={tableHeaderCellClass}>交易所</th><th className={tableHeaderCellClass}>资产</th><th className={tableHeaderCellClass}>做多</th><th className={tableHeaderCellClass}>做空</th><th className={`${tableHeaderCellClass} text-center`}>净 APR</th><th className={`${tableHeaderCellClass} text-center`}>有利天数</th><th className={`${tableHeaderCellClass} text-center`}>基差</th><th className={`${tableHeaderCellClass} text-center`}>容量</th><th className={tableHeaderCellClass}>执行条件</th><th className={`${tableHeaderCellClass} text-right`}>操作</th></tr></thead>
          <tbody>{candidates.map((candidate) => {
            const preflightMode = candidate.automationEligible ? "arbitrage_entry" : "manual_entry";
            const preflightEnabled = canPreflightCandidate(candidate);
            return (
              <tr key={candidate.id}>
                <td className={tableCellClass}><strong className="text-white">{venueLabel(candidate.venue)}</strong></td>
                <td className={tableCellClass}>{candidate.asset}</td>
                <td className={tableCellClass}><Leg candidate={candidate.longLeg} /></td>
                <td className={tableCellClass}><Leg candidate={candidate.shortLeg} /></td>
                <td className={`${tableCellClass} text-center font-mono ${candidate.netApr > 0 ? "text-white" : "text-red-300"}`}>{formatPercent(candidate.netApr, true)}</td>
                <td className={`${tableCellClass} text-center font-mono`}>{formatPercent(candidate.favorableDayRatio)}</td>
                <td className={`${tableCellClass} text-center font-mono`}>{candidate.basisBps === null ? "-" : `${candidate.basisBps.toFixed(2)} bps`}</td>
                <td className={`${tableCellClass} text-center font-mono`}>{candidate.capacityUsd === null ? "-" : formatMoney(candidate.capacityUsd)}</td>
                <td className={tableCellClass}><CandidateConditions candidate={candidate} /></td>
                <td className={`${tableCellClass} text-right`}>
                  <Button className="min-h-9 whitespace-nowrap px-3 py-2 text-xs" disabled={!preflightEnabled} onClick={() => {
                    if (preflightEnabled) onPreflight(candidate, preflightMode);
                  }} type="button" variant="secondary">
                    <FileCheck2 size={14} />{candidate.canExecute ? candidate.automationEligible ? "自动策略预检" : "手动风险预检" : "条件检查"}
                  </Button>
                </td>
              </tr>
            );
          })}</tbody>
        </ScrollTable>
      )}
    </ConsoleSection>
  );
}

export function canPreflightCandidate(candidate: AutomationCandidate) {
  return candidate.adapterImplemented
    && candidate.canRunReadOnlyPreflight
    && candidate.safetyEligible
    && (!candidate.canExecute || candidate.executionReady);
}

function CandidateConditions({ candidate }: { candidate: AutomationCandidate }) {
  if (!candidate.adapterImplemented) {
    return <div><StatusTag tone="neutral">Adapter 未接入</StatusTag><p className="mt-2 text-xs leading-5 text-muted">该交易所暂不提供预检。</p></div>;
  }
  if (!candidate.canRunReadOnlyPreflight) {
    return <div><StatusTag tone="neutral">能力状态未知</StatusTag><p className="mt-2 text-xs leading-5 text-muted">服务端未明确开放当前阶段的预检能力。</p></div>;
  }
  if (!candidate.safetyEligible) {
    const reasons = candidate.safetyDisqualifiers.join("；") || "未通过实时安全校验";
    return <div><StatusTag tone="danger">安全阻断</StatusTag><p className="mt-2 line-clamp-2 text-xs leading-5 text-red-200/80" title={reasons}>{reasons}</p></div>;
  }
  if (candidate.canExecute && !candidate.executionReady) {
    return <div><StatusTag tone="warning">执行未就绪</StatusTag><p className="mt-2 text-xs leading-5 text-amber-100/75">请先完成 API 授权、执行与策略开关，并确认用户急停和服务端全局急停均已解除。</p></div>;
  }
  if (!candidate.automationEligible) {
    const reasons = candidate.automationDisqualifiers.join("；") || "当前条件不符合自动策略";
    return <div className="space-y-2"><div className="flex flex-wrap gap-1.5"><StatusTag tone="success">安全条件通过</StatusTag><StatusTag tone="warning">{candidate.canExecute ? "未达到自动策略条件" : "仅可检查"}</StatusTag></div><p className="line-clamp-2 text-xs leading-5 text-amber-100/75" title={reasons}>{reasons}</p></div>;
  }
  return <div className="flex flex-wrap gap-1.5"><StatusTag tone="success">安全条件通过</StatusTag><StatusTag tone={candidate.canExecute ? "success" : "warning"}>{candidate.canExecute ? "自动策略条件通过" : "仅可检查"}</StatusTag></div>;
}

function Leg({ candidate }: { candidate: AutomationCandidate["longLeg"] }) {
  return <div className="min-w-0"><p className="truncate font-medium text-white">{candidate.side === "long" ? "多" : "空"} · {candidate.symbol}</p><p className="mt-1 text-xs text-muted">{venueLabel(candidate.venue)} · {candidate.marketType === "spot" ? "现货" : "永续"}</p></div>;
}
