import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAsset } from "../cex/Asset";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import type { ArbitrageExecutionDraft } from "./ArbitrageExecutionDraft";
import {
  ArbitrageExecutionCommandService,
  type FormalArbitrageExecutionRuntime,
} from "./ArbitrageExecutionCommandService";

const now = 1_800_000_000_000;

test("final confirmation replans authoritatively, creates both real legs, and is idempotent", async (t) => {
  const fixture = setup(t);
  const request = finalRequest();

  const first = await fixture.service.confirm("user-a", request);
  const replay = await fixture.service.confirm("user-a", request);

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.instance.arbitrageId, first.instance.arbitrageId);
  assert.equal(first.instance.status, "OPENING");
  assert.deepEqual(first.instance.legs.map((leg) => ({
    role: leg.role,
    venue: leg.venue,
    instrumentId: leg.instrumentId,
    plannedQuantity: leg.plannedQuantity,
  })), [
    { role: "LONG", venue: "binance", instrumentId: "BTC-USDT-SPOT", plannedQuantity: "0.001" },
    { role: "SHORT", venue: "binance", instrumentId: "BTC-USDT-PERP", plannedQuantity: "0.001" },
  ]);
  assert.equal(fixture.drafts.calls.length, 2);
  assert.equal(fixture.runtime.calls.length, 0);
});

test("capability failure and stale replanning fail closed before provider mutation", async (t) => {
  const unavailable = setup(t, { draft: draft(false) });
  await assert.rejects(
    () => unavailable.service.confirm("user-a", finalRequest()),
    /未同时满足执行能力/u,
  );
  assert.equal(unavailable.store.listActive("user-a").length, 0);
  assert.equal(unavailable.runtime.calls.length, 0);

  const stale = setup(t);
  const created = await stale.service.confirm("user-a", finalRequest());
  stale.drafts.value = draft(true, "0.002");
  await assert.rejects(
    () => stale.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg")),
    /不一致/u,
  );
  assert.equal(stale.runtime.calls.length, 0);
  assert.equal(stale.store.get("user-a", created.instance.arbitrageId)?.executionReferences.length, 0);
});

test("user-selected first leg claims before runtime and confirmed result updates managed quantity", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => {
    const claimed = fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences[0];
    assert.equal(claimed?.status, "CLAIMED");
    assert.equal(claimed?.executionIntentId, intent.intentId);
    return runtimeResult(intent, "CONFIRMED", "0.001");
  };

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg"),
  );

  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(fixture.runtime.calls[0]?.arbitrageId, created.instance.arbitrageId);
  assert.equal(fixture.runtime.calls[0]?.legId, "short-leg");
  assert.equal(fixture.runtime.calls[0]?.side, "sell");
  assert.equal(fixture.runtime.calls[0]?.quantity.quantity, "0.001");
  assert.equal(result.instance.legs[1].confirmedOpenedQuantity, "0.001");
  assert.equal(result.instance.status, "RESIDUAL");
  assert.equal(result.secondLegAllowed, true);
  assert.equal(result.executionRecord.status, "CONFIRMED");
});

test("partial first leg is retained as RESIDUAL and never enables or auto-runs the second leg", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0004");

  const partial = await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  assert.equal(partial.instance.status, "RESIDUAL");
  assert.equal(partial.instance.legs[0].confirmedOpenedQuantity, "0.0004");
  assert.equal(partial.secondLegAllowed, false);
  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-command")),
    /第一腿尚未完整确认/u,
  );
  assert.equal(fixture.runtime.calls.length, 1);
});

test("FAILED and UNKNOWN first-leg facts preserve the instance and block the second leg", async (t) => {
  for (const status of ["FAILED", "UNKNOWN"] as const) {
    const fixture = setup(t);
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `confirmation-${status}` }));
    fixture.runtime.onExecute = (intent) => runtimeResult(intent, status, "0");
    const first = await fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "long-leg",
      `command-${status}`,
      { confirmationId: `confirmation-${status}` },
    ));
    assert.ok(fixture.store.get("user-a", created.instance.arbitrageId));
    assert.equal(first.secondLegAllowed, false);
    assert.equal(first.instance.executionReferences[0]?.status, status);
    await assert.rejects(
      () => fixture.service.executeLeg("user-a", legRequest(
        created.instance.arbitrageId,
        "short-leg",
        `second-${status}`,
        { confirmationId: `confirmation-${status}` },
      )),
      /第一腿尚未完整确认/u,
    );
  }
});

test("the second leg requires a separate command and both confirmed legs reach HOLDING", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");

  const first = await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  assert.equal(first.secondLegAllowed, true);
  assert.equal(fixture.runtime.calls.length, 1);
  const second = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "short-leg", "second-command"),
  );
  assert.equal(fixture.runtime.calls.length, 2);
  assert.equal(second.instance.status, "HOLDING");
  assert.equal(second.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(second.instance.legs[1].confirmedOpenedQuantity, "0.001");
});

test("duplicate leg confirmation returns the existing reference without a second mutation", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  const request = legRequest(created.instance.arbitrageId, "long-leg");

  const first = await fixture.service.executeLeg("user-a", request);
  const replay = await fixture.service.executeLeg("user-a", request);

  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.executionRecord.intentId, first.executionRecord.intentId);
  assert.equal(fixture.runtime.calls.length, 1);
});

test("foreign users and non-instance legs are rejected without runtime access", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  await assert.rejects(
    () => fixture.service.executeLeg("user-b", legRequest(created.instance.arbitrageId, "long-leg")),
    /不存在或不属于/u,
  );
  await assert.rejects(
    () => fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "foreign-leg")),
    /不属于当前套利实例/u,
  );
  assert.equal(fixture.runtime.calls.length, 0);
});

