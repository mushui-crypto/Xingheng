import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { registerUserAuthMiddleware } from "../../auth/authRoutes";
import { registerStrategyRoutes } from "../../api/strategyRoutes";
import { readStrategyCandles, type StrategyCandlesCache } from "./StrategyCandlesService";

const NOW = Date.parse("2026-07-15T12:09:00.000Z");

test("strategy candles route rejects unauthenticated requests", async () => {
  const app = express();
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/strategy/ict/candles`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "用户未登录或登录已失效。" });
    const martingale = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api/strategy/martingale/candles?symbol=ETHUSDT`);
    assert.equal(martingale.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("strategy candles route is covered by user auth middleware", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse([latestClosedKline()])) as typeof fetch;
  const app = express();
  registerUserAuthMiddleware(app, {
    authenticate: (token: string | null | undefined) => {
      if (token === "valid-token") {
        return { id: "USR-test", email: "test@example.com", nickname: "Test", status: "active", createdAt: "2026-07-15T00:00:00.000Z", emailVerifiedAt: "2026-07-15T00:00:00.000Z" };
      }
      if (token === "disabled-token") {
        return { id: "USR-disabled", email: "disabled@example.com", nickname: "Disabled", status: "disabled", createdAt: "2026-07-15T00:00:00.000Z", emailVerifiedAt: "2026-07-15T00:00:00.000Z" };
      }
      return null;
    },
  } as any);
  registerStrategyRoutes(app, { getStatus: () => ({ ok: true }) } as any);
  const server = app.listen(0);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
    const status = await previousFetch(`${baseUrl}/api/strategy/ict/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true });

    const unauthenticated = await previousFetch(`${baseUrl}/api/strategy/ict/candles`);
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { message: "用户未登录或登录已失效。" });

    const authenticated = await previousFetch(`${baseUrl}/api/strategy/ict/candles?limit=1`, {
      headers: { authorization: "Bearer valid-token" },
    });
    assert.equal(authenticated.status, 200);
    const body = await authenticated.json() as any;
    assert.equal(body.status, "available");
    assert.equal(body.candles.length, 1);

    const martingaleEth = await previousFetch(`${baseUrl}/api/strategy/martingale/candles?symbol=ETHUSDT&limit=1`, {
      headers: { authorization: "Bearer valid-token" },
    });
    assert.equal(martingaleEth.status, 200);
    assert.equal((await martingaleEth.json() as any).symbol, "ETHUSDT");

    const disabled = await previousFetch(`${baseUrl}/api/strategy/ict/candles?limit=1`, {
      headers: { authorization: "Bearer disabled-token" },
    });
    assert.equal(disabled.status, 403);
    assert.deepEqual(await disabled.json(), { message: "账号已禁用，请联系管理员。" });
  } finally {
    globalThis.fetch = previousFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("strategy candles normalize, sort, de-duplicate and return only closed candles", async () => {
  const calls: URL[] = [];
  const fetchFn = async (input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    calls.push(url);
    return jsonResponse([
      kline("2026-07-15T12:05:00.000Z", "70000", "70100", "69900", "70050", "9"), // still open at NOW
      kline("2026-07-15T11:55:00.000Z", "68000", "68100", "67900", "68050", "3"),
      kline("2026-07-15T11:50:00.000Z", "67000", "67100", "66900", "67050", "2"),
      kline("2026-07-15T11:55:00.000Z", "68200", "68300", "68100", "68250", "4"),
      kline("2026-07-15T12:00:00.000Z", "69000", "69100", "68900", "69050", "5"),
      kline("2026-07-15T11:45:00.000Z", "1", "0", "1", "1", "1"), // invalid
    ]);
  };

  const result = await readStrategyCandles({
    interval: "5m",
    from: "2026-07-15T11:50:00.000Z",
    to: "2026-07-15T12:05:00.000Z",
    limit: "10",
  }, { now: () => NOW, fetchFn: fetchFn as typeof fetch, cache: new Map() });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.report.source, "binance_usdm");
  assert.equal(result.report.symbol, "BTCUSDT");
  assert.equal(result.report.interval, "5m");
  assert.equal(result.report.status, "available");
  assert.deepEqual(result.report.candles.map((item) => item.time), [
    Date.parse("2026-07-15T11:50:00.000Z") / 1000,
    Date.parse("2026-07-15T11:55:00.000Z") / 1000,
    Date.parse("2026-07-15T12:00:00.000Z") / 1000,
  ]);
  assert.equal(result.report.candles[1].close, 68250);
  assert.equal(result.report.dataThrough, "2026-07-15T12:00:00.000Z");
  assert.equal(calls[0].searchParams.get("symbol"), "BTCUSDT");
  assert.equal(calls[0].searchParams.get("interval"), "5m");
  assert.equal(calls[0].searchParams.get("limit"), "10");
});

test("strategy candles support official 15m, 1h and 4h intervals", async () => {
  const intervals = ["15m", "1h", "4h"] as const;
  for (const interval of intervals) {
    let requestedInterval: string | null = null;
    const fetchFn = async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      requestedInterval = url.searchParams.get("interval");
      return jsonResponse([kline("2026-07-15T04:00:00.000Z", "1", "2", "1", "2", "10")]);
    };
    const result = await readStrategyCandles({ interval, from: "2026-07-15T04:00:00.000Z", to: "2026-07-15T08:00:00.000Z" }, {
      now: () => NOW,
      fetchFn: fetchFn as typeof fetch,
      cache: new Map(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.report.interval, interval);
    assert.equal(requestedInterval, interval);
  }
});

test("martingale candles support ETHUSDT without sharing the BTC cache key", async () => {
  const cache: StrategyCandlesCache = new Map();
  const symbols: string[] = [];
  const fetchFn = async (input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    symbols.push(url.searchParams.get("symbol") ?? "");
    return jsonResponse([kline("2026-07-15T12:00:00.000Z", "3000", "3010", "2990", "3005", "12")]);
  };
  const query = { interval: "5m", from: "2026-07-15T12:00:00.000Z", to: "2026-07-15T12:00:00.000Z", limit: "1" };
  const eth = await readStrategyCandles({ ...query, symbol: "ETHUSDT" }, { now: () => NOW, fetchFn: fetchFn as typeof fetch, cache });
  const btc = await readStrategyCandles({ ...query, symbol: "BTCUSDT" }, { now: () => NOW, fetchFn: fetchFn as typeof fetch, cache });
  assert.equal(eth.report.symbol, "ETHUSDT");
  assert.equal(btc.report.symbol, "BTCUSDT");
  assert.deepEqual(symbols, ["ETHUSDT", "BTCUSDT"]);
});

test("strategy candles support old historical windows and cap large limits", async () => {
  let requestedStartTime: string | null = null;
  let requestedLimit: string | null = null;
  const fetchFn = async (input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    requestedStartTime = url.searchParams.get("startTime");
    requestedLimit = url.searchParams.get("limit");
    return jsonResponse([kline("2024-01-01T00:00:00.000Z", "42000", "42100", "41900", "42050", "12.345678")]);
  };
  const result = await readStrategyCandles({
    interval: "1h",
    from: "2024-01-01T00:00:00.000Z",
    to: "2024-01-02T00:00:00.000Z",
    limit: "5000",
  }, { now: () => NOW, fetchFn: fetchFn as typeof fetch, cache: new Map() });

  assert.equal(result.ok, true);
  assert.equal(requestedStartTime, String(Date.parse("2024-01-01T00:00:00.000Z")));
  assert.equal(requestedLimit, "1000");
  assert.equal(result.report.candles[0].volume, 12.345678);
});

test("strategy candles reject historical requests that would require multi-year downloads", async () => {
  const result = await readStrategyCandles({
    interval: "4h",
    from: "2024-01-01T00:00:00.000Z",
    to: "2026-07-15T00:00:00.000Z",
  }, { now: () => NOW, fetchFn: neverFetch as typeof fetch, cache: new Map() });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.report.warnings, ["max_window_exceeded"]);
});

test("strategy candles validate interval, range, limit and maximum window", async () => {
  const cases = [
    [{ symbol: "SOLUSDT" }, "invalid_symbol"],
    [{ interval: "1m" }, "invalid_interval"],
    [{ from: "bad" }, "invalid_from"],
    [{ from: "2026-07-15T12:00:00.000Z", to: "2026-07-15T11:00:00.000Z" }, "invalid_range"],
    [{ limit: "0" }, "invalid_limit"],
    [{ interval: "5m", from: "2026-07-01T00:00:00.000Z", to: "2026-07-15T00:00:00.000Z" }, "max_window_exceeded"],
  ] as const;
  for (const [query, warning] of cases) {
    const result = await readStrategyCandles(query, { now: () => NOW, fetchFn: neverFetch as typeof fetch, cache: new Map() });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.report.warnings, [warning]);
    assert.equal(result.report.status, "unavailable");
  }
});

test("strategy candles return safe unavailable response for Binance timeout, 429 and empty data", async () => {
  const failing = await readStrategyCandles({}, {
    now: () => NOW,
    fetchFn: (async () => { throw new Error("timeout /tmp/internal"); }) as typeof fetch,
    cache: new Map(),
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.statusCode, 503);
  assert.deepEqual(failing.report.warnings, ["binance_candles_unavailable"]);
  assert.equal(failing.report.candles.length, 0);

  const limited = await readStrategyCandles({}, {
    now: () => NOW,
    fetchFn: (async () => jsonResponse([], 429)) as typeof fetch,
    cache: new Map(),
  });
  assert.equal(limited.statusCode, 503);
  assert.deepEqual(limited.report.warnings, ["binance_candles_unavailable"]);

  const empty = await readStrategyCandles({}, {
    now: () => NOW,
    fetchFn: (async () => jsonResponse([])) as typeof fetch,
    cache: new Map(),
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.report.warnings, ["empty_data"]);
});

test("strategy candles cache and de-duplicate identical in-flight requests", async () => {
  const cache: StrategyCandlesCache = new Map();
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jsonResponse([kline("2026-07-15T12:00:00.000Z", "1", "2", "1", "2", "1")]);
  };
  const query = { interval: "5m", from: "2026-07-15T12:00:00.000Z", to: "2026-07-15T12:00:00.000Z", limit: "1" };
  const [first, second] = await Promise.all([
    readStrategyCandles(query, { now: () => NOW, fetchFn: fetchFn as typeof fetch, cache }),
    readStrategyCandles(query, { now: () => NOW, fetchFn: fetchFn as typeof fetch, cache }),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(calls, 1);

  const third = await readStrategyCandles(query, { now: () => NOW + 1_000, fetchFn: fetchFn as typeof fetch, cache });
  assert.equal(third.statusCode, 200);
  assert.equal(calls, 1);
});

function kline(openTimeIso: string, open: string, high: string, low: string, close: string, volume: string) {
  return [
    Date.parse(openTimeIso),
    open,
    high,
    low,
    close,
    volume,
  ];
}

function latestClosedKline() {
  const intervalMs = 5 * 60 * 1000;
  const openTime = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;
  return [openTime, "69000", "69100", "68900", "69050", "5"];
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function neverFetch(): Promise<Response> {
  throw new Error("fetch should not be called");
}
