import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAsset } from "../cex/Asset";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import { ManualReconciliationRequiredError } from "../cex/ManualReconciliationRequiredError";
import type { ArbitrageExecutionDraft } from "./ArbitrageExecutionDraft";
import {
  ArbitrageExecutionCommandError,
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

test("cancelled-with-partial fill remains FAILED execution evidence with managed residual exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "FAILED", "0.0002");

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg"),
  );

  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.executionRecord.confirmedQuantity, "0.0002");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0.0002");
  assert.equal(result.instance.status, "RESIDUAL");
  assert.equal(result.secondLegAllowed, false);
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

test("unattributable UNKNOWN result preserves zero evidence without fabricating a fill", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);

  const result = await fixture.service.executeLeg(
    "user-a",
    legRequest(created.instance.arbitrageId, "long-leg"),
  );

  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.executionRecord.confirmedQuantity, "0");
  assert.equal(result.instance.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(result.secondLegAllowed, false);
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

test("PENDING and UNKNOWN reconciliation recover full Decimal fills and unlock only a complete first leg", async (t) => {
  for (const initialStatus of ["PENDING_CONFIRMATION", "UNKNOWN"] as const) {
    await t.test(initialStatus, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest());
      fixture.runtime.onExecute = (intent) => runtimeResult(intent, initialStatus, initialStatus === "UNKNOWN" ? null : "0");
      await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
      fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");

      const recovered = await fixture.service.reconcileLeg("user-a", {
        arbitrageId: created.instance.arbitrageId,
        legId: "long-leg",
      });

      assert.equal(recovered.executionRecord.status, "CONFIRMED");
      assert.equal(recovered.executionRecord.confirmedQuantity, "0.001");
      assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.001");
      assert.equal(recovered.secondLegAllowed, true);
      assert.equal(fixture.runtime.reconcileCalls.length, 1);
    });
  }
});

test("reconciliation selects the unique unresolved closing reference when a leg has opening history", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-command"));

  const closeIntentId = "close-short-command";
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "short-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: closeIntentId,
    requestedQuantity: "0.0005",
    createdAt: now,
  });
  const shortLeg = created.instance.legs[1];
  const pending = recoveryRecord(closeIntentId, shortLeg, { executionId: "record-close-short" });
  fixture.runtime.records.set(pending.executionId, pending);
  fixture.store.linkExecutionRecord("user-a", created.instance.arbitrageId, closeIntentId, pending.executionId, now);
  fixture.store.applyExecutionResult("user-a", created.instance.arbitrageId, {
    executionIntentId: closeIntentId,
    status: "PENDING_CONFIRMATION",
    confirmedQuantity: "0.0002",
    updatedAt: now,
  });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.0005");

  const result = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "short-leg",
  });

  assert.equal(result.executionRecord.intentId, closeIntentId);
  assert.equal(result.executionRecord.confirmedQuantity, "0.0005");
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "0.0005");
  assert.equal(result.instance.legs[1].confirmedOpenedQuantity, "0.001");
  assert.equal(fixture.runtime.calls.length, 2, "reconciliation must not place a new order");
});

test("CLAIMED closing reference reuses link recovery and never places another order", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "CONFIRMED", "0.001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "short-leg", "second-command"));

  const closeIntentId = "interrupted-close-short";
  fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
    legId: "short-leg",
    phase: "CLOSING",
    quantityEffect: "DECREASE",
    executionIntentId: closeIntentId,
    requestedQuantity: "0.0005",
    createdAt: now,
  });
  const localRecord = recoveryRecord(closeIntentId, created.instance.legs[1], {
    executionId: "record-interrupted-close",
  });
  fixture.runtime.records.set(localRecord.executionId, localRecord);
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.0005");

  const result = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "short-leg",
  });

  assert.equal(result.instance.executionReferences.at(-1)?.executionRecordId, localRecord.executionId);
  assert.equal(result.instance.legs[1].confirmedClosedQuantity, "0.0005");
  assert.equal(fixture.runtime.calls.length, 2, "link recovery must not retry provider mutation");
});

