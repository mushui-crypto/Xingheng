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
