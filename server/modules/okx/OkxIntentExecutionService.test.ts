import assert from "node:assert/strict";
import test from "node:test";
import { OkxIntentExecutionService, okxClientOrderIdFor } from "./OkxIntentExecutionService";
import { createVerifiedManagedCloseNativeExecutionRules } from "../arbitrage-execution/FormalExecutionRuntime";
import {
  createVerifiedExecutionProviderIdentity,
  ExecutionMutationSafetyGuard,
} from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { okxTestQuantityRules, okxTestQuantityRulesSource } from "./OkxTestFixtures";
import type { OkxQuantityRulesSnapshot, OkxQuantityRulesSource } from "./OkxQuantitySemantics";
import type {
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPerpetualPosition,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;
const testMutationGuard = () => new ExecutionMutationSafetyGuard({
  liveTradingEnabled: true,
  killSwitchActive: false,
});
const serviceOptions = (rules: Partial<OkxQuantityRulesSnapshot> = {}) => ({
  clock: () => now,
  mutationSafetyGuard: testMutationGuard(),
  quantityRulesSource: okxTestQuantityRulesSource(now, rules),
});
const missingRuleSource = (field: keyof OkxQuantityRulesSnapshot): OkxQuantityRulesSource => {
  const rules = { ...okxTestQuantityRules(now) } as Record<string, unknown>;
  delete rules[field];
  return () => rules as unknown as OkxQuantityRulesSnapshot;
};

test("converts 100 canonical DOGE to 10 OKX contracts when ctVal=10 before market submit", async () => {
  const client = new FakeOkxExecutionClient();
  const service = new OkxIntentExecutionService(client, serviceOptions({ ctVal: "10" }));
  const intent = executionIntent({
    side: "buy",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "100" },
  });

  const result = await service.execute(intent);

  assert.equal(result.state, "SUBMITTED");
  assert.equal(result.confirmedQuantity, "0");
  assert.equal(result.providerOrderId, "7001");
  assert.equal(result.clientOrderId, okxClientOrderIdFor(intent));
  assert.deepEqual(result.orderIdentity, {
    instId: "DOGE-USDT-SWAP",
    ordId: "7001",
    clOrdId: okxClientOrderIdFor(intent),
  });
  assert.deepEqual(client.placeRequests, [{
    instId: "DOGE-USDT-SWAP",
    tdMode: "cross",
    side: "buy",
    ordType: "market",
    quantity: "10",
    clOrdId: okxClientOrderIdFor(intent),
    reduceOnly: false,
  }]);
});

test("submits an OKX open short as a market sell", async () => {
  const client = new FakeOkxExecutionClient();
  const intent = executionIntent({ side: "sell", intentId: "intent-short-1" });

  await new OkxIntentExecutionService(client, serviceOptions()).execute(intent);

  assert.equal(client.placeRequests[0]?.side, "sell");
  assert.equal(client.placeRequests[0]?.reduceOnly, false);
  assert.equal(client.placeRequests[0]?.instId, "DOGE-USDT-SWAP");
});

test("fails closed before Provider mutation when authoritative position mode is unavailable", async () => {
  const client = new FakeOkxExecutionClient();
  client.readPositionMode = undefined;

  await assert.rejects(
    () => new OkxIntentExecutionService(client, serviceOptions()).execute(executionIntent()),
    /authoritative position mode is unavailable/u,
  );
  assert.equal(client.placeRequests.length, 0);
});

test("perpetual close preserves reduceOnly=true at the OKX order boundary", async () => {
  const client = new FakeOkxExecutionClient();
  const intent = executionIntent({
    intentId: "intent-close-1",
    side: "sell",
    orderConstraints: { reduceOnly: true },
  });

  await new OkxIntentExecutionService(client, serviceOptions()).execute(intent);

  assert.equal(client.placeRequests[0]?.reduceOnly, true);
  assert.equal(client.placeRequests[0]?.ordType, "market");
});

