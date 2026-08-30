import assert from "node:assert/strict";
import test from "node:test";
import { createVerifiedManagedCloseNativeExecutionRules, type FormalManagedCloseExecutionContext } from "../arbitrage-execution/FormalExecutionRuntime";
import { ExecutionCoordinator } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { createVerifiedExecutionProviderIdentity, ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { BitgetClient, BitgetProviderError } from "./BitgetClient";
import { BitgetIntentCancellationCapability } from "./BitgetIntentCancellationCapability";
import { BitgetIntentExecutionCapability } from "./BitgetIntentExecutionCapability";
import { BitgetIntentExecutionService, bitgetClientOrderIdFor } from "./BitgetIntentExecutionService";
import { createBitgetInstrumentQuantityRulesSource } from "./BitgetInstrumentQuantityRulesSource";
import { BitgetInstrumentMappingAdapter } from "./BitgetInstrumentMapping";
import { bitgetBaseQuantityToProvider, loadBitgetQuantityRules } from "./BitgetQuantitySemantics";
import type { BitgetCancelOrderRequest, BitgetGetOrderRequest, BitgetPlaceOrderRequest, BitgetProviderOrder } from "./BitgetTypes";

const now = 1_800_000_000_000;

test("Bitget UTA client preserves safe auth category/code without exposing Provider msg", async () => {
  const rawMessage = "passphrase=provider-secret arbitrary upstream details";
  const client = new BitgetClient(() => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }), {
    now: () => now,
    fetchImpl: (async () => Response.json({ code: "40009", msg: rawMessage, data: {} })) as typeof fetch,
  });

  await assert.rejects(
    () => client.getAccountIdentity(),
    (error: unknown) => error instanceof BitgetProviderError
      && error.category === "credential_validation_failed"
      && error.providerCode === "40009"
      && error.message === "Bitget credential validation failed."
      && !error.message.includes(rawMessage),
  );
});

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
          posSide: "short", tradeSide: "open_short", holdMode: "hedge_mode",
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
  assert.equal(order.posSide, "short");
  assert.equal(order.tradeSide, "open_short");
  assert.equal(order.holdMode, "hedge_mode");
  await client.cancelOrder({ category: "USDT-FUTURES", symbol: "DOGEUSDT", orderId: accepted.orderId, clientOid: "sxbg-test" });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", "/api/v3/trade/place-order"], ["GET", "/api/v3/trade/order-info"], ["POST", "/api/v3/trade/cancel-order"],
  ]);
});

test("Bitget UTA client replays production HEDGE open_short filled evidence", async () => {
  const client = new BitgetClient(() => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }), {
    now: () => now,
    fetchImpl: (async () => Response.json({ code: "00000", data: {
      orderId: "1477865537739440128", clientOid: "sxbga6f126be4669155fd212e6e366ec",
      category: "USDT-FUTURES", symbol: "DOGEUSDT", side: "sell",
      orderStatus: "filled", qty: "95", cumExecQty: "95", avgPrice: "0.0847",
      posSide: "short", tradeSide: "open_short", holdMode: "hedge_mode", reduceOnly: "NO",
      feeDetail: [{ fee: "0.0048279", feeCoin: "USDT" }], updatedTime: String(now),
    } })) as typeof fetch,
  });

  const order = await client.getOrder({
    category: "USDT-FUTURES", symbol: "DOGEUSDT", orderId: "1477865537739440128",
    clientOid: "sxbga6f126be4669155fd212e6e366ec",
  });

  assert.equal(order.status, "CONFIRMED");
  assert.equal(order.requestedQuantity, "95");
  assert.equal(order.filledQuantity, "95");
  assert.equal(order.posSide, "short");
  assert.equal(order.tradeSide, "open_short");
  assert.equal(order.holdMode, "hedge_mode");
});

test("Bitget UTA client rejects an unknown tradeSide enum", async () => {
  const client = new BitgetClient(() => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }), {
    now: () => now,
    fetchImpl: (async () => Response.json({ code: "00000", data: {
      orderId: "order-unknown", clientOid: "sxbg-unknown", category: "USDT-FUTURES", symbol: "DOGEUSDT",
      side: "sell", orderStatus: "filled", qty: "95", cumExecQty: "95", avgPrice: "0.0847",
      posSide: "short", tradeSide: "unexpected_short", holdMode: "hedge_mode", reduceOnly: "NO",
      feeDetail: [], updatedTime: String(now),
    } })) as typeof fetch,
  });

  await assert.rejects(
    () => client.getOrder({
      category: "USDT-FUTURES", symbol: "DOGEUSDT", orderId: "order-unknown", clientOid: "sxbg-unknown",
    }),
    (error: unknown) => error instanceof BitgetProviderError && error.category === "provider_response_invalid",
  );
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

