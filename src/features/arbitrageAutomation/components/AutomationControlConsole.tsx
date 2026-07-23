import { Activity, CandlestickChart, CheckCircle2, KeyRound, Settings2, ShieldAlert, SlidersHorizontal, XCircle } from "lucide-react";
import React, { useState } from "react";
import { isAccountMismatchError, isCredentialActivationReady, presentAutomationConsoleError } from "../../../api/arbitrageAutomationConsole";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { Toast, useTradingToast } from "../../trading/components/TradingFeedback";
import type {
  AutomationCandidate,
  AutomationConsoleClient,
  AutomationConsoleSnapshot,
  AutomationConsoleTab,
  AutomationPreflight,
  AutomationPreflightMode,
  AutomationShadowCheck,
  CredentialDraft,
  ParameterDraft,
  SafetyAction,
} from "../model/controlConsoleTypes";
import { AutomationCandidates } from "./AutomationCandidates";
import { AutomationCredentials } from "./AutomationCredentials";
import { AutomationOverview } from "./AutomationOverview";
import { AutomationParameters } from "./AutomationParameters";
import { AutomationPositions } from "./AutomationPositions";
import { AutomationSafety } from "./AutomationSafety";
import { StatusTag, formatDate, formatMoney, venueLabel } from "./AutomationConsoleShared";

const tabs: Array<{ id: AutomationConsoleTab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "总览", icon: <Activity size={15} /> },
  { id: "candidates", label: "候选与执行", icon: <CandlestickChart size={15} /> },
  { id: "positions", label: "持仓与盈亏", icon: <SlidersHorizontal size={15} /> },
  { id: "credentials", label: "API 账户", icon: <KeyRound size={15} /> },
  { id: "parameters", label: "参数", icon: <Settings2 size={15} /> },
  { id: "safety", label: "安全操作", icon: <ShieldAlert size={15} /> },
];

type PendingSafetyConfirmation = { action: SafetyAction; title: string; phrase: string };

