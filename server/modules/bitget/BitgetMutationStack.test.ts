import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCoordinator } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { BitgetClient } from "./BitgetClient";
import { BitgetIntentCancellationCapability } from "./BitgetIntentCancellationCapability";
import { BitgetIntentExecutionCapability } from "./BitgetIntentExecutionCapability";
import { BitgetIntentExecutionService, bitgetClientOrderIdFor } from "./BitgetIntentExecutionService";
import { createBitgetInstrumentQuantityRulesSource } from "./BitgetInstrumentQuantityRulesSource";
import { BitgetInstrumentMappingAdapter } from "./BitgetInstrumentMapping";
import { bitgetBaseQuantityToProvider, loadBitgetQuantityRules } from "./BitgetQuantitySemantics";
import type { BitgetCancelOrderRequest, BitgetGetOrderRequest, BitgetPlaceOrderRequest, BitgetProviderOrder } from "./BitgetTypes";

const now = 1_800_000_000_000;

test("Bitget UTA client signs Spot/Perp place, exact query, and known-order cancel without number quantity conversion", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; query: URLSearchParams }> = [];
  const client = new BitgetClient(() => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }), {
    now: () => now,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body, query: url.searchParams });
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["ACCESS-KEY"], "key");
      assert.match(headers["ACCESS-SIGN"] ?? "", /^[A-Za-z0-9+/]+=*$/u);
      if (url.pathname === "/api/v3/trade/place-order") {
        return Response.json({ code: "00000", data: { orderId: "90071992547409931234", clientOid: body?.clientOid } });
      }
      if (url.pathname === "/api/v3/trade/order-info") {
        return Response.json({ code: "00000", data: {
          symbol: "DOGEUSDT", orderId: "90071992547409931234", clientOid: "sxbg-test", side: "sell",
          orderStatus: "partially_filled", qty: "95.12345678", cumExecQty: "40.12345678", avgPrice: "0.0842",
          feeDetail: [{ fee: "0.002", feeCoin: "USDT" }, { fee: "0.001", feeCoin: "USDT" }], updatedTime: String(now),
        } });
      }
      if (url.pathname === "/api/v3/trade/cancel-order") {
        return Response.json({ code: "00000", data: { orderId: "90071992547409931234", clientOid: "sxbg-test" } });
      }
      throw new Error(`Unexpected Bitget request: ${url.pathname}`);
    }) as typeof fetch,
  });

  const accepted = await client.placeOrder({
    category: "USDT-FUTURES", symbol: "DOGEUSDT", side: "sell", orderType: "market",
    qty: "95.12345678", clientOid: "sxbg-test", reduceOnly: "no",
  });
  assert.equal(accepted.orderId, "90071992547409931234");
  assert.equal(calls[0]?.body?.qty, "95.12345678");
  const order = await client.getOrder({
    category: "USDT-FUTURES", symbol: "DOGEUSDT", orderId: accepted.orderId, clientOid: "sxbg-test",
  });
  assert.equal(order.status, "PENDING_CONFIRMATION");
  assert.equal(order.filledQuantity, "40.12345678");
  assert.equal(order.fee, "0.003");
  assert.equal(order.feeCurrency, "USDT");
  await client.cancelOrder({ category: "USDT-FUTURES", symbol: "DOGEUSDT", orderId: accepted.orderId, clientOid: "sxbg-test" });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", "/api/v3/trade/place-order"], ["GET", "/api/v3/trade/order-info"], ["POST", "/api/v3/trade/cancel-order"],
  ]);
});

