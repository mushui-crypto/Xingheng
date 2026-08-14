import assert from "node:assert/strict";
import test from "node:test";
import { createAsset } from "../cex/Asset";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecordFromIntent, createExecutionRecord } from "../cex/ExecutionRecord";
import { BinanceFormalArbitrageExecutionRuntime } from "./BinanceFormalArbitrageExecutionRuntime";

const now = 1_800_000_000_000;

test("formal adapter delegates to the existing Binance runtime and confirms only full fills", async () => {
  const intent = executionIntent();
  let received = null;
  const adapter = new BinanceFormalArbitrageExecutionRuntime({
    async execute(value) {
      received = value;
      return {
        executionRecord: createExecutionRecord({
          ...createExecutionRecordFromIntent("record-1", value),
          status: "CONFIRMED",
        }),
        execution: {} as any,
      };
    },
  });
  const result = await adapter.execute(intent);
  assert.equal(received, intent);
  assert.equal(result.confirmedQuantity, "0.00123456789");
  assert.equal(result.executionRecord.status, "CONFIRMED");
});

test("pending/unknown production records fail closed without fabricating partial quantity", async () => {
  for (const status of ["PENDING_CONFIRMATION", "UNKNOWN"] as const) {
    const intent = executionIntent();
    const adapter = new BinanceFormalArbitrageExecutionRuntime({
      async execute(value) {
        return {
          executionRecord: createExecutionRecord({
            ...createExecutionRecordFromIntent(`record-${status}`, value),
            status,
          }),
          execution: {} as any,
        };
      },
    });
    const result = await adapter.execute(intent);
    assert.equal(result.confirmedQuantity, "0");
    assert.equal(result.executionRecord.status, status);
  }
});

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
