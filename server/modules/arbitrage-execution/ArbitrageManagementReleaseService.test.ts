import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeManagedQuantity,
  managedCurrentQuantity,
  type NewArbitrageInstance,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { ArbitrageManagementReleaseError, ArbitrageManagementReleaseService } from "./ArbitrageManagementReleaseService";

const now = 1_800_000_000_000;

test("releases all remaining active quantity without changing confirmed execution history", async (t) => {
  const fixture = setup(t);
  open(fixture.store, "arbitrage-1", "long-leg", "100", now + 10);
  open(fixture.store, "arbitrage-1", "short-leg", "100", now + 20);
  close(fixture.store, "arbitrage-1", "long-leg", "20", now + 30);

  const released = await fixture.service.release("user-a", request("long-leg", "release-long"));
  const long = released.instance.legs[0];
  assert.equal(released.release.releasedQuantity, "80");
  assert.equal(managedCurrentQuantity(long), "80");
  assert.equal(activeManagedQuantity(released.instance, long), "0");
  assert.equal(long.confirmedOpenedQuantity, "100");
  assert.equal(long.confirmedClosedQuantity, "20");
  assert.equal(released.release.reason, "USER_CONFIRMED_STOP_MANAGEMENT");
  assert.equal(released.release.source, "AUTHENTICATED_API");
  assert.equal(released.release.requestedByUserId, "user-a");
  assert.equal(released.release.actualSignedNetQuantity, "20");
  assert.equal(released.instance.status, "RESIDUAL");

  const replay = await fixture.service.release("user-a", request("long-leg", "release-long"));
  assert.equal(replay.idempotentReplay, true);
  await assert.rejects(
    () => fixture.service.release("user-a", request("long-leg", "different-command")),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "management_release_unavailable",
  );

  const completed = await fixture.service.release("user-a", request("short-leg", "release-short"));
  assert.equal(completed.instance.status, "CLOSED");
  assert.equal(completed.instance.closedAt, now + 100);
  assert.deepEqual(completed.instance.legs.map(managedCurrentQuantity), ["80", "100"]);
  assert.deepEqual(completed.instance.legs.map((leg) => activeManagedQuantity(completed.instance, leg)), ["0", "0"]);
  assert.deepEqual(completed.instance.legs.map((leg) => leg.confirmedClosedQuantity), ["20", "0"]);
  const restarted = new ArbitrageInstanceStore({ dbPath: fixture.dbPath });
  try {
    const restored = restarted.get("user-a", "arbitrage-1")!;
    assert.deepEqual(restored.managementReleases, completed.instance.managementReleases);
    assert.equal(restored.status, "CLOSED");
    assert.deepEqual(restored.legs.map((leg) => activeManagedQuantity(restored, leg)), ["0", "0"]);
  } finally {
    restarted.close();
  }
});

test("fails closed for UNKNOWN reality and every unresolved execution status", async (t) => {
  const unknown = setup(t, { verificationStatus: "UNKNOWN" });
  open(unknown.store, "arbitrage-1", "long-leg", "100", now + 10);
  await assert.rejects(
    () => unknown.service.release("user-a", request("long-leg", "unknown")),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "position_verification_unavailable",
  );
  assert.deepEqual(unknown.store.get("user-a", "arbitrage-1")?.managementReleases, []);

  for (const [index, status] of ["CLAIMED", "LINKED", "PENDING_CONFIRMATION", "UNKNOWN"] .entries()) {
    await t.test(status, async (child) => {
      const fixture = setup(child, { arbitrageId: `pending-${status.toLowerCase()}` });
      open(fixture.store, fixture.arbitrageId, "long-leg", "100", now + 10);
      const intentId = `pending-${status}`;
      fixture.store.claimExecutionReference("user-a", fixture.arbitrageId, {
        legId: "short-leg", phase: "OPENING", quantityEffect: "INCREASE",
        executionIntentId: intentId, requestedQuantity: "100", createdAt: now + 20 + index,
      });
      if (status !== "CLAIMED") {
        fixture.store.linkExecutionRecord("user-a", fixture.arbitrageId, intentId, `${intentId}-record`, now + 30 + index);
      }
      if (status === "PENDING_CONFIRMATION" || status === "UNKNOWN") {
        fixture.store.applyExecutionResult("user-a", fixture.arbitrageId, {
          executionIntentId: intentId,
          status,
          confirmedQuantity: "0",
          updatedAt: now + 40 + index,
        });
      }
      await assert.rejects(
        () => fixture.service.release("user-a", {
          arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: status, confirmed: true,
        }),
        (error: unknown) => error instanceof ArbitrageManagementReleaseError
          && error.category === "execution_state_unknown",
      );
      assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
    });
  }
});