export function AutomationControlConsole({ client, onReload, snapshot }: { client: AutomationConsoleClient; onReload: () => Promise<void>; snapshot: AutomationConsoleSnapshot }) {
  const [activeTab, setActiveTab] = useState<AutomationConsoleTab>("overview");
  const [preflight, setPreflight] = useState<AutomationPreflight | null>(null);
  const [shadowCheck, setShadowCheck] = useState<AutomationShadowCheck | null>(null);
  const [preflightChecks, setPreflightChecks] = useState<Record<number, boolean>>({});
  const [preflightPhrase, setPreflightPhrase] = useState("");
  const [safetyConfirmation, setSafetyConfirmation] = useState<PendingSafetyConfirmation | null>(null);
  const [safetyPhrase, setSafetyPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const { dismissToast, showToast, toast } = useTradingToast();

  const handleContractError = async (error: unknown) => {
    if (isAccountMismatchError(error)) await onReload();
    showContractError(error, showToast);
  };

  const requestPreflight = async (candidate: AutomationCandidate, mode: AutomationPreflightMode) => {
    setBusy(true);
    try {
      const result = await client.requestPreflight(candidate.id, mode);
      if (isShadowCheck(result)) {
        setShadowCheck(result);
        setPreflight(null);
      } else {
        setPreflight(result);
        setShadowCheck(null);
        setPreflightChecks({});
        setPreflightPhrase("");
      }
    } catch (error) {
      await handleContractError(error);
    } finally {
      setBusy(false);
    }
  };

  const confirmPreflight = async () => {
    if (!preflight) return;
    setBusy(true);
    try {
      const receipt = await client.confirmExecution(preflight.challengeId);
      showToast(receipt.message, receipt.simulated ? "warning" : "success");
      setPreflight(null);
    } catch (error) {
      await handleContractError(error);
    } finally {
      setBusy(false);
    }
  };

  const validateCredential = async (draft: CredentialDraft) => {
    try {
      const credential = await client.validateCredential(draft);
      if (!isCredentialActivationReady(credential)) {
        throw new Error("服务端签名、交易权限、提现关闭或账户模式验证未全部通过；旧连接保持不变。");
      }
      showToast(
        draft.venue === "binance"
          ? "Binance API 只读授权验证已通过；Secret 已清空，实盘执行仍未开放。"
          : `${venueLabel(draft.venue)} API 授权已通过服务端验证；Secret 已从表单清空。`,
        "success",
      );
      await onReload();
    } catch (error) {
      await handleContractError(error);
      throw error;
    }
  };

  const deleteCredential = async (accountId: string) => {
    try {
      const receipt = await client.deleteCredential(accountId);
      showToast(receipt.message, "warning");
      await onReload();
    } catch (error) {
      await handleContractError(error);
      throw error;
    }
  };

  const validateParameters = async (draft: ParameterDraft) => {
    try {
      const receipt = await client.validateParameters(draft);
      showToast(receipt.message, "success");
    } catch (error) {
      await handleContractError(error);
    }
  };

  const performSafetyAction = async () => {
    if (!safetyConfirmation) return;
    setBusy(true);
    try {
      const receipt = await client.performSafetyAction(safetyConfirmation.action);
      showToast(receipt.message, "warning");
      setSafetyConfirmation(null);
      setSafetyPhrase("");
    } catch (error) {
      await handleContractError(error);
    } finally {
      setBusy(false);
    }
  };

  const allPreflightChecks = preflight ? preflight.confirmations.every((_, index) => preflightChecks[index]) : false;
  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-3 border border-red-400/25 bg-red-400/[0.045] px-4 py-3 text-xs text-red-100 sm:flex-row sm:items-center sm:justify-between sm:px-5" aria-label="Mainnet 真实执行边界">
        <div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 shrink-0" size={15} /><p className="leading-5"><strong className="font-semibold">Mainnet 能力边界</strong><span className="ml-2 text-red-100/75">Bybit 真实执行需要服务端 preflight 与二次确认；Binance 第一阶段仅开放凭证验证和只读 Shadow 检查。</span></p></div>
        <div className="flex shrink-0 flex-wrap gap-2"><StatusTag tone={snapshot.mode === "shadow" ? "info" : "warning"}>{snapshot.mode === "shadow" ? "Shadow" : "受控真实"}</StatusTag><StatusTag tone={snapshot.killSwitchActive ? "danger" : "success"}>{snapshot.killSwitchActive ? "急停开启" : "急停待命"}</StatusTag></div>
      </section>

      <nav className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto border-b border-white/15" aria-label="套利自动化控制台">
        {tabs.map((tab) => <button aria-current={activeTab === tab.id ? "page" : undefined} className={`inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition ${activeTab === tab.id ? "border-white text-white" : "border-transparent text-muted hover:border-white/30 hover:text-white"}`} key={tab.id} onClick={() => setActiveTab(tab.id)} type="button">{tab.icon}{tab.label}</button>)}
      </nav>

      {activeTab === "overview" ? <AutomationOverview snapshot={snapshot} /> : null}
      {activeTab === "candidates" ? <AutomationCandidates candidates={snapshot.candidates} onPreflight={(candidate, mode) => void requestPreflight(candidate, mode)} /> : null}
      {activeTab === "positions" ? <AutomationPositions groups={snapshot.positionGroups} onClose={async (positionId) => { try { const receipt = await client.closePosition(positionId); showToast(receipt.message, "warning"); await onReload(); } catch (error) { await handleContractError(error); } }} writableVenues={snapshot.credentials.filter((credential) => credential.canExecute).map((credential) => credential.venue)} /> : null}
      {activeTab === "credentials" ? <AutomationCredentials credentials={snapshot.credentials} onDelete={deleteCredential} onFeedback={showToast} onGoToSafety={() => setActiveTab("safety")} onValidate={validateCredential} productionEgressIps={snapshot.productionEgressIps} /> : null}
      {activeTab === "parameters" ? <AutomationParameters onValidate={validateParameters} parameters={snapshot.parameters} /> : null}
      {activeTab === "safety" ? <AutomationSafety onAction={(action, title, phrase) => { setSafetyConfirmation({ action, title, phrase }); setSafetyPhrase(""); }} snapshot={snapshot} /> : null}

      <Modal closeDisabled={busy} onClose={() => setPreflight(null)} open={preflight !== null} title={preflight?.mode === "manual_entry" ? "手动风险预检" : "自动策略预检"} description={preflight?.mode === "manual_entry" ? "该机会已通过安全门槛，但未达到自动策略条件；提交时服务端仍会重新校验安全状态。" : "短效 challenge 仅在服务端门禁通过后生成；提交时服务端会再次读取实时状态。"} shellClassName="max-w-[820px]">
        {preflight ? <div className="space-y-4"><PreflightModeNotice mode={preflight.mode} /><PreflightWarnings warnings={preflight.warnings} /><div className="grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-4"><PreflightMetric label="执行账户" value={preflight.accountId} /><PreflightMetric label="有效期" value={formatDate(preflight.expiresAt)} /><PreflightMetric label="预计所需资金" value={formatMoney(preflight.estimatedCapitalRequiredUsd)} /><PreflightMetric label="总预算上限" value={formatMoney(preflight.totalBudgetUsd)} /><PreflightMetric label="预计总费用" value={optionalMoney(preflight.estimatedTotalFeesUsd)} /><PreflightMetric label="预计滑点" value={optionalMoney(preflight.estimatedSlippageUsd)} /><PreflightMetric label="最大损失" value={optionalMoney(preflight.maximumLossUsd)} /><PreflightMetric label="预检类型" value={preflight.mode === "manual_entry" ? "手动决策" : "自动策略"} /></div><div className="overflow-x-auto border border-white/10"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b border-white/10 bg-white/[0.025] text-xs text-muted"><tr><th className="px-3 py-2">腿</th><th className="px-3 py-2">交易所 / 品种</th><th className="px-3 py-2">精确数量</th><th className="px-3 py-2">参考价格</th><th className="px-3 py-2">预计费用</th></tr></thead><tbody>{preflight.exactLegs.map((leg) => <tr className="border-b border-white/[0.07]" key={`${leg.venue}:${leg.symbol}:${leg.side}`}><td className="px-3 py-3">{leg.side === "buy" ? "买入" : "卖出"}</td><td className="px-3 py-3">{venueLabel(leg.venue)} · <span className="font-mono">{leg.symbol}</span></td><td className="px-3 py-3 font-mono">{leg.quantity}</td><td className="px-3 py-3 font-mono">{leg.referencePrice}</td><td className="px-3 py-3 font-mono">{optionalMoney(leg.estimatedFeeUsd)}</td></tr>)}</tbody></table></div><div className="space-y-2">{preflight.confirmations.map((label, index) => <label className="flex cursor-pointer items-start gap-3 border border-white/10 p-3 text-sm text-slate-200" key={label}><input checked={Boolean(preflightChecks[index])} className="mt-0.5" onChange={(event) => setPreflightChecks((current) => ({ ...current, [index]: event.target.checked }))} type="checkbox" /><span>{label}</span></label>)}</div><label className="xh-account-modal-field"><span>输入“确认执行”完成二次确认</span><input autoComplete="off" className="xh-account-modal-control" onChange={(event) => setPreflightPhrase(event.target.value)} type="text" value={preflightPhrase} /></label><Button className="w-full" disabled={busy || !allPreflightChecks || preflightPhrase !== "确认执行"} onClick={() => void confirmPreflight()} type="button" variant="danger">{busy ? "确认中" : "确认 Mainnet 执行"}</Button></div> : null}
      </Modal>

      <Modal onClose={() => setShadowCheck(null)} open={shadowCheck !== null} title="Binance 只读条件检查" description="该结果来自实时账户与市场只读检查。第一阶段不签发 challenge，不会发送订单或执行任何资金动作。" shellClassName="max-w-[860px]">
        {shadowCheck ? <ShadowCheckResult report={shadowCheck} /> : null}
      </Modal>

      <Modal closeDisabled={busy} onClose={() => setSafetyConfirmation(null)} open={safetyConfirmation !== null} title={safetyConfirmation?.title ?? "确认安全操作"} description="该操作只影响当前用户的自动套利账户；服务端仍会校验 accountId 与实时状态。">
        {safetyConfirmation ? <div className="space-y-4"><div className="border border-red-400/30 bg-red-400/[0.06] p-4 text-sm leading-6 text-red-100">执行前请核对当前持仓、在途订单、策略状态和退出风险。真实接入后仍以服务端二次校验结果为准。</div><label className="xh-account-modal-field"><span>输入“{safetyConfirmation.phrase}”确认</span><input autoComplete="off" className="xh-account-modal-control" onChange={(event) => setSafetyPhrase(event.target.value)} type="text" value={safetyPhrase} /></label><Button className="w-full" disabled={busy || safetyPhrase !== safetyConfirmation.phrase} onClick={() => void performSafetyAction()} type="button" variant="danger">{busy ? "处理中" : "确认操作"}</Button></div> : null}
      </Modal>
      <Toast onDismiss={dismissToast} toast={toast} />
    </div>
  );
}

function PreflightMetric({ label, value }: { label: string; value: string }) { return <div className="bg-[#101010] p-3"><p className="text-xs text-muted">{label}</p><p className="mt-2 font-mono text-sm font-semibold text-white">{value}</p></div>; }
function ShadowCheckResult({ report }: { report: AutomationShadowCheck }) {
  const availability = report.productAvailability;
  return (
    <div className="space-y-4">
      <div className={`border p-4 text-sm leading-6 ${report.marketChecksPassed ? "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100" : "border-red-400/30 bg-red-400/[0.06] text-red-100"}`}>
        <div className="flex items-start gap-3">
          {report.marketChecksPassed ? <CheckCircle2 className="mt-0.5 shrink-0" size={18} /> : <XCircle className="mt-0.5 shrink-0" size={18} />}
          <div><strong className="font-semibold">{report.marketChecksPassed ? "市场与账户只读检查通过" : "只读检查未通过"}</strong><p className="mt-1 text-xs leading-5 opacity-80">{report.message}</p><p className="mt-2 text-xs font-semibold">实盘执行未开放，不会生成 challenge。</p></div>
        </div>
      </div>
      <div className="grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
        <PreflightMetric label="账户" value={report.accountId} />
        <PreflightMetric label="计划数量" value={optionalNumber(report.quantityXaut, " XAUT")} />
        <PreflightMetric label="总预算上限" value={optionalMoney(report.totalBudgetUsd)} />
        <PreflightMetric label="预计资金" value={optionalMoney(report.estimatedCapitalRequiredUsd)} />
        <PreflightMetric label="现货参考价" value={optionalNumber(report.referenceSpotAsk)} />
        <PreflightMetric label="永续参考价" value={optionalNumber(report.referencePerpetualBid)} />
        <PreflightMetric label="入场基差" value={optionalNumber(report.entryBasisBps, " bps")} />
        <PreflightMetric label="估算净 APR" value={report.estimatedNetAprPercent === null ? "服务端未提供" : `${report.estimatedNetAprPercent.toFixed(2)}%`} />
      </div>
      <div className="border border-white/10">
        <div className="border-b border-white/10 px-4 py-3"><h3 className="text-sm font-semibold text-white">XAUT 产品双腿</h3></div>
        <div className="grid gap-px bg-white/10 sm:grid-cols-2">
          <ShadowProductLeg label="现货腿" symbol={availability?.spotSymbol ?? "XAUTUSDT"} available={availability ? availability.status === "available" || availability.status === "perpetual_unavailable" : null} />
          <ShadowProductLeg label="USD-M 永续腿" symbol={availability?.perpetualSymbol ?? "XAUTUSDT"} available={availability ? availability.status === "available" || availability.status === "spot_unavailable" : null} />
        </div>
        {availability?.message ? <p className="border-t border-white/10 px-4 py-3 text-xs leading-5 text-amber-100">{availability.message}</p> : null}
      </div>
      <div className="border border-white/10">
        <div className="border-b border-white/10 px-4 py-3"><h3 className="text-sm font-semibold text-white">实时检查项</h3><p className="mt-1 text-xs text-muted">{report.checks.filter((check) => check.passed).length} / {report.checks.length} 通过</p></div>
        <div className="divide-y divide-white/10">{report.checks.map((check) => <div className="flex items-start gap-3 px-4 py-3" key={check.id}>{check.passed ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-300" size={16} /> : <XCircle className="mt-0.5 shrink-0 text-red-300" size={16} />}<div><p className="font-mono text-xs text-slate-200">{check.id}</p><p className="mt-1 text-xs leading-5 text-muted">{check.message}</p></div></div>)}</div>
      </div>
      <PreflightWarnings warnings={report.warnings} />
    </div>
  );
}
function ShadowProductLeg({ available, label, symbol }: { available: boolean | null; label: string; symbol: string }) {
  const text = available === null ? "未知" : available ? "可用" : "不可用";
  const color = available === null ? "text-amber-200" : available ? "text-emerald-200" : "text-red-200";
  return <div className="bg-[#101010] p-4"><p className="text-xs text-muted">{label}</p><p className="mt-2 font-mono text-sm font-semibold text-white">{symbol}</p><p className={`mt-1 text-xs ${color}`}>{text}</p></div>;
}
export function PreflightModeNotice({ mode }: { mode: AutomationPreflightMode }) {
  return mode === "manual_entry"
    ? <div className="border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm leading-6 text-amber-100"><strong className="font-semibold">由用户手动决策</strong><p className="mt-1 text-xs leading-5 text-amber-100/80">收益、Funding、基差和持续性仅是风险提示，不构成系统推荐；手动预检不会绕过任何安全门槛。</p></div>
    : <div className="border border-white/10 p-4 text-sm leading-6 text-slate-200"><strong className="font-semibold text-white">自动策略条件已通过</strong><p className="mt-1 text-xs leading-5 text-muted">仍需核对服务端实时预检、执行账户、两腿数量和总预算。</p></div>;
}
export function PreflightWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return <div className="border border-amber-400/30 p-4"><p className="text-sm font-semibold text-amber-100">服务端实时风险提示</p><ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100/80">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul></div>;
}
function optionalMoney(value: number | null) { return value === null ? "服务端未提供" : formatMoney(value); }
function optionalNumber(value: number | null, suffix = "") { return value === null ? "服务端未提供" : `${value.toLocaleString("en-US", { maximumFractionDigits: 8 })}${suffix}`; }
function isShadowCheck(value: AutomationPreflight | AutomationShadowCheck): value is AutomationShadowCheck {
  return "kind" in value && value.kind === "shadow_check";
}

function showContractError(error: unknown, showToast: (message: string, tone?: "error" | "info" | "success" | "warning") => void) {
  const presentation = presentAutomationConsoleError(error);
  showToast(`${presentation.title}：${presentation.message}`, "error");
}