test("PENDING and UNKNOWN reconciliation preserve partial Decimal fills and keep second leg disabled", async (t) => {
  for (const initialStatus of ["PENDING_CONFIRMATION", "UNKNOWN"] as const) {
    await t.test(initialStatus, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest());
      fixture.runtime.onExecute = (intent) => runtimeResult(intent, initialStatus, initialStatus === "UNKNOWN" ? null : "0.0001");
      await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
      fixture.runtime.onReconcile = (record) => reconciliationResult(
        record,
        "PENDING_CONFIRMATION",
        "0.000456789012345678",
      );

      const recovered = await fixture.service.reconcileLeg("user-a", {
        arbitrageId: created.instance.arbitrageId,
        legId: "long-leg",
      });

      assert.equal(recovered.executionRecord.confirmedQuantity, "0.000456789012345678");
      assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.000456789012345678");
      assert.equal(recovered.secondLegAllowed, false);
    });
  }
});

test("UNKNOWN reconciliation retains prior evidence when provider quantity remains unknowable", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0004");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "UNKNOWN", null);

  const recovered = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(recovered.executionRecord.status, "UNKNOWN");
  assert.equal(recovered.executionRecord.confirmedQuantity, "0.0004");
  assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.0004");
  assert.equal(recovered.secondLegAllowed, false);
});

test("cancelled-with-partial reconciliation preserves exposure and becomes terminal idempotently", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "FAILED", "0.0006");
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };

  const recovered = await fixture.service.reconcileLeg("user-a", request);
  const replay = await fixture.service.reconcileLeg("user-a", request);

  assert.equal(recovered.executionRecord.status, "FAILED");
  assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0.0006");
  assert.equal(replay.instance.legs[0].confirmedOpenedQuantity, "0.0006");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("concurrent reconciliation shares one provider query and cannot double-count exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "PENDING_CONFIRMATION", "0.0001");
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.runtime.onReconcile = async (record) => {
    await gate;
    return reconciliationResult(record, "PENDING_CONFIRMATION", "0.0007");
  };
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };
  const first = fixture.service.reconcileLeg("user-a", request);
  const second = fixture.service.reconcileLeg("user-a", request);
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(left.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(right.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(fixture.runtime.reconcileCalls.length, 1);
});

test("reconciliation enforces user/reference ownership and query failures never mutate exposure", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };

  await assert.rejects(() => fixture.service.reconcileLeg("user-b", request), /不存在或不属于/u);
  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", { ...request, legId: "short-leg" }),
    /不存在唯一可核验/u,
  );
  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", { ...request, providerOrderId: "untrusted-order" }),
    /不允许的字段/u,
  );
  fixture.runtime.onReconcile = async () => { throw new Error("provider GET failed"); };
  await assert.rejects(() => fixture.service.reconcileLeg("user-a", request), /核验暂不可用/u);
  assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("manual reconciliation metadata survives the formal CommandService boundary", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  fixture.runtime.onExecute = (intent) => runtimeResult(intent, "UNKNOWN", null);
  await fixture.service.executeLeg("user-a", legRequest(created.instance.arbitrageId, "long-leg"));
  fixture.runtime.onReconcile = async () => {
    throw new ManualReconciliationRequiredError(
      "intent:intent-user-a",
      "Stored Binance provider orderId is invalid.",
    );
  };

  await assert.rejects(
    () => fixture.service.reconcileLeg("user-a", {
      arbitrageId: created.instance.arbitrageId,
      legId: "long-leg",
    }),
    (error: unknown) => error instanceof ArbitrageExecutionCommandError
      && error.category === "manual_reconciliation_required"
      && error.manualReconciliation?.manualReconciliationRequired === true
      && error.manualReconciliation.idempotencyKey === "intent:intent-user-a"
      && error.manualReconciliation.reason === "Stored Binance provider orderId is invalid.",
  );
  assert.equal(fixture.runtime.providerMutations, 0);
});

