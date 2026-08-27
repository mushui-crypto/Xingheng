import { createHash } from "node:crypto";
import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitrageExecutionCloseService } from "./ArbitrageExecutionCloseService";
import type { ArbitrageCloseSafetyResult } from "./ArbitrageCloseSafetyEvaluator";
import { createArbitrageCommandPayloadFingerprint } from "./ArbitrageCommandFingerprint";

type InstanceStore = Pick<ArbitrageInstanceStore, "get" | "releaseLegManagement">;
type CloseSafetyEvaluator = Pick<ArbitrageExecutionCloseService, "evaluateCloseSafety">;

export class ArbitrageManagementReleaseError extends Error {
  constructor(
    readonly category:
      | "invalid_management_release"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "management_release_unavailable"
      | "position_verification_unavailable"
      | "execution_state_unknown"
      | "idempotency_conflict"
      | "authentication_required",
    message: string,
  ) {
    super(message);
  }
}

export type ArbitrageManagementReleaseEligibilityReason =
  | "RELEASE_ELIGIBLE"
  | "INSTANCE_TERMINAL"
  | "UNRESOLVED_EXECUTION"
  | "NO_ACTIVE_MANAGED_EXPOSURE"
  | "PROVIDER_REALITY_UNAVAILABLE"
  | "FULL_MANAGED_CLOSE_AVAILABLE";

export type ArbitrageManagementReleaseEligibilityResult = ArbitrageCloseSafetyResult & Readonly<{
  realityReliable: boolean;
  releaseEligible: boolean;
  hasUnresolvedExecution: boolean;
  releaseEligibilityReason: ArbitrageManagementReleaseEligibilityReason;
}>;

