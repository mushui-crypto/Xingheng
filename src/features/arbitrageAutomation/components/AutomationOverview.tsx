import { AlertTriangle, CheckCircle2, PlugZap } from "lucide-react";
import React from "react";
import type { AutomationConsoleSnapshot } from "../model/controlConsoleTypes";
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

export function AutomationOverview({ snapshot }: { snapshot: AutomationConsoleSnapshot }) {
  const authorityIncomplete = snapshot.summary.positionAuthorityIncompleteCount > 0;
  return (
    <div className="space-y-4">
      <section className="grid overflow-hidden border-l border-t border-white/10 bg-[#101010] sm:grid-cols-2 xl:grid-cols-4" aria-label="套利自动化摘要">
        <SummaryMetric label="连接状态" value={`${snapshot.summary.connectedVenueCount} / ${snapshot.summary.totalVenueCount}`} detail="Bybit、Bitget、Binance、OKX" tone={snapshot.summary.connectedVenueCount === snapshot.summary.totalVenueCount ? "positive" : "warning"} />
        <SummaryMetric label="执行模式" value={snapshot.mode === "shadow" ? "Shadow" : "受控真实"} detail={snapshot.globalExecutionEnabled ? "我的执行已启用" : "我的执行关闭"} />
        <SummaryMetric
          label="自动策略候选"
          value={String(snapshot.summary.eligibleCandidateCount)}
          detail={`${snapshot.candidates.length} 个候选已评估`}
          help={snapshot.summary.eligibleCandidateCount === 0 ? "当前没有达到自动策略条件的候选。安全条件通过的机会仍可发起手动风险预检；安全阻断不能由前端绕过。" : "已同时通过安全门槛与自动策略条件的候选数量。"}
          tone={snapshot.summary.eligibleCandidateCount > 0 ? "positive" : "warning"}
        />
        <SummaryMetric
          label="总资金占用"
          value={authorityIncomplete ? "-" : formatMoney(snapshot.summary.totalCapitalUsedUsd)}
          detail={authorityIncomplete ? "等待重新核对交易所账户" : "仅策略组合资金占用"}
          help={authorityIncomplete ? `${snapshot.summary.positionAuthorityIncompleteCount} 个组合缺少可用的交易所最新数据；旧策略记录不会作为当前真实持仓。` : undefined}
          tone={authorityIncomplete ? "warning" : undefined}
        />
        <SummaryMetric
          label="净 Delta"
          value={authorityIncomplete ? "-" : formatMoney(snapshot.summary.netDeltaUsd, true)}
          detail={authorityIncomplete ? "旧策略记录不计入当前值" : "当前用户全部策略组合"}
          help={authorityIncomplete ? "等待重新核对交易所账户后再展示当前净 Delta，避免旧策略记录造成误导。" : undefined}
          tone={authorityIncomplete ? "warning" : pnlTone(-Math.abs(snapshot.summary.netDeltaUsd))}
        />
        <SummaryMetric label="累计净 PnL" value={formatMoney(snapshot.summary.cumulativeNetPnl, true)} detail="策略级口径" tone={pnlTone(snapshot.summary.cumulativeNetPnl)} />
        <SummaryMetric label="今日净 PnL" value={formatMoney(snapshot.summary.todayNetPnl, true)} detail="Funding、费用、滑点后" tone={pnlTone(snapshot.summary.todayNetPnl)} />
        <SummaryMetric label="Funding / 手续费" value={`${formatMoney(snapshot.summary.fundingPnl, true)} / ${formatMoney(-snapshot.summary.fees)}`} detail="策略归属，不使用账户总 PnL" />
      </section>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
        <ConsoleSection title="策略净 PnL" description="当前用户策略级时间序列，非交易所账户总权益。">
          <PnlChart snapshot={snapshot} />
        </ConsoleSection>
        <ConsoleSection title="当前告警" description={`${snapshot.alerts.length} 条未关闭告警`}>
          <div className="divide-y divide-white/10">
            {snapshot.alerts.map((alert) => (
              <div className="flex gap-3 px-4 py-4 sm:px-5" key={alert.id}>
                {alert.severity === "critical" ? <AlertTriangle className="mt-0.5 shrink-0 text-red-300" size={16} /> : alert.severity === "warning" ? <AlertTriangle className="mt-0.5 shrink-0 text-amber-200" size={16} /> : <CheckCircle2 className="mt-0.5 shrink-0 text-sky-200" size={16} />}
                <div className="min-w-0"><p className="text-sm leading-5 text-slate-200">{alert.message}</p><p className="mt-1 text-xs text-dim">{formatDate(alert.occurredAt)}</p></div>
              </div>
            ))}
          </div>
        </ConsoleSection>
      </div>

      <ConsoleSection title="交易所连接" description="Secret 永不回显；提现权限必须保持关闭。">
        <ScrollTable minWidth={920}>
          <thead className={tableHeadClass}><tr><th className={tableHeaderCellClass}>交易所</th><th className={tableHeaderCellClass}>状态</th><th className={tableHeaderCellClass}>账户模式</th><th className={tableHeaderCellClass}>权限</th><th className={tableHeaderCellClass}>IP 白名单</th><th className={tableHeaderCellClass}>最近验证</th></tr></thead>
          <tbody>{snapshot.credentials.map((credential) => (
            <tr key={credential.venue}>
              <td className={tableCellClass}><span className="inline-flex items-center gap-2 font-semibold text-white"><PlugZap size={15} />{venueLabel(credential.venue)}</span></td>
              <td className={tableCellClass}><div className="space-y-1.5"><StatusTag tone={credential.status === "connected" ? "success" : credential.status === "unconfigured" || credential.status === "not_implemented" ? "neutral" : "warning"}>{credential.status === "connected" ? "已连接" : credential.status === "unconfigured" ? "未配置" : credential.status === "not_implemented" ? "暂未接入" : "需处理"}</StatusTag><p className="text-xs text-muted">{credential.phaseLabel}</p>{credential.canExecute && !credential.enabled ? <p className="text-xs text-amber-200">执行门禁尚未全部就绪</p> : null}</div></td>
              <td className={tableCellClass}>{credential.accountMode ? accountModeLabel(credential.accountMode) : "-"}</td>
              <td className={tableCellClass}>{credential.status === "not_implemented" || credential.status === "unconfigured" ? "-" : <><span className="whitespace-nowrap">{credential.permissions.read ? "读取" : "无读取"} / {credential.permissions.spotTrade ? "现货" : "无现货"} / {credential.permissions.contractTrade ? credential.venue === "binance" ? "USD-M" : "合约" : credential.venue === "binance" ? "无 USD-M" : "无合约"}</span><span className={`ml-2 ${credential.permissions.withdraw ? "text-red-300" : "text-emerald-300"}`}>{credential.permissions.withdraw ? "提现已开启" : "提现关闭"}</span>{credential.venue === "binance" ? <p className="mt-1 text-xs text-muted">{credential.permissions.positionModeSupported ? "one-way 已确认" : "one-way 未确认"}</p> : null}</>}</td>
              <td className={tableCellClass}>{credential.ipWhitelistConfigured === true ? "已配置" : credential.ipWhitelistConfigured === false ? <span className="text-amber-200">未配置（建议）</span> : "-"}</td>
              <td className={tableCellClass}>{credential.lastVerifiedAt ? formatDate(credential.lastVerifiedAt) : "-"}</td>
            </tr>
          ))}</tbody>
        </ScrollTable>
      </ConsoleSection>
    </div>
  );
}

