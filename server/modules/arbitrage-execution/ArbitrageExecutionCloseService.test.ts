import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAsset } from "../cex/Asset";
import { managedCurrentQuantity } from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { createTradingRules } from "../cex/TradingRules";
import type { FormalArbitrageExecutionRuntime } from "./ArbitrageExecutionCommandService";
import {
  ArbitrageExecutionCloseError,
  ArbitrageExecutionCloseService,
} from "./ArbitrageExecutionCloseService";

const now = 1_900_000_000_000;

test("LONG perpetual close is authoritative SELL reduceOnly and decreases managed quantity", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "0.4";

  const result = await fixture.service.closeLeg("user-a", request("long-leg", "0.4"));

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.side, "sell");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, true);
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "0.4");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.4");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "1");
  assert.equal(result.instance.executionReferences.at(-1)?.phase, "CLOSING");
  assert.equal(result.instance.executionReferences.at(-1)?.quantityEffect, "DECREASE");
  assert.equal(result.instance.status, "RESIDUAL");
});

test("SHORT perpetual close is authoritative BUY reduceOnly", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "1";

  const result = await fixture.service.closeLeg("user-a", request("short-leg", "1"));

  assert.equal(fixture.runtime.calls[0]?.side, "buy");
  assert.equal(fixture.runtime.calls[0]?.orderConstraints.reduceOnly, true);
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "1");
  assert.notEqual(result.instance.status, "CLOSED", "one flat leg must not close the two-leg instance");
});

test("both fully closed legs reach CLOSED without deleting the instance", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "1";
  await fixture.service.closeLeg("user-a", request("long-leg", "1", "close-long"));
  const closed = await fixture.service.closeLeg("user-a", request("short-leg", "1", "close-short"));

  assert.equal(closed.instance.status, "CLOSED");
  assert.equal(closed.instance.legs[0].confirmedClosedQuantity, "1");
  assert.equal(closed.instance.legs[1].confirmedClosedQuantity, "1");
  assert.ok(fixture.store.get("user-a", fixture.arbitrageId));
});

test("partial and UNKNOWN close retain Decimal evidence and remain reconcilable", async (t) => {
  const partial = setup(t);
  partial.runtime.resultStatus = "PENDING_CONFIRMATION";
  partial.runtime.confirmedQuantity = "0.12345678";
  const partialResult = await partial.service.closeLeg("user-a", request("long-leg", "0.5"));
  assert.equal(partialResult.executionRecord.confirmedQuantity, "0.12345678");
  assert.equal(partialResult.instance.legs[0].confirmedClosedQuantity, "0.12345678");
  assert.equal(partialResult.instance.status, "CLOSING");

  const unknown = setup(t);
  unknown.runtime.resultStatus = "UNKNOWN";
  unknown.runtime.confirmedQuantity = null;
  const unknownResult = await unknown.service.closeLeg("user-a", request("long-leg", "0.5"));
  assert.equal(unknownResult.executionRecord.status, "UNKNOWN");
  assert.equal(unknownResult.instance.legs[0].confirmedClosedQuantity, "0");
  assert.equal(unknownResult.instance.executionReferences.at(-1)?.status, "UNKNOWN");
});

