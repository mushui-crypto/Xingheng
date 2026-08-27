import { useEffect, useState } from "react";
import { exitArbitrageInstance } from "../../../api/arbitrageExecutionDraft";
import { fetchArbitrageInstanceById, type ArbitrageInstance } from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

export function ArbitrageHedgeExitDialog({ hasQuantityRuleDust, instance, onClose, onUpdated }: {
  hasQuantityRuleDust: boolean;
  instance: ArbitrageInstance;
  onClose: () => void;
  onUpdated: (instance: ArbitrageInstance) => void;
}) {
  const [commandId] = useState(createCommandId);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "stopped" | "error">("idle");
  const [currentInstance, setCurrentInstance] = useState(instance);
  useEffect(() => {
    if (status !== "submitting") return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void fetchArbitrageInstanceById(instance.arbitrageId, controller.signal)
        .then((next) => {
          setCurrentInstance(next);
          onUpdated(next);
        })
        .catch(() => undefined);
    }, 750);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [instance.arbitrageId, onUpdated, status]);
  const submit = async () => {
    setStatus("submitting");
    try {
      const result = await exitArbitrageInstance({ arbitrageId: instance.arbitrageId, commandId, executionMode: "EXECUTION_PRIORITY" });
      setCurrentInstance(result.instance);
      onUpdated(result.instance);
      setStatus(result.status === "CONFIRMED" ? "done" : "stopped");
    } catch {
      setStatus("error");
    }
  };
  const busy = status === "submitting";
  const progress = persistedExitProgress(currentInstance);
  return <Modal
    closeDisabled={busy}
    description="服务端按套利实例的正式退出顺序处理两腿。任一腿状态不确定时会停止，不会自动重试。"
    onClose={onClose}
    open
    title="退出对冲"
  >
    <div className="space-y-4 text-sm text-[#c5ccd4]">
      {hasQuantityRuleDust ? <p className="border border-amber-300/30 bg-amber-300/[0.06] px-3 py-2 text-xs leading-5 text-amber-100">
        系统将关闭所有可交易数量，并停止管理因交易所数量规则无法继续交易的小额残余。小额残余不会记为交易成交。
      </p> : null}
      <div className="border border-[#25282f] bg-black p-4">
        <p className="text-xs font-semibold text-white">{status === "done" ? "退出请求已完成" : "正在退出对冲"}</p>
        <div className="mt-3 space-y-2 text-xs">
          {progress.map((item, index) => <p key={item}>{busy && index === progress.findIndex((value) => value.startsWith("○"))
            ? item.replace("等待退出", "确认中")
            : item}</p>)}
        </div>
      </div>
      {status === "stopped" || status === "error"
        ? <p className="text-xs text-red-200">退出流程已停止。{remainingActiveManaged(currentInstance) !== "0" ? `剩余 Active Managed ${remainingActiveManaged(currentInstance)}。` : ""} 请重新核验后再人工处理；系统不会自动重试。</p>
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

export function remainingActiveManaged(instance: ArbitrageInstance) {
  return instance.legs.reduce((sum, leg) => addDecimals(sum, activeManaged(instance, leg)), "0");
}

function activeManaged(instance: ArbitrageInstance, leg: ArbitrageInstance["legs"][number]) {
  if (instance.managementReleases.some((release) => release.legId === leg.legId)) return "0";
  return subtractDecimals(leg.confirmedOpenedQuantity, leg.confirmedClosedQuantity);
}

function addDecimals(left: string, right: string) {
  const scale = Math.max((left.split(".")[1] ?? "").length, (right.split(".")[1] ?? "").length);
  const value = scaled(left, scale) + scaled(right, scale);
  return decimal(value, scale);
}

function subtractDecimals(left: string, right: string) {
  const scale = Math.max((left.split(".")[1] ?? "").length, (right.split(".")[1] ?? "").length);
  return decimal(scaled(left, scale) - scaled(right, scale), scale);
}

function scaled(value: string, scale: number) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
}

function decimal(value: bigint, scale: number) {
  if (scale === 0) return value.toString();
  const raw = value.toString().padStart(scale + 1, "0");
  const normalized = `${raw.slice(0, -scale)}.${raw.slice(-scale)}`.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
  return normalized;
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
