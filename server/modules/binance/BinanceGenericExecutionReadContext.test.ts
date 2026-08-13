import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ExplicitCanonicalAssetSource,
  createExecutionCanonicalAssetSource,
} from "../cex/CanonicalAssetSource";
import { ExecutionQuantityPlanner } from "../cex/ExecutionQuantityPlanner";
import {
  BinanceGenericExecutionReadContextService,
  BinanceGenericExecutionReadError,
  type BinanceExecutionMarket,
  type BinanceGenericExecutionReadClient,
} from "./BinanceGenericExecutionReadContext";

const now = 1_800_000_000_000;
test("resolves arbitrary Binance USDT Spot products with authoritative Decimal rules and quotes", async () => {
  const client = fixtureClient();
  const service = contextService(client);

  const btc = await service.load("BTC-USDT-SPOT");
  const eth = await service.load("ETH-USDT-SPOT");

  assert.equal(btc.instrument.providerSymbol, "BTCUSDT");
  assert.equal(btc.instrument.baseAsset.type, "DIGITAL_ASSET");
  assert.equal(btc.instrument.marketType, "spot");
  assert.equal(btc.instrument.contractType, "spot");
  assert.equal(btc.instrument.quantityUnit, "base");
  assert.equal(btc.instrument.contractSize, "1");
  assert.deepEqual(btc.tradingRules, {
    quantityStep: "0.00001",
    minQuantity: "0.00001",
    priceTick: "0.01",
    minNotional: "5",
    precision: { quantity: 8, price: 8 },
  });
  assert.deepEqual(btc.quote, { bid: "67234.123456789", ask: "67234.223456789", fetchedAt: now });
  assert.equal(eth.instrument.providerSymbol, "ETHUSDT");
  assert.equal(client.exchangeInfoReads.spot, 2);
  assert.deepEqual(client.bookReads.slice(0, 2), ["spot:BTCUSDT", "spot:ETHUSDT"]);
});

test("resolves arbitrary Binance USD-M USDT linear perpetual products", async () => {
  const client = fixtureClient();
  const service = contextService(client);

  const btc = await service.load("BTC-USDT-PERP");
  const doge = await service.load("DOGE-USDT-PERP");

  assert.equal(btc.instrument.providerSymbol, "BTCUSDT");
  assert.equal(btc.instrument.marketType, "perpetual");
  assert.equal(btc.instrument.contractType, "linear_perpetual");
  assert.equal(btc.instrument.settlementAsset, "USDT");
  assert.equal(btc.instrument.quantityUnit, "base");
  assert.equal(btc.instrument.contractSize, "1");
  assert.deepEqual(btc.tradingRules, {
    quantityStep: "0.001",
    minQuantity: "0.001",
    priceTick: "0.1",
    minNotional: "5",
    precision: { quantity: 3, price: 1 },
  });
  assert.deepEqual(btc.quote, { bid: "67233.987654321", ask: "67234.087654321", fetchedAt: now });
  assert.equal(doge.instrument.providerSymbol, "DOGEUSDT");
  assert.equal(doge.tradingRules.quantityStep, "1");
});

test("fails closed for missing, non-trading, non-USDT, inverse and coin-margined products", async () => {
  const service = contextService(fixtureClient());

  await rejectsCode(() => service.load("SOL-USDT-SPOT"), "INSTRUMENT_NOT_FOUND");
  await rejectsCode(() => service.load("PAUSED-USDT-SPOT"), "INSTRUMENT_NOT_TRADING");
  await rejectsCode(() => service.load("BTC-USDC-SPOT"), "INSTRUMENT_UNSUPPORTED");
  await rejectsCode(() => service.load("BTC-USD-PERP"), "INSTRUMENT_UNSUPPORTED");
  await rejectsCode(() => service.load("INVERSE-USDT-PERP"), "INSTRUMENT_NOT_FOUND");
});

test("fails closed when canonical Asset.type cannot be resolved authoritatively", async () => {
  const service = new BinanceGenericExecutionReadContextService(
    fixtureClient(),
    new ExplicitCanonicalAssetSource([]),
    () => now,
  );
  await rejectsCode(() => service.load("BTC-USDT-SPOT"), "ASSET_MAPPING_UNAVAILABLE");
});

test("preserves XAUT support without making XAUT the only accepted asset", async () => {
  const service = contextService(fixtureClient());
  const spot = await service.load("XAUT-USDT-SPOT");
  const perpetual = await service.load("XAUT-USDT-PERP");

  assert.equal(spot.instrument.baseAsset.type, "RWA_ASSET");
  assert.equal(spot.instrument.providerSymbol, "XAUTUSDT");
  assert.equal(perpetual.instrument.providerSymbol, "XAUTUSDT");
});

test("ExecutionQuantityPlanner consumes Binance generic Spot and perpetual contexts", async () => {
  const service = contextService(fixtureClient());
  for (const scenario of [
    { instrumentId: "BTC-USDT-SPOT", side: "buy" as const, input: "20" },
    { instrumentId: "ETH-USDT-SPOT", side: "sell" as const, input: "0.01", assetMode: true },
    { instrumentId: "BTC-USDT-PERP", side: "sell" as const, input: "100" },
    { instrumentId: "DOGE-USDT-PERP", side: "buy" as const, input: "20" },
  ]) {
    const context = await service.load(scenario.instrumentId);
    const planner = new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === scenario.instrumentId ? context.instrument : null },
      { getTradingRules: async () => context.tradingRules },
      { now: () => now },
    );
    const result = await planner.plan({
      instrumentId: scenario.instrumentId,
      side: scenario.side,
      quantityInput: scenario.assetMode
        ? { mode: "ASSET_QUANTITY", quantity: scenario.input }
        : { mode: "NOTIONAL_USDT", amountUsdt: scenario.input },
      quote: context.quote,
    });
    assert.equal(result.ok, true, scenario.instrumentId);
    if (result.ok) {
      assert.equal(result.plan.instrumentId, scenario.instrumentId);
      assert.equal(result.plan.plannedAssetQuantity.asset.symbol, context.instrument.baseAsset.symbol);
    }
  }
});