test("Bitget UTA quantity rules prove Spot and USDT Perp size are base quantity with contractSize=1", async () => {
  const requested: string[] = [];
  const source = createBitgetInstrumentQuantityRulesSource({
    clock: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const category = url.searchParams.get("category")!;
      const symbol = url.searchParams.get("symbol")!;
      requested.push(`${category}:${symbol}`);
      return Response.json({ code: "00000", data: [{
        symbol, status: "online", baseCoin: "DOGE", quoteCoin: "USDT", quantityPrecision: "8",
        ...(category === "USDT-FUTURES" ? { quantityMultiplier: "0.00000001" } : {}),
        minOrderQty: "0.00000001", minOrderAmount: "1",
      }] });
    }) as typeof fetch,
  });
  const mapping = new BitgetInstrumentMappingAdapter();
  for (const instrumentId of ["DOGE-USDT-SPOT", "DOGE-USDT-PERP"] as const) {
    const rules = await loadBitgetQuantityRules(source, mapping.resolve(instrumentId), now);
    assert.equal(rules.contractSize, "1");
    assert.equal(rules.quantityUnit, "base");
    assert.equal(bitgetBaseQuantityToProvider("95.12345678", rules), "95.12345678");
  }
  assert.deepEqual(requested, ["SPOT:DOGEUSDT", "USDT-FUTURES:DOGEUSDT"]);
  const invalidContract = await source("USDT-FUTURES", "DOGEUSDT");
  assert.throws(() => bitgetBaseQuantityToProvider("95", { ...invalidContract!, contractSize: "0.1" }), /contract/u);
});

test("Bitget clientOid is deterministic, identity-scoped, and within the Provider limit", () => {
  const intent = executionIntent();
  const first = bitgetClientOrderIdFor(intent);
  assert.equal(bitgetClientOrderIdFor(intent), first);
  assert.equal(first.length, 32);
  assert.match(first, /^sxbg[a-f0-9]{28}$/u);
  assert.notEqual(bitgetClientOrderIdFor({ ...intent, intentId: "another-intent" }), first);
});

test("Bitget service maps Spot BUY/SELL and Perp BUY/SELL reduceOnly through one shared capability", async (t) => {
  for (const scenario of [
    { instrumentId: "DOGE-USDT-SPOT", side: "buy", reduceOnly: false, orderType: "limit", force: "ioc" },
    { instrumentId: "DOGE-USDT-SPOT", side: "sell", reduceOnly: false, orderType: "market" },
    { instrumentId: "DOGE-USDT-PERP", side: "buy", reduceOnly: true, orderType: "market" },
    { instrumentId: "DOGE-USDT-PERP", side: "sell", reduceOnly: false, orderType: "market" },
  ] as const) {
    await t.test(`${scenario.instrumentId}:${scenario.side}`, async () => {
      const provider = new FakeBitgetService();
      const service = new BitgetIntentExecutionService(provider, serviceOptions());
      const intent = executionIntent(scenario);
      const result = await new BitgetIntentExecutionCapability(service).execute(intent);
      const request = provider.placeRequests[0]!;
      assert.equal(result.state, "SUBMITTED");
      assert.equal(result.confirmedQuantity, "0");
      assert.equal(request.qty, "95.12345678");
      assert.equal(request.side, scenario.side);
      assert.equal(request.orderType, scenario.orderType);
      assert.equal(request.force, "force" in scenario ? scenario.force : undefined);
      assert.equal(request.reduceOnly, scenario.instrumentId.endsWith("PERP") ? (scenario.reduceOnly ? "yes" : "no") : undefined);
      assert.equal(request.clientOid, bitgetClientOrderIdFor(intent));
      assert.equal(provider.positionModeReads, scenario.instrumentId.endsWith("PERP") ? 1 : 0);
    });
  }
});

test("Bitget ACK is not confirmed; query preserves partial and canceled-with-fill quantities", async () => {
  const provider = new FakeBitgetService();
  const service = new BitgetIntentExecutionService(provider, serviceOptions());
  const intent = executionIntent({ instrumentId: "DOGE-USDT-PERP", side: "sell", reduceOnly: false });
  const accepted = await service.execute(intent);
  assert.equal(accepted.state, "SUBMITTED");
  const lookup = {
    instrumentId: intent.instrumentId, category: accepted.category, symbol: accepted.symbol,
    orderId: accepted.providerOrderId, clientOid: accepted.clientOrderId,
    expectedProviderQuantity: accepted.expectedProviderQuantity, expectedSide: accepted.expectedSide,
  };
  provider.orderStatus = "PENDING_CONFIRMATION";
  provider.filledQuantity = "40.12345678";
  let queried = await service.query(lookup);
  assert.equal(queried.observation.state, "PENDING_CONFIRMATION");
  assert.equal(queried.observation.filledBaseQuantity, "40.12345678");
  provider.orderStatus = "FAILED";
  queried = await service.query(lookup);
  assert.equal(queried.observation.state, "FAILED");
  assert.equal(queried.observation.filledBaseQuantity, "40.12345678");
  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "95.12345678";
  queried = await service.query(lookup);
  assert.equal(queried.observation.state, "CONFIRMED");
  provider.orderStatus = "UNKNOWN";
  queried = await service.query(lookup);
  assert.equal(queried.observation.state, "UNKNOWN");
});

