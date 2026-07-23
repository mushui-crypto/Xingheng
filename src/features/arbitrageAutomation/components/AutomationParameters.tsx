import { Save, ShieldAlert } from "lucide-react";
import React, { useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import type { AutomationParameter, ParameterDraft } from "../model/controlConsoleTypes";
import { ConsoleSection, StatusTag } from "./AutomationConsoleShared";

export function AutomationParameters({ parameters, onValidate }: { parameters: AutomationParameter[]; onValidate: (draft: ParameterDraft) => Promise<void> }) {
  const initial = useMemo(() => Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.value])), [parameters]);
  const [draft, setDraft] = useState<ParameterDraft>(initial);
  const [saving, setSaving] = useState(false);
  const invalidIds = parameters.filter((parameter) => !Number.isFinite(draft[parameter.id]) || draft[parameter.id] < parameter.min || draft[parameter.id] > parameter.max).map((parameter) => parameter.id);
  const submit = async () => { setSaving(true); try { await onValidate(draft); } finally { setSaving(false); } };
  return (
    <ConsoleSection title="策略参数" description="按当前账户、交易所、策略分层；前端范围检查仅改善体验，服务端始终为权威。" actions={<StatusTag tone={invalidIds.length > 0 ? "danger" : "neutral"}>{invalidIds.length > 0 ? `${invalidIds.length} 项超出范围` : "草稿未保存"}</StatusTag>}>
      <div className="divide-y divide-white/10">
        {(["global", "venue", "strategy"] as const).map((scope) => <section key={scope}><div className="flex items-center justify-between gap-4 bg-white/[0.02] px-4 py-3 sm:px-5"><div><h3 className="text-sm font-semibold text-white">{scopeLabel(scope)}</h3><p className="mt-1 text-xs text-muted">{scopeDescription(scope)}</p></div><StatusTag>{parameters.filter((parameter) => parameter.scope === scope).length} 项</StatusTag></div><div className="grid gap-px bg-white/10 sm:grid-cols-2 xl:grid-cols-3">{parameters.filter((parameter) => parameter.scope === scope).map((parameter) => <ParameterField invalid={invalidIds.includes(parameter.id)} key={parameter.id} onChange={(value) => setDraft((current) => ({ ...current, [parameter.id]: value }))} parameter={parameter} value={draft[parameter.id]} />)}</div></section>)}
      </div>
      <footer className="flex flex-col gap-3 border-t border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><p className="flex items-start gap-2 text-xs leading-5 text-muted"><ShieldAlert className="mt-0.5 shrink-0" size={15} />新增 venue 默认 disabled；参数保存不会自动启用交易所、策略或真实执行。</p><Button disabled={saving || invalidIds.length > 0} onClick={() => void submit()} type="button" variant="secondary"><Save size={15} />{saving ? "检查中" : "验证参数草稿"}</Button></footer>
    </ConsoleSection>
  );
}

function ParameterField({ invalid, onChange, parameter, value }: { invalid: boolean; onChange: (value: number) => void; parameter: AutomationParameter; value: number }) {
  return <label className="min-w-0 bg-[#101010] p-4 sm:p-5"><span className="flex items-center justify-between gap-3 text-sm font-medium text-white"><span>{parameter.label}</span><StatusTag tone={invalid ? "danger" : "neutral"}>{parameter.scopeId}</StatusTag></span><span className="mt-2 block min-h-10 text-xs leading-5 text-muted">{parameter.description}</span><span className="mt-3 flex items-center border border-white/15 bg-black focus-within:border-white/50"><input aria-invalid={invalid} className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-white outline-none" max={parameter.max} min={parameter.min} onChange={(event) => onChange(event.target.valueAsNumber)} step={parameter.step} type="number" value={Number.isFinite(value) ? value : ""} /><span className="shrink-0 border-l border-white/10 px-3 text-xs text-muted">{parameter.unit}</span></span><span className={`mt-2 block text-xs ${invalid ? "text-red-300" : "text-dim"}`}>服务端范围 {parameter.min}–{parameter.max} {parameter.unit}</span></label>;
}

function scopeLabel(scope: AutomationParameter["scope"]) { return scope === "global" ? "当前账户限制" : scope === "venue" ? "交易所限制" : "策略限制"; }
function scopeDescription(scope: AutomationParameter["scope"]) { return scope === "global" ? "仅适用于当前登录用户，跨 venue 和策略共享。" : scope === "venue" ? "单一交易所的连接与成交质量边界。" : "同所中性策略自身的入场、对冲和退出边界。"; }