test("Bitget UTA HEDGE close uses side plus posSide, omits one-way reduceOnly, and rejects an opening side", async () => {
  const provider = new FakeBitgetService();
  provider.readPositionMode = async () => "HEDGE";
  const service = new BitgetIntentExecutionService(provider, {
    ...serviceOptions(), mutationSafetyGuard: guard(false, true), mutationEffect: "DECREASE",
  });
  await new BitgetIntentExecutionCapability(service).execute(executionIntent({
    instrumentId: "DOGE-USDT-PERP", side: "buy", positionDirection: "SHORT", reduceOnly: true,
  }));
  const request = provider.placeRequests[0]!;
  assert.equal(request.posSide, "short");
  assert.equal(request.reduceOnly, undefined);

  const invalid = new FakeBitgetService();
  invalid.readPositionMode = async () => "HEDGE";
  await assert.rejects(() => new BitgetIntentExecutionCapability(new BitgetIntentExecutionService(invalid, serviceOptions()))
    .execute(executionIntent({
      instrumentId: "DOGE-USDT-PERP", side: "buy", positionDirection: "LONG", reduceOnly: true,
    })), /does not reduce/u);
  assert.equal(invalid.placeRequests.length, 0);
});

test("Bitget managed close consumes attempt-scoped verified facts with zero post-safety Provider reads", async (t) => {
  for (const fixture of [
    { direction: "SHORT" as const, side: "buy" as const, posSide: "short" as const },
    { direction: "LONG" as const, side: "sell" as const, posSide: "long" as const },
  ]) await t.test(fixture.direction, async () => {
    const provider = new FakeBitgetService();
    provider.readPositionMode = async () => { provider.positionModeReads += 1; return "HEDGE"; };
    let rulesReads = 0;
    let identityReads = 0;
    const intent = executionIntent({
      instrumentId: "DOGE-USDT-PERP",
      side: fixture.side,
      positionDirection: fixture.direction,
      reduceOnly: true,
      quantity: "59",
    });
    const service = new BitgetIntentExecutionService(provider, {
      ...serviceOptions(),
      mutationEffect: "DECREASE",
      quantityRulesSource: async () => { rulesReads += 1; throw new Error("duplicate rules read"); },
      validateProviderIdentity: async () => { identityReads += 1; throw new Error("duplicate identity read"); },
      verifiedCloseContext: verifiedCloseContext(intent, fixture.direction),
    });

    await service.execute(intent);

    const request = provider.placeRequests[0]!;
    assert.equal(request.qty, "59");
    assert.equal(request.side, fixture.side);
    assert.equal(request.posSide, fixture.posSide);
    assert.equal(request.reduceOnly, undefined);
    assert.equal(provider.positionModeReads, 0);
    assert.equal(rulesReads, 0);
    assert.equal(identityReads, 0);
  });
});

test("Bitget managed close rejects mismatched verified bucket without falling back to Provider reads", async () => {
  const provider = new FakeBitgetService();
  provider.readPositionMode = async () => { provider.positionModeReads += 1; return "HEDGE"; };
  let rulesReads = 0;
  let identityReads = 0;
  const intent = executionIntent({
    instrumentId: "DOGE-USDT-PERP", side: "buy", positionDirection: "SHORT", reduceOnly: true, quantity: "59",
  });
  const context = Object.freeze({ ...verifiedCloseContext(intent, "SHORT"), positionDirection: "LONG" as const });
  const service = new BitgetIntentExecutionService(provider, {
    ...serviceOptions(),
    mutationEffect: "DECREASE",
    quantityRulesSource: async () => { rulesReads += 1; throw new Error("must not fall back"); },
    validateProviderIdentity: async () => { identityReads += 1; },
    verifiedCloseContext: context,
  });

  await assert.rejects(() => service.execute(intent), /verified close context/u);
  assert.equal(provider.placeRequests.length, 0);
  assert.equal(provider.positionModeReads, 0);
  assert.equal(rulesReads, 0);
  assert.equal(identityReads, 0);
});