test("CLAIMED reference recovers a unique local record and attributes confirmed or partial Decimal fills", async (t) => {
  for (const scenario of [
    { name: "confirmed", status: "CONFIRMED" as const, quantity: "0.001" },
    { name: "partial", status: "PENDING_CONFIRMATION" as const, quantity: "0.000456789012345678" },
    { name: "canceled-with-partial", status: "FAILED" as const, quantity: "0.0002" },
  ]) {
    await t.test(scenario.name, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `recovery-${scenario.name}` }));
      const seeded = seedInterruptedExecution(fixture, created.instance, "long-leg", `intent-${scenario.name}`);
      fixture.runtime.onReconcile = (record) => reconciliationResult(record, scenario.status, scenario.quantity);

      const recovered = await fixture.service.reconcileLeg("user-a", {
        arbitrageId: created.instance.arbitrageId,
        legId: "long-leg",
      });

      const reference = recovered.instance.executionReferences[0]!;
      assert.equal(reference.executionRecordId, seeded.executionId);
      assert.equal(reference.confirmedQuantity, scenario.quantity);
      assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, scenario.quantity);
      assert.equal(recovered.secondLegAllowed, scenario.status === "CONFIRMED");
      assert.equal(fixture.runtime.calls.length, 0);
      assert.equal(fixture.runtime.reconcileCalls.length, 1);
      assert.equal(fixture.runtime.providerMutations, 0);
    });
  }
});

test("CLAIMED UNKNOWN record recovers its link without fabricating confirmed quantity", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  const seeded = seedInterruptedExecution(fixture, created.instance, "long-leg", "intent-unknown", { status: "UNKNOWN" });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "UNKNOWN", null);

  const recovered = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(recovered.instance.executionReferences[0]?.executionRecordId, seeded.executionId);
  assert.equal(recovered.instance.executionReferences[0]?.status, "UNKNOWN");
  assert.equal(recovered.instance.executionReferences[0]?.confirmedQuantity, "0");
  assert.equal(recovered.instance.legs[0].confirmedOpenedQuantity, "0");
  assert.equal(recovered.secondLegAllowed, false);
});

test("missing or multiple local records fail closed without provider access", async (t) => {
  for (const scenario of ["missing", "multiple"] as const) {
    await t.test(scenario, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `recovery-${scenario}` }));
      const intentId = `intent-${scenario}`;
      fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
        legId: "long-leg",
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: intentId,
        requestedQuantity: "0.001",
        createdAt: now,
      });
      if (scenario === "multiple") {
        const leg = created.instance.legs[0];
        fixture.runtime.records.set("record-a", recoveryRecord(intentId, leg, { executionId: "record-a" }));
        fixture.runtime.records.set("record-b", recoveryRecord(intentId, leg, { executionId: "record-b" }));
      }

      await assert.rejects(
        () => fixture.service.reconcileLeg("user-a", { arbitrageId: created.instance.arbitrageId, legId: "long-leg" }),
        (error) => error instanceof ArbitrageExecutionCommandError
          && error.category === (scenario === "missing"
            ? "execution_recovery_record_not_found"
            : "execution_recovery_identity_conflict"),
      );
      assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences[0]?.executionRecordId, null);
      assert.equal(fixture.runtime.reconcileCalls.length, 0);
      assert.equal(fixture.runtime.providerMutations, 0);
    });
  }
});

