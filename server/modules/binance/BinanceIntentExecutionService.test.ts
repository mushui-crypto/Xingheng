import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExecutionCoordinator } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { BinanceIntentExecutionService } from "./BinanceIntentExecutionService";
import type { BinanceOrderInput } from "./BinanceOrderManager";
import type { BinanceProviderOrder } from "./BinanceTypes";
import type { BinanceGenericExecutionContext } from "./BinanceGenericExecutionReadContext";

const now = 1_800_000_000_000;

test("converts canonical perpetual intent into Binance execution request", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });

  const result = await service.execute(executionIntent());

  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.executionAttemptId, "intent-user-1");
  assert.deepEqual(binding.contextInstrumentIds, ["XAUT-USDT-PERP"]);
  assert.equal(binding.providerMutations, 1);
  assert.deepEqual(binding.placeInputs[0], {
    idempotencyKey: binding.placeInputs[0]!.idempotencyKey,
    category: "linear",
    symbol: "XAUTUSDT",
    side: "Buy",
    quantity: "0.002",
    executionPriceMode: "MARKET",
    reduceOnly: false,
  });
  assert.match(binding.placeInputs[0]!.idempotencyKey, /^execution-intent:[a-f0-9]{64}$/u);
});

test("maps spot, sell, price priority, and reduceOnly constraints", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });

  await service.execute(executionIntent({
    instrumentId: "XAUT-USDT-SPOT",
    side: "sell",
    executionMode: "PRICE_PRIORITY",
    orderConstraints: { reduceOnly: true },
  }));

  assert.deepEqual(binding.placeInputs[0], {
    idempotencyKey: binding.placeInputs[0]!.idempotencyKey,
    category: "spot",
    symbol: "XAUTUSDT",
    side: "Sell",
    quantity: "0.002",
    limitPrice: "997",
    executionPriceMode: "IOC_LIMIT",
    reduceOnly: true,
  });
});

test("passes BTC, ETH, and DOGE symbols and Decimal quantities from generic context", async (t) => {
  for (const fixture of [
    { instrumentId: "BTC-USDT-SPOT", symbol: "BTCUSDT", asset: "BTC", type: "DIGITAL_ASSET", quantity: "0.000123456789012345" },
    { instrumentId: "ETH-USDT-SPOT", symbol: "ETHUSDT", asset: "ETH", type: "DIGITAL_ASSET", quantity: "0.012345678901234567" },
    { instrumentId: "DOGE-USDT-PERP", symbol: "DOGEUSDT", asset: "DOGE", type: "DIGITAL_ASSET", quantity: "12.34567890123456789" },
  ] as const) {
    await t.test(fixture.instrumentId, async () => {
      const binding = new FakeBinancePersonalTradingBinding();
      await new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 }).execute(executionIntent({
        instrumentId: fixture.instrumentId,
        quantity: { asset: { symbol: fixture.asset, type: fixture.type }, quantity: fixture.quantity },
      }));
      assert.equal(binding.placeInputs[0]!.symbol, fixture.symbol);
      assert.equal(binding.placeInputs[0]!.quantity, fixture.quantity);
      assert.equal(binding.providerMutations, 1);
    });
  }
});

