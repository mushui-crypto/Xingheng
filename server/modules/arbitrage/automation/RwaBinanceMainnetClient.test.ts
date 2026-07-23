import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { RwaBinanceMainnetClient, RwaBinanceProviderError } from "./RwaBinanceMainnetClient";

test("Binance client signs private reads with server-time offset and keeps spot/futures balances isolated", async () => {
  const calls: Array<{ path: string; signed: boolean; timestamp: string | null }> = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ calls }),
    () => 1_000,
  );

  const access = await client.validateAccess();
  assert.equal(access.accountId.startsWith("binance:"), true);
  assert.equal(access.accountMode, "single_asset_one_way");
  assert.deepEqual(access.permissions, {
    read: true,
    spotTrade: true,
    contractTrade: true,
    withdraw: false,
    ipRestricted: true,
    spotAccount: true,
    futuresAccount: true,
    positionModeSupported: true,
  });
  assert.equal(calls.filter((item) => item.signed).length, 4);
  assert.ok(calls.filter((item) => item.signed).every((item) => item.timestamp === "2000"));

  const snapshot = await client.readPreflightSnapshot();
  assert.equal(snapshot.productAvailability.available, true);
  assert.equal(snapshot.spotAvailableUsdt, 18);
  assert.equal(snapshot.futuresAvailableUsdt, 17);
  assert.equal(snapshot.spot.qtyStep, 0.0001);
  assert.equal(snapshot.spot.minNotionalUsd, 5);
  assert.equal(snapshot.perpetual.qtyStep, 0.001);
  assert.equal(snapshot.perpetual.minNotionalUsd, 5);
  assert.equal(snapshot.perpetual.fundingIntervalHours, 4);
  assert.equal(snapshot.spot.depthUsd > 8, true);
  assert.equal(snapshot.perpetual.depthUsd > 8, true);
});

test("Binance client reports missing real products without substituting another symbol", async () => {
  const calls: Array<{ path: string; signed: boolean; timestamp: string | null }> = [];
  const client = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ missingSpot: true, calls }),
    () => 1_000,
  );

  const availability = await client.readProductAvailability();
  await client.readProductAvailability();
  assert.deepEqual(availability, {
    available: false,
    status: "spot_unavailable",
    spotSymbol: "XAUTUSDT",
    perpetualSymbol: "XAUTUSDT",
    checkedAt: 1_000,
    message: "Binance Mainnet 当前没有可用的 XAUTUSDT 现货产品。",
  });
  assert.equal(calls.filter((item) => item.path === "/api/v3/exchangeInfo").length, 1);
  assert.equal(calls.filter((item) => item.path === "/fapi/v1/exchangeInfo").length, 1);
});

test("Binance permission and provider errors are fail-closed and never echo raw secrets", async () => {
  const withdrawalClient = new RwaBinanceMainnetClient(
    { apiKey: "fake-key", apiSecret: "fake-secret" },
    fixtureFetch({ withdrawalsEnabled: true }),
    () => 1_000,
  );
  assert.equal((await withdrawalClient.validateAccess()).permissions.withdraw, true);

  const failingClient = new RwaBinanceMainnetClient(
    { apiKey: "visible-key", apiSecret: "never-echo-this" },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") return json({ serverTime: 2_000 });
      return json({ code: -2015, msg: "never-echo-this https://private.invalid/path" }, 401);
    },
    () => 1_000,
  );
  await assert.rejects(
    failingClient.validateAccess(),
    (error: unknown) => {
      assert.ok(error instanceof RwaBinanceProviderError);
      assert.equal(error.category, "provider_credential_invalid");
      assert.equal(error.message.includes("never-echo-this"), false);
      assert.equal(error.message.includes("private.invalid"), false);
      return true;
    },
  );
});

function fixtureFetch(options: {
  calls?: Array<{ path: string; signed: boolean; timestamp: string | null }>;
  missingSpot?: boolean;
  withdrawalsEnabled?: boolean;
} = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method ?? "GET", "GET");
    const signed = Boolean(init?.headers && new Headers(init.headers).get("X-MBX-APIKEY"));
    options.calls?.push({ path: url.pathname, signed, timestamp: url.searchParams.get("timestamp") });
    if (signed) {
      assert.equal(new Headers(init?.headers).get("X-MBX-APIKEY"), "fake-key");
      const signature = url.searchParams.get("signature");
      assert.ok(signature);
      url.searchParams.delete("signature");
      assert.equal(signature, createHmac("sha256", "fake-secret").update(url.searchParams.toString()).digest("hex"));
    }
    switch (url.pathname) {
      case "/api/v3/time":
        return json({ serverTime: 2_000 });
      case "/sapi/v1/account/apiRestrictions":
        return json({
          enableReading: true,
          enableSpotAndMarginTrading: true,
          enableFutures: true,
          enableWithdrawals: Boolean(options.withdrawalsEnabled),
          ipRestrict: true,
        });
      case "/api/v3/account":
        return json({
          uid: 42,
          canTrade: true,
          balances: [
            { asset: "USDT", free: "18", locked: "0" },
            { asset: "XAUT", free: "0", locked: "0" },
          ],
        });
      case "/fapi/v2/account":
        return json({
          canTrade: true,
          multiAssetsMargin: false,
          availableBalance: "17",
          assets: [{ asset: "USDT", availableBalance: "17" }],
        });
      case "/fapi/v1/positionSide/dual":
        return json({ dualSidePosition: false });
      case "/api/v3/exchangeInfo":
        return json({
          symbols: options.missingSpot ? [] : [{
            symbol: "XAUTUSDT",
            status: "TRADING",
            baseAsset: "XAUT",
            quoteAsset: "USDT",
            isSpotTradingAllowed: true,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001" },
              { filterType: "NOTIONAL", minNotional: "5" },
            ],
          }],
        });
      case "/fapi/v1/exchangeInfo":
        return json({
          symbols: [{
            symbol: "XAUTUSDT",
            status: "TRADING",
            contractType: "PERPETUAL",
            baseAsset: "XAUT",
            quoteAsset: "USDT",
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "LOT_SIZE", minQty: "0.001", stepSize: "0.001" },
              { filterType: "MIN_NOTIONAL", notional: "5" },
            ],
          }],
        });
      case "/sapi/v1/asset/tradeFee":
        return json([{ symbol: "XAUTUSDT", takerCommission: "0.001" }]);
      case "/fapi/v1/commissionRate":
        return json({ symbol: "XAUTUSDT", takerCommissionRate: "0.0005" });
      case "/fapi/v2/positionRisk":
      case "/api/v3/openOrders":
      case "/fapi/v1/openOrders":
        return json([]);
      case "/api/v3/ticker/bookTicker":
        return json({ bidPrice: "4129", askPrice: "4130" });
      case "/fapi/v1/ticker/bookTicker":
        return json({ bidPrice: "4128", askPrice: "4129" });
      case "/fapi/v1/premiumIndex":
        return json({ markPrice: "4128.5", lastFundingRate: "0.0001", nextFundingTime: 5_000 });
      case "/fapi/v1/fundingInfo":
        return json([{ symbol: "XAUTUSDT", fundingIntervalHours: 4 }]);
      case "/api/v3/depth":
        return json({ bids: [["4129", "0.01"]], asks: [["4130", "0.01"]] });
      case "/fapi/v1/depth":
        return json({ bids: [["4128", "0.01"]], asks: [["4129", "0.01"]] });
      default:
        return json({ code: -1 }, 404);
    }
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