test("Bitget gates, identity, one-way mode, and recovery anchor fail closed before mutation while remote uncertainty remains UNKNOWN", async (t) => {
  for (const scenario of ["live", "kill", "identity", "validator", "position", "anchor"] as const) {
    await t.test(scenario, async () => {
      const provider = new FakeBitgetService();
      if (scenario === "position") provider.oneWay = false;
      const options = {
        ...serviceOptions(),
        ...(scenario === "live" ? { mutationSafetyGuard: guard(false, false) } : {}),
        ...(scenario === "kill" ? { mutationSafetyGuard: guard(true, true) } : {}),
        ...(scenario === "identity" ? { validateProviderIdentity: async () => { throw new Error("mismatch"); } } : {}),
        ...(scenario === "validator" ? { validateProviderIdentity: undefined } : {}),
        ...(scenario === "anchor" ? { persistRecoveryReference: undefined } : {}),
      };
      const result = await new ExecutionCoordinator(new BitgetIntentExecutionCapability(new BitgetIntentExecutionService(provider, options)), () => now)
        .execute(executionIntent({ instrumentId: "DOGE-USDT-PERP" }));
      assert.equal(result.executionState.status, "FAILED");
      assert.equal(provider.placeRequests.length, 0);
    });
  }
  const provider = new FakeBitgetService();
  provider.placeFailure = new Error("write outcome uncertain");
  const result = await new ExecutionCoordinator(new BitgetIntentExecutionCapability(new BitgetIntentExecutionService(provider, serviceOptions())), () => now)
    .execute(executionIntent({ instrumentId: "DOGE-USDT-PERP" }));
  assert.equal(result.executionState.status, "UNKNOWN");
  assert.equal(provider.placeRequests.length, 1);
});

test("Bitget rejects Spot reduceOnly and Spot market-BUY quote-size semantics before Provider mutation", async () => {
  const provider = new FakeBitgetService();
  const service = new BitgetIntentExecutionService(provider, serviceOptions());
  await assert.rejects(() => service.execute(executionIntent({ instrumentId: "DOGE-USDT-SPOT", reduceOnly: true })), /must not use reduceOnly/u);
  assert.equal(provider.placeRequests.length, 0);
  const client = new BitgetClient(() => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }), {
    fetchImpl: (async () => { throw new Error("must not be called"); }) as typeof fetch,
  });
  await assert.rejects(() => client.placeOrder({
    category: "SPOT", symbol: "DOGEUSDT", side: "buy", orderType: "market", qty: "95", clientOid: "sxbg-market-buy",
  }), /quote quantity/u);
});

test("Bitget known-order cancellation validates ExecutionRecord identity and uses venue gate", async () => {
  const provider = new FakeBitgetService();
  const service = new BitgetIntentExecutionService(provider, serviceOptions());
  const reference = {
    executionId: "execution-1", intentId: "intent-1", userId: "user-a", accountId: "bitget:account-a",
    instrumentId: "DOGE-USDT-PERP", category: "USDT-FUTURES" as const, symbol: "DOGEUSDT",
    orderId: "order-1", clientOid: "sxbg-reference", expectedProviderQuantity: "95", expectedSide: "sell" as const,
  };
  const record = createExecutionRecord({
    executionId: "execution-1", intentId: "intent-1", userId: "user-a", venue: "bitget", accountId: "bitget:account-a",
    instrumentId: "DOGE-USDT-PERP", status: "PENDING_CONFIRMATION", remoteOrderId: "order-1", createdAt: now, updatedAt: now,
  });
  const result = await new BitgetIntentCancellationCapability(service, reference).cancel(record);
  assert.equal(result.state, "CANCEL_REQUESTED");
  assert.equal(provider.cancelRequests.length, 1);
  assert.throws(() => new BitgetIntentCancellationCapability(service, { ...reference, userId: "user-b" }).cancel(record), /does not match/u);
});