test("Bitget managed close rejects stale verified rules without Provider fallback", async () => {
  const provider = new FakeBitgetService();
  let rulesReads = 0;
  const intent = executionIntent({
    instrumentId: "DOGE-USDT-PERP", side: "buy", positionDirection: "SHORT", reduceOnly: true, quantity: "59",
  });
  const fresh = verifiedCloseContext(intent, "SHORT");
  const staleRules = createVerifiedManagedCloseNativeExecutionRules({
    ...fresh.verifiedNativeExecutionRules!,
    verifiedAt: now - 15_001,
  });
  const service = new BitgetIntentExecutionService(provider, {
    ...serviceOptions(),
    mutationEffect: "DECREASE",
    clock: () => now,
    quantityRulesSource: async () => { rulesReads += 1; throw new Error("must not fall back"); },
    verifiedCloseContext: Object.freeze({ ...fresh, verifiedNativeExecutionRules: staleRules }),
  });

  await assert.rejects(() => service.execute(intent), /invalid, stale/u);
  assert.equal(provider.placeRequests.length, 0);
  assert.equal(rulesReads, 0);
});

test("Bitget UTA HEDGE LONG and SHORT openings preserve the target posSide without Classic tradeSide request fields", async () => {
  for (const fixture of [
    { direction: "LONG" as const, side: "buy" as const, posSide: "long" as const },
    { direction: "SHORT" as const, side: "sell" as const, posSide: "short" as const },
  ]) {
    const provider = new FakeBitgetService();
    provider.readPositionMode = async () => "HEDGE";
    const result = await new BitgetIntentExecutionService(provider, serviceOptions()).execute(executionIntent({
      instrumentId: "DOGE-USDT-PERP",
      side: fixture.side,
      positionDirection: fixture.direction,
      reduceOnly: false,
    }));
    const request = provider.placeRequests[0]!;

    assert.equal(request.side, fixture.side);
    assert.equal(request.posSide, fixture.posSide);
    assert.equal(request.reduceOnly, undefined);
    assert.equal("tradeSide" in request, false);
    assert.equal(result.positionMode, "HEDGE");
    assert.equal(result.positionDirection, fixture.direction);
    assert.equal(result.posSide, fixture.posSide);
  }
});

test("Bitget UTA HEDGE query accepts direction-qualified opening and closing tradeSide evidence", async () => {
  for (const fixture of [
    { direction: "SHORT" as const, side: "sell" as const, reduceOnly: false, tradeSide: "open_short" as const },
    { direction: "SHORT" as const, side: "buy" as const, reduceOnly: true, tradeSide: "close_short" as const },
    { direction: "LONG" as const, side: "buy" as const, reduceOnly: false, tradeSide: "open_long" as const },
    { direction: "LONG" as const, side: "sell" as const, reduceOnly: true, tradeSide: "close_long" as const },
  ]) {
    const provider = new FakeBitgetService();
    provider.readPositionMode = async () => "HEDGE";
    const intent = executionIntent({
      instrumentId: "DOGE-USDT-PERP",
      side: fixture.side,
      positionDirection: fixture.direction,
      reduceOnly: fixture.reduceOnly,
      quantity: "95",
    });
    const service = new BitgetIntentExecutionService(provider, fixture.reduceOnly
      ? { ...serviceOptions(), mutationEffect: "DECREASE", verifiedCloseContext: verifiedCloseContext(intent, fixture.direction) }
      : serviceOptions());
    const accepted = await service.execute(intent);
    provider.orderStatus = "CONFIRMED";
    provider.filledQuantity = "95";

    const result = await service.query({
      instrumentId: "DOGE-USDT-PERP",
      category: accepted.category,
      symbol: accepted.symbol,
      orderId: accepted.providerOrderId,
      clientOid: accepted.clientOrderId,
      expectedProviderQuantity: accepted.expectedProviderQuantity,
      expectedSide: accepted.expectedSide,
      positionMode: accepted.positionMode,
      positionDirection: accepted.positionDirection,
      posSide: accepted.posSide,
    });

    assert.equal(provider.lastTradeSide, fixture.tradeSide);
    assert.equal(result.observation.state, "CONFIRMED");
  }
});

