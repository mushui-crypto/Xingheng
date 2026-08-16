import assert from "node:assert/strict";
import test from "node:test";
import { verifyPosition, type ExpectedPosition } from "../cex/position/PositionVerification";
import { OkxAccountReadClient } from "./OkxAccountReadClient";
import {
  OkxPositionReader,
  type OkxPositionInstrumentBinding,
} from "./OkxPositionReader";

const now = 1_800_000_000_000;
const credentials = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  passphrase: "test-passphrase",
};

test("maps an OKX LONG position to a canonical snapshot", async () => {
  const reader = readerFor([
    row({ pos: "730", posSide: "long" }),
  ]);

  const snapshot = await reader.readPosition(request({ expectedSide: "LONG" }));

  assert.deepEqual(snapshot, {
    venue: "okx",
    accountId: "okx:account-1",
    instrumentId: "DOGE-USDT-PERP",
    side: "LONG",
    quantity: "73",
    fetchedAt: now - 1,
  });
  assert.equal(Object.hasOwn(snapshot, "instId"), false);
  assert.equal(Object.hasOwn(snapshot, "pos"), false);
  assert.equal(Object.hasOwn(snapshot, "ctVal"), false);
});

test("maps an OKX SHORT position to a canonical snapshot", async () => {
  const reader = readerFor([
    row({ pos: "-730", posSide: "net" }),
  ]);

  const snapshot = await reader.readPosition(request({ expectedSide: "SHORT" }));

  assert.equal(snapshot.side, "SHORT");
  assert.equal(snapshot.quantity, "73");
  assert.equal(verifyPosition(expected({ side: "SHORT" }), snapshot).status, "MATCHED");
});

test("maps an empty OKX position response to FLAT zero", async () => {
  const reader = readerFor([]);

  const snapshot = await reader.readPosition(request({ expectedSide: "SHORT" }));

  assert.equal(snapshot.side, "FLAT");
  assert.equal(snapshot.quantity, "0");
  assert.equal(snapshot.fetchedAt, now);
  assert.equal(verifyPosition(expected({ side: "FLAT", quantity: "0" }), snapshot).status, "MATCHED");
});

test("converts OKX contract quantity to base-asset quantity with exact Decimal arithmetic", async () => {
  const reader = readerFor(
    [row({ pos: "3", posSide: "long" })],
    { instId: "DOGE-USDT-SWAP", contractSize: "0.000000000000000001" },
  );

  const snapshot = await reader.readPosition(request({ expectedSide: "LONG" }));

  assert.equal(snapshot.quantity, "0.000000000000000003");
});

test("maps an OKX provider failure to UNKNOWN verification", async () => {
  const reader = new OkxPositionReader(
    clientFor([], 503),
    resolver({ instId: "DOGE-USDT-SWAP", contractSize: "0.1" }),
    () => now,
  );
  const snapshot = await reader.readPosition(request()).catch(() => null);

  const result = verifyPosition(expected(), snapshot);

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "SNAPSHOT_UNAVAILABLE");
});

test("fails closed when OKX instrument mapping is unavailable", async () => {
  const reader = new OkxPositionReader(
    clientFor([]),
    { resolve: () => null },
    () => now,
  );

  await assert.rejects(reader.readPosition(request()), /mapping is unavailable/u);
});

test("fails closed when the OKX provider instrument does not match", async () => {
  const reader = readerFor([
    row({ instId: "BTC-USDT-SWAP", pos: "730", posSide: "long" }),
  ]);

  await assert.rejects(reader.readPosition(request()), /instrument does not match/u);
});

test("fails closed when OKX position direction is unknown", async () => {
  const reader = readerFor([
    row({ pos: "730", posSide: "mystery" }),
  ]);

  await assert.rejects(reader.readPosition(request()), /side is unknown/u);
});

test("fails closed when multiple OKX position rows are ambiguous", async () => {
  const reader = readerFor([
    row({ pos: "730", posSide: "long" }),
    row({ pos: "10", posSide: "long" }),
  ]);

  await assert.rejects(reader.readPosition(request({ expectedSide: "LONG" })), /multiple non-zero/u);
});

function readerFor(
  rows: readonly Record<string, unknown>[],
  binding: OkxPositionInstrumentBinding = { instId: "DOGE-USDT-SWAP", contractSize: "0.1" },
) {
  return new OkxPositionReader(clientFor(rows), resolver(binding), () => now);
}

function clientFor(rows: readonly Record<string, unknown>[], status = 200) {
  return new OkxAccountReadClient(credentials, {
    baseUrl: "https://okx.example.test",
    now: () => now,
    fetchImpl: (async () => status === 200
      ? Response.json({ code: "0", data: rows })
      : new Response("unavailable", { status })) as typeof fetch,
  });
}

function resolver(binding: OkxPositionInstrumentBinding) {
  return {
    resolve: async (instrumentId: string) => {
      assert.equal(instrumentId, "DOGE-USDT-PERP");
      return binding;
    },
  };
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    instId: "DOGE-USDT-SWAP",
    pos: "730",
    posSide: "long",
    uTime: String(now - 1),
    ...overrides,
  };
}

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accountId: "okx:account-1",
    instrumentId: "DOGE-USDT-PERP",
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedPosition> = {}): ExpectedPosition {
  return {
    instrumentId: "DOGE-USDT-PERP",
    side: "LONG",
    quantity: "73",
    tolerance: "0",
    ...overrides,
  };
}