function guard(liveTradingEnabled = true, killSwitchActive = false) {
  return new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: true,
    venues: { bitget: { liveTradingEnabled, killSwitchActive } } });
}
function serviceOptions() {
  return {
    clock: () => now,
    mutationSafetyGuard: guard(),
    quantityRulesSource: async (category: "SPOT" | "USDT-FUTURES", symbol: string) => ({
      category, symbol, status: "online", baseCoin: "DOGE", quoteCoin: "USDT", quantityStep: "0.00000001",
      minOrderQty: "0.00000001", minNotional: "1", contractSize: "1", quantityUnit: "base" as const, fetchedAt: now,
    }),
    limitPriceResolver: () => "0.08512345",
    validateProviderIdentity: async (_context: unknown) => undefined,
    persistRecoveryReference: async (_reference: unknown) => undefined,
  } as const;
}
function executionIntent(input: Partial<{ instrumentId: string; side: "buy" | "sell"; reduceOnly: boolean }> = {}): ExecutionIntent {
  const instrumentId = input.instrumentId ?? "DOGE-USDT-PERP";
  return createExecutionIntent({
    intentId: `intent-${instrumentId}-${input.side ?? "buy"}-${input.reduceOnly ?? false}`,
    userId: "user-a", venue: "bitget", accountId: "bitget:account-a", instrumentId,
    ...(instrumentId.endsWith("-PERP")
      ? { positionDirection: input.side === "sell" ? "SHORT" as const : "LONG" as const }
      : {}),
    side: input.side ?? "buy", quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "95.12345678" },
    orderConstraints: { reduceOnly: input.reduceOnly ?? false }, executionMode: "EXECUTION_PRIORITY",
    createdAt: now, expiresAt: now + 60_000,
  });
}

class FakeBitgetService {
  readonly placeRequests: BitgetPlaceOrderRequest[] = [];
  readonly getRequests: BitgetGetOrderRequest[] = [];
  readonly cancelRequests: BitgetCancelOrderRequest[] = [];
  identityValidations = 0;
  positionModeReads = 0;
  oneWay = true;
  orderStatus: BitgetProviderOrder["status"] = "PENDING_CONFIRMATION";
  filledQuantity = "0";
  placeFailure?: Error;
  private lastOrder?: BitgetPlaceOrderRequest;
  async assertOneWayMode() { this.positionModeReads += 1; if (!this.oneWay) throw new Error("one-way required"); }
  async placeOrder(request: BitgetPlaceOrderRequest) { this.placeRequests.push(request); this.lastOrder = request; if (this.placeFailure) throw this.placeFailure; return { category: request.category, symbol: request.symbol, orderId: "order-1", clientOid: request.clientOid }; }
  async getOrder(request: BitgetGetOrderRequest): Promise<BitgetProviderOrder> {
    this.getRequests.push(request); const placed = this.lastOrder; if (!placed) throw new Error("no order");
    return { category: request.category, symbol: request.symbol, orderId: request.orderId ?? "order-1", clientOid: request.clientOid,
      side: placed.side, status: this.orderStatus, rawStatus: "fixture", requestedQuantity: placed.qty,
      filledQuantity: this.filledQuantity, averagePrice: this.filledQuantity === "0" ? null : "0.085", fee: "0", feeCurrency: null, updatedAt: now };
  }
  async cancelOrder(request: BitgetCancelOrderRequest) { this.cancelRequests.push(request); return { category: request.category, symbol: request.symbol, orderId: request.orderId ?? "order-1", clientOid: request.clientOid }; }
}