test("isolates releases by instance and preserves Spot attribution ledger plus ONE_WAY/HEDGE reality", async (t) => {
  const fixture = setup(t);
  fixture.store.create(instance({ arbitrageId: "arbitrage-2" }));
  open(fixture.store, "arbitrage-1", "long-leg", "100", now + 10);
  open(fixture.store, "arbitrage-2", "long-leg", "100", now + 20);

  const first = await fixture.service.release("user-a", request("long-leg", "isolated"));
  const second = fixture.store.get("user-a", "arbitrage-2")!;
  assert.equal(activeManagedQuantity(first.instance, first.instance.legs[0]), "0");
  assert.equal(managedCurrentQuantity(second.legs[0]), "100");
  assert.equal(activeManagedQuantity(second, second.legs[0]), "100");
  assert.deepEqual(second.managementReleases, []);

  const spot = setup(t, { arbitrageId: "spot-instance", spot: true });
  open(spot.store, spot.arbitrageId, "long-leg", "1", now + 50);
  const releasedSpot = await spot.service.release("user-a", {
    arbitrageId: spot.arbitrageId, legId: "long-leg", commandId: "spot", confirmed: true,
  });
  assert.equal(releasedSpot.release.releasedQuantity, "1");
  assert.equal(releasedSpot.instance.legs[0].confirmedOpenedQuantity, "1");
  assert.equal(releasedSpot.instance.legs[0].confirmedClosedQuantity, "0");
  assert.equal(releasedSpot.release.actualQuantity, "1.4");

  for (const mode of ["ONE_WAY", "HEDGE"] as const) {
    const perpetual = setup(t, { arbitrageId: `perp-${mode.toLowerCase()}`, positionMode: mode });
    open(perpetual.store, perpetual.arbitrageId, "short-leg", "100", now + 60);
    const released = await perpetual.service.release("user-a", {
      arbitrageId: perpetual.arbitrageId, legId: "short-leg", commandId: mode, confirmed: true,
    });
    assert.equal(released.release.positionMode, mode);
    assert.equal(released.release.actualQuantity, "20");
    assert.equal(released.instance.legs[1].confirmedClosedQuantity, "0");
  }
});

test("rejects partial quantity input instead of accepting a caller-selected release amount", async (t) => {
  const fixture = setup(t);
  open(fixture.store, "arbitrage-1", "long-leg", "100", now + 10);
  await assert.rejects(
    () => fixture.service.release("user-a", { ...request("long-leg", "partial"), quantity: "37" }),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "invalid_management_release",
  );
  assert.deepEqual(fixture.store.get("user-a", "arbitrage-1")?.managementReleases, []);
});

