import { useState } from "react";
import {
  closeArbitrageExecutionLeg,
  reconcileArbitrageExecutionLeg,
  type ArbitrageLegExecutionConfirmation,
  type FormalExecutionMode,
} from "../../../api/arbitrageExecutionDraft";
import type {
  ArbitrageInstance,
  ArbitrageInstanceLeg,
  ArbitrageLegVerification,
} from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

export function ArbitrageLegCloseDialog({
  instance,
  leg,
  verification,
  onClose,
  onUpdated,
}: {
  instance: ArbitrageInstance;
  leg: ArbitrageInstanceLeg;
  verification: ArbitrageLegVerification;
  onClose: () => void;
  onUpdated: (instance: ArbitrageInstance) => void;
}) {
  const [quantity, setQuantity] = useState(verification.expectedManagedQuantity);
  const [executionMode, setExecutionMode] = useState<FormalExecutionMode>("EXECUTION_PRIORITY");
  const [commandId] = useState(createCommandId);
  const [result, setResult] = useState<ArbitrageLegExecutionConfirmation | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "reconciling" | "error">("idle");

  const submit = async () => {
    setStatus("submitting");
    try {
      const next = await closeArbitrageExecutionLeg({
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
        commandId,
        quantity,
        executionMode,
      });
      setResult(next);
      setStatus("idle");
      onUpdated(next.instance);
    } catch {
      setStatus("error");
    }
  };

  const reconcile = async () => {
    setStatus("reconciling");
    try {
      const next = await reconcileArbitrageExecutionLeg({ arbitrageId: instance.arbitrageId, legId: leg.legId });
      setResult(next);
      setStatus("idle");
      onUpdated(next.instance);
    } catch {
      setStatus("error");
    }
  };

  const pending = result?.executionRecord.status === "PENDING_CONFIRMATION"
    || result?.executionRecord.status === "UNKNOWN";
  const busy = status === "submitting" || status === "reconciling";

  return (
    <Modal
      closeDisabled={busy}
      description={leg.instrumentId.endsWith("-SPOT")
        ? "仅卖出该 StellaX 套利实例已知的现货多头腿。服务端会重新核验真实可用余额，现货不使用只减仓参数。"
        : "仅退出该 StellaX 套利实例已知的永续合约腿。服务端会重新核验真实仓位并强制使用只减仓约束。"}
      onClose={onClose}
      open
      title="确认退出套利腿"
    >
      <div className="space-y-4 text-sm text-[#c5ccd4]">
        <dl className="grid gap-2 border border-[#25282f] bg-black p-4 text-xs sm:grid-cols-2">
          <Metric label="套利 ID" value={instance.arbitrageId} />
          <Metric label="套利腿" value={leg.role === "LONG" ? "多头腿" : "空头腿"} />
          <Metric label="交易标的" value={leg.instrumentId} />
          <Metric label="系统管理数量" value={verification.expectedManagedQuantity} />
          <Metric label="当前真实数量" value={verification.actualQuantity ?? "暂无可靠数据"} />
          {leg.instrumentId.endsWith("-SPOT")
            ? <Metric label="当前实际可用数量" value={verification.availableQuantity ?? "暂无可靠数据"} />
            : null}
          <Metric label="核验状态" value={verification.verificationStatus === "MATCHED" ? "仓位一致" : "暂不可退出"} />
        </dl>
        <label className="block text-xs text-[#8f99a5]">
          计划退出数量
          <input
            className="mt-2 w-full border border-[#343943] bg-black px-3 py-2 font-mono text-sm text-white outline-none focus:border-white/50"
            disabled={busy || result !== null}
            inputMode="decimal"
            onChange={(event) => setQuantity(event.target.value)}
            value={quantity}
          />
        </label>
        <label className="block text-xs text-[#8f99a5]">
          执行模式
          <select
            className="mt-2 w-full border border-[#343943] bg-black px-3 py-2 text-sm text-white outline-none focus:border-white/50"
            disabled={busy || result !== null}
            onChange={(event) => setExecutionMode(event.target.value as FormalExecutionMode)}
            value={executionMode}
          >
            <option value="EXECUTION_PRIORITY">成交优先</option>
            <option value="PRICE_PRIORITY">价格优先</option>
          </select>
        </label>
        {result ? (
          <div className="border border-[#25282f] bg-black p-4 text-xs">
            <Metric label="执行状态" value={executionStatusLabel(result.executionRecord.status)} />
            <div className="mt-2"><Metric label="已确认退出数量" value={result.executionRecord.confirmedQuantity} /></div>
            <div className="mt-2"><Metric label="实例状态" value={instanceStatusLabel(result.instance.status)} /></div>
          </div>
        ) : null}
        {status === "error" ? <p className="text-xs text-red-200">退出状态暂不可确认，请稍后重试或重新核验。</p> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={onClose} type="button" variant="secondary">关闭</Button>
          {!result ? (
            <Button disabled={busy || !positiveDecimal(quantity)} onClick={() => void submit()} type="button">
              {status === "submitting" ? "正在提交…" : "确认退出"}
            </Button>
          ) : null}
          {pending ? (
            <Button disabled={busy} onClick={() => void reconcile()} type="button">
              {status === "reconciling" ? "正在核验…" : "重新核验"}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[#707985]">{label}</dt><dd className="mt-1 break-all font-mono text-[#c5ccd4]">{value}</dd></div>;
}

function positiveDecimal(value: string) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && !/^0(?:\.0+)?$/u.test(value);
}

function executionStatusLabel(status: ArbitrageLegExecutionConfirmation["executionRecord"]["status"]) {
  return {
    CREATED: "已创建",
    SUBMITTED: "已提交",
    PENDING_CONFIRMATION: "等待确认",
    CONFIRMED: "已确认",
    FAILED: "失败",
    UNKNOWN: "暂无法确认",
  }[status];
}

function instanceStatusLabel(status: ArbitrageInstance["status"]) {
  return {
    OPENING: "建仓中",
    HOLDING: "持有中",
    RESIDUAL: "存在残余",
    CLOSING: "退出中",
    CLOSED: "已关闭",
    FAILED: "失败",
  }[status];
}

function createCommandId() {
  return globalThis.crypto?.randomUUID?.() ?? `close-${Date.now().toString(36)}`;
}
