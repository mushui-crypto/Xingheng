import { createHash } from "node:crypto";
import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  type ArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitrageExecutionCloseService } from "./ArbitrageExecutionCloseService";
import type { ArbitrageCloseSafetyResult } from "./ArbitrageCloseSafetyEvaluator";
import type { VerifiedDustReleaseFacts } from "./ArbitrageCloseSafetyEvaluator";
import type { SpotCloseAvailableBalance } from "./BinanceSpotCloseBalanceSource";
import { SpotCloseBalanceReadError } from "./BinanceSpotCloseBalanceSource";
import { createArbitrageCommandPayloadFingerprint } from "./ArbitrageCommandFingerprint";

type InstanceStore = Pick<ArbitrageInstanceStore, "get" | "releaseLegManagement" | "readSpotOpeningAttributionEvidence">;
type CloseSafetyEvaluator = Pick<
  ArbitrageExecutionCloseService,
  "evaluateCloseSafety" | "readFreshDustReleaseBalance"
>;

export type DustReleaseReadAttempt = Readonly<{
  attempt: number;
  substage: "LOCAL_STATE" | "SPOT_BALANCE";
  result: "SUCCESS" | "FAILED";
  retryDecision: "COMPLETE" | "RETRY" | "STOP";
  delayMs: number;
  category: string | null;
  providerCode: string | null;
}>;

export type VerifiedDustReleaseContext = Readonly<{
  commandId: string;
  facts: VerifiedDustReleaseFacts;
  createdAt: number;
  fingerprint: string;
}>;

export function createVerifiedDustReleaseContext(
  commandId: string,
  facts: VerifiedDustReleaseFacts,
  createdAt: number,
): VerifiedDustReleaseContext {
  const normalizedCommandId = identifier(commandId, "commandId");
  const normalizedCreatedAt = checkedTimestamp(createdAt, "dust context time");
  const fingerprint = dustContextFingerprint(normalizedCommandId, facts, normalizedCreatedAt);
  return Object.freeze({ commandId: normalizedCommandId, facts, createdAt: normalizedCreatedAt, fingerprint });
}

