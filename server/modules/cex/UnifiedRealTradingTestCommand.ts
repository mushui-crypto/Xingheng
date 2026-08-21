import { createHash } from "node:crypto";
import type { FormalExecutionRuntimeResolver } from "../arbitrage-execution/FormalExecutionRuntimeRegistry";
import type { FormalExecutionRuntimeResult } from "../arbitrage-execution/FormalExecutionRuntime";
import type {
  ExecutionQuantityInput,
  ExecutionQuantityPlan,
} from "./ExecutionQuantityPlanner";
import { createExecutionIntent, type ExecutionIntent, type ExecutionVenue } from "./ExecutionIntent";
import type { ExecutionRecord } from "./ExecutionRecord";
import type { ExecutionRecordRecoveryStore } from "./ExecutionRecordStore";
import {
  ExecutionMutationSafetyError,
  ExecutionMutationSafetyGuard,
  type ExecutionMutationContext,
  type ExecutionProviderIdentityValidator,
} from "./ExecutionMutationSafetyGuard";

export type UnifiedRealTradingTestRequest = Readonly<{
  requestId: string;
  userId: string;
  venue: ExecutionVenue;
  instrumentId: string;
  side: "buy" | "sell";
  quantityInput: ExecutionQuantityInput;
  reduceOnly: boolean;
  executionMode: ExecutionIntent["executionMode"];
  executeLive: boolean;
}>;

export type UnifiedRealTradingTestPreparationRequest = Pick<
  UnifiedRealTradingTestRequest,
  "userId" | "venue" | "instrumentId" | "side" | "quantityInput" | "reduceOnly" | "executionMode"
>;

export type UnifiedRealTradingTestPreparation = Readonly<{
  accountId: string;
  quantityPlan: ExecutionQuantityPlan;
}>;

export interface UnifiedRealTradingTestVenuePreparation {
  readonly venue: ExecutionVenue;
  prepare(request: UnifiedRealTradingTestPreparationRequest): Promise<UnifiedRealTradingTestPreparation>;
}

export type UnifiedRealTradingTestResult = Readonly<{
  action: "PREVIEW" | "EXECUTED" | "RECONCILED" | "BLOCKED" | "FAILED" | "UNKNOWN";
  intent: ExecutionIntent;
  quantityPlan: ExecutionQuantityPlan;
  runtimeResult: FormalExecutionRuntimeResult | null;
}>;

type RecoveryStore = Pick<ExecutionRecordRecoveryStore, "findByIntentId">;

export type UnifiedRealTradingTestCommandOptions = Readonly<{
  now?: () => number;
  expiresInMs?: number;
  mutationSafetyRejections?: Pick<UnifiedRealTradingTestMutationSafetyGuard, "rejectionCount">;
}>;

export class UnifiedRealTradingTestMutationSafetyGuard extends ExecutionMutationSafetyGuard {
  private readonly rejections = new Map<string, number>();

  override async assertAllowed(
    context: ExecutionMutationContext,
    validateProviderIdentity?: ExecutionProviderIdentityValidator,
  ) {
    try {
      await super.assertAllowed(context, validateProviderIdentity);
    } catch (error) {
      if (error instanceof ExecutionMutationSafetyError) {
        this.rejections.set(context.venue, this.rejectionCount(context.venue) + 1);
      }
      throw error;
    }
  }

  rejectionCount(venue: string) {
    return this.rejections.get(venue) ?? 0;
  }
}

export class UnifiedRealTradingTestCommand {
  private readonly preparations = new Map<ExecutionVenue, UnifiedRealTradingTestVenuePreparation>();
  private readonly now: () => number;
  private readonly expiresInMs: number;
  private readonly mutationSafetyRejections?: Pick<UnifiedRealTradingTestMutationSafetyGuard, "rejectionCount">;

  constructor(
    private readonly runtimes: FormalExecutionRuntimeResolver,
    private readonly records: RecoveryStore,
    preparations: readonly UnifiedRealTradingTestVenuePreparation[],
    options: UnifiedRealTradingTestCommandOptions = {},
  ) {
    for (const preparation of preparations) {
      if (this.preparations.has(preparation.venue)) {
        throw new Error(`Duplicate real trading test preparation for venue: ${preparation.venue}.`);
      }
      this.preparations.set(preparation.venue, preparation);
    }
    this.now = options.now ?? Date.now;
    this.expiresInMs = options.expiresInMs ?? 60_000;
    this.mutationSafetyRejections = options.mutationSafetyRejections;
    if (!Number.isSafeInteger(this.expiresInMs) || this.expiresInMs <= 0) {
      throw new Error("Real trading test intent expiry must be a positive safe integer.");
    }
  }