test("verified managed-close facts remove the duplicate OKX position-mode read", async () => {
  const client = new FakeOkxExecutionClient();
  let positionModeReads = 0;
  let instrumentRulesReads = 0;
  client.readPositionMode = async () => {
    positionModeReads += 1;
    throw Object.assign(new Error("duplicate account config read"), {
      category: "provider_request_rejected",
      providerCode: "50011",
    });
  };
  const intent = executionIntent({
    intentId: "intent-close-verified-one-way",
    side: "buy",
    positionDirection: "SHORT",
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "10" },
    orderConstraints: { reduceOnly: true },
  });

  await new OkxIntentExecutionService(client, {
    ...serviceOptions({ ctVal: "1000", lotSz: "0.01", minSz: "0.01" }),
    quantityRulesSource: async () => {
      instrumentRulesReads += 1;
      throw new Error("duplicate instrument rules read");
    },
    verifiedCloseContext: {
      positionMode: "ONE_WAY",
      side: "buy",
      positionDirection: "SHORT",
      actualSignedNetQuantity: "-10",
      actualLongQuantity: "0",
      actualShortQuantity: "10",
      safeClosableQuantity: "10",
      legalizedCloseQuantity: "10",
      reduceOnly: true,
      verifiedProviderIdentity: createVerifiedExecutionProviderIdentity({
        userId: intent.userId,
        venue: intent.venue,
        accountId: intent.accountId,
        executionIntentId: intent.intentId,
        verifiedAt: now - 1,
      }),
      verifiedNativeExecutionRules: createVerifiedManagedCloseNativeExecutionRules({
        userId: intent.userId,
        accountId: intent.accountId,
        venue: intent.venue,
        canonicalInstrumentId: intent.instrumentId,
        providerInstrumentId: "DOGE-USDT-SWAP",
        executionIntentId: intent.intentId,
        instrumentState: "live",
        contractType: "linear",
        contractValueCurrency: "DOGE",
        settlementAsset: "USDT",
        contractValue: "1000",
        lotSize: "0.01",
        minimumSize: "0.01",
        canonicalSafeCloseQuantity: "10",
        legalizedCanonicalCloseQuantity: "10",
        providerNativeQuantity: "0.01",
        verifiedAt: now - 1,
      }),
    },
  }).execute(intent);

  assert.equal(positionModeReads, 0);
  assert.equal(instrumentRulesReads, 0);
  assert.equal(client.placeRequests.length, 1);
  assert.equal(client.placeRequests[0]?.quantity, "0.01");
  assert.equal(client.placeRequests[0]?.reduceOnly, true);
  assert.equal(client.placeRequests[0]?.posSide, undefined);
});

test("managed-close verified native rules fail closed when stale or outside the attempt scope", async (t) => {
  for (const fixture of [
    { name: "stale", verifiedAt: now - 15_001, providerInstrumentId: "DOGE-USDT-SWAP" },
    { name: "instrument mismatch", verifiedAt: now - 1, providerInstrumentId: "BTC-USDT-SWAP" },
  ] as const) {
    await t.test(fixture.name, async () => {
      const client = new FakeOkxExecutionClient();
      let instrumentRulesReads = 0;
      const intent = executionIntent({
        intentId: `intent-close-${fixture.name}`,
        side: "buy",
        positionDirection: "SHORT",
        quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "10" },
        orderConstraints: { reduceOnly: true },
      });
      await assert.rejects(
        () => new OkxIntentExecutionService(client, {
          ...serviceOptions(),
          quantityRulesSource: async () => {
            instrumentRulesReads += 1;
            return okxTestQuantityRules(now);
          },
          verifiedCloseContext: {
            positionMode: "ONE_WAY",
            side: "buy",
            positionDirection: "SHORT",
            actualSignedNetQuantity: "-10",
            actualLongQuantity: "0",
            actualShortQuantity: "10",
            safeClosableQuantity: "10",
            legalizedCloseQuantity: "10",
            reduceOnly: true,
            verifiedNativeExecutionRules: createVerifiedManagedCloseNativeExecutionRules({
              userId: intent.userId,
              accountId: intent.accountId,
              venue: intent.venue,
              canonicalInstrumentId: intent.instrumentId,
              providerInstrumentId: fixture.providerInstrumentId,
              executionIntentId: intent.intentId,
              instrumentState: "live",
              contractType: "linear",
              contractValueCurrency: "DOGE",
              settlementAsset: "USDT",
              contractValue: "1000",
              lotSize: "0.01",
              minimumSize: "0.01",
              canonicalSafeCloseQuantity: "10",
              legalizedCanonicalCloseQuantity: "10",
              providerNativeQuantity: "0.01",
              verifiedAt: fixture.verifiedAt,
            }),
          },
        }).execute(intent),
        (error: unknown) => Boolean(error && typeof error === "object"
          && "originalError" in error
          && (error as { originalError?: { category?: unknown } }).originalError?.category
            === "instrument_rules_invalid"),
      );
      assert.equal(instrumentRulesReads, 0, "invalid managed-close context must not fall back to a fresh unbound rules read");
      assert.equal(client.placeRequests.length, 0);
    });
  }
});

