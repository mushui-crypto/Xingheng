import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  createTerminalAuthoritativeRefreshCoordinator,
  exitArbitrageInstance,
  type ArbitrageInstanceExitStopDiagnostic,
  type ArbitrageInstanceExitStopPhase,
} from "../../../api/arbitrageExecutionDraft";
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
  const [exitStop, setExitStop] = useState<ArbitrageInstanceExitStopDiagnostic | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const submissionGuard = useRef(false);
  const pollingController = useRef<AbortController | null>(null);
  const terminalRefreshCoordinator = useRef(createTerminalAuthoritativeRefreshCoordinator());
  useEffect(() => {
    if (status !== "submitting") return;
    const controller = new AbortController();
    pollingController.current?.abort();
    pollingController.current = controller;
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
      if (pollingController.current === controller) pollingController.current = null;
      clearInterval(timer);
    };
  }, [instance.arbitrageId, onUpdated, status]);
  useEffect(() => () => terminalRefreshCoordinator.current.cancel(), []);
  const submit = async () => {
    await submitExitOnce(submissionGuard, async () => {
      setStatus("submitting");
      setExitStop(null);
      setRefreshError(false);
      let terminalStatus: "done" | "stopped" | "error" = "error";
      let terminalStop: ArbitrageInstanceExitStopDiagnostic | null = null;
      let responseInstance: ArbitrageInstance | null = null;
      try {
        const result = await exitArbitrageInstance({ arbitrageId: instance.arbitrageId, commandId, executionMode: "EXECUTION_PRIORITY" });
        responseInstance = result.instance;
        terminalStop = result.stop ?? null;
        terminalStatus = result.status === "CONFIRMED" ? "done" : "stopped";
      } catch {
        terminalStatus = "error";
      } finally {
        pollingController.current?.abort();
        try {
          const snapshot = await terminalRefreshCoordinator.current.refresh(instance.arbitrageId);
          if (snapshot) {
            responseInstance = snapshot.instance;
            if (!snapshot.complete) setRefreshError(true);
          }
        } catch {
          setRefreshError(true);
        }
        if (responseInstance) {
          setCurrentInstance(responseInstance);
          onUpdated(responseInstance);
        }
        setExitStop(terminalStop);
        setStatus(terminalStatus);
      }
    });
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
      {busy ? <div
        aria-live="polite"
        className="flex items-start gap-3 border border-sky-400/30 bg-sky-500/[0.06] px-4 py-3 text-sky-100"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        <p className="leading-6">交易处理中，正在等待交易所确认并同步最新仓位…</p>
      </div> : null}
      <div className="border border-[#25282f] bg-black p-4">
        <p className="text-xs font-semibold text-white">{status === "done" ? "退出请求已完成" : "正在退出对冲"}</p>
        <div className="mt-3 space-y-2 text-xs">
          {progress.map((item, index) => <p key={item}>{busy && index === progress.findIndex((value) => value.startsWith("○"))
            ? item.replace("等待退出", "确认中")
            : item}</p>)}
        </div>
      </div>
      {status === "stopped" ? <p className="text-xs leading-5 text-red-200">
        {exitStopMessage(exitStop)}{remainingActiveManaged(currentInstance) !== "0"
          ? ` 剩余 Active Managed ${remainingActiveManaged(currentInstance)}。`
          : ""} 系统不会自动提交后续交易。
      </p> : null}
      {status === "error" ? <p className="text-xs leading-5 text-red-200">
        退出请求未能可靠完成；系统不会自动重发交易命令。
      </p> : null}
      {refreshError ? <p className="text-xs leading-5 text-amber-100" role="alert">
        状态刷新失败，请关闭后手动刷新以查看最新状态。刷新失败不会重新执行退出交易。
      </p> : null}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose} type="button" variant="secondary">关闭</Button>
        {status === "idle" ? <Button onClick={() => void submit()} type="button">确认退出对冲</Button> : null}
      </div>
    </div>
  </Modal>;
}

