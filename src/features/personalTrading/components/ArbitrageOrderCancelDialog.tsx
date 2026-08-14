import { useState } from "react";
import {
  cancelKnownArbitrageOrder,
  type ArbitrageLegExecutionConfirmation,
} from "../../../api/arbitrageExecutionDraft";
import type {
  ArbitrageExecutionReference,
  ArbitrageInstance,
  ArbitrageInstanceLeg,
} from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

export function ArbitrageOrderCancelDialog({
  instance,
  leg,
  reference,
  onClose,
  onUpdated,
}: {
  instance: ArbitrageInstance;
  leg: ArbitrageInstanceLeg;
  reference: ArbitrageExecutionReference;
  onClose: () => void;
  onUpdated: (instance: ArbitrageInstance) => void;
}) {
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "done">("idle");
  const [confirmedQuantity, setConfirmedQuantity] = useState(reference.confirmedQuantity);
  const [executionStatus, setExecutionStatus] = useState<
    ArbitrageExecutionReference["status"] | ArbitrageLegExecutionConfirmation["executionRecord"]["status"]
  >(reference.status);

  const submit = async () => {
    setStatus("submitting");
    try {
      const result = await cancelKnownArbitrageOrder({
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
        executionIntentId: reference.executionIntentId,
      });
      setConfirmedQuantity(result.executionRecord.confirmedQuantity);
      setExecutionStatus(result.executionRecord.status);
      setStatus("done");
      onUpdated(result.instance);
    } catch {
      setStatus("error");
    }
  };

  const busy = status === "submitting";
  return <Modal
    closeDisabled={busy}
    description="仅撤销该套利实例已绑定的 StellaX 活动订单。撤销后会立即重新核验交易所最终状态和实际成交数量。"
    onClose={onClose}
    open
    title="确认撤销订单"
  >
    <div className="space-y-4 text-sm text-[#c5ccd4]">
      <dl className="grid gap-2 border border-[#25282f] bg-black p-4 text-xs sm:grid-cols-2">
        <Metric label="套利 ID" value={instance.arbitrageId} />
        <Metric label="套利腿" value={leg.role === "LONG" ? "多头腿" : "空头腿"} />
        <Metric label="交易标的" value={leg.instrumentId} />
        <Metric label="执行状态" value={executionStatusLabel(executionStatus)} />
        <Metric label="计划数量" value={reference.requestedQuantity} />
        <Metric label="已确认数量" value={confirmedQuantity} />
      </dl>
      {status === "error" ? <p className="text-xs text-red-200">订单撤销状态暂不可确认，请稍后重试或重新核验。</p> : null}
      {status === "done" ? <p className="text-xs text-[#aeb7c2]">撤单请求已处理，并已重新核验订单最终状态。</p> : null}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose} type="button" variant="secondary">关闭</Button>
        {status !== "done" ? <Button disabled={busy} onClick={() => void submit()} type="button">
          {busy ? "正在撤销…" : "确认撤销订单"}
        </Button> : null}
      </div>
    </div>
  </Modal>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[#707985]">{label}</dt><dd className="mt-1 break-all font-mono text-[#c5ccd4]">{value}</dd></div>;
}

function executionStatusLabel(status: ArbitrageExecutionReference["status"] | "CREATED" | "SUBMITTED") {
  return {
    CLAIMED: "已认领",
    LINKED: "已关联",
    CREATED: "已创建",
    SUBMITTED: "已提交",
    PENDING_CONFIRMATION: "等待确认",
    CONFIRMED: "已确认",
    FAILED: "已结束",
    UNKNOWN: "暂无法确认",
  }[status];
}
