import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAsset } from "./Asset";
import { createAssetQuantity, QuantityConverter } from "./AssetQuantity";
import { createCanonicalInstrument } from "./Instrument";
import { InstrumentCapability } from "./InstrumentCapability";
import {
  BinanceTradingRulesAdapter,
  BitgetTradingRulesAdapter,
  BybitTradingRulesAdapter,
  OkxInstrumentRulesError,
  OkxTradingRulesAdapter,
  type PublicTradingRulesClient,
} from "./TradingRulesAdapter";

test("parses BTC trading rules for all four venues", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "BTC", quoteAsset: "USDT", contractType: "perpetual" });
  const capability = new InstrumentCapability();

  const binance = await new BinanceTradingRulesAdapter(new FakePublicRulesClient(binancePayload("BTCUSDT")))
    .getTradingRules(capability.resolveVenueInstrument(instrument, "binance"));
  const okx = await new OkxTradingRulesAdapter(new FakePublicRulesClient(okxPayload("BTC-USDT-SWAP")))
    .getTradingRules(capability.resolveVenueInstrument(instrument, "okx"));
  const bybit = await new BybitTradingRulesAdapter(new FakePublicRulesClient(bybitPayload("BTCUSDT")))
    .getTradingRules(capability.resolveVenueInstrument(instrument, "bybit"));
  const bitget = await new BitgetTradingRulesAdapter(new FakePublicRulesClient(bitgetPayload("BTCUSDT")))
    .getTradingRules(capability.resolveVenueInstrument(instrument, "bitget"));

  assert.deepEqual(binance, {
    quantityStep: "0.001",
    minQuantity: "0.001",
    priceTick: "0.1",
    minNotional: "5",
    precision: { quantity: 3, price: 1 },
  });
  assert.deepEqual(okx, {
    quantityStep: "0.01",
    minQuantity: "0.01",
    priceTick: "0.1",
    contractSize: "0.01",
    precision: {},
  });
  assert.equal(bybit.quantityStep, "0.001");
  assert.equal(bybit.minNotional, "5");
  assert.equal(bitget.quantityStep, "0.001");
  assert.equal(bitget.contractSize, "0.001");
});

test("parses authoritative Bitget UTA multiplier and minimum amount fields", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "DOGE", quoteAsset: "USDT", contractType: "perpetual" });
  const rules = await new BitgetTradingRulesAdapter(new FakePublicRulesClient({ code: "00000", data: [{
    symbol: "DOGEUSDT", quantityPrecision: "0", quantityMultiplier: "1", minOrderQty: "1",
    pricePrecision: "5", priceMultiplier: "0.00001", minOrderAmount: "5",
  }] })).getTradingRules(new InstrumentCapability().resolveVenueInstrument(instrument, "bitget"));
  assert.equal(rules.quantityStep, "1");
  assert.equal(rules.minQuantity, "1");
  assert.equal(rules.priceTick, "0.00001");
  assert.equal(rules.minNotional, "5");
});

test("parses XAUT RWA trading rules without asset identity assumptions", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "XAUT", quoteAsset: "USDT", contractType: "perpetual" });
  const venueInstrument = new InstrumentCapability().resolveVenueInstrument(instrument, "okx");

  const rules = await new OkxTradingRulesAdapter(new FakePublicRulesClient(okxPayload("XAUT-USDT-SWAP")))
    .getTradingRules(venueInstrument);

  assert.deepEqual(rules, {
    quantityStep: "0.01",
    minQuantity: "0.01",
    priceTick: "0.1",
    contractSize: "0.01",
    precision: {},
  });
});

test("uses OKX adapter min size as venue contract quantity during conversion", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "XAUT", quoteAsset: "USDT", contractType: "perpetual" });
  const venueInstrument = new InstrumentCapability().resolveVenueInstrument(instrument, "okx");
  const rules = await new OkxTradingRulesAdapter(new FakePublicRulesClient(okxPayload("XAUT-USDT-SWAP")))
    .getTradingRules(venueInstrument);
  const quantity = createAssetQuantity({
    asset: createAsset({
      symbol: "XAUT",
      type: "RWA_ASSET",
      externalReference: {
        namespace: "issuer",
        identifier: "tether:xaut",
      },
    }),
    quantity: "0.002",
  });

  const converted = new QuantityConverter().toVenueContractQuantity(quantity, rules);

  assert.deepEqual(converted, { quantity: "0.2" });
});