export async function submitExitOnce(
  guard: { current: boolean },
  submit: () => Promise<void>,
) {
  if (guard.current) return false;
  guard.current = true;
  try {
    await submit();
    return true;
  } finally {
    guard.current = false;
  }
}

export function exitStopMessage(stop: ArbitrageInstanceExitStopDiagnostic | null) {
  if (!stop) return "退出流程已安全停止，服务端未返回可用的停止详情。";
  return `退出流程已停止于${exitStopPhaseLabel(stop.phase)}：${exitStopReasonLabel(stop.reason)}。`;
}

function exitStopPhaseLabel(phase: ArbitrageInstanceExitStopPhase) {
  const labels: Record<ArbitrageInstanceExitStopPhase, string> = {
    INITIAL_STATE: "实例状态检查",
    JOINT_PREFLIGHT: "双腿退出预检",
    SPOT_FRESH_SAFETY: "现货腿下单前安全检查",
    SPOT_CLOSE: "现货腿退出",
    SPOT_CONFIRMATION: "现货腿成交确认",
    SPOT_DUST_RECHECK: "现货残余复核",
    SPOT_DUST_RELEASE: "现货残余责任处理",
    PERPETUAL_FRESH_SAFETY: "永续腿下单前安全检查",
    PERPETUAL_CLOSE: "永续腿退出",
    PERPETUAL_CONFIRMATION: "永续腿成交确认",
  };
  return labels[phase];
}

function exitStopReasonLabel(reason: string) {
  const labels: Readonly<Record<string, string>> = {
    INSTANCE_TERMINAL: "当前实例已经处于终态",
    UNRESOLVED_EXECUTION: "存在尚未完成确认的执行记录",
    PROVIDER_REALITY_UNAVAILABLE: "当前交易所真实仓位暂时无法可靠确认",
    POSITION_VERIFICATION_UNAVAILABLE: "当前交易所真实仓位暂时无法可靠确认",
    SPOT_AVAILABLE_BALANCE_UNAVAILABLE: "当前现货可用余额暂时无法可靠确认",
    SPOT_ATTRIBUTION_UNAVAILABLE: "当前实例的现货归属数量暂时无法可靠确认",
    SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT: "当前可归属现货余额不足以安全完成退出",
    ONE_WAY_REALITY_INSUFFICIENT: "当前单向真实仓位不足以安全完成退出",
    HEDGE_BUCKET_INSUFFICIENT: "目标方向仓位桶不足以安全完成退出",
    CLOSE_QUANTITY_UNAVAILABLE: "当前真实仓位或交易规则不支持本次安全退出数量",
    CLOSE_CAPABILITY_UNAVAILABLE: "当前交易品种暂不支持安全退出",
    EXECUTION_STATE_UNKNOWN: "退出执行状态暂时无法可靠确认",
    IDEMPOTENCY_CONFLICT: "退出命令与已有请求不一致",
    EXISTING_CLOSING_EXECUTION_REQUIRES_USER_CONTINUE: "检测到此前已存在的退出执行，需要重新核验后由用户继续",
    CLOSE_FINALIZATION_UNAVAILABLE: "已提交退出的最终成交状态暂时无法可靠确认",
    CREATED: "退出执行尚未派发",
    SUBMITTED: "退出订单已提交但尚未终态确认",
    PENDING_CONFIRMATION: "退出订单仍在等待终态确认",
    FAILED: "退出订单未能完成",
    UNKNOWN: "退出订单状态暂时无法可靠确认",
    QUANTITY_STEP_DUST: "剩余数量低于当前可交易步长",
    DUST_RELEASE_REALITY_UNAVAILABLE: "现货残余的账户事实暂时无法可靠确认",
    DUST_RELEASE_ELIGIBILITY_CHANGED: "现货残余已不再满足停止管理条件",
    DUST_RELEASE_ATTRIBUTION_UNAVAILABLE: "现货残余的实例归属暂时无法可靠确认",
    DUST_RELEASE_PROVIDER_READ_FAILED: "现货残余复核暂时失败",
  };
  return labels[reason] ?? "当前安全条件未满足";
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