test("generic IOC protection prices use exact Decimal BUY ceil and SELL floor alignment", async (t) => {
  for (const fixture of [
    {
      name: "BTC BUY 0.01 tick with many quote decimals",
      instrumentId: "BTC-USDT-SPOT",
      side: "buy",
      bid: "99.999999999999999999",
      ask: "100.000000000000000001",
      priceTick: "0.01",
      expected: "100.21",
    },
    {
      name: "BTC SELL 0.01 tick with many quote decimals",
      instrumentId: "BTC-USDT-SPOT",
      side: "sell",
      bid: "99.999999999999999999",
      ask: "100.000000000000000001",
      priceTick: "0.01",
      expected: "99.79",
    },
    {
      name: "ETH BUY 0.001 tick",
      instrumentId: "ETH-USDT-SPOT",
      side: "buy",
      bid: "1999.999",
      ask: "2000.001",
      priceTick: "0.001",
      expected: "2004.002",
    },
    {
      name: "ETH SELL 0.001 tick",
      instrumentId: "ETH-USDT-SPOT",
      side: "sell",
      bid: "1999.999",
      ask: "2000.001",
      priceTick: "0.001",
      expected: "1995.999",
    },
    {
      name: "DOGE BUY 0.0001 tick",
      instrumentId: "DOGE-USDT-PERP",
      side: "buy",
      bid: "0.123400000000000001",
      ask: "0.123456789012345678",
      priceTick: "0.0001",
      expected: "0.1238",
    },
    {
      name: "DOGE SELL 0.0001 tick",
      instrumentId: "DOGE-USDT-PERP",
      side: "sell",
      bid: "0.123400000000000001",
      ask: "0.123456789012345678",
      priceTick: "0.0001",
      expected: "0.1231",
    },
    {
      name: "XAUT legacy 0.1 tick",
      instrumentId: "XAUT-USDT-PERP",
      side: "buy",
      bid: "1000",
      ask: "1002",
      priceTick: "0.1",
      expected: "1004.1",
    },
  ] as const) {
    await t.test(fixture.name, async () => {
      const binding = new FakeBinancePersonalTradingBinding();
      binding.contextFactory = (instrumentId) => executionContextWithQuote(instrumentId, fixture);
      await new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 }).execute(executionIntent({
        instrumentId: fixture.instrumentId,
        side: fixture.side,
        executionMode: "PRICE_PRIORITY",
        quantity: {
          asset: {
            symbol: fixture.instrumentId.split("-")[0]!,
            type: fixture.instrumentId.startsWith("XAUT-") ? "RWA_ASSET" : "DIGITAL_ASSET",
          },
          quantity: "0.002",
        },
      }));
      assert.equal(binding.placeInputs[0]?.executionPriceMode, "IOC_LIMIT");
      assert.equal(binding.placeInputs[0]?.limitPrice, fixture.expected);
    });
  }
});

test("rejects generic context errors and asset mismatch before provider mutation", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });

  binding.contextFailure = new Error("generic context unavailable");
  await assert.rejects(
    () => service.execute(executionIntent({ instrumentId: "BTC-USDT-PERP" })),
    /generic context unavailable/u,
  );
  binding.contextFailure = null;
  await assert.rejects(
    () => service.execute(executionIntent({
      quantity: { asset: { symbol: "BTC", type: "DIGITAL_ASSET" }, quantity: "0.002" },
    })),
    /does not match the canonical instrument base asset/u,
  );
  assert.equal(binding.providerMutations, 0);
  assert.equal(binding.placeInputs.length, 0);
});

test("preserves the existing RiskGuard path through the pre-mutation hook", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(
    binding,
    { maxSlippageBps: 20 },
    (prepared) => {
      assert.equal(prepared.limitPrice, 1004.1);
      throw new Error("RiskGuard blocked before provider mutation");
    },
  );

  await assert.rejects(
    () => service.execute(executionIntent()),
    /RiskGuard blocked before provider mutation/u,
  );
  assert.deepEqual(binding.contextInstrumentIds, ["XAUT-USDT-PERP"]);
  assert.equal(binding.providerMutations, 0);
  assert.equal(binding.placeInputs.length, 0);
});

test("maps provider states into execution states", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });
  binding.placeResult = providerOrder({ status: "PartiallyFilled" });
  assert.equal((await service.execute(executionIntent())).state, "PENDING_CONFIRMATION");
  binding.placeResult = providerOrder({ status: "Rejected" });
  assert.equal((await service.execute(executionIntent({ intentId: "intent-user-2" }))).state, "FAILED");
  binding.placeResult = providerOrder({ status: "Unknown" });
  assert.equal((await service.execute(executionIntent({ intentId: "intent-user-3" }))).state, "UNKNOWN");
});

test("provider anomaly becomes UNKNOWN through ExecutionCoordinator without provider retry", async () => {
  const binding = new FakeBinancePersonalTradingBinding();
  binding.failure = new Error("provider write may have happened");
  const service = new BinanceIntentExecutionService(binding, { maxSlippageBps: 20 });
  const coordinated = await new ExecutionCoordinator(service, () => now).execute(executionIntent());

  assert.equal(coordinated.status, "CALL_FAILED");
  assert.equal(coordinated.executionState.status, "UNKNOWN");
  assert.equal(binding.providerMutations, 1);
  assert.equal(binding.placeCalls, 1);
});