test("OKX managed-close planning reads generic and native SWAP facts in one public request", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "DOGE", quoteAsset: "USDT", contractType: "perpetual" });
  const venueInstrument = new InstrumentCapability().resolveVenueInstrument(instrument, "okx");
  const client = new FakePublicRulesClient(okxNativePayload("DOGE-USDT-SWAP"));

  const result = await new OkxTradingRulesAdapter(client)
    .getPerpetualTradingRulesWithNativeFacts(venueInstrument);

  assert.equal(client.calls.length, 1);
  assert.equal(result.tradingRules.contractSize, "1000");
  assert.deepEqual(result.nativeRules, {
    providerInstrumentId: "DOGE-USDT-SWAP",
    instrumentState: "live",
    contractType: "linear",
    contractValueCurrency: "DOGE",
    settlementAsset: "USDT",
    contractValue: "1000",
    lotSize: "0.01",
    minimumSize: "0.01",
  });
});

test("OKX native SWAP rule reads distinguish unavailable, non-tradeable, and invalid facts", async (t) => {
  const instrument = createCanonicalInstrument({ baseAsset: "DOGE", quoteAsset: "USDT", contractType: "perpetual" });
  const venueInstrument = new InstrumentCapability().resolveVenueInstrument(instrument, "okx");
  const fixtures = [
    {
      name: "unavailable",
      client: { get: async () => { throw new Error("temporary read failure"); } },
      category: "instrument_rules_unavailable",
    },
    {
      name: "not tradeable",
      client: new FakePublicRulesClient(okxNativePayload("DOGE-USDT-SWAP", { state: "suspend" })),
      category: "instrument_not_tradable",
    },
    {
      name: "instrument absent",
      client: new FakePublicRulesClient({ code: "0", data: [] }),
      category: "instrument_not_tradable",
    },
    {
      name: "invalid",
      client: new FakePublicRulesClient(okxNativePayload("DOGE-USDT-SWAP", { ctType: "inverse" })),
      category: "instrument_rules_invalid",
    },
  ] as const;
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => new OkxTradingRulesAdapter(fixture.client)
          .getPerpetualTradingRulesWithNativeFacts(venueInstrument),
        (error: unknown) => error instanceof OkxInstrumentRulesError
          && error.category === fixture.category,
      );
    });
  }
});

test("every incomplete or inconsistent OKX native SWAP rule is classified as invalid", async (t) => {
  const instrument = createCanonicalInstrument({ baseAsset: "DOGE", quoteAsset: "USDT", contractType: "perpetual" });
  const venueInstrument = new InstrumentCapability().resolveVenueInstrument(instrument, "okx");
  const fixtures = [
    { name: "missing state", payload: okxNativePayloadWithout("state") },
    { name: "missing instType", payload: okxNativePayloadWithout("instType") },
    { name: "wrong instType", payload: okxNativePayload("DOGE-USDT-SWAP", { instType: "FUTURES" }) },
    { name: "missing ctType", payload: okxNativePayloadWithout("ctType") },
    { name: "wrong ctType", payload: okxNativePayload("DOGE-USDT-SWAP", { ctType: "inverse" }) },
    { name: "missing ctVal", payload: okxNativePayloadWithout("ctVal") },
    { name: "malformed ctVal", payload: okxNativePayload("DOGE-USDT-SWAP", { ctVal: "not-a-decimal" }) },
    { name: "missing ctValCcy", payload: okxNativePayloadWithout("ctValCcy") },
    { name: "missing settleCcy", payload: okxNativePayloadWithout("settleCcy") },
    { name: "malformed lotSz", payload: okxNativePayload("DOGE-USDT-SWAP", { lotSz: "not-a-decimal" }) },
    { name: "malformed minSz", payload: okxNativePayload("DOGE-USDT-SWAP", { minSz: "0" }) },
    { name: "missing tickSz", payload: okxNativePayloadWithout("tickSz") },
    { name: "inconsistent base currency", payload: okxNativePayload("DOGE-USDT-SWAP", { ctValCcy: "BTC" }) },
    { name: "inconsistent settlement currency", payload: okxNativePayload("DOGE-USDT-SWAP", { settleCcy: "USDC" }) },
  ] as const;

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => new OkxTradingRulesAdapter(new FakePublicRulesClient(fixture.payload))
          .getPerpetualTradingRulesWithNativeFacts(venueInstrument),
        (error: unknown) => error instanceof OkxInstrumentRulesError
          && error.category === "instrument_rules_invalid",
      );
    });
  }
});