export class ArbitrageManagementReleaseService {
  constructor(
    private readonly instances: InstanceStore,
    private readonly closeSafety: CloseSafetyEvaluator,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluateEligibility(
    authenticatedUserId: string,
    arbitrageIdInput: string,
    legIdInput: string,
  ): Promise<ArbitrageManagementReleaseEligibilityResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const arbitrageId = identifier(arbitrageIdInput, "arbitrageId");
    const legId = identifier(legIdInput, "legId");
    const instance = this.instances.get(userId, arbitrageId);
    if (!instance) throw releaseError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === legId);
    if (!leg) throw releaseError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");
    const safety = await this.closeSafety.evaluateCloseSafety(userId, instance.arbitrageId, leg.legId);
    return eligibilityResult(instance, leg.legId, safety);
  }

  async release(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    return this.releaseOnce(userId, parseRequest(input), "MANUAL");
  }

  async releaseDustAfterClose(
    authenticatedUserId: string,
    input: Readonly<{ arbitrageId: string; legId: string; commandId: string }>,
  ) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = Object.freeze({
      arbitrageId: identifier(input.arbitrageId, "arbitrageId"),
      legId: identifier(input.legId, "legId"),
      commandId: identifier(input.commandId, "commandId"),
    });
    return this.releaseOnce(userId, request, "QUANTITY_STEP_DUST");
  }

  private async releaseOnce(
    userId: string,
    request: Readonly<{ arbitrageId: string; legId: string; commandId: string }>,
    mode: "MANUAL" | "QUANTITY_STEP_DUST",
  ) {
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw releaseError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    const leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw releaseError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");

    const releaseId = deterministicReleaseId(userId, request.arbitrageId, request.legId, request.commandId);
    const replay = instance.managementReleases?.find((candidate) => candidate.releaseId === releaseId);
    if (replay) return Object.freeze({ instance, release: replay, idempotentReplay: true });
    const staticReason = staticIneligibilityReason(instance, leg.legId);
    if (staticReason === "INSTANCE_TERMINAL") {
      throw releaseError("management_release_unavailable", "已结束的套利实例不能释放管理责任。");
    }
    if (staticReason === "UNRESOLVED_EXECUTION") {
      throw releaseError("execution_state_unknown", "套利实例存在未决执行，不能释放管理责任。");
    }
    const activeQuantity = activeManagedQuantity(instance, leg);
    if (staticReason === "NO_ACTIVE_MANAGED_EXPOSURE") {
      throw releaseError("management_release_unavailable", "该套利腿当前没有可释放的管理数量。");
    }

    const requestedAt = checkedTimestamp(this.now(), "release request time");
    const safety = await this.closeSafety.evaluateCloseSafety(userId, instance.arbitrageId, leg.legId);
    const eligibility = eligibilityResult(instance, leg.legId, safety);
    if (eligibility.releaseEligibilityReason === "PROVIDER_REALITY_UNAVAILABLE"
      || safety.actualQuantity === null
      || safety.positionMode === null
      || safety.actualLongQuantity === null
      || safety.actualShortQuantity === null) {
      throw releaseError("position_verification_unavailable", "当前真实仓位无法可靠确认，不能释放管理责任。");
    }
    if (mode === "MANUAL" && eligibility.releaseEligibilityReason === "FULL_MANAGED_CLOSE_AVAILABLE") {
      throw releaseError("management_release_unavailable", "当前套利腿仍可通过正常退出完整关闭，不能释放管理责任。");
    }
    if (mode === "QUANTITY_STEP_DUST") {
      const confirmedCloseExists = instance.executionReferences.some((reference) => reference.legId === leg.legId
        && reference.phase === "CLOSING"
        && reference.status === "CONFIRMED"
        && compareUnsignedDecimals(reference.confirmedQuantity, reference.requestedQuantity) === 0);
      if (!confirmedCloseExists || safety.reason !== "QUANTITY_STEP_DUST" || safety.safeClosableQuantity !== "0") {
        throw releaseError(
          "management_release_unavailable",
          "剩余管理数量不满足交易所数量规则残余的自动责任终止条件。",
        );
      }
    }

    const confirmedAt = Math.max(requestedAt, safety.checkedAt, instance.updatedAt);
    try {
      return this.instances.releaseLegManagement(userId, instance.arbitrageId, {
        releaseId,
        commandId: request.commandId,
        operationType: "MANAGEMENT_RELEASE",
        businessPayloadFingerprint: createArbitrageCommandPayloadFingerprint([
          "MANAGEMENT_RELEASE",
          userId,
          instance.arbitrageId,
          leg.legId,
          "CONFIRMED_TRUE",
          ...(mode === "QUANTITY_STEP_DUST" ? [mode] : []),
          leg.role,
          leg.venue,
          leg.accountId,
          leg.instrumentId,
        ]),
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
        releasedQuantity: activeQuantity,
        reason: "USER_CONFIRMED_STOP_MANAGEMENT",
        source: "AUTHENTICATED_API",
        requestedByUserId: userId,
        requestedAt,
        confirmedAt,
        venue: leg.venue,
        accountId: leg.accountId,
        instrumentId: leg.instrumentId,
        positionMode: safety.positionMode,
        actualQuantity: safety.actualQuantity,
        actualSignedNetQuantity: safety.actualSignedNetQuantity,
        actualLongQuantity: safety.actualLongQuantity,
        actualShortQuantity: safety.actualShortQuantity,
        availableQuantity: safety.availableQuantity,
        realityCheckedAt: safety.checkedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Management release failed.";
      if (/execution reference|execution state/iu.test(message)) {
        throw releaseError("execution_state_unknown", "套利实例存在未决执行，不能释放管理责任。");
      }
      if (/idempotency conflict/iu.test(message)) {
        throw releaseError("idempotency_conflict", "commandId 已用于不同的管理责任释放请求。");
      }
      throw releaseError("management_release_unavailable", message);
    }
  }
}

function hasUnresolvedExecution(instance: ArbitrageInstance) {
  return instance.executionReferences.some((reference) => reference.status === "CLAIMED"
    || reference.status === "LINKED"
    || reference.status === "PENDING_CONFIRMATION"
    || reference.status === "UNKNOWN");
}

function staticIneligibilityReason(
  instance: ArbitrageInstance,
  legId: string,
): Exclude<ArbitrageManagementReleaseEligibilityReason, "RELEASE_ELIGIBLE" | "PROVIDER_REALITY_UNAVAILABLE" | "FULL_MANAGED_CLOSE_AVAILABLE"> | null {
  if (instance.status === "CLOSED" || instance.status === "FAILED") return "INSTANCE_TERMINAL";
  if (hasUnresolvedExecution(instance)) return "UNRESOLVED_EXECUTION";
  const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
  return activeManagedQuantity(instance, leg) === "0" ? "NO_ACTIVE_MANAGED_EXPOSURE" : null;
}

function eligibilityResult(
  instance: ArbitrageInstance,
  legId: string,
  safety: ArbitrageCloseSafetyResult,
): ArbitrageManagementReleaseEligibilityResult {
  const realityReliable = safety.reason !== "PROVIDER_REALITY_UNAVAILABLE"
    && safety.actualQuantity !== null
    && safety.positionMode !== null
    && safety.actualLongQuantity !== null
    && safety.actualShortQuantity !== null;
  const staticReason = staticIneligibilityReason(instance, legId);
  const releaseEligibilityReason = staticReason
    ?? (!realityReliable
      ? "PROVIDER_REALITY_UNAVAILABLE"
      : safety.fullManagedCloseAvailable
        ? "FULL_MANAGED_CLOSE_AVAILABLE"
        : "RELEASE_ELIGIBLE");
  return Object.freeze({
    ...safety,
    realityReliable,
    releaseEligible: releaseEligibilityReason === "RELEASE_ELIGIBLE",
    hasUnresolvedExecution: hasUnresolvedExecution(instance),
    releaseEligibilityReason,
  });
}

function deterministicReleaseId(userId: string, arbitrageId: string, legId: string, commandId: string) {
  return `management-release-${createHash("sha256").update(`${userId}\0${arbitrageId}\0${legId}\0${commandId}`).digest("hex")}`;
}

function parseRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw releaseError("invalid_management_release", "管理责任释放请求必须为对象。");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["arbitrageId", "legId", "commandId", "confirmed"];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown || allowed.some((key) => !(key in value)) || value.confirmed !== true) {
    throw releaseError("invalid_management_release", "管理责任释放必须显式确认且不能包含数量或 Provider 字段。");
  }
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    legId: identifier(value.legId, "legId"),
    commandId: identifier(value.commandId, "commandId"),
  });
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw releaseError("invalid_management_release", `${name} 无效。`);
  }
  return value.trim();
}

function checkedTimestamp(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid.`);
  return value;
}

function releaseError(category: ArbitrageManagementReleaseError["category"], message: string) {
  return new ArbitrageManagementReleaseError(category, message);
}