test("recovery rejects user, account, venue, and instrument identity conflicts", async (t) => {
  const mismatches = [
    { name: "intent", overrides: { intentId: "another-intent" } },
    { name: "user", overrides: { userId: "user-b" } },
    { name: "account", overrides: { accountId: "binance:account-b" } },
    { name: "venue", overrides: { venue: "okx" as const } },
    { name: "instrument", overrides: { instrumentId: "ETH-USDT-SPOT" } },
  ];
  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async (child) => {
      const fixture = setup(child);
      const created = await fixture.service.confirm("user-a", finalRequest({ confirmationId: `recovery-${mismatch.name}` }));
      const intentId = `intent-${mismatch.name}`;
      const leg = created.instance.legs[0];
      fixture.store.claimExecutionReference("user-a", created.instance.arbitrageId, {
        legId: leg.legId,
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: intentId,
        requestedQuantity: "0.001",
        createdAt: now,
      });
      const conflicting = recoveryRecord(intentId, leg, mismatch.overrides);
      fixture.runtime.records.set("record-conflict", conflicting);
      if (mismatch.name === "intent") fixture.runtime.recoveryCandidates = [conflicting];

      await assert.rejects(
        () => fixture.service.reconcileLeg("user-a", { arbitrageId: created.instance.arbitrageId, legId: leg.legId }),
        (error) => error instanceof ArbitrageExecutionCommandError
          && error.category === "execution_recovery_identity_conflict",
      );
      assert.equal(fixture.store.get("user-a", created.instance.arbitrageId)?.executionReferences[0]?.executionRecordId, null);
      assert.equal(fixture.runtime.reconcileCalls.length, 0);
    });
  }
});