test("Bitget UTA HEDGE query rejects tradeSide conflicts and unqualified open/close evidence", async () => {
  const provider = new FakeBitgetService();
  provider.readPositionMode = async () => "HEDGE";
  const service = new BitgetIntentExecutionService(provider, serviceOptions());
  const accepted = await service.execute(executionIntent({
    instrumentId: "DOGE-USDT-PERP",
    side: "sell",
    positionDirection: "SHORT",
    reduceOnly: false,
  }));
  const lookup = {
    instrumentId: "DOGE-USDT-PERP",
    category: accepted.category,
    symbol: accepted.symbol,
    orderId: accepted.providerOrderId,
    clientOid: accepted.clientOrderId,
    expectedProviderQuantity: accepted.expectedProviderQuantity,
    expectedSide: accepted.expectedSide,
    positionMode: accepted.positionMode,
    positionDirection: accepted.positionDirection,
    posSide: accepted.posSide,
  };
  provider.orderStatus = "CONFIRMED";
  provider.filledQuantity = "95.12345678";

  assert.equal((await service.query(lookup)).observation.state, "CONFIRMED");
  for (const fixture of [
    { posSide: "long" as const, reason: /posSide/u },
    { tradeSide: "close_long" as const, reason: /tradeSide/u },
    { tradeSide: "close_short" as const, reason: /tradeSide/u },
    { tradeSide: "open" as const, reason: /tradeSide/u },
    { tradeSide: "close" as const, reason: /tradeSide/u },
    { holdMode: "one_way_mode" as const, reason: /holdMode/u },
  ]) {
    provider.orderEvidenceOverride = fixture;
    const wrongEvidence = await service.query(lookup);
    assert.equal(wrongEvidence.observation.state, "UNKNOWN");
    assert.equal(wrongEvidence.observation.filledBaseQuantity, "0");
    assert.match(wrongEvidence.statusReason ?? "", fixture.reason);
  }
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

test("halted Bitget allows trusted managed closes and known-order cancel but blocks ordinary Spot SELL", async () => {
  for (const instrumentId of ["DOGE-USDT-PERP", "DOGE-USDT-SPOT"] as const) {
    const provider = new FakeBitgetService();
    const service = new BitgetIntentExecutionService(provider, {
      ...serviceOptions(), mutationSafetyGuard: guard(false, true), mutationEffect: "DECREASE",
    });
    await service.execute(executionIntent({
      instrumentId,
      side: "sell",
      ...(instrumentId.endsWith("-PERP") ? { positionDirection: "LONG", reduceOnly: true } : {}),
    }));
    assert.equal(provider.placeRequests.length, 1);
  }

  const ordinaryProvider = new FakeBitgetService();
  const ordinary = new BitgetIntentExecutionService(ordinaryProvider, {
    ...serviceOptions(), mutationSafetyGuard: guard(false, true),
  });
  await assert.rejects(() => ordinary.execute(executionIntent({ instrumentId: "DOGE-USDT-SPOT", side: "sell" })));
  assert.equal(ordinaryProvider.placeRequests.length, 0);

  const cancelProvider = new FakeBitgetService();
  const cancel = new BitgetIntentExecutionService(cancelProvider, {
    ...serviceOptions(), mutationSafetyGuard: guard(false, true),
  });
  await cancel.cancel({
    instrumentId: "DOGE-USDT-PERP", category: "USDT-FUTURES", symbol: "DOGEUSDT",
    orderId: "order-1", clientOid: "sxbg-reference", expectedProviderQuantity: "95",
    expectedSide: "sell", positionMode: "ONE_WAY", positionDirection: "SHORT",
  }, { userId: "user-a", accountId: "bitget:account-a", instrumentId: "DOGE-USDT-PERP" });
  assert.equal(cancelProvider.cancelRequests.length, 1);
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
function executionIntent(input: Partial<{
  instrumentId: string; side: "buy" | "sell"; reduceOnly: boolean; positionDirection: "LONG" | "SHORT";
  quantity: string;
}> = {}): ExecutionIntent {
  const instrumentId = input.instrumentId ?? "DOGE-USDT-PERP";
  return createExecutionIntent({
    intentId: `intent-${instrumentId}-${input.side ?? "buy"}-${input.reduceOnly ?? false}`,
    userId: "user-a", venue: "bitget", accountId: "bitget:account-a", instrumentId,
    ...(instrumentId.endsWith("-PERP")
      ? { positionDirection: input.positionDirection ?? (input.side === "sell" ? "SHORT" as const : "LONG" as const) }
      : {}),
    side: input.side ?? "buy", quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: input.quantity ?? "95.12345678" },
    orderConstraints: { reduceOnly: input.reduceOnly ?? false }, executionMode: "EXECUTION_PRIORITY",
    createdAt: now, expiresAt: now + 60_000,
  });
}

function verifiedCloseContext(
  intent: ExecutionIntent,
  positionDirection: "LONG" | "SHORT",
): FormalManagedCloseExecutionContext {
  return Object.freeze({
    positionMode: "HEDGE",
    side: intent.side,
    positionDirection,
    actualSignedNetQuantity: null,
    actualLongQuantity: positionDirection === "LONG" ? intent.quantity.quantity : "0",
    actualShortQuantity: positionDirection === "SHORT" ? intent.quantity.quantity : "0",
    safeClosableQuantity: intent.quantity.quantity,
    legalizedCloseQuantity: intent.quantity.quantity,
    reduceOnly: true,
    verifiedProviderIdentity: createVerifiedExecutionProviderIdentity({
      userId: intent.userId,
      venue: intent.venue,
      accountId: intent.accountId,
      executionIntentId: intent.intentId,
      verifiedAt: now,
    }),
    verifiedNativeExecutionRules: createVerifiedManagedCloseNativeExecutionRules({
      userId: intent.userId,
      accountId: intent.accountId,
      venue: intent.venue,
      canonicalInstrumentId: intent.instrumentId,
      providerInstrumentId: "DOGEUSDT",
      executionIntentId: intent.intentId,
      instrumentState: "live",
      contractType: "linear",
      contractValueCurrency: "DOGE",
      settlementAsset: "USDT",
      contractValue: "1",
      lotSize: "1",
      minimumSize: "1",
      minimumNotional: "5",
      canonicalSafeCloseQuantity: intent.quantity.quantity,
      legalizedCanonicalCloseQuantity: intent.quantity.quantity,
      providerNativeQuantity: intent.quantity.quantity,
      verifiedAt: now,
    }),
  });
}

class FakeBitgetService {
  readonly placeRequests: BitgetPlaceOrderRequest[] = [];
  readonly getRequests: BitgetGetOrderRequest[] = [];
  readonly cancelRequests: BitgetCancelOrderRequest[] = [];
  identityValidations = 0;
  positionModeReads = 0;
  oneWay = true;
  readPositionMode?: () => Promise<"ONE_WAY" | "HEDGE">;
  orderStatus: BitgetProviderOrder["status"] = "PENDING_CONFIRMATION";
  filledQuantity = "0";
  orderEvidenceOverride: Partial<Pick<BitgetProviderOrder, "posSide" | "tradeSide" | "holdMode" | "reduceOnly">> = {};
  placeFailure?: Error;
  private lastOrder?: BitgetPlaceOrderRequest;
  get lastTradeSide() {
    const placed = this.lastOrder;
    if (placed?.posSide === undefined) return undefined;
    const operation = placed.posSide === "long"
      ? placed.side === "buy" ? "open" : "close"
      : placed.side === "sell" ? "open" : "close";
    return `${operation}_${placed.posSide}` as const;
  }
  async assertOneWayMode() { this.positionModeReads += 1; if (!this.oneWay) throw new Error("one-way required"); }
  async placeOrder(request: BitgetPlaceOrderRequest) { this.placeRequests.push(request); this.lastOrder = request; if (this.placeFailure) throw this.placeFailure; return { category: request.category, symbol: request.symbol, orderId: "order-1", clientOid: request.clientOid }; }
  async getOrder(request: BitgetGetOrderRequest): Promise<BitgetProviderOrder> {
    this.getRequests.push(request); const placed = this.lastOrder; if (!placed) throw new Error("no order");
    const posSide = placed.posSide;
    const tradeSide = this.lastTradeSide;
    return { category: request.category, symbol: request.symbol, orderId: request.orderId ?? "order-1", clientOid: request.clientOid,
      side: placed.side, status: this.orderStatus, rawStatus: "fixture", requestedQuantity: placed.qty,
      filledQuantity: this.filledQuantity, averagePrice: this.filledQuantity === "0" ? null : "0.085", fee: "0", feeCurrency: null,
      ...(posSide === undefined ? {} : { posSide, tradeSide, holdMode: "hedge_mode" as const }),
      ...(request.category === "USDT-FUTURES" && posSide === undefined ? {
        holdMode: "one_way_mode" as const,
        reduceOnly: placed.reduceOnly,
        tradeSide: placed.reduceOnly === "yes" ? "close" as const : "open" as const,
      } : {}),
      ...this.orderEvidenceOverride,
      updatedAt: now };
  }
  async cancelOrder(request: BitgetCancelOrderRequest) { this.cancelRequests.push(request); return { category: request.category, symbol: request.symbol, orderId: request.orderId ?? "order-1", clientOid: request.clientOid }; }
}
