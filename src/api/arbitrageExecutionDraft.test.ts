import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmArbitrageExecution,
  confirmArbitrageExecutionLeg,
  fetchArbitrageExecutionDraft,
  previewArbitrageExecutionDraft,
} from "./arbitrageExecutionDraft";

test("draft API sends only opportunity identity, horizon, and explicit quantity input", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ opportunityId: "op-1", legs: [] });
  };
  try {
    await fetchArbitrageExecutionDraft("op/1", 90);
    await previewArbitrageExecutionDraft("op/1", 90, { mode: "NOTIONAL_USDT", amountUsdt: "20" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0]?.url, "/api/arbitrage-execution/draft?opportunityId=op%2F1&horizonDays=90");
  const body = JSON.parse(String(calls[1]?.init?.body));
  assert.deepEqual(body, {
    opportunityId: "op/1",
    horizonDays: 90,
    quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "20" },
  });
  assert.equal("providerSymbol" in body, false);
  assert.equal("fundingIntent" in body, false);
});

test("formal confirmation APIs send only command identity and user inputs", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body));
    const instance = instancePayload(body.arbitrageId ?? "arbitrage-1");
    return Response.json(String(input).includes("legs/confirm")
      ? {
          instance,
          executionRecord: { executionId: "record-1", intentId: "intent-1", status: "CONFIRMED", plannedQuantity: "0.001", confirmedQuantity: "0.001" },
          idempotentReplay: false,
          secondLegAllowed: true,
        }
      : { instance, created: true });
  };
  const common = {
    confirmationId: "confirmation-1",
    opportunityId: "op-1",
    horizonDays: 90 as const,
    quantityInput: { mode: "ASSET_QUANTITY" as const, quantity: "0.001" },
    executionMode: "PRICE_PRIORITY" as const,
  };
  try {
    await confirmArbitrageExecution(common);
    await confirmArbitrageExecutionLeg({ ...common, commandId: "command-1", arbitrageId: "arbitrage-1", legId: "long-leg" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const finalBody = JSON.parse(String(calls[0]?.init?.body));
  const legBody = JSON.parse(String(calls[1]?.init?.body));
  assert.deepEqual(finalBody, { ...common, confirmed: true });
  assert.deepEqual(legBody, { ...common, commandId: "command-1", arbitrageId: "arbitrage-1", legId: "long-leg", confirmed: true });
  assert.equal("providerSymbol" in finalBody, false);
  assert.equal("quantity" in finalBody, false);
  assert.equal(calls[0]?.url, "/api/arbitrage-execution/confirm");
  assert.equal(calls[1]?.url, "/api/arbitrage-execution/legs/confirm");
});

function instancePayload(arbitrageId: string) {
  const leg = (role: "LONG" | "SHORT") => ({
    legId: role === "LONG" ? "long-leg" : "short-leg",
    role,
    venue: "binance",
    accountId: "binance:account-a",
    instrumentId: role === "LONG" ? "BTC-USDT-SPOT" : "BTC-USDT-PERP",
    plannedQuantity: "0.001",
    confirmedOpenedQuantity: "0",
    confirmedClosedQuantity: "0",
  });
  return {
    arbitrageId,
    userId: "user-a",
    strategyType: "SPOT_PERPETUAL",
    sourcePlanId: "source-1",
    maxResidualBaseQuantity: "0",
    status: "OPENING",
    createdAt: 1,
    openedAt: null,
    updatedAt: 1,
    closedAt: null,
    legs: [leg("LONG"), leg("SHORT")],
    executionReferences: [],
    pnl: { asset: null, cumulativeFundingPnl: null, realizedTradingPnl: null, feesCosts: null, cumulativeNetPnl: null, updatedAt: null },
  };
}
