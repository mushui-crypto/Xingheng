import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";
import type {
  ArbitrageExecutionCommandService,
  ArbitrageLegExecutionConfirmation,
} from "./ArbitrageExecutionCommandService";
import {
  FormalExecutionRuntimeRegistryError,
  type FormalExecutionRuntimeResolver,
} from "./FormalExecutionRuntimeRegistry";

type InstanceStore = Pick<ArbitrageInstanceStore, "get">;
type RecordStore = Pick<ExecutionRecordStore, "loadForUser">;
type Reconciler = Pick<ArbitrageExecutionCommandService, "reconcileLeg">;

export class ArbitrageExecutionCancelError extends Error {
  constructor(
    readonly category:
      | "invalid_cancel_confirmation"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "arbitrage_execution_reference_not_found"
      | "cancel_identity_conflict"
      | "cancel_state_unavailable"
      | "execution_state_unknown"
      | "manual_reconciliation_required",
    message: string,
    readonly manualReconciliation?: Readonly<{
      manualReconciliationRequired: true;
      idempotencyKey: string;
      reason: string;
    }>,
  ) {
    super(message);
  }
}

/** Cancels only an active provider order already owned by a persisted StellaX execution. */
export class ArbitrageExecutionCancelService {
  private readonly inFlight = new Map<string, Promise<ArbitrageLegExecutionConfirmation>>();

  constructor(
    private readonly instances: InstanceStore,
    private readonly executionRecords: RecordStore,
    private readonly runtimes: FormalExecutionRuntimeResolver,
    private readonly reconciler: Reconciler,
  ) {}

  async cancelKnownOrder(
    authenticatedUserId: string,
    input: unknown,
  ): Promise<ArbitrageLegExecutionConfirmation> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseRequest(input);
    const key = `${userId}\u0000${request.arbitrageId}\u0000${request.legId}\u0000${request.executionIntentId}`;
    const active = this.inFlight.get(key);
    if (active) return active;
    const operation = this.cancelKnownOrderOnce(userId, request);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async cancelKnownOrderOnce(
    userId: string,
    request: Readonly<{ arbitrageId: string; legId: string; executionIntentId: string }>,
  ) {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw cancelError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw cancelError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");
    const reference = instance.executionReferences.find(
      (candidate) => candidate.executionIntentId === request.executionIntentId,
    );
    if (!reference || reference.legId !== leg.legId) {
      throw cancelError("arbitrage_execution_reference_not_found", "未找到该套利腿对应的已知执行引用。");
    }
    if (reference.status === "CONFIRMED" || reference.status === "FAILED") {
      return resultFromReference(instance, reference, true);
    }
    if (!reference.executionRecordId) {
      throw cancelError("cancel_state_unavailable", "执行记录尚未完成关联，不能安全撤销订单。");
    }
    const unresolved = instance.executionReferences.filter((candidate) => candidate.legId === leg.legId
      && (candidate.status === "LINKED"
        || candidate.status === "PENDING_CONFIRMATION"
        || candidate.status === "UNKNOWN"));
    if (unresolved.length !== 1 || unresolved[0]?.executionIntentId !== reference.executionIntentId) {
      throw cancelError("cancel_state_unavailable", "该套利腿不存在唯一可撤销的活动订单。");
    }

    const record = await this.executionRecords.loadForUser(userId, reference.executionRecordId);
    if (!record) throw cancelError("cancel_identity_conflict", "已知执行记录不存在或不属于当前用户。");
    assertIdentity(record, userId, leg, reference);
    const runtime = this.resolveRuntime(record.venue);
    if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
      if (record.status === "CONFIRMED" || record.status === "FAILED") {
        return this.reconciler.reconcileLeg(userId, {
          arbitrageId: instance.arbitrageId,
          legId: leg.legId,
        });
      }
      throw cancelError("cancel_state_unavailable", "该执行记录当前不是可撤销的活动订单。");
    }

    try {
      await runtime.cancel(userId, record.executionId);
    } catch (error) {
      if (error instanceof ManualReconciliationRequiredError) {
        throw manualReconciliationCancelError(error);
      }
      throw cancelError("execution_state_unknown", "订单撤销状态暂无法确认；未提交任何新订单。");
    }
    return this.reconciler.reconcileLeg(userId, {
      arbitrageId: instance.arbitrageId,
      legId: leg.legId,
    });
  }

  private resolveRuntime(venue: ExecutionRecord["venue"]) {
    try {
      return this.runtimes.resolve(venue);
    } catch (error) {
      if (error instanceof FormalExecutionRuntimeRegistryError
        && error.category === "runtime_not_registered") {
        throw cancelError("cancel_state_unavailable", "该交易所尚未接入正式撤单能力。");
      }
      throw error;
    }
  }
}

function assertIdentity(
  record: ExecutionRecord,
  userId: string,
  leg: ArbitrageInstance["legs"][number],
  reference: ArbitrageInstance["executionReferences"][number],
) {
  if (record.executionId !== reference.executionRecordId
    || record.intentId !== reference.executionIntentId
    || record.userId !== userId
    || record.accountId !== leg.accountId
    || record.venue !== leg.venue
    || record.instrumentId !== leg.instrumentId) {
    throw cancelError("cancel_identity_conflict", "执行记录与套利实例的订单身份不一致。");
  }
}

function parseRequest(input: unknown) {
  const value = object(input);
  exactKeys(value, ["arbitrageId", "legId", "executionIntentId", "confirmed"]);
  if (value.confirmed !== true) throw cancelError("invalid_cancel_confirmation", "需要用户明确确认撤销订单。");
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    executionIntentId: identifier(value.executionIntentId, "executionIntentId"),
  });
}

function resultFromReference(
  instance: ArbitrageInstance,
  reference: ArbitrageInstance["executionReferences"][number],
  idempotentReplay: boolean,
): ArbitrageLegExecutionConfirmation {
  return Object.freeze({
    instance,
    executionRecord: Object.freeze({
      executionId: reference.executionRecordId,
      intentId: reference.executionIntentId,
      status: reference.status === "CLAIMED" || reference.status === "LINKED" ? "CREATED" : reference.status,
      plannedQuantity: reference.requestedQuantity,
      confirmedQuantity: reference.confirmedQuantity,
      verifiedAt: reference.updatedAt,
    }),
    idempotentReplay,
    secondLegAllowed: instance.executionReferences.length === 1
      && reference.status === "CONFIRMED"
      && reference.confirmedQuantity === reference.requestedQuantity,
  });
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw cancelError("invalid_cancel_confirmation", "撤单确认必须为对象。");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw cancelError("invalid_cancel_confirmation", `请求包含不允许的字段：${unknown}。`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw cancelError("invalid_cancel_confirmation", `请求缺少字段：${missing}。`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw cancelError("invalid_cancel_confirmation", `${name} 无效。`);
  }
  return value.trim();
}

function cancelError(category: ArbitrageExecutionCancelError["category"], message: string) {
  return new ArbitrageExecutionCancelError(category, message);
}

function manualReconciliationCancelError(error: ManualReconciliationRequiredError) {
  return new ArbitrageExecutionCancelError(
    "manual_reconciliation_required",
    "本地订单记录无法安全解析，需要人工核账；未调用交易所撤单接口。",
    {
      manualReconciliationRequired: true,
      idempotencyKey: error.idempotencyKey,
      reason: safeManualReconciliationReason(error.reason),
    },
  );
}

function safeManualReconciliationReason(reason: string) {
  return reason.length <= 200 && /^Stored Binance [A-Za-z0-9 ._-]+$/u.test(reason)
    ? reason
    : "Stored Binance order requires manual reconciliation.";
}
