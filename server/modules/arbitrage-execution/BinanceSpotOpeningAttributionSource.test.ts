import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { binanceExecutionIdempotencyKeyFor } from "../binance/BinanceIntentExecutionService";
import { BinanceSpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";

const record = createExecutionRecord({
  executionId: "execution-open-doge",
  intentId: "intent-open-doge",
  executionAttemptId: "intent-open-doge",
  userId: "user-a",
  venue: "binance",
  accountId: "binance:account-a",
  instrumentId: "DOGE-USDT-SPOT",
  status: "CONFIRMED",
  remoteOrderId: "9223372036854775807",
  createdAt: 1_900_000_000_000,
  updatedAt: 1_900_000_000_001,
});

test("resolves the exact opening order and subtracts only authoritative base commission", async () => {
  const calls: string[] = [];
  const source = new BinanceSpotOpeningAttributionSource(
    { loadForUser: (userId, executionId) => userId === "user-a" && executionId === record.executionId ? record : null },
    registry({
      executionAccountIdentity: async () => ({ accountId: record.accountId }),
      executionOrderState(idempotencyKey: string) {
        calls.push(idempotencyKey);
        return {
          kind: "found" as const,
          order: { category: "spot" as const, symbol: "DOGEUSDT", providerOrderId: record.remoteOrderId!, clientOrderId: "client-open-doge" },
        };
      },
      readSpotOrderFills: async (symbol: string, orderId: string, baseAsset: string) => {
        assert.deepEqual({ symbol, orderId, baseAsset }, {
          symbol: "DOGEUSDT", orderId: "9223372036854775807", baseAsset: "DOGE",
        });
        return {
          symbol,
          providerOrderId: orderId,
          grossBaseQuantity: "73",
          baseCommissionQuantity: "0.073",
        };
      },
    }),
  );

  const quantity = await source.readAttributableBaseQuantity("user-a", request());

  assert.equal(quantity, "72.927");
  assert.deepEqual(calls, [binanceExecutionIdempotencyKeyFor(record)]);
});

test("fails closed when local provider identity, fills identity, or commission read is unavailable", async (t) => {
  for (const fixture of [
    { name: "missing local order", local: { kind: "missing" as const }, fills: fills() },
    { name: "wrong provider order", local: found("other-order"), fills: fills() },
    { name: "gross fill mismatch", local: found(record.remoteOrderId!), fills: fills({ grossBaseQuantity: "72" }) },
    { name: "commission unavailable", local: found(record.remoteOrderId!), fills: new Error("commission unavailable") },
  ]) {
    await t.test(fixture.name, async () => {
      const source = new BinanceSpotOpeningAttributionSource(
        { loadForUser: () => record },
        registry({
          executionAccountIdentity: async () => ({ accountId: record.accountId }),
          executionOrderState: () => fixture.local,
          readSpotOrderFills: async () => {
            if (fixture.fills instanceof Error) throw fixture.fills;
            return fixture.fills;
          },
        }),
      );
      await assert.rejects(() => source.readAttributableBaseQuantity("user-a", request()));
    });
  }
});

function request() {
  return {
    accountId: record.accountId,
    instrumentId: record.instrumentId,
    providerSymbol: "DOGEUSDT",
    baseAsset: "DOGE",
    executionIntentId: record.intentId,
    executionRecordId: record.executionId,
    grossConfirmedQuantity: "73",
  };
}

function found(providerOrderId: string) {
  return {
    kind: "found" as const,
    order: { category: "spot" as const, symbol: "DOGEUSDT", providerOrderId, clientOrderId: "client-open-doge" },
  };
}

type FillSummary = {
  symbol: string;
  providerOrderId: string;
  grossBaseQuantity: string;
  baseCommissionQuantity: string;
};

function fills(overrides: Partial<FillSummary> = {}): FillSummary {
  return {
    symbol: "DOGEUSDT",
    providerOrderId: record.remoteOrderId!,
    grossBaseQuantity: "73",
    baseCommissionQuantity: "0.073",
    ...overrides,
  };
}

function registry(service: object) {
  return {
    async run<T>(_userId: string, operation: (value: never) => Promise<T> | T): Promise<T> {
      return operation(service as never);
    },
  };
}
