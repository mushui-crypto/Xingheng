import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAsset } from "../cex/Asset";
import { ExecutionPreMutationFailure } from "../cex/ExecutionCapability";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecordFromIntent, createExecutionRecord } from "../cex/ExecutionRecord";
import { assertExecutionIdentityContract, assertFormalResultContract } from "../cex/RuntimeLifecycleContractAssertions";
import type {
  OkxIntentExecutionCancelRuntimeResult,
  OkxIntentExecutionReconciliationRuntimeResult,
  OkxIntentExecutionRuntimeResult,
} from "./OkxIntentExecutionRuntime";
import { OkxFormalArbitrageExecutionRuntime } from "./OkxFormalArbitrageExecutionRuntime";

test("formal runtime exposes the underlying mode capability used by Draft", () => {
  const adapter = new OkxFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute() { throw new Error("unused"); },
    supportsOpeningExecutionMode: ({ executionMode }) => executionMode === "EXECUTION_PRIORITY",
  });

  assert.deepEqual(adapter.openingExecutionCapability({
    executionMode: "PRICE_PRIORITY",
    marketType: "perpetual",
  }), { supported: false, reasonCode: "EXECUTION_MODE_NOT_SUPPORTED" });
  assert.deepEqual(adapter.openingExecutionCapability({
    executionMode: "EXECUTION_PRIORITY",
    marketType: "perpetual",
  }), { supported: true, reasonCode: "AVAILABLE" });
});

test("uses the same diagnostic contract for rejected and credential errors", async () => {
  for (const [category, message] of [
    ["provider_request_rejected", "request rejected"],
    ["credential_validation_failed", "passphrase=top-secret rejected"],
  ] as const) {
    const intent = diagnosticExecutionIntent();
    const adapter = new OkxFormalArbitrageExecutionRuntime({
      async cancel() { throw new Error("unused"); },
      async reconcile() { throw new Error("unused"); },
      async execute(value) {
        return {
          executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent(`record-${category}`, value), status: "UNKNOWN" }),
          execution: {
            status: "CALL_FAILED",
            step: { status: "CALL_FAILED", result: null, error: Object.assign(new Error(message), { category }) },
          },
        } as any;
      },
    });
    const result = await adapter.execute(intent);
    assert.equal(result.diagnostic?.category, category);
    assert.equal(result.diagnostic?.stage, "execution-capability");
    assert.equal(result.diagnostic?.errorType, "Error");
    assert.doesNotMatch(result.diagnostic?.sanitizedMessage ?? "", /top-secret/u);
  }
});

test("formal diagnostics retain only a controlled OKX provider code", async () => {
  const intent = diagnosticExecutionIntent();
  const adapter = new OkxFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({ ...createExecutionRecordFromIntent("record-provider-code", value), status: "FAILED" }),
        execution: {
          status: "CALL_FAILED",
          step: {
            status: "CALL_FAILED",
            result: null,
            error: new ExecutionPreMutationFailure("controlled", Object.assign(new Error("safe"), {
              category: "position_mode_unavailable",
              providerCode: "50011",
            })),
          },
        },
      } as any;
    },
  });

  const result = await adapter.execute(intent);
  assert.equal(result.diagnostic?.category, "position_mode_unavailable");
  assert.equal(result.diagnostic?.providerCode, "50011");
  assert.equal(result.mutationDisposition, "NOT_DISPATCHED");
});

test("exposes NOT_DISPATCHED only for a proven OKX pre-mutation FAILED result", async () => {
  const intent = diagnosticExecutionIntent();
  const adapter = new OkxFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-okx-not-dispatched", value),
          status: "FAILED",
        }),
        execution: {
          status: "CALL_FAILED",
          step: {
            status: "CALL_FAILED",
            result: null,
            error: new ExecutionPreMutationFailure("OKX blocked before placeOrder"),
          },
        },
      } as any;
    },
  });

  const result = await adapter.execute(intent);

  assert.equal(result.confirmedQuantity, "0");
  assert.equal(result.mutationDisposition, "NOT_DISPATCHED");
});

function diagnosticExecutionIntent() {
  return createExecutionIntent({
    intentId: "intent-okx-diagnostic",
    arbitrageId: "arbitrage-okx",
    legId: "leg-okx",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-a",
    instrumentId: "BTC-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: { asset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }), quantity: "1" },
    orderConstraints: { reduceOnly: false },
    executionMode: "PRICE_PRIORITY",
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_030_000,
  });
}

const now = 1_800_000_000_000;

test("OKX formal adapter executes through the runtime and exposes only canonical result fields", async () => {
  const intent = executionIntent();
  const executionRecord = record("execution-okx-execute", "CONFIRMED");
  let received = null;
  const adapter = new OkxFormalArbitrageExecutionRuntime({
    async execute(value) {
      received = value;
      return executeResult(executionRecord, "12.500000000000000001");
    },
    async reconcile() { throw new Error("unused"); },
    async cancel() { throw new Error("unused"); },
  });

  const result = await adapter.execute(intent);

  assert.equal(received, intent);
  assert.deepEqual(result, {
    executionRecord,
    confirmedQuantity: "12.500000000000000001",
    mutationDisposition: "DISPATCHED_OR_POSSIBLE",
  });
  assert.deepEqual(Object.keys(result).sort(), ["confirmedQuantity", "executionRecord", "mutationDisposition"]);
  assert.equal(JSON.stringify(result).includes("DOGE-USDT-SWAP"), false);
  assert.equal(JSON.stringify(result).includes("8001"), false);
  assertExecutionIdentityContract(result.executionRecord, intent);
  assertFormalResultContract({ result, expectedQuantity: "12.500000000000000001" });
});

