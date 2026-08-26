import assert from "node:assert/strict";
import test from "node:test";
import {
  closeArbitrageExecutionLeg,
  confirmArbitrageExecution,
  confirmArbitrageExecutionLeg,
  exitArbitrageInstance,
  fetchArbitrageExecutionDraft,
  previewArbitrageExecutionDraft,
  reconcileArbitrageInstance,
  reconcileArbitrageExecutionLeg,
} from "./arbitrageExecutionDraft";

test("draft API sends only opportunity identity, horizon, and explicit quantity input", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ opportunityId: "op-1", legs: [] });
  };
  try {
    await fetchArbitrageExecutionDraft("op/1", 90, "PRICE_PRIORITY");
    await previewArbitrageExecutionDraft(
      "op/1",
      90,
      { mode: "NOTIONAL_USDT", amountUsdt: "20" },
      "EXECUTION_PRIORITY",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    calls[0]?.url,
    "/api/arbitrage-execution/draft?opportunityId=op%2F1&horizonDays=90&executionMode=PRICE_PRIORITY",
  );
  const body = JSON.parse(String(calls[1]?.init?.body));
  assert.deepEqual(body, {
    opportunityId: "op/1",
    horizonDays: 90,
    executionMode: "EXECUTION_PRIORITY",
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
          executionRecord: { executionId: "record-1", intentId: "intent-1", status: "CONFIRMED", plannedQuantity: "0.001", confirmedQuantity: "0.001", verifiedAt: 10 },
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

test("reconciliation API sends only arbitrageId and legId and parses the latest result", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      instance: instancePayload("arbitrage-1"),
      executionRecord: {
        executionId: "record-1",
        intentId: "intent-1",
        status: "PENDING_CONFIRMATION",
        plannedQuantity: "0.001",
        confirmedQuantity: "0.000456789012345678",
        verifiedAt: 1_800_000_000_001,
      },
      idempotentReplay: false,
      secondLegAllowed: false,
    });
  };
  try {
    const result = await reconcileArbitrageExecutionLeg({ arbitrageId: "arbitrage-1", legId: "long-leg" });
    assert.equal(result.executionRecord.confirmedQuantity, "0.000456789012345678");
    assert.equal(result.executionRecord.verifiedAt, 1_800_000_000_001);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0]?.url, "/api/arbitrage-execution/legs/reconcile");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { arbitrageId: "arbitrage-1", legId: "long-leg" });
});

test("close API sends only application identity, Decimal quantity, mode, and explicit confirmation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      instance: instancePayload("arbitrage-1"),
      executionRecord: {
        executionId: "record-close-1",
        intentId: "intent-close-1",
        status: "CONFIRMED",
        plannedQuantity: "0.0004",
        confirmedQuantity: "0.0004",
        verifiedAt: 20,
      },
      idempotentReplay: false,
      secondLegAllowed: false,
    });
  };
  try {
    await closeArbitrageExecutionLeg({
      arbitrageId: "arbitrage-1",
      legId: "short-leg",
      commandId: "close-command-1",
      quantity: "0.0004",
      executionMode: "EXECUTION_PRIORITY",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0]?.url, "/api/arbitrage-execution/legs/close");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    arbitrageId: "arbitrage-1",
    legId: "short-leg",
    commandId: "close-command-1",
    quantity: "0.0004",
    executionMode: "EXECUTION_PRIORITY",
    confirmed: true,
  });
});

test("instance exit and reconciliation APIs do not expose browser leg orchestration", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(String(input).endsWith("/exit")
      ? { instance: { ...instancePayload("arbitrage-1"), status: "CLOSED", closedAt: 40 }, status: "CONFIRMED", legs: [] }
      : {
          instance: instancePayload("arbitrage-1"),
          verification: {
            arbitrageId: "arbitrage-1",
            checkedAt: 50,
            legs: [
              { arbitrageId: "arbitrage-1", legId: "long-leg", expectedManagedQuantity: "0", actualQuantity: "0", actualSignedNetQuantity: "0", availableQuantity: null, verificationStatus: "MATCHED", reason: null, checkedAt: 50 },
              { arbitrageId: "arbitrage-1", legId: "short-leg", expectedManagedQuantity: "0", actualQuantity: "0", actualSignedNetQuantity: "0", availableQuantity: null, verificationStatus: "MATCHED", reason: null, checkedAt: 50 },
            ],
          },
        });
  };
  try {
    await exitArbitrageInstance({
      arbitrageId: "arbitrage-1",
      commandId: "instance-exit-1",
      executionMode: "EXECUTION_PRIORITY",
    });
    await reconcileArbitrageInstance("arbitrage-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0]?.url, "/api/arbitrage-execution/exit");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    arbitrageId: "arbitrage-1",
    commandId: "instance-exit-1",
    executionMode: "EXECUTION_PRIORITY",
    confirmed: true,
  });
  assert.equal(calls[1]?.url, "/api/arbitrage-execution/reconcile");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { arbitrageId: "arbitrage-1" });
  assert.equal("legId" in JSON.parse(String(calls[0]?.init?.body)), false);
  assert.equal("quantity" in JSON.parse(String(calls[0]?.init?.body)), false);
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
