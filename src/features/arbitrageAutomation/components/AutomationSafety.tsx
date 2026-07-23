import { Ban, Power, ShieldAlert, ToggleLeft } from "lucide-react";
import React, { useState } from "react";
import { Button } from "../../../components/ui/Button";
import type { AutomationConsoleSnapshot, SafetyAction } from "../model/controlConsoleTypes";
import { ConsoleSection, StatusTag, venueLabel } from "./AutomationConsoleShared";

export function AutomationSafety({ snapshot, onAction }: { snapshot: AutomationConsoleSnapshot; onAction: (action: SafetyAction, title: string, phrase: string) => void }) {
  const controls = snapshot.venueControls;
  const [selectedVenue, setSelectedVenue] = useState(() => controls.some((item) => item.venue === "binance") ? "binance" as const : controls[0]?.venue ?? "bybit");
  const control = controls.find((item) => item.venue === selectedVenue) ?? null;
  return (
    <div className="space-y-4">
      <div className="border border-red-400/35 bg-red-400/[0.055] px-4 py-4 sm:px-5"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 shrink-0 text-red-300" size={19} /><div><h2 className="text-sm font-semibold text-red-100">安全操作与普通设置隔离</h2><p className="mt-1 text-xs leading-5 text-red-100/75">所有动作都需要明确确认；退出动作即使开仓已关闭也必须保留。操作仅影响当前登录用户。</p></div></div></div>
      <div className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto border-y border-white/10 py-3" role="tablist" aria-label="安全操作交易所">
        {controls.map((item) => <button aria-selected={selectedVenue === item.venue} className={`min-h-10 shrink-0 border px-4 text-sm font-semibold transition ${selectedVenue === item.venue ? "border-white bg-white text-black" : "border-white/20 text-muted hover:border-white/50 hover:text-white"}`} key={item.venue} onClick={() => setSelectedVenue(item.venue)} role="tab" type="button">{venueLabel(item.venue)}</button>)}
      </div>
      {control ? <>
      <ConsoleSection title={`${venueLabel(control.venue)} 执行开关`} description="三个用户级门禁必须同时就绪；服务端全局急停为只读状态，前端不能绕过。">
        <div className="divide-y divide-white/10">
          <SafetyRow action={<Button disabled={!control.accountId || (!control.globalExecutionEnabled && control.serverGlobalKillSwitchActive)} onClick={() => onAction({ type: "toggle_global_execution", venue: control.venue, enabled: !control.globalExecutionEnabled }, control.globalExecutionEnabled ? `关闭 ${venueLabel(control.venue)} 真实执行` : `启用 ${venueLabel(control.venue)} 真实执行`, control.globalExecutionEnabled ? "关闭我的执行" : "启用我的执行")} type="button" variant={control.globalExecutionEnabled ? "danger" : "secondary"}><Power size={15} />{control.globalExecutionEnabled ? "关闭" : "启用"}</Button>} label="我的真实执行" status={<StatusTag tone={control.globalExecutionEnabled ? "warning" : "neutral"}>{control.globalExecutionEnabled ? "已启用" : "已关闭"}</StatusTag>} />
          <SafetyRow action={<Button disabled={!control.accountId} onClick={() => onAction({ type: "toggle_strategy", venue: control.venue, enabled: !control.strategyEnabled }, control.strategyEnabled ? "停用 XAUT 对冲策略" : "启用 XAUT 对冲策略", control.strategyEnabled ? "停用策略" : "启用策略")} type="button" variant="secondary"><ToggleLeft size={15} />{control.strategyEnabled ? "停用" : "启用"}</Button>} label="XAUT 现货与永续对冲策略" status={<StatusTag tone={control.strategyEnabled ? "success" : "neutral"}>{control.strategyEnabled ? "已启用" : "已停用"}</StatusTag>} />
          <SafetyRow action={<Button disabled={!control.accountId} onClick={() => onAction({ type: "set_kill_switch", venue: control.venue, active: !control.killSwitchActive }, control.killSwitchActive ? `解除 ${venueLabel(control.venue)} 用户急停` : `触发 ${venueLabel(control.venue)} 用户急停`, control.killSwitchActive ? "解除用户急停" : "触发用户急停")} type="button" variant={control.killSwitchActive ? "secondary" : "danger"}><Ban size={15} />{control.killSwitchActive ? "解除急停" : "触发急停"}</Button>} label="当前用户 Kill switch" status={<StatusTag tone={control.killSwitchActive ? "danger" : "success"}>{control.killSwitchActive ? "已激活" : "未激活"}</StatusTag>} />
          <SafetyRow action={<span className="max-w-xs text-right text-xs text-muted">该状态由服务端运维控制，当前用户不能修改或绕过。</span>} label="服务端全局急停" status={<StatusTag tone={control.serverGlobalKillSwitchActive ? "danger" : "success"}>{control.serverGlobalKillSwitchActive ? "已激活" : "未激活"}</StatusTag>} />
        </div>
      </ConsoleSection>
      <ConsoleSection title="退出对冲组合" description={`仅退出当前用户在 ${venueLabel(control.venue)} 的 XAUT 现货与永续对冲组合，不影响其他用户或交易所。`}>
        <DangerAction icon={<ShieldAlert size={20} />} title="Close all" description="请求服务端撤销策略订单并退出两侧仓位；即使建立对冲组合已关闭，该安全退出入口仍保留。" status={control.accountId ? "可提交退出请求" : "尚未配置 API 账户"} action={<Button disabled={!control.accountId} onClick={() => onAction({ type: "close_all", venue: control.venue, idempotencyKey: actionKey(`close-all:${control.venue}`) }, `退出 ${venueLabel(control.venue)} 对冲组合`, "退出对冲组合")} type="button" variant="danger"><ShieldAlert size={15} />退出全部对冲组合</Button>} />
      </ConsoleSection>
      </> : <p className="border border-white/15 px-5 py-12 text-center text-sm text-muted">当前没有可操作的交易所。</p>}
    </div>
  );
}

function SafetyRow({ action, label, status }: { action: React.ReactNode; label: string; status: React.ReactNode }) { return <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div className="flex items-center gap-3"><span className="text-sm font-medium text-white">{label}</span>{status}</div>{action}</div>; }
function DangerAction({ action, description, icon, status, title }: { action: React.ReactNode; description: string; icon: React.ReactNode; status: string; title: string }) { return <div className="bg-[#101010] p-4 sm:p-5"><div className="flex items-start gap-3 text-red-200">{icon}<div><h3 className="text-sm font-semibold text-white">{title}</h3><p className="mt-1 text-xs text-red-100/70">{status}</p></div></div><p className="mt-4 min-h-10 text-xs leading-5 text-muted">{description}</p><div className="mt-4">{action}</div></div>; }
function actionKey(scope: string) { return `${scope}:${crypto.randomUUID()}`.slice(0, 100); }