test("real position, managed quantity, flat state, and exact trading rules fail closed", async (t) => {
  const tooLarge = setup(t);
  await assert.rejects(
    () => tooLarge.service.closeLeg("user-a", request("long-leg", "1.1")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_quantity_unavailable",
  );

  const mismatch = setup(t);
  mismatch.verificationStatus = "MISMATCH";
  await assert.rejects(
    () => mismatch.service.closeLeg("user-a", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "position_verification_unavailable",
  );

  const flat = setup(t);
  flat.actualQuantity = "0";
  await assert.rejects(
    () => flat.service.closeLeg("user-a", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "position_verification_unavailable",
  );

  const invalidStep = setup(t);
  await assert.rejects(
    () => invalidStep.service.closeLeg("user-a", request("long-leg", "0.00015")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_quantity_unavailable",
  );
  assert.equal(tooLarge.runtime.calls.length + mismatch.runtime.calls.length + flat.runtime.calls.length + invalidStep.runtime.calls.length, 0);
});

test("client cannot control side, reduceOnly, account, provider symbol, or another user's instance", async (t) => {
  const fixture = setup(t);
  for (const field of ["side", "reduceOnly", "accountId", "providerSymbol", "userId"]) {
    await assert.rejects(
      () => fixture.service.closeLeg("user-a", { ...request("long-leg", "0.5"), [field]: "malicious" }),
      /不允许的字段/u,
    );
  }
  await assert.rejects(
    () => fixture.service.closeLeg("user-b", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "arbitrage_instance_not_found",
  );
  assert.equal(fixture.runtime.calls.length, 0);
});

test("Spot and unsupported venues fail closed before provider mutation", async (t) => {
  const spot = setup(t, { longInstrumentId: "BTC-USDT-SPOT" });
  await assert.rejects(
    () => spot.service.closeLeg("user-a", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "spot_close_not_yet_wired",
  );
  const venue = setup(t, { longVenue: "okx" });
  await assert.rejects(
    () => venue.service.closeLeg("user-a", request("long-leg", "0.5")),
    (error) => error instanceof ArbitrageExecutionCloseError && error.category === "close_capability_unavailable",
  );
  assert.equal(spot.runtime.calls.length + venue.runtime.calls.length, 0);
});

test("duplicate and concurrent close commands cause one runtime mutation", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "0.5";
  fixture.runtime.delay = true;
  const close = request("long-leg", "0.5");
  const [first, replay] = await Promise.all([
    fixture.service.closeLeg("user-a", close),
    fixture.service.closeLeg("user-a", close),
  ]);

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal([first.idempotentReplay, replay.idempotentReplay].filter(Boolean).length, 1);
  assert.equal(fixture.store.get("user-a", fixture.arbitrageId)?.legs[0].confirmedClosedQuantity, "0.5");
  const third = await fixture.service.closeLeg("user-a", close);
  assert.equal(third.idempotentReplay, true);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("concurrent distinct commands cannot claim overlapping closes for the same leg", async (t) => {
  const fixture = setup(t);
  fixture.runtime.resultStatus = "CONFIRMED";
  fixture.runtime.confirmedQuantity = "0.5";
  fixture.runtime.delay = true;
  const outcomes = await Promise.allSettled([
    fixture.service.closeLeg("user-a", request("long-leg", "0.5", "close-a")),
    fixture.service.closeLeg("user-a", request("long-leg", "0.5", "close-b")),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.store.get("user-a", fixture.arbitrageId)?.legs[0].confirmedClosedQuantity, "0.5");
});

function setup(
  t: TestContext,
  options: Readonly<{
    longInstrumentId?: "BTC-USDT-SPOT" | "BTC-USDT-PERP";
    longVenue?: "binance" | "okx";
  }> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "stellax-close-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ArbitrageInstanceStore({ dbPath: join(directory, "trading.sqlite") });
  const arbitrageId = "arbitrage-close-1";
  store.create({
    arbitrageId,
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "source-1",
    maxResidualBaseQuantity: "0",
    createdAt: now - 20,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: options.longVenue ?? "binance",
        accountId: "account-a",
        instrumentId: options.longInstrumentId ?? "BTC-USDT-PERP",
        plannedQuantity: "1",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "account-a",
        instrumentId: "BTC-USDT-PERP",
        plannedQuantity: "1",
      },
    ],
  });
  openLeg(store, arbitrageId, "long-leg", now - 18);
  openLeg(store, arbitrageId, "short-leg", now - 14);

  const runtime = new FakeRuntime();
  const fixture = {
    verificationStatus: "MATCHED" as "MATCHED" | "MISMATCH" | "UNKNOWN",
    actualQuantity: "1" as string | null,
  };
  let closeClock = now;
  const service = new ArbitrageExecutionCloseService(
    store,
    {
      verify: async () => {
        const current = store.get("user-a", arbitrageId)!;
        return {
          arbitrageId,
          checkedAt: now,
          legs: current.legs.map((leg) => ({
            arbitrageId,
            legId: leg.legId,
            expectedManagedQuantity: managedCurrentQuantity(leg),
            actualQuantity: fixture.actualQuantity,
            verificationStatus: fixture.verificationStatus,
            checkedAt: now,
          })) as any,
        };
      },
    },
    {
      load: async (_venue, instrumentId) => ({
        instrument: {
          instrumentId,
          providerSymbol: "BTCUSDT",
          baseAsset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }),
          quoteAsset: "USDT",
          settlementAsset: "USDT",
          marketType: instrumentId.endsWith("-SPOT") ? "spot" : "perpetual",
          contractType: instrumentId.endsWith("-SPOT") ? "spot" : "linear_perpetual",
          quantityUnit: "base",
          status: "trading",
        },
        tradingRules: createTradingRules({
          quantityStep: "0.0001",
          minQuantity: "0.0001",
          priceTick: "0.01",
          minNotional: "1",
          contractSize: "1",
          precision: { quantity: 4, price: 2 },
        }),
        quote: { bid: "60000", ask: "60001", fetchedAt: now },
      }),
    },
    runtime,
    { clock: () => closeClock += 10, createIntentId: (_user, _arbitrage, leg, command) => `close-${leg}-${command}` },
  );
  return Object.assign(fixture, { service, store, runtime, arbitrageId });
}

function openLeg(store: ArbitrageInstanceStore, arbitrageId: string, legId: string, timestamp: number) {
  const intentId = `opening-${legId}`;
  store.claimExecutionReference("user-a", arbitrageId, {
    legId,
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: intentId,
    requestedQuantity: "1",
    createdAt: timestamp,
  });
  store.linkExecutionRecord("user-a", arbitrageId, intentId, `record-${legId}`, timestamp + 1);
  store.applyExecutionResult("user-a", arbitrageId, {
    executionIntentId: intentId,
    status: "CONFIRMED",
    confirmedQuantity: "1",
    updatedAt: timestamp + 2,
  });
}

function request(legId: string, quantity: string, commandId = "close-command") {
  return {
    arbitrageId: "arbitrage-close-1",
    legId,
    commandId,
    quantity,
    executionMode: "EXECUTION_PRIORITY" as const,
    confirmed: true,
  };
}

class FakeRuntime implements FormalArbitrageExecutionRuntime {
  readonly calls: import("../cex/ExecutionIntent").ExecutionIntent[] = [];
  resultStatus: ExecutionRecord["status"] = "CONFIRMED";
  confirmedQuantity: string | null = "0.5";
  delay = false;

  async execute(intent: import("../cex/ExecutionIntent").ExecutionIntent) {
    this.calls.push(intent);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      executionRecord: createExecutionRecord({
        executionId: `record-${intent.intentId}`,
        intentId: intent.intentId,
        userId: intent.userId,
        venue: intent.venue,
        accountId: intent.accountId,
        instrumentId: intent.instrumentId,
        status: this.resultStatus,
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt + 1,
      }),
      confirmedQuantity: this.confirmedQuantity,
    };
  }

  async reconcile(): ReturnType<FormalArbitrageExecutionRuntime["reconcile"]> {
    throw new Error("not used");
  }
}
