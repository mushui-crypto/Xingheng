import assert from "node:assert/strict";
import test from "node:test";
import {
  createMonitoredActivityContinuity,
  createUnmonitoredActivityContinuity,
  mergeActivitySnapshot,
  RWA_ACTIVITY_MAX_GAP_MS,
  RWA_ACTIVITY_MAX_PAGES_PER_SOURCE,
} from "./RwaProviderActivityContinuity";
import {
  scanBinancePositionAttribution,
  scanBybitPositionAttribution,
} from "./RwaProviderActivityScanner";

const since = 1_000_000;
const checkedThrough = since + 60_000;

test("Binance scanner reaches a complete empty baseline across every frozen source", async () => {
  const calls: string[] = [];
  const transferTypes: string[] = [];
  const request = async (path: string, params: Record<string, string>) => {
    calls.push(path);
    if (path === "/sapi/v1/asset/transfer") transferTypes.push(params.type);
    return emptyBinance(path);
  };
  const result = await scanBinancePositionAttribution(request, request, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createUnmonitoredActivityContinuity(since),
  });
  assert.equal(result.coverage, "complete");
  assert.equal(result.externalPositionActivity, false);
  assert.equal(result.checkedFrom, since);
  assert.equal(result.checkedThrough, checkedThrough);
  assert.equal(new Set(result.sources.map((item) => item.source)).size, 13);
  assert.equal(calls.length, 32);
  assert.equal(transferTypes.length, 21);
  assert.equal(transferTypes.every(Boolean), true);
  assert.equal(new Set(transferTypes).size, 21);
});

test("Binance scanner follows fromId pagination and classifies strategy orders without external activity", async () => {
  let orderPages = 0;
  const request = async (path: string, params: Record<string, string>) => {
    if (path !== "/api/v3/allOrders") return emptyBinance(path);
    orderPages += 1;
    if (params.orderId) return [];
    return Array.from({ length: 1000 }, (_, index) => ({
      orderId: index + 1,
      clientOrderId: `rwa-owner-${index + 1}`,
      symbol: "XAUTUSDT",
      time: since + index,
    }));
  };
  const result = await scanBinancePositionAttribution(request, request, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createUnmonitoredActivityContinuity(since),
  });
  assert.equal(result.coverage, "complete");
  assert.equal(result.externalPositionActivity, false);
  assert.equal(orderPages, 2);
  assert.equal(result.providerOrderIds.spot.length, 64);
});

