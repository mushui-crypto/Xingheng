import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  confirmArbitrageExecution,
  confirmArbitrageExecutionLeg,
  fetchArbitrageExecutionDraft,
  previewArbitrageExecutionDraft,
  reconcileArbitrageExecutionLeg,
  type ArbitrageExecutionDraft,
  type ArbitrageExecutionDraftLeg,
  type ArbitrageLegExecutionConfirmation,
  type ExecutionQuantityInput,
} from "../../../api/arbitrageExecutionDraft";
import { fetchArbitrageInstanceById, type ArbitrageInstance, type ArbitrageInstanceLeg } from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Modal } from "../../../components/ui/Modal";
import { Select } from "../../../components/ui/Select";
import type { ArbitrageHorizon } from "../model/types";

export function ArbitrageExecutionDraftEntry({
  horizonDays,
  opportunityId,
  resumeArbitrageId = null,
}: {
  horizonDays: ArbitrageHorizon;
  opportunityId: string;
  resumeArbitrageId?: string | null;
}) {
  const resumeMode = Boolean(resumeArbitrageId);
  const [open, setOpen] = useState(resumeMode);
  const [draft, setDraft] = useState<ArbitrageExecutionDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ExecutionQuantityInput["mode"]>("NOTIONAL_USDT");
  const [amount, setAmount] = useState("");
  const [executionMode, setExecutionMode] = useState("PRICE_PRIORITY");
  const [validationNotice, setValidationNotice] = useState("");
  const [instance, setInstance] = useState<ArbitrageInstance | null>(null);
  const [executionResults, setExecutionResults] = useState<Record<string, ArbitrageLegExecutionConfirmation["executionRecord"]>>({});
  const [confirmationId, setConfirmationId] = useState("");
  const [commandIds, setCommandIds] = useState<Record<string, string>>({});
  const [resumeValidated, setResumeValidated] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setValidationNotice("");
    const request = resumeArbitrageId
      ? loadResumeContext(resumeArbitrageId, opportunityId, horizonDays, controller.signal)
      : fetchArbitrageExecutionDraft(opportunityId, horizonDays, controller.signal).then((nextDraft) => ({ draft: nextDraft }));
    void request
      .then((result) => {
        if (controller.signal.aborted) return;
        setDraft(result.draft);
        if ("instance" in result) {
          setInstance(result.instance);
          setMode("ASSET_QUANTITY");
          setAmount(result.quantity);
          setExecutionMode(result.executionMode);
          setConfirmationId(createClientCommandId("resume"));
          setResumeValidated(true);
          setValidationNotice(`已进入继续现有实例模式。请重新核对机会、${result.quantity} ${result.assetSymbol} 数量和两条腿后，再人工确认待执行腿。`);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResumeValidated(false);
          setError(resumeArbitrageId ? "当前实例无法继续，需要重新处理" : "套利执行草案加载失败，请稍后重试。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [horizonDays, open, opportunityId, resumeArbitrageId]);

  async function planQuantity() {
    if (!amount.trim()) {
      setError(mode === "NOTIONAL_USDT" ? "请输入 USDT 名义金额。" : "请输入资产数量。");
      return;
    }
    const quantityInput: ExecutionQuantityInput = mode === "NOTIONAL_USDT"
      ? { mode, amountUsdt: amount.trim() }
      : { mode, quantity: amount.trim() };
    setLoading(true);
    setError("");
    setValidationNotice("");
    try {
      setDraft(await previewArbitrageExecutionDraft(opportunityId, horizonDays, quantityInput));
    } catch {
      setError("套利数量计划生成失败，请检查输入后重试。");
    } finally {
      setLoading(false);
    }
  }

  function close() {
    if (loading) return;
    setOpen(false);
    setDraft(null);
    setError("");
    setValidationNotice("");
    setInstance(null);
    setExecutionResults({});
    setCommandIds({});
    setResumeValidated(false);
  }

  function openConfirmation() {
    setConfirmationId(createClientCommandId("confirmation"));
    setOpen(true);
  }

  function currentQuantityInput(): ExecutionQuantityInput | null {
    if (!amount.trim()) return null;
    return mode === "NOTIONAL_USDT"
      ? { mode, amountUsdt: amount.trim() }
      : { mode, quantity: amount.trim() };
  }

  async function confirmInstance() {
    const quantityInput = currentQuantityInput();
    if (resumeMode || !draft || !quantityInput || !canConfirmDraft(draft)) return;
    setLoading(true);
    setError("");
    try {
      const result = await confirmArbitrageExecution({
        confirmationId,
        opportunityId,
        horizonDays,
        quantityInput,
        executionMode: executionMode as "PRICE_PRIORITY" | "EXECUTION_PRIORITY",
      });
      setInstance(result.instance);
      setValidationNotice(result.created ? "套利实例已创建。请选择要先执行的套利腿。" : "已恢复此前创建的套利实例。");
    } catch {
      setError("最终确认未通过；服务端已重新校验机会、规则、报价和执行能力。");
    } finally {
      setLoading(false);
    }
  }

  async function executeLeg(legId: string) {
    const quantityInput = currentQuantityInput();
    if (!instance || !quantityInput || (resumeMode && !resumeValidated) || !canExecuteLeg(instance, legId)) return;
    const commandId = commandIds[legId] ?? createClientCommandId(`leg-${legId}`);
    setCommandIds((current) => ({ ...current, [legId]: commandId }));
    setLoading(true);
    setError("");
    try {
      const result = await confirmArbitrageExecutionLeg({
        confirmationId,
        commandId,
        opportunityId,
        horizonDays,
        quantityInput,
        executionMode: executionMode as "PRICE_PRIORITY" | "EXECUTION_PRIORITY",
        arbitrageId: instance.arbitrageId,
        legId,
      });
      setInstance(result.instance);
      setExecutionResults((current) => ({ ...current, [legId]: result.executionRecord }));
      setValidationNotice(executionNotice(result.executionRecord.status, result.secondLegAllowed));
    } catch {
      if (resumeMode) setResumeValidated(false);
      setError(resumeMode ? "当前实例无法继续，需要重新处理" : "该套利腿执行状态未能安全确认。实例和执行引用已保留，请勿重复提交。");
    } finally {
      setLoading(false);
    }
  }

  async function reconcileLeg(legId: string) {
    if (!instance || !canReconcileLeg(instance, legId)) return;
    setLoading(true);
    setError("");
    try {
      const result = await reconcileArbitrageExecutionLeg({ arbitrageId: instance.arbitrageId, legId });
      setInstance(result.instance);
      setExecutionResults((current) => ({ ...current, [legId]: result.executionRecord }));
      setValidationNotice(reconciliationNotice(result.executionRecord.status, result.secondLegAllowed));
    } catch {
      setError("套利腿执行状态核验失败，请稍后重试；系统未提交任何新订单。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" onClick={openConfirmation}>
        <ShieldCheck aria-hidden="true" size={15} /> {resumeMode ? "继续开仓" : "创建套利"}
      </Button>
      <Modal
        bodyClassName="max-h-[75vh] overflow-y-auto"
        closeDisabled={loading}
        description={resumeMode ? "继续使用现有套利实例；服务端会重新校验机会、source-plan、账户和数量，不会创建替代实例。" : "预览只生成草案；最终确认时服务端会重新校验权威机会、规则和报价，通过后才创建套利实例。每条腿仍需单独人工确认。"}
        onClose={close}
        open={open}
        shellClassName="max-w-5xl"
        title={resumeMode ? "继续现有套利实例" : "确认创建套利"}
      >
        <ArbitrageExecutionDraftContent
          amount={amount}
          draft={draft}
          error={error}
          executionResults={executionResults}
          executionMode={executionMode}
          instance={instance}
          loading={loading}
          mode={mode}
          resumeMode={resumeMode}
          resumeValidated={resumeValidated}
          onAmountChange={setAmount}
          onCancel={close}
          onConfirm={() => void confirmInstance()}
          onExecuteLeg={(legId) => void executeLeg(legId)}
          onReconcileLeg={(legId) => void reconcileLeg(legId)}
          onExecutionModeChange={setExecutionMode}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            setAmount("");
            setValidationNotice("");
          }}
          onPlan={() => void planQuantity()}
          validationNotice={validationNotice}
        />
      </Modal>
    </>
  );
}

export function ArbitrageExecutionDraftContent({
  amount,
  draft,
  error,
  executionResults = {},
  executionMode,
  instance = null,
  loading,
  mode,
  resumeMode = false,
  resumeValidated = false,
  onAmountChange,
  onCancel,
  onConfirm,
  onExecuteLeg = () => undefined,
  onReconcileLeg = () => undefined,
  onExecutionModeChange,
  onModeChange,
  onPlan,
  validationNotice,
}: {
  amount: string;
  draft: ArbitrageExecutionDraft | null;
  error: string;
  executionResults?: Record<string, ArbitrageLegExecutionConfirmation["executionRecord"]>;
  executionMode: string;
  instance?: ArbitrageInstance | null;
  loading: boolean;
  mode: ExecutionQuantityInput["mode"];
  resumeMode?: boolean;
  resumeValidated?: boolean;
  onAmountChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onExecuteLeg?: (legId: string) => void;
  onReconcileLeg?: (legId: string) => void;
  onExecutionModeChange: (value: string) => void;
  onModeChange: (value: ExecutionQuantityInput["mode"]) => void;
  onPlan: () => void;
  validationNotice: string;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Select
          disabled={resumeMode}
          label="数量输入方式"
          onChange={(event) => onModeChange(event.target.value as ExecutionQuantityInput["mode"])}
          options={[
            { value: "NOTIONAL_USDT", label: "USDT 名义金额" },
            { value: "ASSET_QUANTITY", label: "资产数量" },
          ]}
          value={mode}
        />
        <Input
          autoComplete="off"
          inputMode="decimal"
          label={mode === "NOTIONAL_USDT" ? "名义金额（USDT）" : "资产数量"}
          disabled={resumeMode}
          onChange={(event) => onAmountChange(event.target.value)}
          placeholder={mode === "NOTIONAL_USDT" ? "例如 20" : "例如 0.001"}
          value={amount}
        />
        <Select
          label="执行模式"
          onChange={(event) => onExecutionModeChange(event.target.value)}
          options={[
            { value: "PRICE_PRIORITY", label: "价格优先" },
            { value: "EXECUTION_PRIORITY", label: "执行优先" },
          ]}
          value={executionMode}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={loading || resumeMode} onClick={onPlan} type="button" variant="secondary">
          {loading ? "正在读取规则" : "生成数量计划"}
        </Button>
        <p className="text-xs leading-5 text-[#8f99a5]">两条腿分别使用实时 bid/ask 和交易所规则规划；不会自动提高用户输入金额。</p>
      </div>

      {error ? <p className="border border-red-400/35 bg-red-500/[0.06] px-4 py-3 text-sm text-red-200" role="alert">{error}</p> : null}
      {draft ? (
        <>
          <section className="border border-[#25282f] bg-black p-4">
            <dl className="grid gap-3 text-xs sm:grid-cols-3">
              <DraftMetric label="机会标识" value={draft.opportunityId} mono />
              <DraftMetric label="策略类型" value={strategyLabel(draft.strategyType)} />
              <DraftMetric label="持有测算情景" value={`${draft.horizonDays} 天`} />
            </dl>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            {draft.legs.map((leg) => <ExecutionLegCard key={leg.legId} leg={leg} />)}
          </div>
          {!draft.allLegsExecutable ? (
            <p className="border border-amber-400/35 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-100">
              两条腿尚未同时满足执行条件。可查看草案，但不能进入真实执行。
            </p>
          ) : null}
        </>
      ) : loading ? <DraftSkeleton /> : null}

      {instance ? (
        <ExecutionInstancePanel
          executionResults={executionResults}
          instance={instance}
          loading={loading}
          onExecuteLeg={onExecuteLeg}
          onReconcileLeg={onReconcileLeg}
        />
      ) : null}

      {validationNotice ? <p className="border border-emerald-400/35 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-100" role="status">{validationNotice}</p> : null}
      <div className="flex flex-wrap justify-end gap-3 border-t border-[#25282f] pt-4">
        <Button disabled={loading} onClick={onCancel} type="button" variant="ghost">取消</Button>
        {resumeMode
          ? <span className={`inline-flex min-h-9 items-center border px-3 text-xs ${resumeValidated ? "border-sky-400/30 text-sky-100" : "border-red-400/30 text-red-200"}`}>{resumeValidated ? "继续使用现有实例" : "已停止继续执行"}</span>
          : <Button disabled={loading || instance !== null || !canConfirmDraft(draft)} onClick={onConfirm} type="button">确认创建套利</Button>}
      </div>
      <p className="text-right text-[11px] leading-5 text-[#707985]">{resumeMode ? "继续执行不会创建新套利实例；每条腿仍由现有 executeLeg 边界重新校验。" : "最终确认会由服务端重新读取权威数据；两条腿始终分别要求人工确认。"}</p>
    </div>
  );
}

export function canConfirmDraft(draft: ArbitrageExecutionDraft | null) {
  return draft?.allLegsExecutable === true
    && draft.legs.every((leg) => leg.executionAvailable && leg.planning.status === "PLANNED");
}

export function canExecuteLeg(instance: ArbitrageInstance, legId: string) {
  if (!instance.legs.some((leg) => leg.legId === legId)) return false;
  if (instance.executionReferences.some((reference) => reference.legId === legId)) return false;
  if (instance.executionReferences.length === 0) return true;
  if (instance.executionReferences.length !== 1) return false;
  const first = instance.executionReferences[0]!;
  return first.status === "CONFIRMED" && first.confirmedQuantity === first.requestedQuantity;
}

export function canReconcileLeg(instance: ArbitrageInstance, legId: string) {
  const references = instance.executionReferences.filter((reference) => reference.legId === legId);
  return references.length === 1
    && (references[0]!.status === "PENDING_CONFIRMATION" || references[0]!.status === "UNKNOWN")
    && references[0]!.executionRecordId !== null;
}

export async function loadResumeContext(
  arbitrageId: string,
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  signal?: AbortSignal,
) {
  const instance = await fetchArbitrageInstanceById(arbitrageId, signal);
  if (instance.status !== "OPENING" || !instance.sourcePlanId) throw new Error("resume instance is not opening");
  const [firstLeg, secondLeg] = instance.legs;
  if (firstLeg.plannedQuantity !== secondLeg.plannedQuantity) throw new Error("resume quantities differ");
  const quantityInput = { mode: "ASSET_QUANTITY" as const, quantity: firstLeg.plannedQuantity };
  const draft = await previewArbitrageExecutionDraft(opportunityId, horizonDays, quantityInput, signal);
  if (!resumeDraftMatchesInstance(draft, instance)) throw new Error("resume draft does not match instance");
  const executionMode = await matchingResumeExecutionMode(instance.sourcePlanId, opportunityId, horizonDays, quantityInput);
  if (!executionMode) throw new Error("resume source plan does not match instance");
  const assetSymbol = plannedAssetSymbol(draft);
  if (!assetSymbol) throw new Error("resume asset is unavailable");
  return Object.freeze({ draft, instance, quantity: firstLeg.plannedQuantity, assetSymbol, executionMode });
}

export function resumeDraftMatchesInstance(draft: ArbitrageExecutionDraft, instance: ArbitrageInstance) {
  if (draft.strategyType !== instance.strategyType || draft.legs.length !== instance.legs.length) return false;
  return draft.legs.every((draftLeg) => {
    const plannedQuantity = draftLeg.planning.status === "PLANNED"
      ? draftLeg.planning.plan.plannedAssetQuantity.quantity
      : null;
    return instance.legs.some((instanceLeg) => instanceLeg.legId === draftLeg.legId
      && instanceLeg.role === draftLeg.role
      && instanceLeg.venue === draftLeg.venue
      && instanceLeg.instrumentId === draftLeg.instrumentId
      && instanceLeg.plannedQuantity === plannedQuantity);
  });
}

async function matchingResumeExecutionMode(
  sourcePlanId: string,
  opportunityId: string,
  horizonDays: ArbitrageHorizon,
  quantityInput: ExecutionQuantityInput,
) {
  for (const executionMode of ["PRICE_PRIORITY", "EXECUTION_PRIORITY"] as const) {
    const payload = JSON.stringify({ opportunityId, horizonDays, quantityInput, executionMode });
    const digest = await sha256(payload);
    if (sourcePlanId === `execution-confirmation:${digest}`) return executionMode;
  }
  return null;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function plannedAssetSymbol(draft: ArbitrageExecutionDraft) {
  const symbols = draft.legs.map((leg) => leg.planning.status === "PLANNED"
    ? leg.planning.plan.plannedAssetQuantity.asset.symbol
    : null);
  return symbols[0] && symbols[0] === symbols[1] ? symbols[0] : null;
}

function ExecutionInstancePanel({
  executionResults,
  instance,
  loading,
  onExecuteLeg,
  onReconcileLeg,
}: {
  executionResults: Record<string, ArbitrageLegExecutionConfirmation["executionRecord"]>;
  instance: ArbitrageInstance;
  loading: boolean;
  onExecuteLeg: (legId: string) => void;
  onReconcileLeg: (legId: string) => void;
}) {
  return (
    <section className="border border-sky-400/30 bg-sky-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs text-[#8f99a5]">套利实例</p><p className="mt-1 break-all font-mono text-xs text-white">{instance.arbitrageId}</p></div>
        <span className="border border-white/20 px-2 py-1 text-[11px] text-white">{instanceStatusLabel(instance.status)}</span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {instance.legs.map((leg) => (
          <ExecutionInstanceLeg
            execution={executionResults[leg.legId]}
            key={leg.legId}
            leg={leg}
            loading={loading}
            onExecute={() => onExecuteLeg(leg.legId)}
            onReconcile={() => onReconcileLeg(leg.legId)}
            permitted={canExecuteLeg(instance, leg.legId)}
            reference={instance.executionReferences.find((reference) => reference.legId === leg.legId)}
          />
        ))}
      </div>
    </section>
  );
}

function ExecutionInstanceLeg({ execution, leg, loading, onExecute, onReconcile, permitted, reference }: {
  execution?: ArbitrageLegExecutionConfirmation["executionRecord"];
  leg: ArbitrageInstanceLeg;
  loading: boolean;
  onExecute: () => void;
  onReconcile: () => void;
  permitted: boolean;
  reference?: ArbitrageInstance["executionReferences"][number];
}) {
  const status = execution?.status ?? reference?.status ?? "CREATED";
  const reconcilable = status === "PENDING_CONFIRMATION" || status === "UNKNOWN";
  const verifiedAt = execution?.verifiedAt ?? reference?.updatedAt;
  return (
    <div className="border border-[#25282f] bg-black p-4">
      <div className="flex items-center justify-between gap-3"><strong className="text-xs text-white">{leg.role === "LONG" ? "LONG · 多头腿" : "SHORT · 空头腿"}</strong><span className="text-[11px] text-[#8f99a5]">{executionStatusLabel(status)}</span></div>
      <dl className="mt-3 space-y-2 text-xs">
        <LegExecutionMetric label="计划数量" value={leg.plannedQuantity} />
        <LegExecutionMetric label="已确认数量" value={execution?.confirmedQuantity ?? leg.confirmedOpenedQuantity} />
        <LegExecutionMetric label="执行状态" value={executionStatusLabel(status)} />
        <LegExecutionMetric label="最近核验时间" value={verifiedAt === undefined ? "尚未核验" : formatCheckedAt(verifiedAt)} />
      </dl>
      <Button
        className="mt-4 w-full"
        disabled={loading || (reconcilable ? reference?.executionRecordId === null : !permitted)}
        onClick={reconcilable ? onReconcile : onExecute}
        type="button"
        variant="secondary"
      >
        {reconcilable ? "重新核验" : instanceLegButtonLabel(reference?.status)}
      </Button>
    </div>
  );
}

function LegExecutionMetric({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-[#707985]">{label}</dt><dd className="font-mono text-white">{value}</dd></div>;
}

function executionStatusLabel(status: string) {
  return ({ CREATED: "待确认", SUBMITTED: "已提交", PENDING_CONFIRMATION: "等待成交确认", CONFIRMED: "已确认", FAILED: "失败", UNKNOWN: "状态未知", CLAIMED: "已认领", LINKED: "已关联" } as Record<string, string>)[status] ?? "状态未知";
}

function instanceStatusLabel(status: ArbitrageInstance["status"]) {
  return { OPENING: "建仓中", HOLDING: "持有中", RESIDUAL: "存在残余", CLOSING: "退出中", CLOSED: "已关闭", FAILED: "失败" }[status];
}

function instanceLegButtonLabel(status?: string) {
  return status ? "该腿已提交" : "确认执行该腿";
}

function executionNotice(status: string, secondLegAllowed: boolean) {
  if (status === "CONFIRMED" && secondLegAllowed) return "第一腿已完整确认。请核对结果后，再次人工确认第二腿。";
  if (status === "CONFIRMED") return "两条腿均已确认。";
  if (status === "PENDING_CONFIRMATION") return "当前存在部分成交或待确认状态，第二腿保持禁用。";
  if (status === "FAILED") return "该腿执行失败，套利实例已保留，第二腿不会自动执行。";
  return "执行状态暂时无法确认，第二腿保持禁用。";
}

function reconciliationNotice(status: string, secondLegAllowed: boolean) {
  if (status === "CONFIRMED" && secondLegAllowed) return "核验已确认第一腿完整成交。请核对结果后，再次人工确认第二腿。";
  if (status === "CONFIRMED") return "核验已确认该套利腿完整成交。";
  if (status === "PENDING_CONFIRMATION") return "核验后仍为部分成交或待确认状态，第二腿保持禁用。";
  if (status === "FAILED") return "核验确认该腿已终止；实际成交数量已保留，第二腿保持禁用。";
  return "核验后状态仍无法确认，第二腿保持禁用。";
}

function formatCheckedAt(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function createClientCommandId(prefix: string) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function ExecutionLegCard({ leg }: { leg: ArbitrageExecutionDraftLeg }) {
  const planned = leg.planning.status === "PLANNED" ? leg.planning.plan : null;
  const sizingPrice = planned?.sizingPrice ?? (leg.quote ? leg.side === "buy" ? leg.quote.ask : leg.quote.bid : null);
  return (
    <section className="border border-[#25282f] bg-[#0b0d11] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-[#8f99a5]">{leg.role === "LONG" ? "LONG · 多头腿" : "SHORT · 空头腿"}</p>
          <h3 className="mt-1 font-mono text-sm font-semibold text-white">{leg.instrumentId}</h3>
        </div>
        <span className={`border px-2 py-1 text-[11px] ${leg.capability.status === "AVAILABLE" ? "border-emerald-400/35 text-emerald-200" : "border-amber-400/35 text-amber-100"}`}>
          {capabilityLabel(leg)}
        </span>
      </div>
      <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        <DraftMetric label="交易所" value={venueLabel(leg.venue)} />
        <DraftMetric label="产品类型" value={leg.marketType === "spot" ? "现货" : "永续"} />
        <DraftMetric label="方向" value={leg.side === "buy" ? "买入" : "卖出"} />
        <DraftMetric label="当前规划价格" value={sizingPrice ?? "暂无可靠数据"} mono />
        <DraftMetric label="计划资产数量" value={planned?.plannedAssetQuantity.quantity ?? planningLabel(leg)} mono />
        <DraftMetric label="预计名义金额" value={planned ? `${planned.estimatedNotionalUsdt} USDT` : "尚未生成"} mono />
        <DraftMetric label="最小数量" value={leg.tradingRules?.minQuantity ?? "暂无可靠数据"} mono />
        <DraftMetric label="数量步长" value={leg.tradingRules?.quantityStep ?? "暂无可靠数据"} mono />
        <DraftMetric label="最小名义金额" value={leg.tradingRules?.minNotional ? `${leg.tradingRules.minNotional} USDT` : "交易所未提供"} mono />
        <DraftMetric label="合约面值" value={leg.tradingRules?.contractSize ?? "不适用"} mono />
      </dl>
      {leg.planning.status === "ERROR" || leg.planning.status === "UNAVAILABLE" ? (
        <p className="mt-4 border-t border-[#25282f] pt-3 text-xs leading-5 text-amber-100">
          {planningErrorLabel(leg)}
        </p>
      ) : null}
    </section>
  );
}

function DraftMetric({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return <div className="min-w-0"><dt className="text-[#707985]">{label}</dt><dd className={`mt-1 break-all text-white ${mono ? "font-mono" : ""}`}>{value}</dd></div>;
}

function capabilityLabel(leg: ArbitrageExecutionDraftLeg) {
  if (leg.capability.status === "AVAILABLE") return "执行能力已接入";
  if (leg.capability.reasonCode === "CREDENTIAL_NOT_CONFIGURED") return "账户凭证未配置";
  return "执行能力尚未接入";
}

function planningLabel(leg: ArbitrageExecutionDraftLeg) {
  if (leg.planning.status === "NOT_REQUESTED") return "等待数量输入";
  if (leg.planning.status === "UNAVAILABLE") return "当前无法规划";
  return "规则校验未通过";
}

function planningErrorLabel(leg: ArbitrageExecutionDraftLeg) {
  if (leg.planning.status !== "ERROR" && leg.planning.status !== "UNAVAILABLE") return "";
  const minimum = leg.planning.minimumRequiredNotionalUsdt;
  if (minimum) return `当前输入低于最低合法要求，最低名义金额约为 ${minimum} USDT。`;
  if (leg.planning.nearestLegalAssetQuantity) return `数量不符合步长；不超过原输入的最近合法数量为 ${leg.planning.nearestLegalAssetQuantity}。`;
  const labels: Record<string, string> = {
    INSTRUMENT_CONTEXT_UNAVAILABLE: "当前无法取得该腿的权威品种、交易规则或报价。",
    QUOTE_STALE: "当前报价已过期，请重新生成数量计划。",
    INSTRUMENT_NOT_TRADING: "当前交易品种不可交易。",
    QUANTITY_BELOW_MINIMUM: "输入数量低于交易所最低数量。",
    NOTIONAL_BELOW_MINIMUM: "输入金额低于交易所最低名义金额。",
    QUANTITY_STEP_MISMATCH: "输入数量不符合交易所数量步长。",
  };
  return labels[leg.planning.errorCode] ?? "当前数量计划未通过交易规则校验。";
}

function venueLabel(venue: ArbitrageExecutionDraftLeg["venue"]) {
  return { binance: "Binance", okx: "OKX", bybit: "Bybit", bitget: "Bitget" }[venue];
}

function strategyLabel(strategy: ArbitrageExecutionDraft["strategyType"]) {
  return strategy === "PERPETUAL_PERPETUAL" ? "永续-永续" : "现货-永续";
}

function DraftSkeleton() {
  return <div aria-label="正在加载套利执行草案" className="h-64 animate-pulse border border-[#25282f] bg-[#0b0d11]" />;
}