test("client-controlled provider fields and complete intents are rejected", async (t) => {
  const fixture = setup(t);
  await assert.rejects(
    () => fixture.service.confirm("user-a", { ...finalRequest(), providerSymbol: "BTCUSDT" }),
    /不允许的字段：providerSymbol/u,
  );
  await assert.rejects(
    () => fixture.service.confirm("user-a", { ...finalRequest(), executionIntent: { intentId: "client-intent" } }),
    /不允许的字段：executionIntent/u,
  );
  assert.equal(fixture.store.listActive("user-a").length, 0);
  assert.equal(fixture.runtime.calls.length, 0);
});

test("LIVE/kill-switch style RiskGuard blocks remain UNKNOWN and never enable a second leg", async (t) => {
  for (const gate of ["LIVE_TRADING_ENABLED=false", "BINANCE_KILL_SWITCH=true"] as const) {
    const fixture = setup(t);
    const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: gate }));
    fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", "0");
    const result = await fixture.service.executeLeg("user-a", legRequest(
      created.instance.arbitrageId,
      "long-leg",
      gate,
      { confirmationId: gate },
    ));
    assert.equal(result.executionRecord.status, "UNKNOWN");
    assert.equal(result.secondLegAllowed, false);
    assert.equal(fixture.runtime.providerMutations, 0);
  }
});

class FakeDraftService {
  readonly calls: unknown[] = [];
  constructor(public value: ArbitrageExecutionDraft) {}
  async preview(userId: string, input: unknown) {
    this.calls.push({ userId, input });
    return this.value;
  }
}

class FakeRuntime implements FormalArbitrageExecutionRuntime {
  readonly calls: ExecutionIntent[] = [];
  providerMutations = 0;
  onExecute: (intent: ExecutionIntent) => ReturnType<typeof runtimeResult> = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  async execute(intent: ExecutionIntent) {
    this.calls.push(intent);
    return this.onExecute(intent);
  }
}

function setup(t: TestContext, options: { draft?: ArbitrageExecutionDraft } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "stellax-command-test-"));
  const store = new ArbitrageInstanceStore({ dbPath: join(directory, "test.sqlite") });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const drafts = new FakeDraftService(options.draft ?? draft(true));
  const runtime = new FakeRuntime();
  const service = new ArbitrageExecutionCommandService(
    drafts,
    store,
    { findSummary: (userId: string, venue: string) => userId === "user-a" && venue === "binance" ? ({ accountId: "binance:account-a" } as any) : null },
    runtime,
    { clock: () => now, intentTtlMs: 30_000 },
  );
  return { drafts, runtime, service, store };
}

function finalRequest(overrides: Record<string, unknown> = {}) {
  return {
    confirmationId: "confirmation-1",
    opportunityId: "opportunity-1",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "0.001" },
    executionMode: "PRICE_PRIORITY",
    confirmed: true,
    ...overrides,
  };
}

function legRequest(arbitrageId: string, legId: string, commandId = "first-command", overrides: Record<string, unknown> = {}) {
  return { ...finalRequest(overrides), arbitrageId, legId, commandId };
}

function runtimeResult(intent: ExecutionIntent, status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN", confirmedQuantity: string) {
  return Object.freeze({
    executionRecord: createExecutionRecord({
      executionId: `record-${intent.intentId}`,
      intentId: intent.intentId,
      userId: intent.userId,
      venue: intent.venue,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      status,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    }),
    confirmedQuantity,
  });
}

function draft(allAvailable: boolean, quantity = "0.001"): ArbitrageExecutionDraft {
  const leg = (role: "LONG" | "SHORT", instrumentId: string) => ({
    legId: role === "LONG" ? "long-leg" : "short-leg",
    role,
    venue: "binance" as const,
    instrumentId,
    providerSymbol: "BTCUSDT",
    side: role === "LONG" ? "buy" as const : "sell" as const,
    marketType: instrumentId.endsWith("SPOT") ? "spot" as const : "perpetual" as const,
    quote: { bid: "99999", ask: "100001", updatedAt: now },
    tradingRules: { quantityStep: "0.001", minQuantity: "0.001", priceTick: "0.1", minNotional: "5", precision: {} },
    capability: allAvailable
      ? { status: "AVAILABLE" as const, reasonCode: "AVAILABLE" as const }
      : { status: "UNAVAILABLE" as const, reasonCode: "CREDENTIAL_NOT_CONFIGURED" as const },
    planning: {
      status: "PLANNED" as const,
      plan: {
        instrumentId,
        providerSymbol: "BTCUSDT",
        baseAsset: "BTC",
        quantityInput: { mode: "ASSET_QUANTITY" as const, quantity },
        sizingPrice: role === "LONG" ? "100001" : "99999",
        plannedAssetQuantity: { asset: createAsset({ symbol: "BTC", type: "DIGITAL_ASSET" }), quantity },
        estimatedNotionalUsdt: role === "LONG" ? "100.001" : "99.999",
        generatedAt: now,
      },
    },
    executionAvailable: allAvailable,
  });
  return {
    opportunityId: "opportunity-1",
    sourceIdentity: `arbitrage-dashboard:opportunity-1:${now}`,
    sourceSnapshotGeneratedAt: now,
    horizonDays: 90,
    strategyType: "SPOT_PERPETUAL",
    quantityInput: { mode: "ASSET_QUANTITY", quantity },
    legs: [leg("LONG", "BTC-USDT-SPOT"), leg("SHORT", "BTC-USDT-PERP")],
    allLegsExecutable: allAvailable,
    generatedAt: now,
  };
}
