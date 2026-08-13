import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDefaultFundingOpportunitySource } from "./createDefaultFundingOpportunitySource";

const now = 1_800_000_000_000;
const nextFundingAt = now + 8 * 60 * 60_000;

test("default funding opportunity source wires public read data into the evaluator", async () => {
  const requested: string[] = [];
  const source = createDefaultFundingOpportunitySource({
    now: () => now,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requested.push(`${url.hostname}${url.pathname}?${url.searchParams.toString()}`);
      return Response.json(payloadFor(url));
    },
  });

  const plans = await source.getOpportunities();

  assert.equal(plans.length > 0, true);
  assert.equal(plans[0]?.symbol, "XAUTUSDT");
  assert.equal(plans[0]?.longVenue, "okx");
  assert.equal(plans[0]?.shortVenue, "binance");
  assert.equal(plans[0]?.longInstrumentId, "XAUT-USDT-PERP");
  assert.equal(plans[0]?.shortInstrumentId, "XAUT-USDT-PERP");
  assert.equal(plans[0]?.estimatedNetYield > 0, true);
  assert.equal(requested.some((url) => url.includes("fapi.binance.com/fapi/v1/exchangeInfo")), true);
  assert.equal(requested.some((url) => url.includes("www.okx.com/api/v5/public/instruments")), true);
  assert.equal(requested.some((url) => url.includes("api.bybit.com/v5/market/instruments-info")), true);
  assert.equal(requested.some((url) => url.includes("api.bitget.com/api/v2/mix/market/contracts")), true);
});

test("default funding opportunity source returns an empty list when canonical inputs are unavailable", async () => {
  const source = createDefaultFundingOpportunitySource({
    now: () => now,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("exchangeInfo")) return Response.json({ symbols: [] });
      if (url.hostname === "www.okx.com") return Response.json({ code: "0", data: [] });
      if (url.hostname === "api.bybit.com") return Response.json({ retCode: 0, result: { list: [] } });
      if (url.hostname === "api.bitget.com") return Response.json({ code: "00000", data: [] });
      return Response.json({});
    },
  });

  assert.deepEqual(await source.getOpportunities(), []);
});

test("default source wiring remains read-only and does not import execution components", () => {
  const source = readFileSync(new URL("./createDefaultFundingOpportunitySource.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /placeOrder|cancelOrder|transfer|withdrawal|ExecutionIntent|OrderManager|RiskGuard/u);
  assert.doesNotMatch(source, /BinanceClient|BinanceOrderManager|BinanceRiskGuard|CapitalTestRuntime/u);
});

function payloadFor(url: URL) {
  if (url.hostname === "fapi.binance.com") return binancePayload(url);
  if (url.hostname === "www.okx.com") return okxPayload(url);
  if (url.hostname === "api.bybit.com") return bybitPayload(url);
  if (url.hostname === "api.bitget.com") return bitgetPayload(url);
  throw new Error(`Unexpected URL: ${url.toString()}`);
}

function binancePayload(url: URL) {
  if (url.pathname === "/fapi/v1/exchangeInfo") {
    return {
      symbols: [{
        symbol: "XAUTUSDT",
        contractType: "PERPETUAL",
        status: "TRADING",
        baseAsset: "XAUT",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      }],
    };
  }
  if (url.pathname === "/fapi/v1/premiumIndex") {
    return {
      symbol: "XAUTUSDT",
      markPrice: "4300.6",
      lastFundingRate: "0.0003",
      nextFundingTime: nextFundingAt,
    };
  }
  if (url.pathname === "/fapi/v1/fundingRate") {
    return [{ fundingTime: now }];
  }
  if (url.pathname === "/fapi/v1/ticker/bookTicker") {
    return { symbol: "XAUTUSDT", bidPrice: "4300.5", askPrice: "4300.7" };
  }
  throw new Error(`Unexpected Binance URL: ${url.toString()}`);
}

function okxPayload(url: URL) {
  if (url.pathname === "/api/v5/public/instruments") {
    return {
      code: "0",
      data: [{
        instType: "SWAP",
        instId: "XAUT-USDT-SWAP",
        uly: "XAUT-USDT",
        settleCcy: "USDT",
        ctType: "linear",
        ctVal: "0.01",
        ctValCcy: "XAUT",
        tickSz: "0.01",
        lotSz: "1",
        minSz: "1",
        state: "live",
      }],
    };
  }
  if (url.pathname === "/api/v5/public/funding-rate") {
    return {
      code: "0",
      data: [{
        instType: "SWAP",
        instId: "XAUT-USDT-SWAP",
        fundingRate: "-0.0001",
        fundingTime: String(nextFundingAt),
        nextFundingTime: String(nextFundingAt + 8 * 60 * 60_000),
      }],
    };
  }
  if (url.pathname === "/api/v5/market/ticker") {
    return {
      code: "0",
      data: [{
        instType: "SWAP",
        instId: "XAUT-USDT-SWAP",
        bidPx: "4300.0",
        askPx: "4300.2",
        ts: String(now),
      }],
    };
  }
  throw new Error(`Unexpected OKX URL: ${url.toString()}`);
}

function bybitPayload(url: URL) {
  if (url.pathname === "/v5/market/instruments-info") {
    return {
      retCode: 0,
      result: {
        list: [{
          symbol: "XAUTUSDT",
          contractType: "LinearPerpetual",
          status: "Trading",
          baseCoin: "XAUT",
          quoteCoin: "USDT",
          settleCoin: "USDT",
          priceFilter: { tickSize: "0.01" },
          lotSizeFilter: { minNotionalValue: "5", minOrderQty: "0.001", qtyStep: "0.001" },
        }],
      },
    };
  }
  if (url.pathname === "/v5/market/tickers") {
    return {
      retCode: 0,
      result: {
        list: [{
          symbol: "XAUTUSDT",
          bid1Price: "4300.3",
          ask1Price: "4300.5",
          fundingRate: "0.00005",
          fundingIntervalHour: "8",
          nextFundingTime: String(nextFundingAt),
          markPrice: "4300.4",
        }],
      },
    };
  }
  throw new Error(`Unexpected Bybit URL: ${url.toString()}`);
}

function bitgetPayload(url: URL) {
  if (url.pathname === "/api/v2/mix/market/contracts") {
    return {
      code: "00000",
      data: [{
        symbol: "XAUTUSDT",
        baseCoin: "XAUT",
        quoteCoin: "USDT",
        minTradeNum: "0.001",
        minTradeUSDT: "5",
        priceEndStep: "1",
        pricePlace: "2",
        sizeMultiplier: "0.001",
        symbolType: "perpetual",
        symbolStatus: "normal",
      }],
    };
  }
  if (url.pathname === "/api/v2/mix/market/current-fund-rate") {
    return {
      code: "00000",
      data: {
        symbol: "XAUTUSDT",
        fundingRate: "0.00007",
        fundingRateInterval: "8",
        nextUpdate: String(nextFundingAt),
      },
    };
  }
  if (url.pathname === "/api/v2/mix/market/ticker") {
    return {
      code: "00000",
      data: [{ symbol: "XAUTUSDT", bidPr: "4300.4", askPr: "4300.6" }],
    };
  }
  throw new Error(`Unexpected Bitget URL: ${url.toString()}`);
}
