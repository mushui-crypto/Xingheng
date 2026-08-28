import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { createArbitrageCommandPayloadFingerprint } from "./ArbitrageCommandFingerprint";

type InstanceStore = Pick<ArbitrageInstanceStore, "get" | "abandonUnstarted">;

export class ArbitrageUnstartedAbandonError extends Error {
  constructor(
    readonly category:
      | "invalid_abandon_confirmation"
      | "arbitrage_instance_not_found"
      | "abandon_unavailable"
      | "idempotency_conflict"
      | "authentication_required",
    message: string,
  ) {
    super(message);
  }
}

export class ArbitrageUnstartedAbandonService {
  constructor(
    private readonly instances: InstanceStore,
    private readonly now: () => number = Date.now,
  ) {}

  abandon(authenticatedUserId: string, input: unknown) {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const request = parseRequest(input);
    const instance = this.instances.get(userId, request.arbitrageId);
    if (!instance) {
      throw abandonError("arbitrage_instance_not_found", "套利实例不存在或不属于当前用户。");
    }
    const requestedAt = checkedTimestamp(this.now(), "abandon request time");
    try {
      const result = this.instances.abandonUnstarted(userId, instance.arbitrageId, {
        commandId: request.commandId,
        operationType: "ABANDON_UNSTARTED_ARBITRAGE",
        requestedByUserId: userId,
        arbitrageId: instance.arbitrageId,
        reason: "USER_ABANDONED_BEFORE_EXECUTION",
        businessPayloadFingerprint: createArbitrageCommandPayloadFingerprint([
          "ABANDON_UNSTARTED_ARBITRAGE",
          userId,
          instance.arbitrageId,
          "CONFIRMED_TRUE",
        ]),
        requestedAt,
        confirmedAt: requestedAt,
      });
      return Object.freeze({ ...result, providerMutationCount: 0 as const });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unstarted arbitrage abandonment failed.";
      if (/idempotency|fingerprint|conflicting abandonment/iu.test(message)) {
        throw abandonError("idempotency_conflict", "commandId 已用于不同的套利终止请求。");
      }
      if (/execution|managed-position|cannot be abandoned|OPENING|terminal/iu.test(message)) {
        throw abandonError(
          "abandon_unavailable",
          "该套利已存在交易或管理事实，不能按“尚未开始”终止。",
        );
      }
      throw abandonError("abandon_unavailable", message);
    }
  }
}

function parseRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw abandonError("invalid_abandon_confirmation", "放弃未开始套利的请求必须为对象。");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["arbitrageId", "commandId", "confirmed"];
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || allowed.some((key) => !(key in value)) || value.confirmed !== true) {
    throw abandonError(
      "invalid_abandon_confirmation",
      "放弃未开始套利需要显式确认，且不能包含交易、数量或 Provider 字段。",
    );
  }
  return Object.freeze({
    arbitrageId: identifier(value.arbitrageId, "arbitrageId"),
    commandId: identifier(value.commandId, "commandId"),
  });
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw abandonError("invalid_abandon_confirmation", `${name} 无效。`);
  }
  return value.trim();
}

function checkedTimestamp(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid.`);
  return value;
}

function abandonError(
  category: ArbitrageUnstartedAbandonError["category"],
  message: string,
) {
  return new ArbitrageUnstartedAbandonError(category, message);
}
