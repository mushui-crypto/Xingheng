import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageExecutionReference,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";

type InstanceReader = Readonly<{ get(userId: string, arbitrageId: string): ArbitrageInstance | null }>;

export type ArbitrageHedgeWorkflowPhase =
  | "NOT_STARTED"
  | "FIRST_LEG_EXECUTING"
  | "FIRST_LEG_PENDING"
  | "FIRST_LEG_CONFIRMED"
  | "SECOND_LEG_EXECUTING"
  | "SECOND_LEG_PENDING"
  | "COMPLETED"
  | "FIRST_LEG_FAILED_ZERO"
  | "FIRST_LEG_PARTIAL"
  | "FIRST_LEG_UNKNOWN"
  | "SECOND_LEG_FAILED_ZERO"
  | "SECOND_LEG_PARTIAL"
  | "SECOND_LEG_UNKNOWN"
  | "RESIDUAL"
  | "CLOSED";

export class ArbitrageHedgeWorkflowService {
  constructor(private readonly instances: InstanceReader) {}

  read(userIdInput: string, arbitrageIdInput: string) {
    const userId = identifier(userIdInput, "userId");
    const arbitrageId = identifier(arbitrageIdInput, "arbitrageId");
    const instance = this.instances.get(userId, arbitrageId);
    return instance ? deriveArbitrageHedgeWorkflow(instance) : null;
  }
}

export function deriveArbitrageHedgeWorkflow(instance: ArbitrageInstance) {
  const opening = instance.executionReferences
    .filter((reference) => reference.phase === "OPENING" && reference.quantityEffect === "INCREASE")
    .sort((left, right) => left.createdAt - right.createdAt || left.executionIntentId.localeCompare(right.executionIntentId));
  const first = opening[0] ?? null;
  const second = opening[1] ?? null;
  const phase = derivePhase(instance, first, second);
  const action = actionFor(phase);
  return Object.freeze({
    arbitrageId: instance.arbitrageId,
    phase,
    firstLeg: legSnapshot(instance, first),
    secondLeg: legSnapshot(instance, second),
    requiresUserAction: action !== null,
    ...(action === null ? {} : { riskAction: action }),
    reason: reasonFor(phase),
    derivedAt: instance.updatedAt,
  });
}

function derivePhase(
  instance: ArbitrageInstance,
  first: ArbitrageExecutionReference | null,
  second: ArbitrageExecutionReference | null,
): ArbitrageHedgeWorkflowPhase {
  if (instance.status === "CLOSED") return "CLOSED";
  if (!first) return instance.status === "RESIDUAL" ? "RESIDUAL" : "NOT_STARTED";
  if (!second) return legPhase("FIRST", first);
  const secondPhase = legPhase("SECOND", second);
  if (secondPhase !== "COMPLETED") return secondPhase;
  return instance.status === "RESIDUAL" ? "RESIDUAL" : "COMPLETED";
}

function legPhase(prefix: "FIRST" | "SECOND", reference: ArbitrageExecutionReference): ArbitrageHedgeWorkflowPhase {
  if (reference.status === "CLAIMED" || reference.status === "LINKED") return `${prefix}_LEG_EXECUTING`;
  if (reference.status === "PENDING_CONFIRMATION") return `${prefix}_LEG_PENDING`;
  if (reference.status === "UNKNOWN") return `${prefix}_LEG_UNKNOWN`;
  const zero = compareUnsignedDecimals(reference.confirmedQuantity, "0") === 0;
  const full = compareUnsignedDecimals(reference.confirmedQuantity, reference.requestedQuantity) === 0;
  if (reference.status === "FAILED") return zero ? `${prefix}_LEG_FAILED_ZERO` : `${prefix}_LEG_PARTIAL`;
  if (!full) return `${prefix}_LEG_PARTIAL`;
  return prefix === "FIRST" ? "FIRST_LEG_CONFIRMED" : "COMPLETED";
}

function legSnapshot(instance: ArbitrageInstance, reference: ArbitrageExecutionReference | null) {
  if (!reference) return null;
  const leg = instance.legs.find((candidate) => candidate.legId === reference.legId)!;
  return Object.freeze({
    legId: reference.legId,
    executionIntentId: reference.executionIntentId,
    status: reference.status,
    requestedQuantity: reference.requestedQuantity,
    confirmedQuantity: reference.confirmedQuantity,
    activeManagedQuantity: activeManagedQuantity(instance, leg),
    updatedAt: reference.updatedAt,
  });
}

function actionFor(phase: ArbitrageHedgeWorkflowPhase) {
  if (phase === "FIRST_LEG_FAILED_ZERO") return "RESTART_HEDGE" as const;
  if (phase === "FIRST_LEG_PARTIAL") return "CONTINUE_PARTIAL_HEDGE" as const;
  if (phase === "FIRST_LEG_CONFIRMED") return "CONTINUE_SECOND_LEG" as const;
  if (phase === "FIRST_LEG_UNKNOWN" || phase === "SECOND_LEG_UNKNOWN") return "RECONCILE" as const;
  if (phase === "SECOND_LEG_FAILED_ZERO" || phase === "SECOND_LEG_PARTIAL" || phase === "RESIDUAL") {
    return "REVIEW_RESIDUAL" as const;
  }
  return null;
}

function reasonFor(phase: ArbitrageHedgeWorkflowPhase) {
  const reasons: Partial<Record<ArbitrageHedgeWorkflowPhase, string>> = {
    FIRST_LEG_FAILED_ZERO: "第一腿未成交，对冲未建立。",
    FIRST_LEG_PARTIAL: "第一腿部分成交，对冲未完整建立。",
    FIRST_LEG_UNKNOWN: "第一腿执行结果暂无法确认。",
    SECOND_LEG_FAILED_ZERO: "第二腿未成交，自动流程已停止。",
    SECOND_LEG_PARTIAL: "第二腿部分成交，存在残余方向敞口。",
    SECOND_LEG_UNKNOWN: "第二腿执行结果暂无法确认。",
    RESIDUAL: "实例存在残余方向敞口，需要人工处理。",
    CLOSED: "实例管理已结束。",
  };
  return reasons[phase] ?? null;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) throw new Error(`${name} is invalid.`);
  return value.trim();
}