test("same-net manual replacement and an event beyond the request cutoff are fail-closed", async () => {
  const replacement = async (path: string) => {
    if (path === "/api/v3/myTrades") {
      return [
        { id: 1, orderId: 8001, symbol: "XAUTUSDT", time: since + 10_000 },
        { id: 2, orderId: 8002, symbol: "XAUTUSDT", time: since + 20_000 },
      ];
    }
    return emptyBinance(path);
  };
  const external = await scanBinancePositionAttribution(replacement, replacement, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(external.coverage, "complete");
  assert.equal(external.externalPositionActivity, true);

  const racing = async (path: string) => path === "/api/v3/myTrades"
    ? [{ id: 3, orderId: 8003, symbol: "XAUTUSDT", time: checkedThrough + 1 }]
    : emptyBinance(path);
  const incomplete = await scanBinancePositionAttribution(racing, racing, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(incomplete.coverage, "incomplete");
});

test("Binance schema changes, source failures, duplicate pages, and the page cap remain incomplete", async () => {
  for (const failure of [
    async (path: string) => path === "/api/v3/myTrades" ? {} : emptyBinance(path),
    async (path: string) => {
      if (path === "/fapi/v1/income") throw new Error("offline timeout fixture");
      return emptyBinance(path);
    },
  ]) {
    const result = await scanBinancePositionAttribution(failure, failure, {
      since,
      checkedThrough,
      strategyOrderPrefixes: ["rwa-owner"],
      continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
    });
    assert.equal(result.coverage, "incomplete");
  }

  let repeatedCalls = 0;
  const repeated = async (path: string) => {
    if (path !== "/api/v3/allOrders") return emptyBinance(path);
    repeatedCalls += 1;
    return Array.from({ length: 1000 }, (_, index) => ({
      orderId: index + 1,
      clientOrderId: `rwa-owner-${index + 1}`,
      symbol: "XAUTUSDT",
      time: since + index,
    }));
  };
  const repeatedResult = await scanBinancePositionAttribution(repeated, repeated, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(repeatedResult.coverage, "incomplete");
  assert.equal(repeatedCalls, 2);

  let cappedCalls = 0;
  const capped = async (path: string, params: Record<string, string>) => {
    if (path !== "/api/v3/allOrders") return emptyBinance(path);
    cappedCalls += 1;
    const first = Number(params.orderId ?? 1);
    return Array.from({ length: 1000 }, (_, index) => ({
      orderId: first + index,
      clientOrderId: `rwa-owner-${first + index}`,
      symbol: "XAUTUSDT",
      time: since + Math.min(first + index, checkedThrough - since),
    }));
  };
  const cappedResult = await scanBinancePositionAttribution(capped, capped, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(cappedResult.coverage, "incomplete");
  assert.equal(cappedCalls, RWA_ACTIVITY_MAX_PAGES_PER_SOURCE);
});

test("transient provider rate limits use bounded backoff before advancing the watermark", async () => {
  let attempts = 0;
  const request = async (path: string) => {
    if (path === "/api/v3/myTrades" && attempts < 2) {
      attempts += 1;
      throw Object.assign(new Error("offline rate limit fixture"), { category: "provider_rate_limited" });
    }
    if (path === "/api/v3/myTrades") attempts += 1;
    return emptyBinance(path);
  };
  const result = await scanBinancePositionAttribution(request, request, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(result.coverage, "complete");
  assert.equal(attempts, 3);
});

test("Binance classifies every frozen non-order XAUT activity family as external", async (context) => {
  const fixtures: Array<[string, (path: string) => unknown]> = [
    ["transfer", (path) => path === "/sapi/v1/asset/transfer"
      ? { rows: [{ tranId: "transfer-1", timestamp: since + 1, asset: "XAUT" }], total: 1 }
      : emptyBinance(path)],
    ["deposit", (path) => path === "/sapi/v1/capital/deposit/hisrec"
      ? [{ id: "deposit-1", insertTime: since + 1, coin: "XAUT", transferType: 0 }]
      : emptyBinance(path)],
    ["withdrawal", (path) => path === "/sapi/v1/capital/withdraw/history"
      ? [{ id: "withdraw-1", applyTime: new Date(since + 1).toISOString(), coin: "XAUT" }]
      : emptyBinance(path)],
    ["convert", (path) => path === "/sapi/v1/convert/tradeFlow"
      ? { list: [{ orderId: "convert-1", createTime: since + 1, fromAsset: "XAUT", toAsset: "USDT" }] }
      : emptyBinance(path)],
    ["dust", (path) => path === "/sapi/v1/asset/dribblet"
      ? {
        userAssetDribblets: [{
          operateTime: since + 1,
          transId: "dust-1",
          userAssetDribbletDetails: [{ fromAsset: "XAUT" }],
        }],
      }
      : emptyBinance(path)],
    ["balance adjustment", (path) => path === "/sapi/v1/asset/assetDividend"
      ? { rows: [{ tranId: "adjust-1", divTime: since + 1, asset: "XAUT" }], total: 1 }
      : emptyBinance(path)],
  ];
  for (const [name, fixture] of fixtures) {
    await context.test(name, async () => {
      const request = async (path: string) => fixture(path);
      const result = await scanBinancePositionAttribution(request, request, {
        since,
        checkedThrough,
        strategyOrderPrefixes: ["rwa-owner"],
        continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
      });
      assert.equal(result.coverage, "complete");
      assert.equal(result.externalPositionActivity, true);
    });
  }
});

test("Bybit cursor pagination is complete, while duplicate cursors and external transfers are ambiguous", async () => {
  let executionPages = 0;
  const completeRequest = async (path: string, params: Record<string, string>) => {
    if (path === "/v5/execution/list" && params.category === "spot") {
      executionPages += 1;
      if (params.cursor === "next") return { list: [], nextPageCursor: "" };
      return {
        list: [{
          execId: "exec-1",
          execTime: since + 1,
          orderId: "order-1",
          orderLinkId: "rwa-owner-s1",
          symbol: "XAUTUSDT",
        }],
        nextPageCursor: "next",
      };
    }
    return emptyBybit(path);
  };
  const complete = await scanBybitPositionAttribution(completeRequest, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(complete.coverage, "complete");
  assert.equal(complete.externalPositionActivity, false);
  assert.equal(executionPages, 2);

  const duplicate = async (path: string) => path === "/v5/order/history"
    ? { list: [], nextPageCursor: "same" }
    : emptyBybit(path);
  const duplicateResult = await scanBybitPositionAttribution(duplicate, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(duplicateResult.coverage, "incomplete");

  const transfer = async (path: string) => path === "/v5/asset/transfer/query-inter-transfer-list"
    ? {
      list: [{ transferId: "manual-1", timestamp: since + 2, coin: "XAUT" }],
      nextPageCursor: "",
    }
    : emptyBybit(path);
  const transferResult = await scanBybitPositionAttribution(transfer, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(transferResult.coverage, "complete");
  assert.equal(transferResult.externalPositionActivity, true);
});

test("Bybit perpetual funding settlement is covered without being misclassified as external position activity", async () => {
  const request = async (path: string) => path === "/v5/account/transaction-log"
    ? {
      list: [{
        id: "settlement-1",
        transactionTime: since + 1,
        type: "SETTLEMENT",
        currency: "USDT",
        symbol: "XAUTUSDT",
      }],
      nextPageCursor: "",
    }
    : emptyBybit(path);
  const result = await scanBybitPositionAttribution(request, {
    since,
    checkedThrough,
    strategyOrderPrefixes: ["rwa-owner"],
    continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
  });
  assert.equal(result.coverage, "complete");
  assert.equal(result.externalPositionActivity, false);
});

test("Bybit schema changes, empty cursor pages, page caps, and dust pagination fail closed or classify activity", async () => {
  const malformed = await scanBybitPositionAttribution(
    async (path) => path === "/v5/account/transaction-log" ? {} : emptyBybit(path),
    {
      since,
      checkedThrough,
      strategyOrderPrefixes: ["rwa-owner"],
      continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
    },
  );
  assert.equal(malformed.coverage, "incomplete");

  const emptyProgress = await scanBybitPositionAttribution(
    async (path) => path === "/v5/order/history"
      ? { list: [], nextPageCursor: "unexpected-next" }
      : emptyBybit(path),
    {
      since,
      checkedThrough,
      strategyOrderPrefixes: ["rwa-owner"],
      continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
    },
  );
  assert.equal(emptyProgress.coverage, "incomplete");

  let cappedCalls = 0;
  const capped = await scanBybitPositionAttribution(
    async (path, params) => {
      if (path !== "/v5/execution/list" || params.category !== "spot") return emptyBybit(path);
      cappedCalls += 1;
      return {
        list: [{
          execId: `exec-${cappedCalls}`,
          execTime: since + cappedCalls,
          orderId: `order-${cappedCalls}`,
          orderLinkId: `rwa-owner-${cappedCalls}`,
          symbol: "XAUTUSDT",
        }],
        nextPageCursor: `cursor-${cappedCalls}`,
      };
    },
    {
      since,
      checkedThrough,
      strategyOrderPrefixes: ["rwa-owner"],
      continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
    },
  );
  assert.equal(capped.coverage, "incomplete");
  assert.equal(cappedCalls, RWA_ACTIVITY_MAX_PAGES_PER_SOURCE);

  let dustCalls = 0;
  const dust = await scanBybitPositionAttribution(
    async (path, params) => {
      if (!path.includes("small-balance-history")) return emptyBybit(path);
      dustCalls += 1;
      if (!params.cursor) {
        return {
          records: [{
            exchangeTxId: "dust-1",
            createdAt: since + 1,
            fromCoin: "XAUT",
            toCoin: "USDT",
          }],
          cursor: "1",
          lastPage: "2",
        };
      }
      return { records: [], cursor: "2", lastPage: "2" };
    },
    {
      since,
      checkedThrough,
      strategyOrderPrefixes: ["rwa-owner"],
      continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
    },
  );
  assert.equal(dust.coverage, "complete");
  assert.equal(dust.externalPositionActivity, true);
  assert.equal(dustCalls, 2);

  let convertCalls = 0;
  const convert = await scanBybitPositionAttribution(
    async (path, params) => {
      if (path !== "/v5/asset/exchange/query-convert-history") return emptyBybit(path);
      convertCalls += 1;
      if (params.index === "2") return { list: [] };
      return {
        list: Array.from({ length: 100 }, (_, index) => ({
          exchangeTxId: `convert-${index}`,
          createdAt: since + index,
          fromCoin: index === 0 ? "USDT" : "BTC",
          toCoin: index === 0 ? "XAUT" : "ETH",
        })),
      };
    },
    {
      since,
      checkedThrough,
      strategyOrderPrefixes: ["rwa-owner"],
      continuity: createMonitoredActivityContinuity(since, "rwa-owner"),
    },
  );
  assert.equal(convert.coverage, "complete");
  assert.equal(convert.externalPositionActivity, true);
  assert.equal(convertCalls, 2);
});

test("continuity becomes permanently ambiguous after an incomplete source or a 24 hour gap", () => {
  const continuity = createMonitoredActivityContinuity(since, "rwa-owner");
  const complete = completeSnapshot(since, checkedThrough);
  const advanced = mergeActivitySnapshot(continuity, complete, ["rwa-owner"], checkedThrough);
  assert.equal(advanced.spot.coverage, "monitored");

  const gapStart = checkedThrough + RWA_ACTIVITY_MAX_GAP_MS + 1;
  const afterGap = mergeActivitySnapshot(
    advanced,
    completeSnapshot(gapStart, gapStart + 1),
    ["rwa-owner"],
    gapStart + 1,
  );
  assert.equal(afterGap.spot.coverage, "ambiguous");
  const recovered = mergeActivitySnapshot(
    afterGap,
    completeSnapshot(gapStart, gapStart + 2),
    ["rwa-owner"],
    gapStart + 2,
  );
  assert.equal(recovered.spot.coverage, "ambiguous");
  assert.equal(recovered.perpetual.coverage, "ambiguous");

  const overlapScan = completeSnapshot(
    advanced.spot.checkedThrough - 5 * 60_000,
    advanced.spot.checkedThrough + RWA_ACTIVITY_MAX_GAP_MS + 1,
  );
  const overlapGap = mergeActivitySnapshot(
    advanced,
    overlapScan,
    ["rwa-owner"],
    overlapScan.checkedThrough,
  );
  assert.equal(overlapGap.spot.coverage, "ambiguous");
  assert.equal(overlapGap.perpetual.coverage, "ambiguous");
});

function completeSnapshot(checkedFrom: number, through: number) {
  const continuity = createUnmonitoredActivityContinuity(checkedFrom);
  const sources = [...new Map(
    [...continuity.spot.sources, ...continuity.perpetual.sources].map((item) => [item.source, item]),
  ).keys()].map((source) => ({
    source,
    coverage: "complete" as const,
    checkedFrom,
    checkedThrough: through,
    cursor: null,
    eventIds: [],
    externalActivity: false,
  }));
  return {
    coverage: "complete" as const,
    externalPositionActivity: false,
    checkedFrom,
    checkedThrough: through,
    sources,
    providerOrderIds: { spot: [], perpetual: [] },
  };
}

function emptyBinance(path: string) {
  if (path === "/sapi/v1/asset/transfer"
    || path === "/sapi/v1/sub-account/universalTransfer"
    || path === "/sapi/v1/asset/assetDividend") return { rows: [], total: 0 };
  if (path === "/sapi/v1/convert/tradeFlow") return { list: [] };
  if (path === "/sapi/v1/asset/dribblet") return { userAssetDribblets: [] };
  return [];
}

function emptyBybit(path: string) {
  if (path.includes("/deposit/") || path.includes("/withdraw/")) return { rows: [], nextPageCursor: "" };
  if (path.includes("small-balance-history")) return { records: [], cursor: "" };
  return { list: [], nextPageCursor: "" };
}
