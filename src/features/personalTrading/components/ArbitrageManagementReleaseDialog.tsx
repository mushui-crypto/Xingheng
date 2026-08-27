import { useState } from "react";
import {
  releaseArbitrageLegManagement,
  type ArbitrageCloseSafety,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
} from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

export function ArbitrageManagementReleaseDialog({ closeSafety, instance, leg, onClose, onReleased }: {
  closeSafety: ArbitrageCloseSafety;
  instance: ArbitrageInstance;
  leg: ArbitrageInstanceLeg;
  onClose: () => void;
  onReleased: (arbitrageId: string) => Promise<void> | void;
}) {
  const [commandId] = useState(createCommandId);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const submit = async () => {
    setStatus("submitting");
    try {
      await releaseArbitrageLegManagement({
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
        commandId,
      });
      await onReleased(instance.arbitrageId);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };
  const busy = status === "submitting";
  return <Modal
    closeDisabled={busy}
    description="这是保留交易所残余并结束 Xingheng 跟踪责任，不是平仓操作。"
    onClose={onClose}
    open
    title="确认保留残余并结束跟踪"
  >
    <div className="space-y-4 text-sm text-[#c5ccd4]">
      <dl className="grid gap-2 border border-[#25282f] bg-black p-4 text-xs sm:grid-cols-2">
        <Metric label="套利腿" value={leg.role === "LONG" ? "多头腿" : "空头腿"} />
        <Metric label="交易标的" value={leg.instrumentId} />
        <Metric label="将结束跟踪的系统管理数量" value={closeSafety.activeManagedQuantity} />
        <Metric label="当前可安全退出数量" value={closeSafety.safeClosableQuantity} />
      </dl>
      <div className="border border-amber-400/30 bg-amber-400/[0.06] p-4 text-xs leading-6 text-amber-100">
        <p>确认后，Xingheng 将保留交易所中的残余仓位，并结束对该腿全部剩余 Active Managed Exposure 的跟踪。</p>
        <p>本操作不会向交易所提交平仓订单，也不代表交易所仓位已经关闭。</p>
        <p>历史 execution 记录不会修改；之后请由你自行处理账户中的相关仓位。</p>
      </div>
      {status !== "done" ? <label className="flex items-start gap-2 text-xs leading-5 text-[#c5ccd4]">
        <input checked={confirmed} className="mt-1" disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
        <span>我理解这是保留残余并结束跟踪，而非平仓；后续账户仓位由我自行处理。</span>
      </label> : <p className="text-xs text-emerald-200">已保留残余并结束跟踪，页面状态已按后端权威结果刷新。</p>}
      {status === "error" ? <p className="text-xs text-red-200">结束跟踪失败，请重新核验权威状态后再试。</p> : null}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose} type="button" variant="secondary">关闭</Button>
        {status !== "done" ? <Button disabled={busy || !confirmed || !closeSafety.releaseEligible} onClick={() => void submit()} type="button">
          {busy ? "正在提交…" : "确认保留残余并结束跟踪"}
        </Button> : null}
      </div>
    </div>
  </Modal>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[#707985]">{label}</dt><dd className="mt-1 break-all font-mono text-[#c5ccd4]">{value}</dd></div>;
}

function createCommandId() {
  return globalThis.crypto?.randomUUID?.() ?? `management-release-${Date.now().toString(36)}`;
}