test("non-managed-close execution retains the authoritative instrument-rules read fallback", async () => {
  const client = new FakeOkxExecutionClient();
  let instrumentRulesReads = 0;
  await new OkxIntentExecutionService(client, {
    ...serviceOptions(),
    quantityRulesSource: async () => {
      instrumentRulesReads += 1;
      return okxTestQuantityRules(now);
    },
  }).execute(executionIntent());

  assert.equal(instrumentRulesReads, 1);
  assert.equal(client.placeRequests.length, 1);
});

test("unverified OKX position-mode read failures retain auth errors and classify transient reads", async () => {
  for (const fixture of [
    {
      category: "provider_request_rejected",
      expectedCategory: "position_mode_unavailable",
      providerCode: "50011",
    },
    {
      category: "credential_validation_failed",
      expectedCategory: "credential_validation_failed",
      providerCode: "50113",
    },
  ] as const) {
    const client = new FakeOkxExecutionClient();
    client.readPositionMode = async () => {
      throw Object.assign(new Error("controlled read failure"), {
        category: fixture.category,
        providerCode: fixture.providerCode,
      });
    };
    await assert.rejects(
      () => new OkxIntentExecutionService(client, serviceOptions()).execute(executionIntent()),
      (error: unknown) => Boolean(error && typeof error === "object"
        && "originalError" in error
        && (error as { originalError?: { category?: unknown; providerCode?: unknown } }).originalError?.category
          === fixture.expectedCategory
        && (error as { originalError?: { providerCode?: unknown } }).originalError?.providerCode
          === fixture.providerCode),
    );
    assert.equal(client.placeRequests.length, 0);
  }
});

test("OKX HEDGE close uses side plus posSide, omits net-mode reduceOnly, and rejects an opening side", async () => {
  const client = new FakeOkxExecutionClient();
  client.readPositionMode = async () => "HEDGE";
  const service = new OkxIntentExecutionService(client, {
    ...serviceOptions(),
    mutationSafetyGuard: new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: true }),
    mutationEffect: "DECREASE",
  });
  await service.execute(executionIntent({
    side: "buy", positionDirection: "SHORT", orderConstraints: { reduceOnly: true },
  }));
  assert.equal(client.placeRequests[0]?.posSide, "short");
  assert.equal(client.placeRequests[0]?.side, "buy");
  assert.equal(client.placeRequests[0]?.reduceOnly, undefined);

  const invalid = new FakeOkxExecutionClient();
  invalid.readPositionMode = async () => "HEDGE";
  await assert.rejects(() => new OkxIntentExecutionService(invalid, serviceOptions()).execute(executionIntent({
    side: "buy", positionDirection: "LONG", orderConstraints: { reduceOnly: true },
  })), /does not reduce/u);
  assert.equal(invalid.placeRequests.length, 0);
});

test("OKX HEDGE LONG and SHORT openings preserve the target bucket in recovery and complete evidence", async () => {
  for (const fixture of [
    { direction: "LONG" as const, side: "buy" as const, posSide: "long" as const },
    { direction: "SHORT" as const, side: "sell" as const, posSide: "short" as const },
  ]) {
    const client = new FakeOkxExecutionClient();
    client.readPositionMode = async () => "HEDGE";
    let recovery: unknown = null;
    const service = new OkxIntentExecutionService(client, {
      ...serviceOptions(),
      persistRecoveryReference: (value) => { recovery = value; },
    });

    const result = await service.execute(executionIntent({
      intentId: `intent-okx-hedge-${fixture.posSide}`,
      positionDirection: fixture.direction,
      side: fixture.side,
    }));

    assert.equal(client.placeRequests[0]?.side, fixture.side);
    assert.equal(client.placeRequests[0]?.posSide, fixture.posSide);
    assert.equal(client.placeRequests[0]?.reduceOnly, undefined);
    assert.equal(result.positionMode, "HEDGE");
    assert.equal(result.positionDirection, fixture.direction);
    assert.equal(result.posSide, fixture.posSide);
    assert.deepEqual(recovery, {
      instId: "DOGE-USDT-SWAP",
      clOrdId: okxClientOrderIdFor(executionIntent({
        intentId: `intent-okx-hedge-${fixture.posSide}`,
        positionDirection: fixture.direction,
        side: fixture.side,
      })),
      expectedProviderQuantity: "125",
      expectedSide: fixture.side,
      positionMode: "HEDGE",
      positionDirection: fixture.direction,
      posSide: fixture.posSide,
    });
  }
});