  async run(input: UnifiedRealTradingTestRequest): Promise<UnifiedRealTradingTestResult> {
    const request = normalizeRequest(input);
    const preparation = this.preparations.get(request.venue);
    if (!preparation) {
      throw new Error(`Real trading test preparation is not registered for venue: ${request.venue}.`);
    }
    const prepared = await preparation.prepare(request);
    if (prepared.quantityPlan.instrumentId !== request.instrumentId) {
      throw new Error("Real trading test quantity plan instrument does not match the request.");
    }
    const createdAt = timestamp(this.now());
    const intent = createExecutionIntent({
      intentId: unifiedRealTradingTestIntentId(request),
      userId: request.userId,
      venue: request.venue,
      accountId: prepared.accountId,
      instrumentId: request.instrumentId,
      side: request.side,
      quantity: prepared.quantityPlan.plannedAssetQuantity,
      orderConstraints: { reduceOnly: request.reduceOnly },
      executionMode: request.executionMode,
      createdAt,
      expiresAt: createdAt + this.expiresInMs,
    });

    if (!request.executeLive) {
      return result("PREVIEW", intent, prepared.quantityPlan, null);
    }

    const runtime = this.runtimes.resolve(request.venue);
    const existing = await this.records.findByIntentId(intent.intentId);
    if (existing.length > 1) {
      throw new Error("Multiple ExecutionRecords exist for the real trading test intent; manual reconciliation is required.");
    }
    const record = existing[0];
    if (record) {
      assertRecoveryIdentity(record, intent);
      const runtimeResult = await runtime.reconcile(intent.userId, record.executionId);
      return result(
        runtimeResultAction(runtimeResult, "RECONCILED"),
        intent,
        prepared.quantityPlan,
        runtimeResult,
      );
    }

    const rejectionsBefore = this.mutationSafetyRejections?.rejectionCount(request.venue) ?? 0;
    const runtimeResult = await runtime.execute(intent);
    const safetyRejected = (this.mutationSafetyRejections?.rejectionCount(request.venue) ?? 0) > rejectionsBefore;
    return result(
      runtimeResultAction(runtimeResult, "EXECUTED", safetyRejected),
      intent,
      prepared.quantityPlan,
      runtimeResult,
    );
  }
}

export function unifiedRealTradingTestIntentId(
  request: Pick<UnifiedRealTradingTestRequest, "requestId" | "userId" | "venue">,
) {
  const digest = createHash("sha256")
    .update(`stellax-real-trading-test\0${identifier(request.userId, "userId")}\0${request.venue}\0${identifier(request.requestId, "requestId")}`)
    .digest("hex");
  return `real-test-${request.venue}-${digest.slice(0, 40)}`;
}

export function unifiedRealTradingTestExecutionId(
  intent: Pick<
    ExecutionIntent,
    | "intentId"
    | "userId"
    | "venue"
    | "accountId"
    | "instrumentId"
    | "side"
    | "quantity"
    | "orderConstraints"
    | "executionMode"
  >,
) {
  const digest = createHash("sha256")
    .update([
      "stellax-real-trading-test-execution",
      identifier(intent.intentId, "intentId"),
      identifier(intent.userId, "userId"),
      intent.venue,
      identifier(intent.accountId, "accountId"),
      identifier(intent.instrumentId, "instrumentId"),
      intent.side,
      identifier(intent.quantity.asset.symbol, "quantity asset"),
      identifier(intent.quantity.quantity, "quantity"),
      String(intent.orderConstraints.reduceOnly),
      intent.executionMode,
    ].join("\0"))
    .digest("hex");
  return `real-test-execution-${digest.slice(0, 40)}`;
}

function normalizeRequest(input: UnifiedRealTradingTestRequest): UnifiedRealTradingTestRequest {
  if (!input || typeof input !== "object") throw new Error("Real trading test request is invalid.");
  const venue = executionVenue(input.venue);
  if (input.side !== "buy" && input.side !== "sell") throw new Error("side must be buy or sell.");
  if (input.executionMode !== "PRICE_PRIORITY" && input.executionMode !== "EXECUTION_PRIORITY") {
    throw new Error("executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }
  if (typeof input.reduceOnly !== "boolean" || typeof input.executeLive !== "boolean") {
    throw new Error("reduceOnly and executeLive must be booleans.");
  }
  return Object.freeze({
    requestId: identifier(input.requestId, "requestId"),
    userId: identifier(input.userId, "userId"),
    venue,
    instrumentId: identifier(input.instrumentId, "instrumentId"),
    side: input.side,
    quantityInput: input.quantityInput,
    reduceOnly: input.reduceOnly,
    executionMode: input.executionMode,
    executeLive: input.executeLive,
  });
}

function assertRecoveryIdentity(record: ExecutionRecord, intent: ExecutionIntent) {
  if (record.executionId !== unifiedRealTradingTestExecutionId(intent)) {
    throw new Error("Existing ExecutionRecord request semantics do not match the real trading test request.");
  }
  if (
    record.intentId !== intent.intentId
    || record.userId !== intent.userId
    || record.venue !== intent.venue
    || record.accountId !== intent.accountId
    || record.instrumentId !== intent.instrumentId
  ) {
    throw new Error("Existing ExecutionRecord identity does not match the real trading test intent.");
  }
}

function result(
  action: UnifiedRealTradingTestResult["action"],
  intent: ExecutionIntent,
  quantityPlan: ExecutionQuantityPlan,
  runtimeResult: FormalExecutionRuntimeResult | null,
): UnifiedRealTradingTestResult {
  return Object.freeze({ action, intent, quantityPlan, runtimeResult });
}

function runtimeResultAction(
  runtimeResult: FormalExecutionRuntimeResult,
  successAction: "EXECUTED" | "RECONCILED",
  safetyRejected = false,
): UnifiedRealTradingTestResult["action"] {
  if (runtimeResult.executionRecord.status === "FAILED" && safetyRejected) return "BLOCKED";
  if (runtimeResult.executionRecord.status === "FAILED") return "FAILED";
  if (runtimeResult.executionRecord.status === "UNKNOWN") {
    return safetyRejected ? "BLOCKED" : "UNKNOWN";
  }
  if (
    runtimeResult.executionRecord.status === "PENDING_CONFIRMATION"
    || runtimeResult.executionRecord.status === "CONFIRMED"
  ) {
    return successAction;
  }
  return "UNKNOWN";
}

function executionVenue(value: unknown): ExecutionVenue {
  if (value !== "binance" && value !== "okx" && value !== "bybit" && value !== "bitget") {
    throw new Error("venue must be binance, okx, bybit, or bitget.");
  }
  return value;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Real trading test clock must return a non-negative safe integer timestamp.");
  }
  return value;
}
