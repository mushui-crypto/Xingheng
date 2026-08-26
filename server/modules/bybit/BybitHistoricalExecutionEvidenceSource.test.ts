import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import type { ArbitrageInstance } from "../cex/arbitrage-instance/ArbitrageInstance";
import { BybitHistoricalExecutionEvidenceSource } from "./BybitHistoricalExecutionEvidenceSource";
import { bybitOrderLinkIdFor } from "./BybitIntentExecutionService";

test("Bybit evidence uses deterministic order identity and scans both instance instruments read-only", async () => {
  const exact: unknown[] = [];
  const active: unknown[] = [];
  const source = new BybitHistoricalExecutionEvidenceSource({
    findSummary: () => ({ accountId: "bybit:account-a" }) as never,
    loadForAccountRead: async () => ({ apiKey: "key", apiSecret: "secret" }) as never,
  }, () => ({
    async readHistoricalOrderEvidence(input) {
      exact.push(input);
      return { exactOrderEvidence: "ABSENT", activeOrderCount: 0, checkedAt: 123 };
    },
    async readActiveOrderCount(category, symbol) {
      active.push({ category, symbol });
      return 0;
    },
  }));
  const record = createExecutionRecord({
    executionId: "record-1", intentId: "intent-1", userId: "user-a", venue: "bybit",
    accountId: "bybit:account-a", instrumentId: "DOGE-USDT-SPOT", status: "UNKNOWN",
    createdAt: 100, updatedAt: 101,
  });
  const result = await source.verify({ instance: instance(), executionRecord: record });

  assert.deepEqual(result, {
    recoveryAnchorRequiredBeforeMutation: true,
    exactOrderEvidence: "ABSENT",
    activeOrderEvidence: "NONE",
    absenceScope: "HISTORICAL_WINDOW_UNCERTAIN",
    checkedAt: 123,
  });
  assert.deepEqual(exact, [{
    category: "spot", symbol: "DOGEUSDT",
    orderLinkId: bybitOrderLinkIdFor({ userId: "user-a", accountId: "bybit:account-a", intentId: "intent-1" }),
    startedAt: 100,
  }]);
  assert.deepEqual(active, [
    { category: "spot", symbol: "DOGEUSDT" },
    { category: "linear", symbol: "DOGEUSDT" },
  ]);
});

function instance(): ArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1", userId: "user-a", strategyType: "SPOT_PERPETUAL", sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0.1", status: "OPENING", createdAt: 100, openedAt: null, updatedAt: 101, closedAt: null,
    legs: [
      { legId: "spot", role: "LONG", venue: "bybit", accountId: "bybit:account-a", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "94", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
      { legId: "perp", role: "SHORT", venue: "bybit", accountId: "bybit:account-a", instrumentId: "DOGE-USDT-PERP", plannedQuantity: "94", confirmedOpenedQuantity: "0", confirmedClosedQuantity: "0" },
    ],
    executionReferences: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}
