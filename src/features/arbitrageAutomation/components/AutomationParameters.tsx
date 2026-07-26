import { Save, ShieldAlert } from "lucide-react";
import React, { useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import type { AutomationParameter, AutomationVenue, AutomationVenueControl, ParameterDraft } from "../model/controlConsoleTypes";
import { ConsoleSection, StatusTag, venueLabel } from "./AutomationConsoleShared";

export function AutomationParameters({ controls, parameters, onValidate }: {
  controls: AutomationVenueControl[];
  parameters: AutomationParameter[];
  onValidate: (venue: AutomationVenue, draft: ParameterDraft) => Promise<void>;
}) {
  const [selectedVenue, setSelectedVenue] = useState<AutomationVenue>(() => controls.some((item) => item.venue === "binance") ? "binance" : controls[0]?.venue ?? "bybit");
  const selectedControl = controls.find((item) => item.venue === selectedVenue) ?? null;
  const selectedParameters = parameters.filter((parameter) => parameter.venue === selectedVenue);
  return (
    selectedControl ? (
      <VenueParameterForm
        controls={controls}
        control={selectedControl}
        key={selectedVenue}
        onValidate={onValidate}
        onVenueChange={setSelectedVenue}
        parameters={selectedParameters}
        selectedVenue={selectedVenue}
      />
    ) : <p className="border border-white/15 px-5 py-12 text-center text-sm text-muted">当前没有可配置的交易所。</p>
  );
}

function VenueParameterForm({ control, controls, parameters, onValidate, onVenueChange, selectedVenue }: {
  control: AutomationVenueControl;
  controls: AutomationVenueControl[];
  parameters: AutomationParameter[];
  onValidate: (venue: AutomationVenue, draft: ParameterDraft) => Promise<void>;
  onVenueChange: (venue: AutomationVenue) => void;
  selectedVenue: AutomationVenue;
}) {
  const initial = useMemo(() => Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.value])), [parameters]);
  const [draft, setDraft] = useState<ParameterDraft>(initial);
  const [saving, setSaving] = useState(false);
  const invalidIds = parameters.filter((parameter) => !Number.isFinite(draft[parameter.id]) || draft[parameter.id] < parameter.min || draft[parameter.id] > parameter.max).map((parameter) => parameter.id);
  const isDirty = parameters.some((parameter) => draft[parameter.id] !== initial[parameter.id]);
  const parameterGroups = (["global", "venue", "strategy"] as const)
    .map((scope) => ({
      scope,
      parameters: parameters.filter((parameter) => parameter.scope === scope),
    }))
    .filter((group) => group.parameters.length > 0);
  const submit = async () => { setSaving(true); try { await onValidate(control.venue, draft); } finally { setSaving(false); } };
  return (
    <ConsoleSection title={`${venueLabel(control.venue)} 策略参数`} description="当前用户的资金与策略边界；保存后由服务端重新校验并作为当前配置。" actions={<div className="flex flex-wrap gap-2"><StatusTag tone={control.enabled ? "success" : "neutral"}>{control.enabled ? "执行已就绪" : "执行未就绪"}</StatusTag><StatusTag tone={invalidIds.length > 0 ? "danger" : isDirty ? "warning" : "neutral"}>{invalidIds.length > 0 ? `${invalidIds.length} 项超出范围` : isDirty ? "待保存" : "未修改"}</StatusTag></div>}>
      <div className="flex min-w-0 flex-col gap-3 border-b border-white/10 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
        <span className="shrink-0 text-xs font-medium text-muted">交易所</span>
        <div className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto" role="tablist" aria-label="参数交易所">
          {controls.map((item) => <button aria-selected={selectedVenue === item.venue} className={`min-h-11 shrink-0 border px-4 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${selectedVenue === item.venue ? "border-white bg-white text-black" : "border-white/20 text-muted hover:border-white/50 hover:text-white"}`} key={item.venue} onClick={() => onVenueChange(item.venue)} role="tab" type="button">{venueLabel(item.venue)}</button>)}
        </div>
      </div>
      <div>
        {parameterGroups.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm font-medium text-slate-200">当前交易所暂无可配置参数</p>
            <p className="mt-1 text-xs leading-5 text-muted">参数由服务端策略配置决定，无需在此操作。</p>
          </div>
        ) : null}
        {parameterGroups.map(({ scope, parameters: scopeParameters }) => (
          <section className="grid min-w-0 border-b border-white/10 last:border-b-0 lg:grid-cols-[220px_minmax(0,1fr)]" key={scope}>
            <div className="flex items-start justify-between gap-4 bg-white/[0.018] px-4 py-4 sm:px-5 lg:block">
              <div>
                <h3 className="text-sm font-semibold text-white">{scopeLabel(scope)}</h3>
                <p className="mt-1 max-w-[42rem] text-xs leading-5 text-muted">{scopeDescription(scope)}</p>
              </div>
              <span className="shrink-0 font-mono text-xs tabular-nums text-dim lg:mt-3 lg:block">{scopeParameters.length} 项</span>
            </div>
            <div className="grid min-w-0 border-l border-t border-white/10 sm:grid-cols-2 lg:border-t-0">
              {scopeParameters.map((parameter, index) => {
                const spansRow = scope === "strategy"
                  || (scopeParameters.length % 2 === 1 && index === scopeParameters.length - 1);
                return (
                  <ParameterField
                    className={spansRow ? "sm:col-span-2" : undefined}
                    invalid={invalidIds.includes(parameter.id)}
                    key={parameter.id}
                    onChange={(value) => setDraft((current) => ({ ...current, [parameter.id]: value }))}
                    parameter={parameter}
                    wide={spansRow}
                    value={draft[parameter.id]}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <footer className="flex flex-col gap-3 border-t border-white/10 bg-black/30 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><p className="flex max-w-2xl items-start gap-2 text-xs leading-5 text-muted"><ShieldAlert className="mt-0.5 shrink-0" size={15} />保存后当前短效执行凭证失效；不会自动解除急停或启用真实执行。</p><Button className="sm:min-w-36" disabled={saving || !isDirty || invalidIds.length > 0 || parameters.length === 0} onClick={() => void submit()} type="button" variant="secondary"><Save size={15} />{saving ? "保存中" : "保存参数"}</Button></footer>
    </ConsoleSection>
  );
}

function ParameterField({ className, invalid, onChange, parameter, value, wide = false }: {
  className?: string;
  invalid: boolean;
  onChange: (value: number) => void;
  parameter: AutomationParameter;
  value: number;
  wide?: boolean;
}) {
  return (
    <label className={`min-w-0 border-b border-r border-white/10 bg-[#101010] p-4 ${wide ? "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(280px,400px)] lg:items-center lg:gap-8" : ""} ${className ?? ""}`}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{parameter.label}</span>
        <span className={`mt-1 block text-xs leading-5 text-muted ${wide ? "" : "min-h-10"}`}>{parameter.description}</span>
      </span>
      <span className="min-w-0">
        <span className={`mt-3 flex items-center border bg-black transition focus-within:border-white/60 ${wide ? "lg:mt-0" : ""} ${invalid ? "border-red-400/60" : "border-white/15"}`}>
          <input aria-invalid={invalid} className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm tabular-nums text-white outline-none" max={parameter.max} min={parameter.min} onChange={(event) => onChange(event.target.valueAsNumber)} step={parameter.step} type="number" value={Number.isFinite(value) ? value : ""} />
          <span className="shrink-0 border-l border-white/10 px-3 text-xs text-muted">{parameter.unit}</span>
        </span>
        <span className="mt-2 flex min-w-0 items-center justify-between gap-3 text-xs">
          <span className={invalid ? "text-red-300" : "text-dim"}>{invalid ? "超出范围" : `范围 ${parameter.min}–${parameter.max} ${parameter.unit}`}</span>
          <span className="min-w-0 max-w-[58%] truncate font-mono text-[10px] text-dim" title={parameter.scopeId}>{parameter.scopeId}</span>
        </span>
      </span>
    </label>
  );
}

function scopeLabel(scope: AutomationParameter["scope"]) { return scope === "global" ? "当前账户限制" : scope === "venue" ? "交易所限制" : "策略限制"; }
function scopeDescription(scope: AutomationParameter["scope"]) { return scope === "global" ? "仅适用于当前登录用户，跨 venue 和策略共享。" : scope === "venue" ? "单一交易所的连接与成交质量边界。" : "同所中性策略自身的入场、对冲和退出边界。"; }