test("keeps venue rule differences isolated", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "BTC", quoteAsset: "USDT", contractType: "perpetual" });
  const capability = new InstrumentCapability();
  const binance = await new BinanceTradingRulesAdapter(new FakePublicRulesClient(binancePayload("BTCUSDT")))
    .getTradingRules(capability.resolveVenueInstrument(instrument, "binance"));
  const okx = await new OkxTradingRulesAdapter(new FakePublicRulesClient(okxPayload("BTC-USDT-SWAP")))
    .getTradingRules(capability.resolveVenueInstrument(instrument, "okx"));

  assert.notEqual(binance.quantityStep, okx.quantityStep);
  assert.notEqual(binance.contractSize ?? "1", okx.contractSize);
});

test("rejects missing trading rules", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "MISSING", quoteAsset: "USDT", contractType: "perpetual" });
  const venueInstrument = new InstrumentCapability().resolveVenueInstrument(instrument, "binance");

  await assert.rejects(
    () => new BinanceTradingRulesAdapter(new FakePublicRulesClient({ symbols: [] })).getTradingRules(venueInstrument),
    /trading rules not found/u,
  );
});

test("trading rules adapters expose only public read endpoints", async () => {
  const instrument = createCanonicalInstrument({ baseAsset: "BTC", quoteAsset: "USDT", contractType: "perpetual" });
  const capability = new InstrumentCapability();
  const client = new FakePublicRulesClient(binancePayload("BTCUSDT"));

  await new BinanceTradingRulesAdapter(client).getTradingRules(capability.resolveVenueInstrument(instrument, "binance"));

  assert.deepEqual(client.calls, [{
    path: "/fapi/v1/exchangeInfo",
    query: { symbol: "BTCUSDT" },
  }]);

  const source = readFileSync(new URL("./TradingRulesAdapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/order|placeOrder|cancelOrder|ExecutionCapability|ExecutionCoordinator|Strategy|funding|profit/u);
});

class FakePublicRulesClient implements PublicTradingRulesClient {
  readonly calls: Array<{ path: string; query: Record<string, string> }> = [];

  constructor(private readonly payload: unknown) {}

  async get(path: string, query: Record<string, string>): Promise<unknown> {
    this.calls.push({ path, query });
    if (/order|account|position|withdraw|transfer/u.test(path)) {
      throw new Error(`Forbidden endpoint in trading rules test: ${path}`);
    }
    return this.payload;
  }
}

function binancePayload(symbol: string) {
  return {
    symbols: [{
      symbol,
      quantityPrecision: 3,
      pricePrecision: 1,
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.1" },
        { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    }],
  };
}

function okxPayload(instId: string) {
  return {
    code: "0",
    data: [{
      instId,
      lotSz: "0.01",
      minSz: "0.01",
      tickSz: "0.1",
      ctVal: "0.01",
    }],
  };
}

function okxNativePayload(instId: string, overrides: Record<string, string> = {}) {
  return {
    code: "0",
    data: [{
      instId,
      instType: "SWAP",
      state: "live",
      ctType: "linear",
      ctValCcy: "DOGE",
      settleCcy: "USDT",
      lotSz: "0.01",
      minSz: "0.01",
      tickSz: "0.00001",
      ctVal: "1000",
      ...overrides,
    }],
  };
}

function okxNativePayloadWithout(field: string) {
  const payload = okxNativePayload("DOGE-USDT-SWAP");
  const row = { ...payload.data[0] } as Record<string, string>;
  delete row[field];
  return { code: "0", data: [row] };
}

function bybitPayload(symbol: string) {
  return {
    retCode: 0,
    result: {
      list: [{
        symbol,
        lotSizeFilter: {
          minOrderQty: "0.001",
          qtyStep: "0.001",
          minNotionalValue: "5",
        },
        priceFilter: {
          tickSize: "0.1",
        },
      }],
    },
  };
}

function bitgetPayload(symbol: string) {
  return {
    code: "00000",
    data: [{
      symbol,
      quantityPrecision: "3",
      pricePrecision: "1",
      minTradeNum: "0.001",
      minTradeUSDT: "5",
      contractSize: "0.001",
    }],
  };
}
