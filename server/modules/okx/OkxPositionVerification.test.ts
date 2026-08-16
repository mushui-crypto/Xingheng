import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { OkxPositionVerification } from "./OkxPositionVerification";
import type { OkxAccountIdentity, OkxPerpetualPosition } from "./OkxTypes";

const now = 1_800_000_000_000;

test("matches a confirmed OKX LONG position", async () => {
  const client = new FakePositionClient([position("long", "12.5")]);
  const result = await verifier(client).verifyOpen(record(), intent("buy", "12.5"));
  assert.equal(result.status, "MATCHED");
  assert.equal(result.observedPosition?.side, "long");
  assert.equal(result.providerMutations, 0);
});

test("matches a confirmed OKX SHORT position", async () => {
  const client = new FakePositionClient([position("short", "12.5000")]);
  const result = await verifier(client).verifyOpen(record(), intent("sell", "12.5"));
  assert.equal(result.status, "MATCHED");
});

test("matches a confirmed reduceOnly close when position is zero", async () => {
  const client = new FakePositionClient([position("flat", "0")]);
  const result = await verifier(client).verifyClose(record(), intent("sell", "12.5"));
  assert.equal(result.status, "MATCHED");
});

test("returns MISMATCH for direction mismatch", async () => {
  const result = await verifier(new FakePositionClient([position("short", "12.5")]))
    .verifyOpen(record(), intent("buy", "12.5"));
  assert.equal(result.status, "MISMATCH");
  assert.match(result.reason, /direction/u);
});

test("returns MISMATCH for quantity mismatch", async () => {
  const result = await verifier(new FakePositionClient([position("long", "11")]))
    .verifyOpen(record(), intent("buy", "12.5"));
  assert.equal(result.status, "MISMATCH");
  assert.match(result.reason, /quantity/u);
});

test("returns UNKNOWN when provider position read fails", async () => {
  const result = await verifier(new FakePositionClient([], new Error("provider unavailable")))
    .verifyOpen(record(), intent("buy", "12.5"));
  assert.equal(result.status, "UNKNOWN");
  assert.match(result.reason, /provider unavailable/u);
});

test("returns UNKNOWN for account identity mismatch and mapping failure", async () => {
  const accountMismatch = await verifier(new FakePositionClient([position("long", "12.5")], undefined, "okx:other"))
    .verifyOpen(record(), intent("buy", "12.5"));
  assert.equal(accountMismatch.status, "UNKNOWN");
  const mappingFailure = await verifier(new FakePositionClient([position("long", "12.5")]))
    .verifyOpen(record("BTC-USDT-PERP"), intent("buy", "12.5", "BTC-USDT-PERP"));
  assert.equal(mappingFailure.status, "UNKNOWN");
});

test("does not treat a mismatched provider instrument as a successful close", async () => {
  const wrongInstrument = { ...position("flat", "0"), instId: "BTC-USDT-SWAP" };
  const result = await verifier(new FakePositionClient([wrongInstrument]))
    .verifyClose(record(), intent("sell", "12.5"));
  assert.equal(result.status, "UNKNOWN");
  assert.match(result.reason, /instrument identity/u);
});

class FakePositionClient {
  readonly mutations = 0;
  constructor(
    private readonly positions: readonly OkxPerpetualPosition[],
    private readonly failure?: Error,
    private readonly accountId = "okx:account-1",
  ) {}

  async getAccountIdentity(): Promise<OkxAccountIdentity> {
    return { accountId: this.accountId, accountFingerprint: "fingerprint", uidHash: "uid-hash", accountLevel: "1" };
  }

  async getPosition(_instId: string) {
    if (this.failure) throw this.failure;
    return this.positions;
  }
}

function verifier(client: FakePositionClient) {
  return new OkxPositionVerification({
    read: async ({ instId }) => Object.freeze({
      account: await client.getAccountIdentity(),
      positions: await client.getPosition(instId),
      instId,
    }),
  });
}

function record(instrumentId = "DOGE-USDT-PERP") {
  return createExecutionRecord({
    executionId: "execution-position-1",
    intentId: "intent-position-1",
    executionAttemptId: "intent-position-1",
    userId: "user-1",
    venue: "okx",
    accountId: "okx:account-1",
    instrumentId,
    status: "CONFIRMED",
    remoteOrderId: "9001",
    createdAt: now,
    updatedAt: now,
  });
}

function intent(side: "buy" | "sell", quantity: string, instrumentId = "DOGE-USDT-PERP") {
  return createExecutionIntent({
    intentId: "intent-position-1",
    userId: "user-1",
    venue: "okx",
    accountId: "okx:account-1",
    instrumentId,
    side,
    quantity: { asset: { symbol: instrumentId.split("-")[0]!, type: "DIGITAL_ASSET" }, quantity },
    orderConstraints: { reduceOnly: side === "buy" ? false : true },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

function position(side: OkxPerpetualPosition["side"], quantity: string): OkxPerpetualPosition {
  return {
    instId: "DOGE-USDT-SWAP",
    side,
    quantity,
    averagePrice: "0.123",
    markPrice: "0.123",
    liquidationPrice: null,
    updatedAt: now,
  };
}