export class ArbitrageManagementReleaseError extends Error {
  constructor(
    readonly category:
      | "invalid_management_release"
      | "arbitrage_instance_not_found"
      | "arbitrage_leg_not_found"
      | "management_release_unavailable"
      | "position_verification_unavailable"
      | "dust_release_reality_unavailable"
      | "dust_release_eligibility_changed"
      | "dust_release_attribution_unavailable"
      | "dust_release_provider_read_failed"
      | "account_identity_unavailable"
      | "spot_balance_unavailable"
      | "provider_response_invalid"
      | "identity_mismatch"
      | "auth_or_permission_failed"
      | "balance_reader_unavailable"
      | "execution_state_unknown"
      | "idempotency_conflict"
      | "authentication_required",
    message: string,
    readonly dustReadAttempts: readonly DustReleaseReadAttempt[] = Object.freeze([]),
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
    private readonly options: Readonly<{
      sleep?: (milliseconds: number) => Promise<void>;
      dustReadMaxAttempts?: number;
      dustReadInitialDelayMs?: number;
      dustContextMaxAgeMs?: number;
    }> = {},
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
    input: Readonly<{
      arbitrageId: string;
      legId: string;
      commandId: string;
      verifiedContext: VerifiedDustReleaseContext;
    }>,
  ) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = Object.freeze({
      arbitrageId: identifier(input.arbitrageId, "arbitrageId"),
      legId: identifier(input.legId, "legId"),
      commandId: identifier(input.commandId, "commandId"),
      verifiedContext: input.verifiedContext,
    });
    return this.releaseOnce(userId, request, "QUANTITY_STEP_DUST");
  }

  private async releaseOnce(
    userId: string,
    request: Readonly<{
      arbitrageId: string;
      legId: string;
      commandId: string;
      verifiedContext?: VerifiedDustReleaseContext;
    }>,
    mode: "MANUAL" | "QUANTITY_STEP_DUST",
  ) {
    let instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) throw releaseError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    let leg = instance.legs.find((candidate) => candidate.legId === request.legId);
    if (!leg) throw releaseError("arbitrage_leg_not_found", "所选套利腿不属于当前套利实例。");

    const releaseId = deterministicReleaseId(userId, request.arbitrageId, request.legId, request.commandId);
    const replay = instance.managementReleases?.find((candidate) => candidate.releaseId === releaseId);
    if (replay) return Object.freeze({
      instance, release: replay, idempotentReplay: true, dustReadAttempts: Object.freeze([]),
    });
    const staticReason = staticIneligibilityReason(instance, leg.legId);
    if (staticReason === "INSTANCE_TERMINAL") {
      throw releaseError("management_release_unavailable", "已结束的套利实例不能释放管理责任。");
    }
    if (staticReason === "UNRESOLVED_EXECUTION") {
      throw releaseError("execution_state_unknown", "套利实例存在未决执行，不能释放管理责任。");
    }
    let activeQuantity = activeManagedQuantity(instance, leg);
    if (staticReason === "NO_ACTIVE_MANAGED_EXPOSURE") {
      throw releaseError("management_release_unavailable", "该套利腿当前没有可释放的管理数量。");
    }

    const requestedAt = checkedTimestamp(this.now(), "release request time");
    let safety: ArbitrageCloseSafetyResult;
    let dustReadAttempts: readonly DustReleaseReadAttempt[] = Object.freeze([]);
    if (mode === "QUANTITY_STEP_DUST") {
      if (!request.verifiedContext) {
        throw releaseError("dust_release_reality_unavailable", "残余核验上下文缺失，未终止管理责任。");
      }
      const dustRead = await this.readDustReleaseSafety(userId, request, request.verifiedContext);
      instance = dustRead.instance;
      leg = dustRead.leg;
      activeQuantity = activeManagedQuantity(instance, leg);
      safety = dustRead.safety;
      dustReadAttempts = dustRead.attempts;
    } else {
      safety = await this.closeSafety.evaluateCloseSafety(userId, instance.arbitrageId, leg.legId);
    }
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
      const released = this.instances.releaseLegManagement(userId, instance.arbitrageId, {
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
      return Object.freeze({ ...released, dustReadAttempts });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Management release failed.";
      if (/execution reference|execution state/iu.test(message)) {
        throw releaseError("execution_state_unknown", "套利实例存在未决执行，不能释放管理责任。", dustReadAttempts);
      }
      if (/idempotency conflict/iu.test(message)) {
        throw releaseError("idempotency_conflict", "commandId 已用于不同的管理责任释放请求。", dustReadAttempts);
      }
      throw releaseError("management_release_unavailable", message, dustReadAttempts);
    }
  }

  private async readDustReleaseSafety(
    userId: string,
    request: Readonly<{ arbitrageId: string; legId: string; commandId: string }>,
    verifiedContext: VerifiedDustReleaseContext,
  ) {
    const maxAttempts = positiveInteger(this.options.dustReadMaxAttempts ?? 3, "dustReadMaxAttempts");
    const initialDelayMs = positiveInteger(this.options.dustReadInitialDelayMs ?? 250, "dustReadInitialDelayMs");
    const sleep = this.options.sleep ?? defaultSleep;
    const attempts: DustReleaseReadAttempt[] = [];
    validateDustContext(userId, request, verifiedContext, this.now(), this.options.dustContextMaxAgeMs ?? 60_000);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const instance = this.instances.get(userId, request.arbitrageId);
      const leg = instance?.legs.find((candidate) => candidate.legId === request.legId);
      const localFailure = instance && leg
        ? validateFreshLocalDustState(this.instances, userId, instance, leg.legId, verifiedContext.facts)
        : "INSTANCE_OR_LEG_MISSING";
      if (!instance || !leg || localFailure !== null) {
        attempts.push(readAttempt(attempt, "LOCAL_STATE", "FAILED", "STOP", 0, localFailure, null));
        throw releaseError(
          localFailure?.startsWith("ATTRIBUTION_")
            ? "dust_release_attribution_unavailable"
            : "dust_release_eligibility_changed",
          "残余管理责任终止条件已变化，未执行责任释放。",
          attempts,
        );
      }
      let balance: SpotCloseAvailableBalance;
      try {
        balance = await this.closeSafety.readFreshDustReleaseBalance(userId, verifiedContext.facts);
      } catch (error) {
        const classified = classifyDustBalanceError(error);
        const delayMs = classified.retryable && attempt < maxAttempts
          ? initialDelayMs * (2 ** (attempt - 1)) : 0;
        attempts.push(readAttempt(
          attempt, "SPOT_BALANCE", "FAILED", delayMs > 0 ? "RETRY" : "STOP",
          delayMs, classified.category, classified.providerCode,
        ));
        if (delayMs > 0) {
          await sleep(delayMs);
          continue;
        }
        throw releaseError(classified.releaseCategory, classified.message, attempts);
      }
      if (compareUnsignedDecimals(balance.totalQuantity ?? balance.availableQuantity, verifiedContext.facts.activeManagedQuantity) < 0
        || compareUnsignedDecimals(balance.availableQuantity, verifiedContext.facts.activeManagedQuantity) < 0) {
        attempts.push(readAttempt(attempt, "SPOT_BALANCE", "FAILED", "STOP", 0, "REALITY_CONFLICT", null));
        throw releaseError(
          "dust_release_eligibility_changed",
          "现货余额已变化，未终止残余管理责任。",
          attempts,
        );
      }
      attempts.push(readAttempt(attempt, "SPOT_BALANCE", "SUCCESS", "COMPLETE", 0, null, null));
      const totalQuantity = balance.totalQuantity ?? balance.availableQuantity;
      const safety = Object.freeze({
        activeManagedQuantity: verifiedContext.facts.activeManagedQuantity,
        safeClosableQuantity: "0",
        fullManagedCloseAvailable: false,
        reason: "QUANTITY_STEP_DUST" as const,
        checkedAt: balance.checkedAt,
        positionMode: "ONE_WAY" as const,
        actualQuantity: totalQuantity,
        actualSignedNetQuantity: totalQuantity,
        actualLongQuantity: totalQuantity,
        actualShortQuantity: "0",
        availableQuantity: balance.availableQuantity,
        verifiedAccountId: verifiedContext.facts.verifiedAccountId,
      });
      return Object.freeze({ instance, leg, safety, attempts: Object.freeze([...attempts]) });
    }
    throw releaseError("dust_release_provider_read_failed", "交易所现货余额读取失败。", attempts);
  }
}