test("queries map OKX order states and preserve UNKNOWN reason", async () => {
  const client = new FakeOkxExecutionClient();
  const service = new OkxIntentExecutionService(client, serviceOptions());

  for (const fixture of [
    { rawState: "filled", expected: "CONFIRMED", reason: null },
    { rawState: "live", expected: "PENDING_CONFIRMATION", reason: null },
    { rawState: "partially_filled", expected: "PENDING_CONFIRMATION", reason: null },
    { rawState: "cancelled", expected: "FAILED", reason: null },
    { rawState: "rejected", expected: "FAILED", reason: null },
    { rawState: "mystery", expected: "UNKNOWN", reason: "unmapped OKX order state: mystery" },
  ] as const) {
    client.orderState = fixture.rawState;
    const result = await service.query({
      instrumentId: "DOGE-USDT-PERP",
      instId: "DOGE-USDT-SWAP",
      ordId: "7001",
      clOrdId: "sxokxidentity000000000000000000",
    });
    assert.equal(result.observation.state, fixture.expected);
    assert.equal(result.statusReason, fixture.reason);
    assert.equal(result.orderIdentity.ordId, "7001");
    assert.equal(result.orderIdentity.clOrdId, "sxokxidentity000000000000000000");
    assert.equal(result.orderIdentity.instId, "DOGE-USDT-SWAP");
  }
});

test("converts accFillSz=7 contracts to canonical filledBaseQuantity=70 when ctVal=10", async () => {
  const client = new FakeOkxExecutionClient();
  client.filledQuantityOverride = "7";
  const service = new OkxIntentExecutionService(client, serviceOptions({ ctVal: "10" }));

  const result = await service.query({
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "7001",
    clOrdId: "sxokxidentity000000000000000000",
  });

  assert.equal(result.observation.filledBaseQuantity, "70");
});

test("OKX HEDGE query confirms only matching Provider side, quantity, and bucket evidence", async () => {
  const client = new FakeOkxExecutionClient();
  client.orderOverride = { side: "sell", posSide: "short" };
  const service = new OkxIntentExecutionService(client, serviceOptions());
  const lookup = {
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "7001",
    clOrdId: "sxokxidentity000000000000000000",
    expectedProviderQuantity: "125",
    expectedSide: "sell" as const,
    positionMode: "HEDGE" as const,
    positionDirection: "SHORT" as const,
    posSide: "short" as const,
  };

  assert.equal((await service.query(lookup)).observation.state, "CONFIRMED");

  client.orderOverride = { side: "sell", posSide: "long" };
  const wrongBucket = await service.query(lookup);
  assert.equal(wrongBucket.observation.state, "UNKNOWN");
  assert.equal(wrongBucket.observation.filledBaseQuantity, "0");
  assert.match(wrongBucket.statusReason ?? "", /posSide/u);
});

test("OKX ONE_WAY query proves net mode, reduce semantic, and canonical cumulative ceiling", async () => {
  const client = new FakeOkxExecutionClient();
  client.orderOverride = { side: "sell", posSide: "net", reduceOnly: false, tdMode: "cross" };
  const service = new OkxIntentExecutionService(client, serviceOptions());
  const lookup = {
    instrumentId: "DOGE-USDT-PERP", instId: "DOGE-USDT-SWAP", ordId: "7001",
    clOrdId: "sxokxidentity000000000000000000", expectedProviderQuantity: "125",
    expectedSide: "sell" as const, positionMode: "ONE_WAY" as const, positionDirection: "SHORT" as const,
  };
  assert.equal((await service.query(lookup)).observation.state, "CONFIRMED");
  for (const override of [
    { posSide: "short" as const },
    { reduceOnly: true },
    { tdMode: "isolated" as const },
    { filledQuantity: "126" },
  ]) {
    client.orderOverride = { side: "sell", posSide: "net", reduceOnly: false, tdMode: "cross", ...override };
    assert.equal((await service.query(lookup)).observation.state, "UNKNOWN");
  }
});

test("rejects unsupported instruments before provider mutation", async () => {
  const client = new FakeOkxExecutionClient();

  await assert.rejects(
    () => new OkxIntentExecutionService(client, serviceOptions()).execute(executionIntent({
      instrumentId: "BTC-USDT-PERP",
      quantity: { asset: { symbol: "BTC", type: "DIGITAL_ASSET" }, quantity: "0.01" },
    })),
    /Unsupported OKX instrument/u,
  );
  assert.equal(client.placeRequests.length, 0);
});