test("repeated and concurrent link recovery cannot double-count exposure", async (t) => {
  const repeated = setup(t);
  const created = await repeated.service.confirm("user-a", finalRequest({ confirmationId: "recovery-repeated" }));
  seedInterruptedExecution(repeated, created.instance, "long-leg", "intent-repeated");
  repeated.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");
  const request = { arbitrageId: created.instance.arbitrageId, legId: "long-leg" };
  const first = await repeated.service.reconcileLeg("user-a", request);
  const replay = await repeated.service.reconcileLeg("user-a", request);
  assert.equal(first.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(replay.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(repeated.runtime.reconcileCalls.length, 1);

  const concurrent = setup(t);
  const concurrentCreated = await concurrent.service.confirm("user-a", finalRequest({ confirmationId: "recovery-concurrent" }));
  seedInterruptedExecution(concurrent, concurrentCreated.instance, "long-leg", "intent-concurrent");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  concurrent.runtime.onReconcile = async (record) => {
    await gate;
    return reconciliationResult(record, "PENDING_CONFIRMATION", "0.0007");
  };
  const concurrentRequest = { arbitrageId: concurrentCreated.instance.arbitrageId, legId: "long-leg" };
  const left = concurrent.service.reconcileLeg("user-a", concurrentRequest);
  const right = concurrent.createService().reconcileLeg("user-a", concurrentRequest);
  release();
  const [leftResult, rightResult] = await Promise.all([left, right]);
  assert.equal(leftResult.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(rightResult.instance.legs[0].confirmedOpenedQuantity, "0.0007");
  assert.equal(concurrent.runtime.reconcileCalls.length, 2);
  assert.equal(concurrent.runtime.providerMutations, 0);
});

test("recovered partial link continues through the existing reconciliation flow", async (t) => {
  const fixture = setup(t);
  const created = await fixture.service.confirm("user-a", finalRequest());
  seedInterruptedExecution(fixture, created.instance, "long-leg", "intent-continue");
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "PENDING_CONFIRMATION", "0.0004");
  await fixture.service.reconcileLeg("user-a", { arbitrageId: created.instance.arbitrageId, legId: "long-leg" });
  fixture.runtime.onReconcile = (record) => reconciliationResult(record, "CONFIRMED", "0.001");

  const completed = await fixture.service.reconcileLeg("user-a", {
    arbitrageId: created.instance.arbitrageId,
    legId: "long-leg",
  });

  assert.equal(completed.instance.legs[0].confirmedOpenedQuantity, "0.001");
  assert.equal(completed.instance.executionReferences[0]?.status, "CONFIRMED");
  assert.equal(completed.secondLegAllowed, true);
  assert.equal(fixture.runtime.reconcileCalls.length, 2);
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
  readonly reconcileCalls: Array<{ userId: string; executionId: string }> = [];
  readonly records = new Map<string, ExecutionRecord>();
  recoveryCandidates: readonly ExecutionRecord[] | null = null;
  providerMutations = 0;
  onExecute: (intent: ExecutionIntent) => ReturnType<typeof runtimeResult> = (intent) => runtimeResult(intent, "CONFIRMED", intent.quantity.quantity);
  onReconcile: (record: ExecutionRecord) => ReturnType<typeof reconciliationResult> | Promise<ReturnType<typeof reconciliationResult>> = (record) => reconciliationResult(record, "UNKNOWN", null);
  async execute(intent: ExecutionIntent) {
    this.calls.push(intent);
    const result = this.onExecute(intent);
    this.records.set(result.executionRecord.executionId, result.executionRecord);
    return result;
  }
  async reconcile(userId: string, executionId: string) {
    this.reconcileCalls.push({ userId, executionId });
    const record = this.records.get(executionId);
    if (!record || record.userId !== userId) throw new Error("ExecutionRecord unavailable");
    const result = await this.onReconcile(record);
    this.records.set(executionId, result.executionRecord);
    return result;
  }
  findByIntentId(intentId: string) {
    return this.recoveryCandidates
      ?? [...this.records.values()].filter((record) => record.intentId === intentId);
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
  const credentials = { findSummary: (userId: string, venue: string) => userId === "user-a" && venue === "binance" ? ({ accountId: "binance:account-a" } as any) : null };
  const createService = () => new ArbitrageExecutionCommandService(
    drafts,
    store,
    credentials,
    runtime,
    runtime,
    { clock: () => now, intentTtlMs: 30_000 },
  );
  const service = createService();
  return { drafts, runtime, service, store, createService };
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

function runtimeResult(intent: ExecutionIntent, status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN", confirmedQuantity: string | null) {
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

function reconciliationResult(
  record: ExecutionRecord,
  status: "CONFIRMED" | "PENDING_CONFIRMATION" | "FAILED" | "UNKNOWN",
  confirmedQuantity: string | null,
) {
  return Object.freeze({
    executionRecord: createExecutionRecord({ ...record, status, updatedAt: record.updatedAt + 1 }),
    confirmedQuantity,
  });
}

function seedInterruptedExecution(
  fixture: ReturnType<typeof setup>,
  instance: Awaited<ReturnType<ArbitrageExecutionCommandService["confirm"]>>["instance"],
  legId: string,
  intentId: string,
  recordOverrides: Partial<ExecutionRecord> = {},
) {
  const leg = instance.legs.find((candidate) => candidate.legId === legId)!;
  fixture.store.claimExecutionReference("user-a", instance.arbitrageId, {
    legId,
    phase: "OPENING",
    quantityEffect: "INCREASE",
    executionIntentId: intentId,
    requestedQuantity: leg.plannedQuantity,
    createdAt: now,
  });
  const record = recoveryRecord(intentId, leg, recordOverrides);
  fixture.runtime.records.set(record.executionId, record);
  return record;
}

function recoveryRecord(
  intentId: string,
  leg: Awaited<ReturnType<ArbitrageExecutionCommandService["confirm"]>>["instance"]["legs"][number],
  overrides: Partial<ExecutionRecord> = {},
) {
  return createExecutionRecord({
    executionId: `record-${intentId}`,
    intentId,
    userId: "user-a",
    venue: leg.venue,
    accountId: leg.accountId,
    instrumentId: leg.instrumentId,
    status: "PENDING_CONFIRMATION",
    createdAt: now,
    updatedAt: now,
    ...overrides,
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
