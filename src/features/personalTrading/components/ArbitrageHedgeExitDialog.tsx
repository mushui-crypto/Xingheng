import { useState } from "react";
import { exitArbitrageInstance } from "../../../api/arbitrageExecutionDraft";
import type { ArbitrageInstance } from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

export function ArbitrageHedgeExitDialog({ instance, onClose, onUpdated }: {
  instance: ArbitrageInstance;
  onClose: () => void;
  onUpdated: (instance: ArbitrageInstance) => void;
}) {
  const [commandId] = useState(createCommandId);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "stopped" | "error">("idle");
  const submit = async () => {
    setStatus("submitting");
    try {
      const result = await exitArbitrageInstance({ arbitrageId: instance.arbitrageId, commandId, executionMode: "EXECUTION_PRIORITY" });
      onUpdated(result.instance);
      setStatus(result.status === "CONFIRMED" ? "done" : "stopped");
    } catch {
      setStatus("error");
    }
  };
  const busy = status === "submitting";
  const progress = persistedExitProgress(instance);
  return <Modal
    closeDisabled={busy}
    description="服务端按套利实例的正式退出顺序处理两腿。任一腿状态不确定时会停止，不会自动重试。"
    onClose={onClose}
    open
    title="退出对冲"
  >
    <div className="space-y-4 text-sm text-[#c5ccd4]">
      <div className="border border-[#25282f] bg-black p-4">
        <p className="text-xs font-semibold text-white">{status === "done" ? "退出请求已完成" : "正在退出对冲"}</p>
        <div className="mt-3 space-y-2 text-xs">
          {progress.map((item, index) => <p key={item}>{busy && index === progress.findIndex((value) => value.startsWith("○"))
            ? item.replace("等待退出", "确认中")
            : item}</p>)}
        </div>
      </div>
      {status === "stopped" || status === "error"
        ? <p className="text-xs text-red-200">退出流程已停止。请使用实例级“重新核验”恢复权威状态，系统不会自动重试。</p>
        : null}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose} type="button" variant="secondary">关闭</Button>
        {status === "idle" ? <Button onClick={() => void submit()} type="button">确认退出对冲</Button> : null}
      </div>
    </div>
  </Modal>;
}

export function persistedExitProgress(instance: ArbitrageInstance) {
  return orderedLegs(instance).map((leg) => {
    const label = legLabel(instance, leg);
    const reference = instance.executionReferences
      .filter((candidate) => candidate.legId === leg.legId && candidate.phase === "CLOSING")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (reference?.status === "CONFIRMED") return `✓ ${label}已退出`;
    if (reference?.status === "FAILED") return `○ ${label}退出失败`;
    if (reference) return `○ ${label}确认中`;
    return `○ ${label}等待退出`;
  });
}

function orderedLegs(instance: ArbitrageInstance) {
  return [...instance.legs].sort((left, right) => priority(left) - priority(right));
}

function priority(leg: ArbitrageInstance["legs"][number]) {
  return leg.instrumentId.endsWith("-SPOT") ? 2 : leg.role === "SHORT" ? 0 : 1;
}

function legLabel(instance: ArbitrageInstance, leg: ArbitrageInstance["legs"][number]) {
  if (leg.instrumentId.endsWith("-SPOT")) return "现货腿";
  return instance.strategyType === "PERPETUAL_PERPETUAL"
    ? `${leg.role === "LONG" ? "多头" : "空头"}永续腿`
    : "永续腿";
}

function createCommandId() {
  return globalThis.crypto?.randomUUID?.() ?? `hedge-exit-${Date.now().toString(36)}`;
}
