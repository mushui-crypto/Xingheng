import assert from "node:assert/strict";
import test from "node:test";
import { createAsset } from "../cex/Asset";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecordFromIntent, createExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceFormalArbitrageExecutionRuntime } from "./BinanceFormalArbitrageExecutionRuntime";

const now = 1_800_000_000_000;

test("formal adapter delegates and preserves the runtime's authoritative Decimal fill", async () => {
  const intent = executionIntent();
  let received = null;
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      received = value;
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-1", value),
          status: "CONFIRMED",
        }),
        execution: executionResult("0.001234567890123456789"),
      };
    },
  });
  const result = await adapter.execute(intent);
  assert.equal(received, intent);
  assert.equal(result.confirmedQuantity, "0.001234567890123456789");
  assert.equal(result.executionRecord.status, "CONFIRMED");
});

test("partial and cancelled-with-partial production records retain exact Decimal fills", async () => {
  for (const [status, quantity] of [
    ["PENDING_CONFIRMATION", "0.000456789012345678"],
    ["FAILED", "0.000123456789012345"],
  ] as const) {
    const intent = executionIntent();
    const adapter = new BinanceFormalArbitrageExecutionRuntime({
      async cancel() { throw new Error("unused"); },
      async reconcile() { throw new Error("unused"); },
      async execute(value) {
        return {
          executionRecord: createExecutionRecord({
            ...createExecutionRecordFromIntent(`record-${status}`, value),
            status,
          }),
          execution: executionResult(quantity),
        };
      },
    });
    const result = await adapter.execute(intent);
    assert.equal(result.confirmedQuantity, quantity);
    assert.equal(result.executionRecord.status, status);
  }
});

test("unknown production results expose no fabricated confirmed quantity", async () => {
  const intent = executionIntent();
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async cancel() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async execute(value) {
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-unknown", value),
          status: "UNKNOWN",
        }),
        execution: executionResult(undefined),
      };
    },
  });
  const result = await adapter.execute(intent);
  assert.equal(result.confirmedQuantity, null);
  assert.equal(result.executionRecord.status, "UNKNOWN");
});

test("formal reconciliation maps authoritative Decimal observations and UNKNOWN to null", async () => {
  const record = createExecutionRecord({
    ...createExecutionRecordFromIntent("record-reconcile", executionIntent()),
    status: "PENDING_CONFIRMATION",
  });
  for (const observation of [
    { state: "CONFIRMED", filledBaseQuantity: "0.001234567890123456789", observedAt: now + 1 },
    { state: "PENDING_CONFIRMATION", filledBaseQuantity: "0.000456789012345678", observedAt: now + 2 },
    { state: "FAILED", filledBaseQuantity: "0.000123456789012345", observedAt: now + 3 },
    { state: "UNKNOWN", filledBaseQuantity: "0", observedAt: now + 4 },
  ] as const) {
    const adapter = new BinanceFormalArbitrageExecutionRuntime({
      async cancel() { throw new Error("unused"); },
      async execute() { throw new Error("unused"); },
      async reconcile(userId, executionId) {
        assert.equal(userId, "user-a");
        assert.equal(executionId, record.executionId);
        return { executionRecord: createExecutionRecord({ ...record, status: observation.state, updatedAt: observation.observedAt }), observation, terminalShortCircuit: false };
      },
    });
    const result = await adapter.reconcile("user-a", record.executionId);
    assert.equal(result.confirmedQuantity, observation.state === "UNKNOWN" ? null : observation.filledBaseQuantity);
    assert.equal(result.executionRecord.status, observation.state);
  }
});

test("formal cancel delegates without exposing provider-native fields", async () => {
  const intent = executionIntent();
  const executionRecord = createExecutionRecord({
    ...createExecutionRecordFromIntent("record-cancel", intent),
    status: "PENDING_CONFIRMATION",
  });
  const observation = { state: "CANCEL_REQUESTED" as const, observedAt: now + 1 };
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async execute() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async cancel(userId, executionId) {
      assert.equal(userId, intent.userId);
      assert.equal(executionId, executionRecord.executionId);
      return { executionRecord, observation };
    },
  });

  const result = await adapter.cancel(intent.userId, executionRecord.executionId);
  assert.deepEqual(result, { executionRecord, observation });
  assert.deepEqual(Object.keys(result).sort(), ["executionRecord", "observation"]);
});

function executionResult(confirmedQuantity: string | undefined) {
  return {
    step: {
      result: confirmedQuantity === undefined ? null : { confirmedQuantity },
    },
  } as any;
}

function executionIntent() {
  return createExecutionIntent({
    intentId: "intent-1",
    arbitrageId: "arbitrage-1",
    legId: "long-leg",
    userId: "user-a",
    venue: "binance",
    accountId: "binance:account-a",
    instrumentId: "BTC-USDT-PERP",
    side: "buy",
    quantity: { asset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }), quantity: "0.00123456789" },
    orderConstraints: { reduceOnly: false },
    executionMode: "PRICE_PRIORITY",
    createdAt: now,
    expiresAt: now + 30_000,
  });
}
