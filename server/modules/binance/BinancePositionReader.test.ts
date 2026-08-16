import assert from "node:assert/strict";
import test from "node:test";
import { verifyPosition, type ExpectedPosition } from "../cex/position/PositionVerification";
import { BinanceClient } from "./BinanceClient";
import {
  BinancePositionReader,
  type BinancePositionReaderClient,
} from "./BinancePositionReader";
import type { BinancePerpetualPositionSnapshot } from "./BinanceTypes";

const now = 1_800_000_000_000;

test("maps a Binance LONG position to a canonical snapshot", async () => {
  const calls: Array<readonly [string, "long" | "short" | undefined]> = [];
  const reader = new BinancePositionReader(client(async (symbol, side) => {
    calls.push([symbol, side]);
    return { symbol, side: "long", baseQuantity: "1.25", updatedAt: now - 1 };
  }), () => now);

  const snapshot = await reader.readPosition(request({ expectedSide: "LONG" }));

  assert.deepEqual(snapshot, {
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "DOGE-USDT-PERP",
    side: "LONG",
    quantity: "1.25",
    fetchedAt: now - 1,
  });
  assert.deepEqual(calls, [["DOGEUSDT", "long"]]);
  assert.equal(Object.hasOwn(snapshot, "symbol"), false);
});

test("keeps the verified DOGEUSDT SHORT 73 position MATCHED", async () => {
  const reader = new BinancePositionReader(client(async () => ({
    symbol: "DOGEUSDT",
    side: "short",
    baseQuantity: "73",
    updatedAt: now,
  })));

  const snapshot = await reader.readPosition(request({ expectedSide: "SHORT" }));
  const result = verifyPosition(expected({ side: "SHORT", quantity: "73" }), snapshot);

  assert.equal(snapshot.side, "SHORT");
  assert.equal(snapshot.quantity, "73");
  assert.equal(result.status, "MATCHED");
});

test("keeps a closed DOGEUSDT FLAT 0 position MATCHED", async () => {
  const reader = new BinancePositionReader(client(async (_symbol, side) => {
    assert.equal(side, "short");
    return { symbol: "DOGEUSDT", side: "flat", baseQuantity: "0", updatedAt: null };
  }), () => now);

  const snapshot = await reader.readPosition(request({ expectedSide: "SHORT" }));
  const result = verifyPosition(expected({ side: "FLAT", quantity: "0" }), snapshot);

  assert.deepEqual(snapshot, {
    venue: "binance",
    accountId: "binance:account-1",
    instrumentId: "DOGE-USDT-PERP",
    side: "FLAT",
    quantity: "0",
    fetchedAt: now,
  });
  assert.equal(result.status, "MATCHED");
});

test("rejects a Binance symbol that does not match the canonical instrument", async () => {
  const reader = new BinancePositionReader(client(async () => ({
    symbol: "BTCUSDT",
    side: "long",
    baseQuantity: "1",
    updatedAt: now,
  })));

  await assert.rejects(reader.readPosition(request()), /symbol does not match/u);
});

test("converts signed Binance provider quantity to canonical base-asset quantity", async () => {
  const methods: string[] = [];
  const providerClient = new BinanceClient(
    { apiKey: "test-key", apiSecret: "test-secret" },
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(init?.method ?? "GET");
      if (url.pathname === "/api/v3/time") return Response.json({ serverTime: now });
      if (url.pathname === "/fapi/v2/positionRisk") {
        return Response.json([{ symbol: "DOGEUSDT", positionAmt: "-73.00000000", updateTime: now }]);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    }) as typeof fetch,
    () => now,
    ["203.0.113.10"],
  );
  const reader = new BinancePositionReader(providerClient, () => now);

  const snapshot = await reader.readPosition(request({ expectedSide: "SHORT" }));

  assert.equal(snapshot.side, "SHORT");
  assert.equal(snapshot.quantity, "73");
  assert.ok(methods.every((method) => method === "GET"));
});

test("maps a Binance provider read error to UNKNOWN verification", async () => {
  const reader = new BinancePositionReader(client(async () => {
    throw new Error("provider unavailable");
  }));
  const snapshot = await reader.readPosition(request()).catch(() => null);

  const result = verifyPosition(expected(), snapshot);

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "SNAPSHOT_UNAVAILABLE");
});

function client(
  read: (
    symbol: string,
    expectedSide?: "long" | "short",
  ) => Promise<BinancePerpetualPositionSnapshot>,
): BinancePositionReaderClient {
  return { readPerpetualPosition: read };
}

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accountId: "binance:account-1",
    instrumentId: "DOGE-USDT-PERP",
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedPosition> = {}): ExpectedPosition {
  return {
    instrumentId: "DOGE-USDT-PERP",
    side: "LONG",
    quantity: "1",
    tolerance: "0",
    ...overrides,
  };
}
