import { useRef, useState } from "react";
import {
  abandonUnstartedArbitrage,
  type ArbitrageInstance,
} from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

export function ArbitrageUnstartedAbandonDialog({ instance, onAbandoned, onClose }: {
  instance: ArbitrageInstance;
  onAbandoned: (instance: ArbitrageInstance) => Promise<void> | void;
  onClose: () => void;
}) {
  const [commandId] = useState(createCommandId);
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const submitting = useRef(false);
  const busy = status === "submitting";
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setStatus("submitting");
    try {
      const result = await abandonUnstartedArbitrage({
        arbitrageId: instance.arbitrageId,
        commandId,
      });
      await onAbandoned(result.instance);
    } catch {
      submitting.current = false;
      setStatus("error");
    }
  };

  return <Modal
    closeDisabled={busy}
    description="终止尚未开始真实交易的套利实例"
    onClose={onClose}
    open
    title="确认放弃套利"
  >
    <div className="space-y-4 text-sm text-[#c5ccd4]">
      <dl className="grid gap-2 border border-[#25282f] bg-black p-4 text-xs sm:grid-cols-2">
        <Metric label="套利 ID" value={instance.arbitrageId} />
        <Metric label="当前状态" value="尚未开始真实交易" />
        <Metric label="执行记录" value="0" />
        <Metric label="系统管理数量" value="0" />
      </dl>
      <div className="border border-amber-400/30 bg-amber-400/[0.06] p-4 text-xs leading-6 text-amber-100">
        <p>该套利尚未开始真实交易。确认后将终止此实例，不会提交任何交易订单。</p>
        <p>实例将从当前套利移入历史记录；不会生成成交、仓位或 Provider 事实。</p>
      </div>
      {status === "error" ? (
        <p role="alert" className="text-xs text-red-200">终止失败。实例可能已产生新的交易事实，请刷新后重新核验。</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button data-modal-initial-focus disabled={busy} onClick={onClose} type="button" variant="secondary">
          取消
        </Button>
        <Button disabled={busy} onClick={() => void submit()} type="button" variant="danger">
          {busy ? "正在终止…" : "确认放弃套利"}
        </Button>
      </div>
    </div>
  </Modal>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[#707985]">{label}</dt><dd className="mt-1 break-all font-mono text-[#c5ccd4]">{value}</dd></div>;
}

function createCommandId() {
  return globalThis.crypto?.randomUUID?.() ?? `abandon-unstarted-${Date.now().toString(36)}`;
}