test("service stays inside Binance execution boundary and does not import client or risk guard", () => {
  const source = readFileSync(new URL("./BinanceIntentExecutionService.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /BinanceClient|new\s+Binance|BinanceRiskGuard|Funding|Strategy|fetch\(|setInterval|scheduler|retry/iu);
  assert.doesNotMatch(source, /Number\(value\)|parseFloat|Math\.ceil|Math\.floor/u);
  assert.match(source, /placeExecutionOrder/u);
});

class FakeBinancePersonalTradingBinding {
  readonly placeInputs: BinanceOrderInput[] = [];
  readonly contextInstrumentIds: string[] = [];
  placeCalls = 0;
  providerMutations = 0;
  placeResult: BinanceProviderOrder = providerOrder({ status: "Filled" });
  failure: Error | null = null;
  contextFailure: Error | null = null;
  contextFactory: (instrumentId: string) => BinanceGenericExecutionContext = executionContext;

  async loadExecutionReadContext(instrumentId: string) {
    this.contextInstrumentIds.push(instrumentId);
    if (this.contextFailure) throw this.contextFailure;
    return this.contextFactory(instrumentId);
  }

  async placeExecutionOrder(
    input: BinanceOrderInput,
    beforeProviderMutation?: (riskValuationPrice: number) => void | Promise<void>,
  ) {
    this.placeCalls += 1;
    await beforeProviderMutation?.(input.limitPrice === undefined ? 1_004.1 : Number(input.limitPrice));
    this.providerMutations += 1;
    if (this.failure) throw this.failure;
    this.placeInputs.push(input);
    return this.placeResult;
  }
}

function executionContextWithQuote(
  instrumentId: string,
  values: Readonly<{ bid: string; ask: string; priceTick: string }>,
): BinanceGenericExecutionContext {
  const context = executionContext(instrumentId);
  return Object.freeze({
    ...context,
    tradingRules: Object.freeze({ ...context.tradingRules, priceTick: values.priceTick }),
    quote: Object.freeze({ ...context.quote, bid: values.bid, ask: values.ask }),
  });
}

function executionContext(instrumentId: string): BinanceGenericExecutionContext {
  const match = /^([A-Z0-9]+)-USDT-(SPOT|PERP)$/u.exec(instrumentId);
  if (!match) throw new Error("generic context unavailable");
  const symbol = match[1]!;
  const marketType = match[2] === "SPOT" ? "spot" : "perpetual";
  const assetType = symbol === "XAUT" ? "RWA_ASSET" as const : "DIGITAL_ASSET" as const;
  return Object.freeze({
    instrument: Object.freeze({
      instrumentId,
      venue: "binance",
      providerSymbol: `${symbol}USDT`,
      baseAsset: Object.freeze({ symbol, type: assetType }),
      quoteAsset: "USDT",
      ...(marketType === "perpetual" ? { settlementAsset: "USDT" } : {}),
      marketType,
      contractType: marketType === "spot" ? "spot" : "linear_perpetual",
      quantityUnit: "base",
      contractSize: "1",
      status: "trading",
    }),
    tradingRules: Object.freeze({
      quantityStep: "0.00000001",
      minQuantity: "0.00000001",
      priceTick: marketType === "spot" ? "1" : "0.1",
      minNotional: "5",
      precision: Object.freeze({ quantity: 8, price: 1 }),
    }),
    quote: Object.freeze({
      bid: marketType === "spot" ? "999" : "1000",
      ask: marketType === "spot" ? "1001" : "1002",
      fetchedAt: now,
    }),
  });
}

function executionIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return createExecutionIntent({
    intentId: "intent-user-1",
    userId: "user-1",
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "XAUT-USDT-PERP",
    side: "buy",
    quantity: {
      asset: { symbol: "XAUT", type: "RWA_ASSET" },
      quantity: "0.002",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  });
}

function providerOrder(overrides: Partial<BinanceProviderOrder> = {}): BinanceProviderOrder {
  return {
    orderId: "binance-order-1",
    orderLinkId: "binance-client-order-1",
    status: "Filled",
    requestedQuantity: 0.002,
    filledQuantity: 0.002,
    averagePrice: 1_004,
    feeUsd: 0,
    updatedAt: now + 1_000,
    ...overrides,
  };
}