function validateDustContext(
  userId: string,
  request: Readonly<{ arbitrageId: string; legId: string; commandId: string }>,
  context: VerifiedDustReleaseContext,
  now: number,
  maxAgeMs: number,
) {
  if (!context || context.commandId !== request.commandId
    || context.facts.userId !== userId
    || context.facts.arbitrageId !== request.arbitrageId
    || context.facts.legId !== request.legId
    || context.fingerprint !== dustContextFingerprint(context.commandId, context.facts, context.createdAt)
    || context.facts.verifiedAt > context.createdAt
    || now < context.createdAt || now - context.createdAt > positiveInteger(maxAgeMs, "dustContextMaxAgeMs")
    || now - context.facts.verifiedAt > maxAgeMs) {
    throw releaseError("dust_release_reality_unavailable", "残余核验上下文无效或已过期，未终止管理责任。");
  }
}

function validateFreshLocalDustState(
  store: InstanceStore,
  userId: string,
  instance: ArbitrageInstance,
  legId: string,
  facts: VerifiedDustReleaseFacts,
): string | null {
  if (staticIneligibilityReason(instance, legId) !== null) return "LOCAL_ELIGIBILITY_CHANGED";
  const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
  if (leg.venue !== facts.venue || leg.accountId !== facts.accountId || leg.instrumentId !== facts.instrumentId
    || facts.verifiedAccountId !== facts.accountId
    || activeManagedQuantity(instance, leg) !== facts.activeManagedQuantity) return "CONTEXT_SCOPE_CHANGED";
  if (!hasConfirmedClosingReference(instance, legId)) return "CONFIRMED_CLOSE_MISSING";
  const evidence = store.readSpotOpeningAttributionEvidence(userId, instance.arbitrageId, legId)
    .filter((candidate) => candidate.executionIntentId === facts.executionIntentId);
  if (evidence.length !== 1) return "ATTRIBUTION_UNAVAILABLE";
  const attribution = evidence[0]!;
  if (attribution.executionRecordId !== facts.executionRecordId
    || attribution.venue !== facts.venue || attribution.accountId !== facts.accountId
    || attribution.instrumentId !== facts.instrumentId
    || attribution.attributableBaseQuantity !== facts.attributableQuantity
    || compareUnsignedDecimals(attribution.attributableBaseQuantity, facts.activeManagedQuantity) < 0) {
    return "ATTRIBUTION_CHANGED";
  }
  return null;
}