test("OKX formal adapter reconciles canonical Decimal observations and fails closed on UNKNOWN", async () => {
  const executionRecord = record("execution-okx-reconcile", "PENDING_CONFIRMATION");
  for (const observation of [
    { state: "CONFIRMED", filledBaseQuantity: "12.500000000000000001", observedAt: now + 1 },
    { state: "PENDING_CONFIRMATION", filledBaseQuantity: "3.125", observedAt: now + 2 },
    { state: "FAILED", filledBaseQuantity: "1.25", observedAt: now + 3 },
    { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now + 4 },
  ] as const) {
    const adapter = new OkxFormalArbitrageExecutionRuntime({
      async execute() { throw new Error("unused"); },
      async reconcile(userId, executionId) {
        assert.equal(userId, "user-a");
        assert.equal(executionId, executionRecord.executionId);
        return reconciliationResult(executionRecord, observation);
      },
      async cancel() { throw new Error("unused"); },
    });

    const result = await adapter.reconcile("user-a", executionRecord.executionId);

    assert.equal(
      result.confirmedQuantity,
      observation.state === "UNKNOWN" ? null : observation.filledBaseQuantity,
    );
    assert.deepEqual(Object.keys(result).sort(), ["confirmedQuantity", "executionRecord"]);
    assert.equal(JSON.stringify(result).includes("ordId"), false);
    assert.equal(JSON.stringify(result).includes("clOrdId"), false);
    assert.equal(JSON.stringify(result).includes("instId"), false);
  }
});

test("OKX formal adapter cancels through the runtime without exposing order references", async () => {
  const executionRecord = record("execution-okx-cancel", "PENDING_CONFIRMATION");
  const observation = { state: "CANCEL_REQUESTED" as const, observedAt: now + 1 };
  const adapter = new OkxFormalArbitrageExecutionRuntime({
    async execute() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async cancel(userId, executionId) {
      assert.equal(userId, "user-a");
      assert.equal(executionId, executionRecord.executionId);
      return cancelResult(executionRecord, observation);
    },
  });

  const result = await adapter.cancel("user-a", executionRecord.executionId);

  assert.deepEqual(result, { executionRecord, observation });
  assert.deepEqual(Object.keys(result).sort(), ["executionRecord", "observation"]);
  assert.equal(JSON.stringify(result).includes("DOGE-USDT-SWAP"), false);
  assert.equal(JSON.stringify(result).includes("8001"), false);
});

test("OKX formal adapter has no direct provider mutation or production registration dependency", () => {
  const source = readFileSync(new URL("./OkxFormalArbitrageExecutionRuntime.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /OkxClient|placeOrder|cancelOrder/u);
  assert.doesNotMatch(source, /FormalExecutionRuntimeRegistry|formalExecutionRuntime\s*\(/u);
});

function executeResult(
  executionRecord: ReturnType<typeof record>,
  confirmedQuantity: string,
): OkxIntentExecutionRuntimeResult {
  return {
    executionRecord,
    execution: {
      status: "SUCCEEDED",
      step: {
        status: "SUCCEEDED",
        result: {
          confirmedQuantity,
          providerOrderId: "8001",
          clientOrderId: "sxokxclientorder000000000000001",
          instId: "DOGE-USDT-SWAP",
        },
      },
    } as unknown as OkxIntentExecutionRuntimeResult["execution"],
    orderReference: {
      executionId: executionRecord.executionId,
      intentId: executionRecord.intentId,
      userId: executionRecord.userId,
      accountId: executionRecord.accountId,
      instrumentId: executionRecord.instrumentId,
      instId: "DOGE-USDT-SWAP",
      ordId: "8001",
      clOrdId: "sxokxclientorder000000000000001",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function reconciliationResult(
  executionRecord: ReturnType<typeof record>,
  observation: NonNullable<OkxIntentExecutionReconciliationRuntimeResult["observation"]>,
): OkxIntentExecutionReconciliationRuntimeResult {
  return {
    executionRecord,
    observation,
    orderReference: {
      executionId: executionRecord.executionId,
      intentId: executionRecord.intentId,
      userId: executionRecord.userId,
      accountId: executionRecord.accountId,
      instrumentId: executionRecord.instrumentId,
      instId: "DOGE-USDT-SWAP",
      ordId: "8001",
      clOrdId: "sxokxclientorder000000000000001",
      createdAt: now,
      updatedAt: observation.observedAt,
    },
    statusReason: null,
    terminalShortCircuit: false,
  };
}

function cancelResult(
  executionRecord: ReturnType<typeof record>,
  observation: OkxIntentExecutionCancelRuntimeResult["observation"],
): OkxIntentExecutionCancelRuntimeResult {
  return {
    executionRecord,
    observation,
    orderReference: {
      executionId: executionRecord.executionId,
      intentId: executionRecord.intentId,
      userId: executionRecord.userId,
      accountId: executionRecord.accountId,
      instrumentId: executionRecord.instrumentId,
      instId: "DOGE-USDT-SWAP",
      ordId: "8001",
      clOrdId: "sxokxclientorder000000000000001",
      createdAt: now,
      updatedAt: observation.observedAt,
    },
  };
}

function executionIntent() {
  return createExecutionIntent({
    intentId: "intent-okx-formal",
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    userId: "user-a",
    venue: "okx",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: { asset: createAsset({ symbol: "DOGE", type: "DIGITAL_ASSET" }), quantity: "12.5" },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 30_000,
  });
}

function record(executionId: string, status: "CONFIRMED" | "PENDING_CONFIRMATION") {
  return createExecutionRecord({
    ...createExecutionRecordFromIntent(executionId, executionIntent()),
    status,
  });
}