test("Decimal rules and quote path never converts provider financial strings through JS number", () => {
  const source = readFileSync(new URL("./BinanceGenericExecutionReadContext.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:parseFloat|parseInt|Number)\s*\(\s*(?:row|lot|price|notional)\./u);
  assert.doesNotMatch(source, /[+*/-]\s*(?:row|lot|price|notional)\./u);
  assert.doesNotMatch(source, /\.(?:toFixed|toPrecision)\s*\(/u);
});

test("read client contract exposes GET-only metadata and quote methods, not provider mutation", () => {
  const source = readFileSync(new URL("./BinanceGenericExecutionReadContext.ts", import.meta.url), "utf8");
  assert.match(source, /method:\s*"GET"/u);
  assert.doesNotMatch(source, /\b(?:placeOrder|cancelOrder|setLeverage|withdraw|transfer)\b/u);
});

function contextService(client: FixtureClient) {
  return new BinanceGenericExecutionReadContextService(
    client,
    createExecutionCanonicalAssetSource(),
    () => now,
  );
}

async function rejectsCode(
  operation: () => Promise<unknown>,
  code: BinanceGenericExecutionReadError["code"],
) {
  await assert.rejects(operation, (error) => error instanceof BinanceGenericExecutionReadError && error.code === code);
}

class FixtureClient implements BinanceGenericExecutionReadClient {
  readonly exchangeInfoReads = { spot: 0, usdm_perpetual: 0 };
  readonly bookReads: string[] = [];

  async readExchangeInfo(market: BinanceExecutionMarket) {
    this.exchangeInfoReads[market] += 1;
    return market === "spot" ? spotExchangeInfo() : futuresExchangeInfo();
  }

  async readBookTicker(market: BinanceExecutionMarket, providerSymbol: string) {
    this.bookReads.push(`${market}:${providerSymbol}`);
    const prices: Record<string, readonly [string, string]> = {
      "spot:BTCUSDT": ["67234.123456789000", "67234.223456789000"],
      "spot:ETHUSDT": ["3521.01000000", "3521.02000000"],
      "spot:XAUTUSDT": ["4339.99000000", "4340.00000000"],
      "usdm_perpetual:BTCUSDT": ["67233.987654321000", "67234.087654321000"],
      "usdm_perpetual:DOGEUSDT": ["0.173456780", "0.173456790"],
      "usdm_perpetual:XAUTUSDT": ["4341.10000000", "4341.20000000"],
    };
    const quote = prices[`${market}:${providerSymbol}`];
    if (!quote) throw new Error("fixture quote missing");
    return { symbol: providerSymbol, bidPrice: quote[0], askPrice: quote[1] };
  }
}

function fixtureClient() {
  return new FixtureClient();
}

function spotExchangeInfo() {
  return {
    symbols: [
      spotRow("BTC", "0.00001000", "0.00001000", "0.01000000", "5.00000000"),
      spotRow("ETH", "0.00010000", "0.00010000", "0.01000000", "5.00000000"),
      spotRow("XAUT", "0.00000100", "0.00000100", "0.01000000", "5.00000000"),
      spotRow("PAUSED", "1.00000000", "1.00000000", "0.01000000", "5.00000000", "BREAK"),
      { ...spotRow("BTC", "0.00001", "0.00001", "0.01", "5"), symbol: "BTCUSDC", quoteAsset: "USDC" },
    ],
  };
}

function futuresExchangeInfo() {
  return {
    symbols: [
      futuresRow("BTC", "0.001", "0.001", "0.1", "5", 3, 1),
      futuresRow("DOGE", "1", "1", "0.00001", "5", 0, 5),
      futuresRow("XAUT", "0.001", "0.001", "0.1", "5", 3, 1),
      { ...futuresRow("INVERSE", "1", "1", "0.1", "5", 0, 1), marginAsset: "BTC" },
    ],
  };
}

function spotRow(
  baseAsset: string,
  stepSize: string,
  minQty: string,
  tickSize: string,
  minNotional: string,
  status = "TRADING",
) {
  return {
    symbol: `${baseAsset}USDT`,
    status,
    baseAsset,
    baseAssetPrecision: 8,
    quoteAsset: "USDT",
    quotePrecision: 8,
    isSpotTradingAllowed: true,
    filters: [
      { filterType: "LOT_SIZE", stepSize, minQty },
      { filterType: "PRICE_FILTER", tickSize },
      { filterType: "NOTIONAL", minNotional },
    ],
  };
}

function futuresRow(
  baseAsset: string,
  stepSize: string,
  minQty: string,
  tickSize: string,
  notional: string,
  quantityPrecision: number,
  pricePrecision: number,
) {
  return {
    symbol: `${baseAsset}USDT`,
    status: "TRADING",
    contractType: "PERPETUAL",
    baseAsset,
    quoteAsset: "USDT",
    marginAsset: "USDT",
    quantityPrecision,
    pricePrecision,
    filters: [
      { filterType: "LOT_SIZE", stepSize, minQty },
      { filterType: "PRICE_FILTER", tickSize },
      { filterType: "MIN_NOTIONAL", notional },
    ],
  };
}