test("automatic dust release requires a confirmed close and preserves execution history", async (t) => {
  const fixture = setup(t, {
    spot: true,
    safeClosableQuantity: "0",
    safetyReason: "QUANTITY_STEP_DUST",
  });
  open(fixture.store, fixture.arbitrageId, "long-leg", "1", now + 10);

  await assert.rejects(
    () => fixture.service.releaseDustAfterClose("user-a", {
      arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "dust-before-close",
    }),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "management_release_unavailable",
  );

  close(fixture.store, fixture.arbitrageId, "long-leg", "0.94", now + 20);
  const result = await fixture.service.releaseDustAfterClose("user-a", {
    arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "dust-after-close",
  });

  assert.equal(result.release.releasedQuantity, "0.06");
  assert.equal(result.instance.legs[0].confirmedClosedQuantity, "0.94");
  assert.equal(managedCurrentQuantity(result.instance.legs[0]), "0.06");
  assert.equal(activeManagedQuantity(result.instance, result.instance.legs[0]), "0");
  assert.equal(result.instance.status, "CLOSED");

  const replay = await fixture.service.releaseDustAfterClose("user-a", {
    arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "dust-after-close",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.instance.managementReleases?.length, 1);
});

test("automatic dust release retries only transient Provider reads and then releases once", async (t) => {
  const fixture = setup(t, {
    spot: true,
    safetySequence: ["SPOT_AVAILABLE_BALANCE_UNAVAILABLE", "QUANTITY_STEP_DUST"],
  });
  open(fixture.store, fixture.arbitrageId, "long-leg", "1", now + 10);
  close(fixture.store, fixture.arbitrageId, "long-leg", "0.94", now + 20);

  const result = await fixture.service.releaseDustAfterClose("user-a", {
    arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "transient-dust-read",
  });

  assert.equal(result.release.releasedQuantity, "0.06");
  assert.equal(fixture.safetyReads(), 2);
  assert.deepEqual(fixture.sleepDelays, [250]);
  assert.equal(result.instance.managementReleases?.length, 1);
});

test("automatic dust release exhausts bounded Provider reads without writing a release", async (t) => {
  const fixture = setup(t, {
    spot: true,
    safetySequence: ["THROW", "SPOT_AVAILABLE_BALANCE_UNAVAILABLE", "SPOT_AVAILABLE_BALANCE_UNAVAILABLE"],
  });
  open(fixture.store, fixture.arbitrageId, "long-leg", "1", now + 10);
  close(fixture.store, fixture.arbitrageId, "long-leg", "0.94", now + 20);

  await assert.rejects(
    () => fixture.service.releaseDustAfterClose("user-a", {
      arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "exhausted-dust-read",
    }),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "dust_release_provider_read_failed",
  );
  assert.equal(fixture.safetyReads(), 3);
  assert.deepEqual(fixture.sleepDelays, [250, 500]);
  assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
});

test("automatic dust release does not retry a non-transient Provider read conflict", async (t) => {
  const fixture = setup(t, {
    spot: true,
    safetySequence: ["SPOT_AVAILABLE_BALANCE_UNAVAILABLE", "QUANTITY_STEP_DUST"],
    transientSafetyRead: false,
  });
  open(fixture.store, fixture.arbitrageId, "long-leg", "1", now + 10);
  close(fixture.store, fixture.arbitrageId, "long-leg", "0.94", now + 20);

  await assert.rejects(
    () => fixture.service.releaseDustAfterClose("user-a", {
      arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "non-transient-read",
    }),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "dust_release_provider_read_failed",
  );
  assert.equal(fixture.safetyReads(), 1);
  assert.deepEqual(fixture.sleepDelays, []);
  assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
});

test("automatic dust release does not retry business, attribution, or Reality conflicts", async (t) => {
  for (const scenario of [
    { reason: "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT", category: "dust_release_eligibility_changed" },
    { reason: "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE", category: "dust_release_attribution_unavailable" },
    { reason: "PROVIDER_REALITY_UNAVAILABLE", category: "dust_release_reality_unavailable" },
  ] as const) {
    await t.test(scenario.reason, async (child) => {
      const fixture = setup(child, { spot: true, safetySequence: [scenario.reason, "QUANTITY_STEP_DUST"] });
      open(fixture.store, fixture.arbitrageId, "long-leg", "1", now + 10);
      close(fixture.store, fixture.arbitrageId, "long-leg", "0.94", now + 20);
      await assert.rejects(
        () => fixture.service.releaseDustAfterClose("user-a", {
          arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: scenario.reason,
        }),
        (error: unknown) => error instanceof ArbitrageManagementReleaseError
          && error.category === scenario.category,
      );
      assert.equal(fixture.safetyReads(), 1);
      assert.deepEqual(fixture.sleepDelays, []);
      assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
    });
  }
});

test("automatic dust release rejects Provider shortfall even after a confirmed partial close", async (t) => {
  const fixture = setup(t, {
    spot: true,
    safeClosableQuantity: "0",
    safetyReason: "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT",
  });
  open(fixture.store, fixture.arbitrageId, "long-leg", "1", now + 10);
  close(fixture.store, fixture.arbitrageId, "long-leg", "0.94", now + 20);

  await assert.rejects(
    () => fixture.service.releaseDustAfterClose("user-a", {
      arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: "not-dust",
    }),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "dust_release_eligibility_changed",
  );
  assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
});

test("rejects Management Release while the full Active Managed leg remains safely closable", async (t) => {
  for (const scenario of [
    { name: "ONE_WAY exact", positionMode: "ONE_WAY" as const },
    { name: "ONE_WAY account larger", positionMode: "ONE_WAY" as const },
    { name: "HEDGE target bucket", positionMode: "HEDGE" as const },
    { name: "Spot attribution and available", spot: true },
  ]) {
    await t.test(scenario.name, async (child) => {
      const fixture = setup(child, { ...scenario, fullManagedCloseAvailable: true });
      open(fixture.store, fixture.arbitrageId, "long-leg", scenario.spot ? "1" : "100", now + 10);
      await assert.rejects(
        () => fixture.service.release("user-a", {
          arbitrageId: fixture.arbitrageId, legId: "long-leg", commandId: scenario.name, confirmed: true,
        }),
        (error: unknown) => error instanceof ArbitrageManagementReleaseError
          && error.category === "management_release_unavailable",
      );
      assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
    });
  }
});

test("same commandId with a different leg fingerprint conflicts instead of replaying", async (t) => {
  const fixture = setup(t);
  fixture.store.create(instance({ arbitrageId: "arbitrage-2" }));
  fixture.store.create(instance({ arbitrageId: "arbitrage-user-b", userId: "user-b" }));
  open(fixture.store, fixture.arbitrageId, "long-leg", "100", now + 10);
  open(fixture.store, fixture.arbitrageId, "short-leg", "100", now + 20);
  open(fixture.store, "arbitrage-2", "long-leg", "100", now + 30);
  open(fixture.store, "arbitrage-user-b", "long-leg", "100", now + 40, "user-b");
  const first = await fixture.service.release("user-a", request("long-leg", "shared-command"));
  assert.equal(first.idempotentReplay, false);

  await assert.rejects(
    () => fixture.service.release("user-a", request("short-leg", "shared-command")),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "idempotency_conflict",
  );
  const persisted = fixture.store.get("user-a", fixture.arbitrageId)!;
  assert.deepEqual(persisted.managementReleases?.map(({ legId }) => legId), ["long-leg"]);
  assert.equal(activeManagedQuantity(persisted, persisted.legs[1]), "100");

  for (const collision of [
    { userId: "user-a", arbitrageId: "arbitrage-2", legId: "long-leg" },
    { userId: "user-b", arbitrageId: "arbitrage-user-b", legId: "long-leg" },
  ]) {
    await assert.rejects(
      () => fixture.service.release(collision.userId, {
        arbitrageId: collision.arbitrageId,
        legId: collision.legId,
        commandId: "shared-command",
        confirmed: true,
      }),
      (error: unknown) => error instanceof ArbitrageManagementReleaseError
        && error.category === "idempotency_conflict",
    );
  }
});

test("same commandId already claimed by a different operation conflicts", async (t) => {
  const fixture = setup(t);
  execute(
    fixture.store,
    fixture.arbitrageId,
    "long-leg",
    "open-with-command-fingerprint",
    "OPENING",
    "INCREASE",
    "100",
    now + 10,
    "user-a",
    "cross-operation-command",
  );

  await assert.rejects(
    () => fixture.service.release("user-a", request("long-leg", "cross-operation-command")),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "idempotency_conflict",
  );
  assert.deepEqual(fixture.store.get("user-a", fixture.arbitrageId)?.managementReleases, []);
});

test("read-only eligibility shares full-close, insufficient, flat, unknown, unresolved, and empty rules", async (t) => {
  const full = setup(t, { arbitrageId: "full", fullManagedCloseAvailable: true });
  open(full.store, full.arbitrageId, "long-leg", "100", now + 10);
  const healthy = await full.service.evaluateEligibility("user-a", full.arbitrageId, "long-leg");
  assert.equal(healthy.fullManagedCloseAvailable, true);
  assert.equal(healthy.releaseEligible, false);
  assert.equal(healthy.releaseEligibilityReason, "FULL_MANAGED_CLOSE_AVAILABLE");

  const insufficient = setup(t, { arbitrageId: "insufficient", safeClosableQuantity: "20" });
  open(insufficient.store, insufficient.arbitrageId, "short-leg", "100", now + 20);
  const partial = await insufficient.service.evaluateEligibility("user-a", insufficient.arbitrageId, "short-leg");
  assert.equal(partial.activeManagedQuantity, "100");
  assert.equal(partial.safeClosableQuantity, "20");
  assert.equal(partial.realityReliable, true);
  assert.equal(partial.releaseEligible, true);

  const flat = setup(t, { arbitrageId: "flat", actualQuantity: "0", safeClosableQuantity: "0" });
  open(flat.store, flat.arbitrageId, "short-leg", "100", now + 30);
  const flatResult = await flat.service.evaluateEligibility("user-a", flat.arbitrageId, "short-leg");
  assert.equal(flatResult.fullManagedCloseAvailable, false);
  assert.equal(flatResult.releaseEligible, true);

  const unknown = setup(t, { arbitrageId: "unknown-read", verificationStatus: "UNKNOWN" });
  open(unknown.store, unknown.arbitrageId, "long-leg", "100", now + 40);
  const unavailable = await unknown.service.evaluateEligibility("user-a", unknown.arbitrageId, "long-leg");
  assert.equal(unavailable.realityReliable, false);
  assert.equal(unavailable.releaseEligible, false);
  assert.equal(unavailable.releaseEligibilityReason, "PROVIDER_REALITY_UNAVAILABLE");

  const unresolved = setup(t, { arbitrageId: "unresolved-read" });
  open(unresolved.store, unresolved.arbitrageId, "long-leg", "100", now + 50);
  unresolved.store.claimExecutionReference("user-a", unresolved.arbitrageId, {
    legId: "short-leg", phase: "OPENING", quantityEffect: "INCREASE",
    executionIntentId: "pending-read", requestedQuantity: "100", createdAt: now + 60,
  });
  const pending = await unresolved.service.evaluateEligibility("user-a", unresolved.arbitrageId, "long-leg");
  assert.equal(pending.hasUnresolvedExecution, true);
  assert.equal(pending.releaseEligible, false);
  assert.equal(pending.releaseEligibilityReason, "UNRESOLVED_EXECUTION");

  const empty = setup(t, { arbitrageId: "empty-read" });
  const noExposure = await empty.service.evaluateEligibility("user-a", empty.arbitrageId, "long-leg");
  assert.equal(noExposure.activeManagedQuantity, "0");
  assert.equal(noExposure.releaseEligible, false);
  assert.equal(noExposure.releaseEligibilityReason, "NO_ACTIVE_MANAGED_EXPOSURE");
});

test("read-only eligibility isolates user, instance, and leg ownership", async (t) => {
  const fixture = setup(t);
  open(fixture.store, fixture.arbitrageId, "long-leg", "100", now + 10);
  await assert.rejects(
    () => fixture.service.evaluateEligibility("user-b", fixture.arbitrageId, "long-leg"),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "arbitrage_instance_not_found",
  );
  await assert.rejects(
    () => fixture.service.evaluateEligibility("user-a", fixture.arbitrageId, "foreign-leg"),
    (error: unknown) => error instanceof ArbitrageManagementReleaseError
      && error.category === "arbitrage_leg_not_found",
  );
});

function setup(t: test.TestContext, options: Readonly<{
  arbitrageId?: string;
  verificationStatus?: "MATCHED" | "MISMATCH" | "UNKNOWN";
  positionMode?: "ONE_WAY" | "HEDGE";
  spot?: boolean;
  fullManagedCloseAvailable?: boolean;
  safeClosableQuantity?: string;
  actualQuantity?: string;
  safetyReason?: "QUANTITY_STEP_DUST" | "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT";
  safetySequence?: readonly (
    | "QUANTITY_STEP_DUST"
    | "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT"
    | "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
    | "SPOT_AVAILABLE_BALANCE_UNAVAILABLE"
    | "PROVIDER_REALITY_UNAVAILABLE"
    | "THROW"
  )[];
  transientSafetyRead?: boolean;
}> = {}) {
  const root = mkdtempSync(join(tmpdir(), "management-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "trading.sqlite");
  const store = new ArbitrageInstanceStore({ dbPath });
  t.after(() => store.close());
  const arbitrageId = options.arbitrageId ?? "arbitrage-1";
  store.create(instance({ arbitrageId, ...(options.spot ? {
    strategyType: "SPOT_PERPETUAL",
    legs: [
      { ...instance().legs[0], instrumentId: "BTC-USDT-SPOT", plannedQuantity: "1" },
      { ...instance().legs[1], plannedQuantity: "1" },
    ],
  } : {}) }));
  let safetyReadCount = 0;
  const sleepDelays: number[] = [];
  const service = new ArbitrageManagementReleaseService(store, {
    evaluateCloseSafety: async (_userId: string, requestedArbitrageId: string, legId: string) => {
      const sequenced = options.safetySequence?.[
        Math.min(safetyReadCount, Math.max(0, options.safetySequence.length - 1))
      ];
      safetyReadCount += 1;
      if (sequenced === "THROW") {
        throw Object.assign(new Error("temporary provider read failed with private detail"), {
          category: "provider_timeout",
        });
      }
      const current = store.get(_userId, requestedArbitrageId)!;
      const leg = current.legs.find((candidate) => candidate.legId === legId)!;
      const active = activeManagedQuantity(current, leg);
      const reason = sequenced ?? options.safetyReason;
      const unknown = options.verificationStatus === "UNKNOWN" || reason === "PROVIDER_REALITY_UNAVAILABLE"
        || reason === "SPOT_AVAILABLE_BALANCE_UNAVAILABLE" || reason === "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE";
      const actual = options.actualQuantity
        ?? (options.spot && leg.legId === "long-leg" ? "1.4" : "20");
      return Object.freeze({
        activeManagedQuantity: active,
        safeClosableQuantity: unknown || reason === "QUANTITY_STEP_DUST" ? "0" : options.fullManagedCloseAvailable
          ? active : options.safeClosableQuantity ?? "20",
        fullManagedCloseAvailable: options.fullManagedCloseAvailable ?? false,
        reason: reason ?? (unknown ? "PROVIDER_REALITY_UNAVAILABLE" as const
          : options.fullManagedCloseAvailable
          ? "FULL_MANAGED_CLOSE_AVAILABLE" as const : leg.role === "SHORT"
          ? "ONE_WAY_REALITY_INSUFFICIENT" as const
          : options.spot ? "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT" as const : "ONE_WAY_REALITY_INSUFFICIENT" as const),
        checkedAt: now + 90,
        positionMode: unknown ? null : options.positionMode ?? "ONE_WAY",
        actualQuantity: unknown ? null : actual,
        actualSignedNetQuantity: unknown || options.positionMode === "HEDGE"
          ? null
          : actual === "0" ? "0" : leg.role === "SHORT" ? `-${actual}` : actual,
        actualLongQuantity: unknown ? null : leg.role === "LONG" ? actual : "0",
        actualShortQuantity: unknown ? null : leg.role === "SHORT" ? actual : "0",
        availableQuantity: unknown ? null : options.spot && leg.legId === "long-leg" ? "1.4" : null,
        ...(reason === "SPOT_AVAILABLE_BALANCE_UNAVAILABLE" && options.transientSafetyRead !== false
          ? { transientReadFailure: true as const }
          : {}),
      });
    },
  }, () => now + 100, {
    sleep: async (milliseconds) => { sleepDelays.push(milliseconds); },
  });
  return { store, service, arbitrageId, dbPath, sleepDelays, safetyReads: () => safetyReadCount };
}

function instance(overrides: Partial<NewArbitrageInstance> = {}): NewArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1",
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0",
    createdAt: now,
    legs: [
      { legId: "long-leg", role: "LONG", venue: "binance", accountId: "account-a", instrumentId: "BTC-USDT-PERP", plannedQuantity: "100" },
      { legId: "short-leg", role: "SHORT", venue: "binance", accountId: "account-a", instrumentId: "BTC-USDT-PERP", plannedQuantity: "100" },
    ],
    ...overrides,
  };
}

function open(
  store: ArbitrageInstanceStore,
  arbitrageId: string,
  legId: string,
  quantity: string,
  at: number,
  userId = "user-a",
) {
  execute(store, arbitrageId, legId, `open-${arbitrageId}-${legId}`, "OPENING", "INCREASE", quantity, at, userId);
}

function close(store: ArbitrageInstanceStore, arbitrageId: string, legId: string, quantity: string, at: number) {
  execute(store, arbitrageId, legId, `close-${arbitrageId}-${legId}`, "CLOSING", "DECREASE", quantity, at);
}

function execute(
  store: ArbitrageInstanceStore,
  arbitrageId: string,
  legId: string,
  intentId: string,
  phase: "OPENING" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  quantity: string,
  at: number,
  userId = "user-a",
  commandId?: string,
) {
  store.claimExecutionReference(userId, arbitrageId, {
    legId, phase, quantityEffect, executionIntentId: intentId, requestedQuantity: quantity, createdAt: at,
    ...(commandId === undefined ? {} : {
      commandId,
      operationType: "EXECUTION_OPEN" as const,
      businessPayloadFingerprint: `opening-fingerprint-${commandId}`,
    }),
  });
  store.linkExecutionRecord(userId, arbitrageId, intentId, `${intentId}-record`, at + 1);
  store.applyExecutionResult(userId, arbitrageId, {
    executionIntentId: intentId, status: "CONFIRMED", confirmedQuantity: quantity, updatedAt: at + 2,
  });
}

function request(legId: string, commandId: string) {
  return { arbitrageId: "arbitrage-1", legId, commandId, confirmed: true } as const;
}