function accountModeLabel(value: string) {
  if (value === "single_asset_one_way") return "Single-Asset · one-way";
  if (value === "multi_assets_one_way") return "Multi-Assets · one-way";
  if (value === "uta") return "UTA";
  return value;
}

function PnlChart({ snapshot }: { snapshot: AutomationConsoleSnapshot }) {
  const points = snapshot.pnlSeries;
  if (points.length < 2) return <p className="px-5 py-10 text-center text-sm text-muted">暂无策略级 PnL 时间序列。</p>;
  const values = points.map((point) => point.netPnl);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const polyline = points.map((point, index) => {
    const x = 24 + (index / (points.length - 1)) * 552;
    const y = 150 - ((point.netPnl - min) / range) * 112;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-end justify-between gap-4"><div><p className="text-xs text-muted">当前策略净 PnL</p><p className="mt-1 font-mono text-xl font-semibold text-white">{formatMoney(values.at(-1) ?? 0, true)}</p></div><p className="text-right text-xs text-dim">最低 {formatMoney(min)}<br />最高 {formatMoney(max)}</p></div>
      <svg aria-label="策略净 PnL 时间序列" className="mt-4 h-44 w-full" preserveAspectRatio="none" role="img" viewBox="0 0 600 176">
        <line stroke="rgba(255,255,255,0.1)" x1="24" x2="576" y1="38" y2="38" />
        <line stroke="rgba(255,255,255,0.1)" x1="24" x2="576" y1="94" y2="94" />
        <line stroke="rgba(255,255,255,0.1)" x1="24" x2="576" y1="150" y2="150" />
        <polyline fill="none" points={polyline} stroke="#f5f5f5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