function hasConfirmedClosingReference(instance: ArbitrageInstance, legId: string) {
  return instance.executionReferences.some((reference) => reference.legId === legId
    && reference.phase === "CLOSING"
    && reference.status === "CONFIRMED"
    && compareUnsignedDecimals(reference.confirmedQuantity, reference.requestedQuantity) === 0);
}

function classifyDustBalanceError(error: unknown): Readonly<{
  category: string;
  providerCode: string | null;
  retryable: boolean;
  releaseCategory: ArbitrageManagementReleaseError["category"];
  message: string;
}> {
  if (error instanceof SpotCloseBalanceReadError) {
    const retryable = error.category === "SPOT_BALANCE_UNAVAILABLE" && error.transient;
    return Object.freeze({
      category: error.category,
      providerCode: controlledProviderCode(error.providerCode),
      retryable,
      releaseCategory: error.category === "SPOT_BALANCE_UNAVAILABLE"
        ? "spot_balance_unavailable"
        : error.category === "BALANCE_READER_UNAVAILABLE"
          ? "balance_reader_unavailable"
          : error.category === "ACCOUNT_IDENTITY_UNAVAILABLE"
            ? "account_identity_unavailable"
            : error.category === "PROVIDER_RESPONSE_INVALID"
              ? "provider_response_invalid"
              : error.category === "IDENTITY_MISMATCH"
                ? "identity_mismatch"
                : "auth_or_permission_failed",
      message: error.category === "SPOT_BALANCE_UNAVAILABLE"
        ? "交易所现货余额读取失败，未终止残余管理责任。"
        : "交易所现货账户事实无法可靠确认，未终止残余管理责任。",
    });
  }
  return Object.freeze({
    category: "OTHER_PROVIDER_READ_FAILURE",
    providerCode: null,
    retryable: false,
    releaseCategory: "dust_release_provider_read_failed" as const,
    message: "交易所现货余额读取失败，未终止残余管理责任。",
  });
}

function readAttempt(
  attempt: number,
  substage: DustReleaseReadAttempt["substage"],
  result: DustReleaseReadAttempt["result"],
  retryDecision: DustReleaseReadAttempt["retryDecision"],
  delayMs: number,
  category: string | null,
  providerCode: string | null,
): DustReleaseReadAttempt {
  return Object.freeze({ attempt, substage, result, retryDecision, delayMs, category, providerCode });
}

function dustContextFingerprint(commandId: string, facts: VerifiedDustReleaseFacts, createdAt: number) {
  return createHash("sha256").update(JSON.stringify([
    "VERIFIED_DUST_RELEASE_CONTEXT", commandId, createdAt,
    facts.userId, facts.arbitrageId, facts.legId, facts.venue, facts.accountId,
    facts.instrumentId, facts.providerSymbol, facts.baseAsset, facts.verifiedAccountId,
    facts.executionIntentId, facts.executionRecordId, facts.attributableQuantity,
    facts.activeManagedQuantity, facts.totalQuantity, facts.availableQuantity,
    facts.quantityStep, facts.minQuantity, facts.verifiedAt,
  ])).digest("hex");
}

function controlledProviderCode(value: string | null) {
  return value !== null && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value) ? value : null;
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

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid.`);
  return value;
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function releaseError(
  category: ArbitrageManagementReleaseError["category"],
  message: string,
  attempts: readonly DustReleaseReadAttempt[] = Object.freeze([]),
) {
  return new ArbitrageManagementReleaseError(category, message, Object.freeze([...attempts]));
}