test("fails closed before provider mutation for unavailable, stale, invalid, or mismatched quantity rules", async (t) => {
  for (const fixture of [
    { name: "unavailable", source: undefined, pattern: /unavailable/u },
    { name: "stale", source: okxTestQuantityRulesSource(now - 300_001), pattern: /stale/u },
    { name: "missing lotSz", source: missingRuleSource("lotSz"), pattern: /lotSz/u },
    { name: "missing minSz", source: missingRuleSource("minSz"), pattern: /minSz/u },
    { name: "missing ctVal", source: missingRuleSource("ctVal"), pattern: /ctVal/u },
    { name: "invalid lotSz", source: okxTestQuantityRulesSource(now, { lotSz: "0" }), pattern: /lotSz/u },
    { name: "invalid minSz", source: okxTestQuantityRulesSource(now, { minSz: "0" }), pattern: /minSz/u },
    { name: "invalid ctVal", source: okxTestQuantityRulesSource(now, { ctVal: "0" }), pattern: /ctVal/u },
    { name: "ctValCcy mismatch", source: okxTestQuantityRulesSource(now, { ctValCcy: "BTC" }), pattern: /identity/u },
    { name: "settleCcy mismatch", source: okxTestQuantityRulesSource(now, { settleCcy: "USDC" }), pattern: /identity/u },
    { name: "instrument identity mismatch", source: okxTestQuantityRulesSource(now, { uly: "BTC-USDT" }), pattern: /identity/u },
    { name: "instId mismatch", source: okxTestQuantityRulesSource(now, { instId: "BTC-USDT-SWAP" }), pattern: /identity/u },
    { name: "unsupported contract type", source: okxTestQuantityRulesSource(now, { ctType: "inverse" }), pattern: /identity/u },
    { name: "instrument not live", source: okxTestQuantityRulesSource(now, { state: "suspend" }), pattern: /tradeable/u },
  ] as const) {
    await t.test(fixture.name, async () => {
      const client = new FakeOkxExecutionClient();
      await assert.rejects(
        () => new OkxIntentExecutionService(client, {
          clock: () => now,
          mutationSafetyGuard: testMutationGuard(),
          quantityRulesSource: fixture.source,
        }).execute(executionIntent()),
        fixture.pattern,
      );
      assert.equal(client.placeRequests.length, 0);
    });
  }
});

test("fails closed before provider mutation when converted contracts violate lotSz or minSz", async (t) => {
  for (const fixture of [
    { name: "not exactly divisible", quantity: "95", rules: { ctVal: "10" } },
    { name: "minimum", quantity: "0.1", rules: { minSz: "2" } },
  ] as const) {
    await t.test(fixture.name, async () => {
      const client = new FakeOkxExecutionClient();
      await assert.rejects(() => new OkxIntentExecutionService(client, {
        clock: () => now,
        mutationSafetyGuard: testMutationGuard(),
        quantityRulesSource: okxTestQuantityRulesSource(now, fixture.rules),
      }).execute(executionIntent({ quantity: {
        asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
        quantity: fixture.quantity,
      } })), /lotSz|minSz/u);
      assert.equal(client.placeRequests.length, 0);
    });
  }
});

class FakeOkxExecutionClient {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  readonly getRequests: OkxGetOrderRequest[] = [];
  readonly cancelRequests: OkxCancelOrderRequest[] = [];
  orderState = "filled";
  filledQuantityOverride: string | null = null;
  orderOverride: Partial<OkxProviderOrder> = {};
  readPositionMode: (() => Promise<"ONE_WAY" | "HEDGE">) | undefined = async () => "ONE_WAY";

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return {
      instId: request.instId,
      ordId: "7001",
      clOrdId: request.clOrdId,
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.getRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "7001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
      status: this.orderState === "filled"
        ? "CONFIRMED"
        : this.orderState === "live"
          ? "SUBMITTED"
          : this.orderState === "partially_filled"
            ? "PENDING_CONFIRMATION"
            : this.orderState === "cancelled" || this.orderState === "rejected"
              ? "FAILED"
              : "UNKNOWN",
      statusReason: this.orderState === "mystery" ? "unmapped OKX order state: mystery" : null,
      rawState: this.orderState,
      tdMode: "cross",
      posSide: "net",
      reduceOnly: false,
      requestedQuantity: "125",
      filledQuantity: this.filledQuantityOverride
        ?? (this.orderState === "filled" ? "125" : "12"),
      averagePrice: "0.123",
      fee: "-0.001",
      updatedAt: now + 100,
      ...this.orderOverride,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelRequests.push(request);
    return {
      instId: request.instId,
      ordId: request.ordId ?? "7001",
      clOrdId: request.clOrdId ?? "sxokxidentity000000000000000000",
    };
  }

  async getPosition(_instId: string): Promise<readonly OkxPerpetualPosition[]> {
    return [];
  }
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-okx-1",
    userId: "user-1",
    venue: "okx",
    accountId: "okx:account-1",
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "12.5",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  });
}
