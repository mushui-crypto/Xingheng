import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  fetchArbitrageExecutionDraft,
  previewArbitrageExecutionDraft,
  type ArbitrageExecutionDraft,
  type ArbitrageExecutionDraftLeg,
  type ExecutionQuantityInput,
} from "../../../api/arbitrageExecutionDraft";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Modal } from "../../../components/ui/Modal";
import { Select } from "../../../components/ui/Select";
import type { ArbitrageHorizon } from "../model/types";

export function ArbitrageExecutionDraftEntry({
  horizonDays,
  opportunityId,
}: {
  horizonDays: ArbitrageHorizon;
  opportunityId: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ArbitrageExecutionDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ExecutionQuantityInput["mode"]>("NOTIONAL_USDT");
  const [amount, setAmount] = useState("");
  const [executionMode, setExecutionMode] = useState("PRICE_PRIORITY");
  const [validationNotice, setValidationNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setValidationNotice("");
    void fetchArbitrageExecutionDraft(opportunityId, horizonDays, controller.signal)
      .then(setDraft)
      .catch(() => {
        if (!controller.signal.aborted) setError("套利执行草案加载失败，请稍后重试。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [horizonDays, open, opportunityId]);

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
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <ShieldCheck aria-hidden="true" size={15} /> 创建套利
      </Button>
      <Modal
        bodyClassName="max-h-[75vh] overflow-y-auto"
        closeDisabled={loading}
        description="服务端将重新读取权威品种、交易规则和报价。本阶段只生成并校验草案，不创建实例，也不会提交订单。"
        onClose={close}
        open={open}
        shellClassName="max-w-5xl"
        title="确认创建套利"
      >
        <ArbitrageExecutionDraftContent
          amount={amount}
          draft={draft}
          error={error}
          executionMode={executionMode}
          loading={loading}
          mode={mode}
          onAmountChange={setAmount}
          onCancel={close}
          onConfirm={() => setValidationNotice("执行草案校验通过。本阶段未创建套利实例，也未提交任何订单。")}
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
  executionMode,
  loading,
  mode,
  onAmountChange,
  onCancel,
  onConfirm,
  onExecutionModeChange,
  onModeChange,
  onPlan,
  validationNotice,
}: {
  amount: string;
  draft: ArbitrageExecutionDraft | null;
  error: string;
  executionMode: string;
  loading: boolean;
  mode: ExecutionQuantityInput["mode"];
  onAmountChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onExecutionModeChange: (value: string) => void;
  onModeChange: (value: ExecutionQuantityInput["mode"]) => void;
  onPlan: () => void;
  validationNotice: string;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Select
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
        <Button disabled={loading} onClick={onPlan} type="button" variant="secondary">
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

      {validationNotice ? <p className="border border-emerald-400/35 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-100" role="status">{validationNotice}</p> : null}
      <div className="flex flex-wrap justify-end gap-3 border-t border-[#25282f] pt-4">
        <Button disabled={loading} onClick={onCancel} type="button" variant="ghost">取消</Button>
        <Button disabled={loading || !canConfirmDraft(draft)} onClick={onConfirm} type="button">确认创建套利</Button>
      </div>
      <p className="text-right text-[11px] leading-5 text-[#707985]">当前确认仅校验只读草案；后续真实执行阶段仍需再次明确确认第二腿。</p>
    </div>
  );
}

export function canConfirmDraft(draft: ArbitrageExecutionDraft | null) {
  return draft?.allLegsExecutable === true
    && draft.legs.every((leg) => leg.executionAvailable && leg.planning.status === "PLANNED");
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
