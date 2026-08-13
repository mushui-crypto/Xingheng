import assert from "node:assert/strict";
import test from "node:test";
import {
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
