import { Ban, Power, ShieldAlert, ToggleLeft } from "lucide-react";
import React from "react";
import { Button } from "../../../components/ui/Button";
import type { AutomationConsoleSnapshot, SafetyAction } from "../model/controlConsoleTypes";
import { ConsoleSection, StatusTag, venueLabel } from "./AutomationConsoleShared";

export function AutomationSafety({ snapshot, onAction }: { snapshot: AutomationConsoleSnapshot; onAction: (action: SafetyAction, title: string, phrase: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="border border-red-400/35 bg-red-400/[0.055] px-4 py-4 sm:px-5"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 shrink-0 text-red-300" size={19} /><div><h2 className="text-sm font-semibold text-red-100">安全操作与普通设置隔离</h2><p className="mt-1 text-xs leading-5 text-red-100/75">所有动作都需要明确确认；退出动作即使开仓已关闭也必须保留。操作仅影响当前登录用户。</p></div></div></div>
      <ConsoleSection title="执行开关" description="当前写操作仅适用于 Bybit 受控执行账户；Binance 第一阶段只读，不受这些开仓开关驱动。">
        <div className="divide-y divide-white/10">
          <SafetyRow action={<Button onClick={() => onAction({ type: "toggle_global_execution", enabled: !snapshot.globalExecutionEnabled }, snapshot.globalExecutionEnabled ? "关闭我的真实执行" : "启用我的真实执行", snapshot.globalExecutionEnabled ? "关闭我的执行" : "启用我的执行")} type="button" variant={snapshot.globalExecutionEnabled ? "danger" : "secondary"}><Power size={15} />{snapshot.globalExecutionEnabled ? "关闭" : "启用"}</Button>} label="我的真实执行" status={<StatusTag tone={snapshot.globalExecutionEnabled ? "warning" : "neutral"}>{snapshot.globalExecutionEnabled ? "已启用" : "已关闭"}</StatusTag>} />
          <SafetyRow action={<Button onClick={() => onAction({ type: "toggle_strategy", enabled: !snapshot.strategyEnabled }, snapshot.strategyEnabled ? "停用中性套利策略" : "启用中性套利策略", snapshot.strategyEnabled ? "停用策略" : "启用策略")} type="button" variant="secondary"><ToggleLeft size={15} />{snapshot.strategyEnabled ? "停用" : "启用"}</Button>} label="同所黄金中性策略" status={<StatusTag tone={snapshot.strategyEnabled ? "success" : "neutral"}>{snapshot.strategyEnabled ? "运行中" : "已停用"}</StatusTag>} />
          {snapshot.credentials.map((credential) => <SafetyRow action={<span className="max-w-xs text-right text-xs text-muted">{credential.canExecute ? "由账户、策略与服务端门禁共同控制" : credential.canRunReadOnlyPreflight ? "仅可授权与只读条件检查，无写动作" : "当前不可用"}</span>} key={credential.venue} label={`${venueLabel(credential.venue)} connector`} status={<StatusTag tone={!credential.canRunReadOnlyPreflight ? "neutral" : credential.canExecute ? credential.enabled ? "success" : "warning" : "info"}>{!credential.canRunReadOnlyPreflight ? credential.implemented ? "能力未知" : "暂未接入" : credential.canExecute ? credential.enabled ? "服务端已启用" : "执行已关闭" : "只读 Shadow"}</StatusTag>} />)}
        </div>
      </ConsoleSection>
      <ConsoleSection title="紧急处置" description="仅处置当前用户的 Bybit 策略与仓位；Binance 第一阶段没有平台代理平仓或 close-all 写能力。">
        <div className="grid gap-px bg-white/10 lg:grid-cols-2">
          <DangerAction icon={<Ban size={20} />} title="Kill switch" description="立即阻断新开仓、补腿和再平衡，保留安全退出能力。" status={snapshot.killSwitchActive ? "急停已启用" : "待命"} action={<Button onClick={() => onAction({ type: "kill_switch" }, "触发 Kill switch", "触发急停")} type="button" variant="danger"><Ban size={15} />触发急停</Button>} />
          <DangerAction icon={<ShieldAlert size={20} />} title="Close all" description="请求服务端逐组合退出全部真实策略持仓，并保留完整订单与成交审计。" status="始终可用" action={<Button onClick={() => onAction({ type: "close_all" }, "退出全部真实策略持仓", "退出全部持仓")} type="button" variant="danger"><ShieldAlert size={15} />全部退出</Button>} />
        </div>
      </ConsoleSection>
    </div>
  );
}

function SafetyRow({ action, label, status }: { action: React.ReactNode; label: string; status: React.ReactNode }) { return <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div className="flex items-center gap-3"><span className="text-sm font-medium text-white">{label}</span>{status}</div>{action}</div>; }
function DangerAction({ action, description, icon, status, title }: { action: React.ReactNode; description: string; icon: React.ReactNode; status: string; title: string }) { return <div className="bg-[#101010] p-4 sm:p-5"><div className="flex items-start gap-3 text-red-200">{icon}<div><h3 className="text-sm font-semibold text-white">{title}</h3><p className="mt-1 text-xs text-red-100/70">{status}</p></div></div><p className="mt-4 min-h-10 text-xs leading-5 text-muted">{description}</p><div className="mt-4">{action}</div></div>; }
