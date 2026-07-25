import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import { RwaAutomationConnectorRegistry } from "./RwaAutomationConnectorRegistry";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import { RwaAutomationGovernanceError } from "./RwaAutomationGovernance";
import { RwaBybitAutomationConnector } from "./RwaBybitAutomationConnector";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import { RwaNeutralExecutionError, RwaNeutralExecutionService } from "./RwaNeutralExecutionService";
import { createNeutralExecutionRecord } from "./RwaNeutralHedgeExecutionEngine";
import type {
  RwaBybitTradingClient,
  RwaBybitPermissions,
  RwaProviderOrder,
  RwaProviderOrderRequest,
  RwaProviderPreflightSnapshot,
  RwaStrategyPnlSnapshot,
} from "./RwaNeutralExecutionTypes";
import {
  createMonitoredActivityContinuity,
  createUnmonitoredActivityContinuity,
  RWA_ACTIVITY_MAX_GAP_MS,
  RWA_SPOT_ACTIVITY_SOURCES,
  RWA_PERPETUAL_ACTIVITY_SOURCES,
} from "./RwaProviderActivityContinuity";
import type { RwaAssetOrderReference } from "./RwaAccountAssetAuthorization";
import {
  createRwaAssetTakeoverRecord,
  type RwaAssetTakeoverProviderSnapshot,
} from "./RwaAssetTakeover";

const accountId = "bybit:test-account";
const accountFingerprint = "test-account";

test("Bybit asset authorization preview create revoke and rotation remain provider-mutation free", async () => {
  const harness = await createHarness();
  try {
    harness.client.unrelatedSpotQuantity = 0.3;
    harness.client.unrelatedPerpetualQuantity = 0.25;
    harness.client.assetOpenOrders = [
      { category: "spot", orderId: "manual-spot", clientOrderId: "manual-spot", symbol: "XAUTUSDT" },
      { category: "linear", orderId: "manual-perp", clientOrderId: "manual-perp", symbol: "XAUTUSDT" },
    ];
    harness.client.openSpotOrderCount = 1;
    harness.client.openPerpetualOrderCount = 1;
    const writesBefore = providerMutationCount(harness.client);
    const preview = await harness.service.previewAccountAssetAuthorization("xaut");
    assert.equal(preview.spotQuantity, 0.3);
    assert.equal(preview.perpetualQuantity, 0.25);
    assert.equal(preview.spotOrderCount, 1);
    assert.equal(preview.perpetualOrderCount, 1);
    assert.equal("accountId" in preview, false);

    const created = await harness.service.createAccountAssetAuthorization("xaut", preview);
    assert.equal(created.revokedAt, null);
    assert.equal("accountId" in created, false);
    assert.equal((await harness.service.getAccountAssetAuthorization("xaut"))?.authorizationId, created.authorizationId);
    assert.equal(providerMutationCount(harness.client), writesBefore);

    const revoked = await harness.service.revokeAccountAssetAuthorization("xaut");
    assert.equal(revoked.revokedAt, harness.now);
    assert.equal(await harness.service.getAccountAssetAuthorization("xaut"), null);
    assert.equal(providerMutationCount(harness.client), writesBefore);

    const nextPreview = await harness.service.previewAccountAssetAuthorization("xaut");
    await harness.service.createAccountAssetAuthorization("xaut", nextPreview);
    await harness.service.putCredentials({ apiKey: "rotated-api-key-123", apiSecret: "rotated-secret-123" });
    assert.equal(await harness.service.getAccountAssetAuthorization("xaut"), null);
    assert.equal(providerMutationCount(harness.client), writesBefore);
  } finally {
    await harness.cleanup();
  }
});

test("Bybit authorization rejects a preview changed by balance or order activity without provider mutation", async () => {
  const harness = await createHarness();
  try {
    const preview = await harness.service.previewAccountAssetAuthorization("xaut");
    const writesBefore = providerMutationCount(harness.client);
    harness.client.unrelatedSpotQuantity = 0.01;
    await assert.rejects(
      harness.service.createAccountAssetAuthorization("xaut", preview),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "asset_authorization_preview_changed",
    );
    assert.equal(providerMutationCount(harness.client), writesBefore);
    assert.deepEqual((await harness.store.readState()).assetAuthorizations, []);
  } finally {
    await harness.cleanup();
  }
});

test("Bybit takeover reuses the authorized account state and only adds the missing perpetual short", async () => {
  const harness = await createHarness({ availableUsdt: 2_000, unrelatedSpotQuantity: 0.1 });
  try {
    const authorizationPreview = await harness.service.previewAccountAssetAuthorization("xaut");
    await harness.service.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.service.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 1_000,
      leverage: 2,
    });
    const result = await harness.service.startAssetTakeover({
      assetId: "xaut",
      preview,
      idempotencyKey: "takeover:bybit:0001",
    }) as any;
    assert.equal(result.state, "managed");
    assert.deepEqual(harness.client.requests.slice(-1).map((item) => [item.category, item.side]), [
      ["linear", "Sell"],
    ]);
    assert.equal(Math.abs(result.finalPerpetualQuantity - 0.1) < 1e-12, true);
    const writesBeforeSecondStart = providerMutationCount(harness.client);
    await assert.rejects(
      harness.service.startAssetTakeover({
        assetId: "xaut",
        preview,
        idempotencyKey: "takeover:bybit:0002",
      }),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "asset_takeover_risk_rejected",
    );
    assert.equal(providerMutationCount(harness.client), writesBeforeSecondStart);
    await assert.rejects(
      harness.service.revokeAccountAssetAuthorization("xaut"),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "asset_authorization_invalid",
    );
  } finally {
    await harness.cleanup();
  }
});

test("Bybit takeover preserves a pending 1500U execution reserve when checking a 1000U takeover", async () => {
  const harness = await createHarness({ availableUsdt: 2_000 });
  try {
    const authorizationPreview = await harness.service.previewAccountAssetAuthorization("xaut");
    await harness.service.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.service.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 1_000,
      leverage: 2,
    });
    const state = await harness.store.readState();
    const pending = createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: `rwa${harness.store.userDomain}`,
      idempotencyKey: `${harness.store.userDomain}:pending-capital`,
      challengeId: "pending-capital",
      now: harness.now,
    });
    pending.reservedCapitalUsd = 1_500;
    state.executions.push(pending);
    await harness.store.writeState(state);
    const writesBefore = providerMutationCount(harness.client);
    await assert.rejects(
      harness.service.startAssetTakeover({
        assetId: "xaut",
        preview,
        idempotencyKey: "takeover:pending-capital",
      }),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "asset_takeover_risk_rejected",
    );
    assert.equal(providerMutationCount(harness.client), writesBefore);
    assert.equal((await harness.store.readState()).assetTakeovers.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("Bybit takeover recovery propagates lease loss after provider snapshot without a state write", async () => {
  const harness = await createHarness({ availableUsdt: 2_000, unrelatedSpotQuantity: 0.1 });
  try {
    const authorizationPreview = await harness.service.previewAccountAssetAuthorization("xaut");
    await harness.service.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.service.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    state.assetTakeovers.push(createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId,
      preview,
      idempotencyKey: "takeover:recovery-lease-loss",
      orderLinkPrefix: "takeover-recovery-lease-loss",
      now: harness.now,
    }));
    await harness.store.writeState(state);

    let leaseHeld = true;
    harness.client.takeoverSnapshotHook = () => { leaseHeld = false; };
    let writesAfterLeaseSetup = 0;
    const originalWriteState = harness.store.writeState.bind(harness.store);
    harness.store.writeState = async (next) => {
      writesAfterLeaseSetup += 1;
      return originalWriteState(next);
    };
    const restarted = new RwaNeutralExecutionService(
      harness.store,
      () => harness.client,
      () => harness.now,
      () => false,
      () => {
        if (!leaseHeld) {
          throw new RwaAutomationExecutionLeaseError(
            "automation_execution_lease_lost",
            "simulated takeover recovery lease loss",
          );
        }
      },
    );
    const writesBefore = providerMutationCount(harness.client);
    await assert.rejects(
      restarted.initialize(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
    assert.equal(providerMutationCount(harness.client), writesBefore);
    assert.equal(writesAfterLeaseSetup, 0);
    assert.equal((await harness.store.readState()).assetTakeovers[0]?.state, "planned");
  } finally {
    await harness.cleanup();
  }
});

test("eligible opportunity executes a two-leg hedge once and idempotent retry sends no duplicate orders", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const input = {
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:test:0001",
    };
    const first = await harness.service.execute(input) as any;
    assert.equal(first.state, "hedged");
    assert.equal(first.hedgedQuantityXaut, 0.002);
    assert.equal(harness.client.spotQuantity, 0.002);
    assert.equal(harness.client.perpetualQuantity, 0.002);
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
    ]);
    const writes = harness.client.requests.length;
    const repeated = await harness.service.execute(input) as any;
    assert.equal(repeated.executionId, first.executionId);
    assert.equal(harness.client.requests.length, writes);
    const stateRaw = await readFile(harness.statePath, "utf8");
    assert.doesNotMatch(stateRaw, new RegExp(challenge.challengeToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await harness.cleanup();
  }
});

test("Neutral execute rejects invalid runtime profile fields before provider mutations", async () => {
  const invalidCases: Array<[string, (execution: any) => void]> = [
    ["unknown-asset", (execution) => { execution.asset = "DOGE"; }],
    ["partial-profile", (execution) => { delete execution.profileId; }],
    ["negative-capital", (execution) => { execution.reservedCapitalUsd = -1; }],
    ["nan-capital", (execution) => { execution.reservedCapitalUsd = Number.NaN; }],
    ["infinite-capital", (execution) => { execution.reservedCapitalUsd = Number.POSITIVE_INFINITY; }],
  ];
  for (const [label, corrupt] of invalidCases) {
    const harness = await createHarness();
    try {
      const challenge = await harness.service.preflight(opportunity(true), accountId);
      const state = await harness.store.readState();
      const invalid = createNeutralExecutionRecord({
        userId: "user-a",
        accountId,
        userOrderPrefix: `rwa${harness.store.userDomain}`,
        idempotencyKey: `${harness.store.userDomain}:invalid:${label}`,
        challengeId: `invalid:${label}`,
        now: harness.now,
      });
      invalid.state = "manual_intervention";
      invalid.reservedCapitalUsd = 25;
      corrupt(invalid);
      state.executions.push(invalid);
      harness.store.readState = async () => state;

      await assert.rejects(
        harness.service.execute({
          accountId,
          challengeId: challenge.challengeId,
          challengeToken: challenge.challengeToken,
          idempotencyKey: `entry:invalid:${label}`,
        }),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_risk_state_invalid",
      );
      assert.equal(harness.client.leverageWrites, 0);
      assert.equal(harness.client.requests.length, 0);
      assert.equal(harness.client.cancelScopes.length, 0);
    } finally {
      await harness.cleanup();
    }
  }
});

test("negative funding blocks arbitrage_entry before any provider write", async () => {
  const harness = await createHarness({ fundingRate: -0.0000281 });
  try {
    await assert.rejects(
      harness.service.preflight(opportunity(true), accountId),
      (error: unknown) => {
        assert.ok(error instanceof RwaNeutralExecutionError);
        assert.equal(error.category, "preflight_rejected");
        const report = error.details?.report as any;
        assert.equal(report.fundingRate, -0.0000281);
        assert.equal(report.checks.find((item: any) => item.name === "funding_direction")?.passed, false);
        return true;
      },
    );
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);
  } finally {
    await harness.cleanup();
  }
});

test("manual_entry keeps private safety checks but treats funding and return thresholds as warnings through execution", async () => {
  const harness = await createHarness({ fundingRate: -0.0000281 });
  try {
    const challenge = await harness.service.preflight(opportunity(false), accountId, "manual_entry");
    assert.equal(challenge.report.action, "manual_entry");
    assert.equal(challenge.report.mode, "manual_entry");
    assert.equal(challenge.report.passed, true);
    assert.ok(!challenge.report.checks.some((item) =>
      item.name === "funding_direction" || item.name === "entry_basis" || item.name === "net_apr"));
    assert.match(challenge.report.warnings.join(" "), /Funding.*自行决策/);

    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:manual:negative-funding",
    }) as any;

    assert.equal(result.state, "hedged");
    assert.equal(harness.client.leverageWrites, 1);
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("manual_entry still rejects insufficient private balance before provider writes", async () => {
  const harness = await createHarness({ availableUsdt: 0 });
  try {
    await assert.rejects(
      harness.service.preflight(opportunity(false), accountId, "manual_entry"),
      (error: unknown) => {
        assert.ok(error instanceof RwaNeutralExecutionError);
        assert.equal(error.category, "preflight_rejected");
        const report = error.details?.report as any;
        assert.equal(report.mode, "manual_entry");
        assert.equal(report.checks.find((item: any) => item.name === "balance")?.passed, false);
        return true;
      },
    );
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);
  } finally {
    await harness.cleanup();
  }
});

test("second-leg failure cancels and exits the filled spot leg instead of leaving one-leg exposure", async () => {
  const harness = await createHarness({ failSecondLeg: true });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:test:failure",
    }) as any;
    assert.equal(result.state, "failed");
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
    assert.equal(harness.client.spotQuantity, 0);
    assert.equal(harness.client.perpetualQuantity, 0);
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
      ["spot", "Sell"],
    ]);
    assert.ok(harness.client.cancelScopes.length >= 1);
  } finally {
    await harness.cleanup();
  }
});

test("restart disarms an unused challenge and never reaches provider writes", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const restarted = new RwaNeutralExecutionService(harness.store, () => harness.client, () => harness.now, () => false);
    await assert.rejects(
      restarted.execute({
        accountId,
        challengeId: challenge.challengeId,
        challengeToken: challenge.challengeToken,
        idempotencyKey: "entry:test:restart",
      }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "restart_disarmed",
    );
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("lease loss after execution reservation performs zero provider writes and leaves restart-safe recovery state", async () => {
  let guardCalls = 0;
  let failAt = Number.POSITIVE_INFINITY;
  const harness = await createHarness({
    leaseGuard: () => {
      guardCalls += 1;
      if (guardCalls >= failAt) throw new Error("lease unavailable");
    },
  });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    guardCalls = 0;
    failAt = 2;
    await assert.rejects(harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:lease-loss:1",
    }), /lease unavailable/);
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);
    const state = await harness.store.readState();
    const execution = state.executions.find((item) => item.idempotencyKey.endsWith("entry:lease-loss:1"));
    assert.equal(execution?.state, "accepted");
    assert.equal(state.challenges.some((item) =>
      item.id === challenge.challengeId && item.consumedAt === null), false);
    assert.equal(state.config.killSwitchActive, false);
  } finally {
    await harness.cleanup();
  }
});

test("lease loss after the first spot mutation prevents perpetual and compensation writes", async () => {
  let leaseHeld = true;
  const harness = await createHarness({
    leaseGuard: () => {
      if (!leaseHeld) throw new Error("lease unavailable");
    },
  });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    harness.client.mutationHook = (kind, request) => {
      if (kind === "place" && request?.category === "spot" && request.side === "Buy") leaseHeld = false;
    };
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:lease-loss-after-spot",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [["spot", "Buy"]]);
    assert.equal(harness.client.cancelScopes.length, 0);
    const persisted = await harness.store.readState();
    const execution = persisted.executions.find((item) => item.executionId === result.executionId)!;
    assert.deepEqual(execution.activityContinuity.spot.providerOrderIds, ["order-1"]);
    assert.deepEqual(execution.activityContinuity.perpetual.providerOrderIds, []);
  } finally {
    await harness.cleanup();
  }
});

test("lease loss after the leverage mutation prevents all order writes", async () => {
  let leaseHeld = true;
  const harness = await createHarness({
    leaseGuard: () => {
      if (!leaseHeld) throw new Error("lease unavailable");
    },
  });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    harness.client.mutationHook = (kind) => {
      if (kind === "leverage") leaseHeld = false;
    };
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:lease-loss-after-leverage",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(harness.client.leverageWrites, 1);
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.cancelScopes.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("incomplete activity baseline blocks leverage and order mutations", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    harness.client.attributionCoverage = "incomplete";
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:incomplete-activity-baseline",
    }) as any;
    assert.equal(result.state, "failed");
    assert.equal(harness.client.leverageWrites, 0);
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.cancelScopes.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("existing XAUT activity orders block monitoring before any provider mutation", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    harness.client.openSpotOrderCount = 1;
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:existing-open-order",
    }) as any;
    assert.equal(result.state, "failed");
    assert.equal(harness.client.leverageWrites, 0);
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("activity monitor source failure permanently disarms exposure without provider mutations", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const opened = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:monitor-source-failure",
    }) as any;
    assert.equal(opened.state, "hedged");
    const writesBefore = harness.client.leverageWrites + harness.client.requests.length
      + harness.client.cancelScopes.length;
    harness.client.attributionCoverage = "incomplete";
    assert.equal(await harness.service.refreshActivityContinuity(), false);
    const state = await harness.store.readState();
    const execution = state.executions.find((item) => item.executionId === opened.executionId)!;
    assert.equal(execution.state, "manual_intervention");
    assert.equal(execution.activityContinuity.spot.coverage, "ambiguous");
    assert.equal(execution.activityContinuity.perpetual.coverage, "ambiguous");
    assert.equal(state.config.globalExecutionEnabled, false);
    assert.equal(state.config.strategyEnabled, false);
    assert.equal(state.config.killSwitchActive, true);
    assert.equal(
      harness.client.leverageWrites + harness.client.requests.length + harness.client.cancelScopes.length,
      writesBefore,
    );
  } finally {
    await harness.cleanup();
  }
});

test("activity monitor propagates lease loss after a scan so control startup cannot continue", async () => {
  let loseLease = false;
  const harness = await createHarness({
    activityMonitoringEnabled: () => true,
    leaseGuard: () => {
      if (loseLease) {
        throw new RwaAutomationExecutionLeaseError(
          "automation_execution_lease_lost",
          "simulated lease loss",
        );
      }
    },
  });
  try {
    await seedTrackedHedge(harness, 0.002);
    harness.client.spotQuantity = 0.002;
    harness.client.perpetualQuantity = 0.002;
    harness.client.attributionHook = () => { loseLease = true; };

    await assert.rejects(
      harness.service.refreshActivityContinuity(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
    assert.equal(harness.client.attributionReads, 1);
    assert.equal(harness.client.leverageWrites, 0);
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.cancelScopes.length, 0);

    loseLease = false;
    const registry = new RwaAutomationConnectorRegistry([
      new RwaBybitAutomationConnector(harness.service),
    ]);
    await assert.rejects(
      registry.startActivityMonitoring(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
  } finally {
    await harness.cleanup();
  }
});

test("restart disarms an unmonitored legacy exposure before any provider read or mutation", async () => {
  const harness = await createHarness();
  try {
    await seedTrackedHedge(harness, 0.002);
    const state = await harness.store.readState();
    const execution = state.executions[0]!;
    execution.activityContinuity = createUnmonitoredActivityContinuity(execution.createdAt);
    state.config.globalExecutionEnabled = true;
    state.config.strategyEnabled = true;
    state.config.killSwitchActive = false;
    await harness.store.writeState(state);

    assert.equal(await harness.service.refreshActivityContinuity(), false);
    const recovered = await harness.store.readState();
    assert.equal(recovered.executions[0]?.state, "manual_intervention");
    assert.equal(recovered.executions[0]?.activityContinuity.spot.coverage, "ambiguous");
    assert.equal(recovered.executions[0]?.activityContinuity.perpetual.coverage, "ambiguous");
    assert.equal(recovered.config.globalExecutionEnabled, false);
    assert.equal(recovered.config.strategyEnabled, false);
    assert.equal(recovered.config.killSwitchActive, true);
    assert.equal(harness.client.preflightReads, 0);
    assert.equal(harness.client.attributionReads, 0);
    assert.equal(harness.client.leverageWrites, 0);
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.cancelScopes.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("restart gap beyond 24 hours enters manual intervention before cancellation or exit writes", async () => {
  const harness = await createHarness();
  try {
    await seedTrackedHedge(harness, 0.002);
    const state = await harness.store.readState();
    const execution = state.executions[0]!;
    const staleAt = harness.now - RWA_ACTIVITY_MAX_GAP_MS - 1;
    execution.createdAt = staleAt;
    execution.updatedAt = staleAt;
    execution.strategyPosition.updatedAt = staleAt;
    execution.activityContinuity = createMonitoredActivityContinuity(staleAt, execution.orderLinkPrefix);
    await harness.store.writeState(state);
    harness.client.spotQuantity = 0.002;
    harness.client.perpetualQuantity = 0.002;
    harness.client.attributionCheckedFrom = staleAt;
    harness.client.attributionCheckedThrough = harness.now;
    await harness.service.initialize();
    assert.equal(await harness.service.refreshActivityContinuity(), false);
    const recovered = await harness.store.readState();
    assert.equal(recovered.executions[0]?.state, "manual_intervention");
    assert.equal(recovered.config.killSwitchActive, true);
    assert.equal(harness.client.cancelScopes.length, 0);
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("lease loss during a failed perpetual mutation prevents compensation provider writes", async () => {
  let leaseHeld = true;
  const harness = await createHarness({
    failSecondLeg: true,
    leaseGuard: () => {
      if (!leaseHeld) throw new Error("lease unavailable");
    },
  });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    harness.client.mutationHook = (kind, request) => {
      if (kind === "place" && request?.category === "linear" && request.side === "Sell") leaseHeld = false;
    };
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:lease-loss-compensation",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.deepEqual(harness.client.requests.map((item) => [item.category, item.side]), [
      ["spot", "Buy"],
      ["linear", "Sell"],
    ]);
    assert.equal(harness.client.cancelScopes.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("lease loss after close-all cancellation prevents subsequent exit mutations", async () => {
  let leaseHeld = true;
  const harness = await createHarness({
    leaseGuard: () => {
      if (!leaseHeld) throw new Error("lease unavailable");
    },
  });
  try {
    await seedTrackedHedge(harness, 0.002);
    harness.client.spotQuantity = 0.002;
    harness.client.perpetualQuantity = 0.002;
    harness.client.mutationHook = (kind) => {
      if (kind === "cancel_strategy") leaseHeld = false;
    };
    const result = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:lease-loss-after-cancel",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(harness.client.cancelScopes.length, 1);
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("recovery rejects untracked provider exposure before cancellation or exit mutations", async () => {
  let leaseHeld = true;
  const harness = await createHarness();
  try {
    const state = await harness.store.readState();
    state.executions.push(createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: `rwa${harness.store.userDomain}`,
      idempotencyKey: `${harness.store.userDomain}:recovery-lease-loss`,
      challengeId: "recovery-lease-loss",
      now: harness.now,
    }));
    await harness.store.writeState(state);
    harness.client.spotQuantity = 0.002;
    harness.client.perpetualQuantity = 0.002;
    harness.client.mutationHook = (kind) => {
      if (kind === "cancel_strategy") leaseHeld = false;
    };
    const restarted = new RwaNeutralExecutionService(
      harness.store,
      () => harness.client,
      () => harness.now,
      () => false,
      () => {
        if (!leaseHeld) throw new Error("lease unavailable");
      },
    );
    await restarted.initialize();
    const recovered = await harness.store.readState();
    assert.equal(recovered.executions.at(-1)?.state, "manual_intervention");
    assert.equal(harness.client.cancelScopes.length, 0);
    assert.equal(harness.client.requests.length, 0);
    assert.equal(recovered.config.killSwitchActive, true);
  } finally {
    await harness.cleanup();
  }
});

test("credential validation rejects withdraw permission and never persists the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-execution-permission-"));
  const store = new RwaAutomationPersistentStore({
    userId: "user-a",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credentials.enc.json"),
    statePath: join(directory, "state.json"),
  });
  const client = new FakeBybitClient({ withdraw: true });
  const service = new RwaNeutralExecutionService(store, () => client, () => 1_800_000_000_000);
  try {
    await assert.rejects(
      service.putCredentials({ apiKey: "owner-api-key", apiSecret: "owner-secret-value" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "permission_rejected",
    );
    assert.equal(await store.hasCredentials(), false);
    assert.doesNotMatch(JSON.stringify(await service.getCredentialStatus()), /owner-secret-value/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing IP whitelist is a high-risk warning, not an activation or preflight blocker", async () => {
  const harness = await createHarness({ ipRestricted: false });
  try {
    const status = await harness.service.getCredentialStatus();
    assert.equal(status.lifecycleStatus, "active");
    assert.equal(status.ipWhitelistConfigured, false);
    assert.match(status.warnings.join(" "), /IP 白名单/);
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    assert.match(challenge.report.warnings.join(" "), /IP 白名单/);
  } finally {
    await harness.cleanup();
  }
});

test("preflight and execute revalidate the selected account permissions", async () => {
  const harness = await createHarness();
  try {
    const before = harness.client.validateCalls;
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    assert.ok(harness.client.validateCalls > before);
    const afterPreflight = harness.client.validateCalls;
    await harness.service.execute({ accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey: "entry:permission:1" });
    assert.ok(harness.client.validateCalls > afterPreflight);
  } finally {
    await harness.cleanup();
  }
});

test("credential key provider failure blocks new-risk controls and provider writes", async () => {
  const harness = await createHarness();
  const executeHarness = await createHarness();
  try {
    harness.keyProvider.failCategory = "credential_key_provider_unavailable";
    await assert.rejects(
      harness.service.updateConfig({ accountId, strategyEnabled: true }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_key_provider_unavailable",
    );
    let state = await harness.store.readState();
    assert.equal(state.config.globalExecutionEnabled, false);
    assert.equal(state.config.strategyEnabled, false);
    assert.equal(state.config.killSwitchActive, true);

    await assert.rejects(
      harness.service.setKillSwitch(false, accountId),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_key_provider_unavailable",
    );

    state = await harness.store.readState();
    state.config.globalExecutionEnabled = true;
    state.config.strategyEnabled = true;
    state.config.killSwitchActive = false;
    await harness.store.writeState(state);
    await assert.rejects(
      harness.service.preflight(opportunity(true), accountId),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_key_provider_unavailable",
    );
    assert.equal(harness.client.requests.length, 0);
    assert.equal(harness.client.leverageWrites, 0);

    const challenge = await executeHarness.service.preflight(opportunity(true), accountId);
    executeHarness.keyProvider.failCategory = "credential_key_provider_unavailable";
    const execution = await executeHarness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:kms-failure",
    }) as any;
    assert.equal(execution.state, "manual_intervention");
    assert.equal(execution.errorCategory, "credential_key_provider_unavailable");
    assert.equal(executeHarness.client.requests.length, 0);
    assert.equal(executeHarness.client.leverageWrites, 0);
  } finally {
    await harness.cleanup();
    await executeHarness.cleanup();
  }
});

test("credential deletion is blocked while strategy exposure exists and succeeds after close-all", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({ accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey: "entry:delete:1" });
    await assert.rejects(
      harness.service.deleteCredentials({ accountId }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "credential_delete_blocked",
    );
    assert.equal(await harness.store.hasCredentials(), true);
    await harness.service.closeAll({ accountId, idempotencyKey: "close:delete:1" });
    const deleted = await harness.service.deleteCredentials({ accountId }) as any;
    assert.equal(deleted.ok, true);
    assert.equal(await harness.store.hasCredentials(), false);
    assert.equal(deleted.credentials.lifecycleStatus, "unconfigured");
  } finally {
    await harness.cleanup();
  }
});

test("invalid credentials refuse unsafe deletion and return manual intervention guidance", async () => {
  const harness = await createHarness();
  try {
    harness.client.accessUnavailable = true;
    await assert.rejects(
      harness.service.deleteCredentials({ accountId }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_delete_manual_intervention"
        && /人工撤单和平仓/.test(error.message),
    );
    assert.equal(await harness.store.hasCredentials(), true);
    const state = await harness.store.readState();
    assert.equal(state.config.killSwitchActive, true);
    assert.match(state.credentialAlert ?? "", /人工撤单和平仓/);
  } finally {
    await harness.cleanup();
  }
});

test("failed credential rotation keeps the previous encrypted credential active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-rotation-"));
  const store = new RwaAutomationPersistentStore({ userId: "user-a", keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credentials.enc.json"), statePath: join(directory, "state.json") });
  const validClient = new FakeBybitClient();
  const service = new RwaNeutralExecutionService(store, (credentials) => {
    if (credentials.apiKey.includes("new")) return { ...validClient, validateAccess: async () => { throw new Error("candidate rejected secret=hidden"); } } as any;
    return validClient;
  }, () => 1_800_000_000_000, () => false);
  try {
    await service.putCredentials({ apiKey: "old-api-key-123", apiSecret: "old-secret-value-123" });
    await assert.rejects(service.putCredentials({ apiKey: "new-api-key-123", apiSecret: "new-secret-value-123" }));
    assert.deepEqual(await store.loadCredentials(), { apiKey: "old-api-key-123", apiSecret: "old-secret-value-123" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("close-all retries partial exits and confirms provider exposure is zero", async () => {
  const harness = await createHarness({ partialClose: true });
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({ accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey: "entry:partial-close" });
    const closed = await harness.service.closeAll({ accountId, idempotencyKey: "close:partial-close" }) as any;
    assert.equal(closed.state, "closed");
    assert.equal(harness.client.spotQuantity, 0);
    assert.equal(harness.client.perpetualQuantity, 0);
    assert.equal(harness.client.closeFillAttempts.spot, 2);
    assert.equal(harness.client.closeFillAttempts.linear, 2);
  } finally {
    await harness.cleanup();
  }
});

test("close-all refuses ambiguous extra spot inventory without selling", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:unrelated-spot",
    });
    harness.client.unrelatedSpotQuantity = 0.01;
    const closed = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:unrelated-spot",
    }) as any;
    assert.equal(closed.state, "manual_intervention");
    assert.equal(harness.client.spotQuantity, 0.002);
    assert.equal(harness.client.unrelatedSpotQuantity, 0.01);
    assert.equal(
      harness.client.requests
        .filter((request) => request.category === "spot" && request.side === "Sell")
        .reduce((total, request) => total + request.quantityXaut, 0),
      0,
    );
    assert.equal((await harness.store.readState()).config.killSwitchActive, true);
  } finally {
    await harness.cleanup();
  }
});

test("close-all uses durable hedged executions when the recent provider ledger is empty", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:older-than-ledger-window",
    });
    harness.client.strategyPnlQuantityOverride = { spot: 0, perpetual: 0 };
    const closed = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:older-than-ledger-window",
    }) as any;
    assert.equal(closed.state, "closed");
    assert.equal(harness.client.spotQuantity, 0);
    assert.equal(harness.client.perpetualQuantity, 0);
  } finally {
    await harness.cleanup();
  }
});

test("close-all blocks external partial spot sale mixed with unrelated inventory", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:external-mixed",
    });
    harness.client.spotQuantity = 0.001;
    harness.client.unrelatedSpotQuantity = 0.01;
    const writesBefore = harness.client.requests.length;
    const result = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:external-mixed",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(result.errorCategory, "strategy_ownership_ambiguous");
    assert.equal(harness.client.requests.length, writesBefore);
  } finally {
    await harness.cleanup();
  }
});

test("close-all blocks same-net external inventory replacement before provider mutations", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:external-same-net",
    });
    harness.client.spotQuantity -= 0.001;
    harness.client.unrelatedSpotQuantity += 0.001;
    harness.client.externalPositionActivity = true;
    const writesBefore = harness.client.requests.length;
    const result = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:external-same-net",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(result.errorCategory, "strategy_ownership_ambiguous");
    assert.equal(harness.client.requests.length, writesBefore);
    assert.equal(harness.client.cancelScopes.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("close-all blocks incomplete provider activity coverage before provider mutations", async () => {
  const harness = await createHarness();
  try {
    await seedTrackedHedge(harness, 0.002);
    harness.client.spotQuantity = 0.002;
    harness.client.perpetualQuantity = 0.002;
    harness.client.attributionCoverage = "incomplete";
    const result = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:incomplete-attribution",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(result.errorCategory, "strategy_ownership_ambiguous");
    assert.equal(harness.client.cancelScopes.length, 0);
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("close-all blocks an activity coverage gap or stale provider watermark before mutations", async () => {
  for (const mode of ["gap", "stale"] as const) {
    const harness = await createHarness();
    try {
      await seedTrackedHedge(harness, 0.002);
      harness.client.spotQuantity = 0.002;
      harness.client.perpetualQuantity = 0.002;
      if (mode === "gap") harness.client.attributionCheckedFrom = harness.now + 1;
      else harness.client.attributionCheckedThrough = harness.now - 1;
      const result = await harness.service.closeAll({
        accountId,
        idempotencyKey: `close:attribution-${mode}`,
      }) as any;
      assert.equal(result.state, "manual_intervention");
      assert.equal(result.errorCategory, "strategy_ownership_ambiguous");
      assert.equal(harness.client.cancelScopes.length, 0);
      assert.equal(harness.client.requests.length, 0);
    } finally {
      await harness.cleanup();
    }
  }
});

test("malformed provider position quantity is rejected before ledger persistence or a second order", async () => {
  const harness = await createHarness();
  try {
    harness.client.invalidPositionQuantity = true;
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    const result = await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:invalid-position-quantity",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(result.errorCategory, "provider_snapshot_invalid");
    assert.equal(harness.client.requests.length, 1);
    const state = await harness.store.readState();
    const persisted = state.executions.find((item) => item.executionId === result.executionId);
    assert.equal(persisted?.spotOrder, null);
    assert.deepEqual(persisted?.perpetualOrders, []);
    assert.equal(persisted?.strategyPosition.spotRemainingXaut, 0);
    assert.equal(persisted?.strategyPosition.perpetualRemainingXaut, 0);
  } finally {
    await harness.cleanup();
  }
});

test("close-all rejects invalid authoritative quantities before provider mutations", async () => {
  const harness = await createHarness();
  try {
    await seedTrackedHedge(harness, 0.002);
    harness.client.spotQuantity = Number.NaN;
    harness.client.perpetualQuantity = 0.002;
    const result = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:invalid-authority",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(result.errorCategory, "provider_snapshot_invalid");
    assert.equal(harness.client.cancelScopes.length, 0);
    assert.equal(harness.client.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("close-all refuses an unrelated perpetual position without provider mutations", async () => {
  const harness = await createHarness();
  try {
    const challenge = await harness.service.preflight(opportunity(true), accountId);
    await harness.service.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "entry:extra-perpetual",
    });
    harness.client.unrelatedPerpetualQuantity = 0.01;
    const writesBefore = harness.client.requests.length;
    const result = await harness.service.closeAll({
      accountId,
      idempotencyKey: "close:extra-perpetual",
    }) as any;
    assert.equal(result.state, "manual_intervention");
    assert.equal(result.errorCategory, "strategy_ownership_ambiguous");
    assert.equal(harness.client.requests.length, writesBefore);
    assert.equal(harness.client.cancelScopes.length, 0);
  } finally {
    await harness.cleanup();
  }
});

async function seedTrackedHedge(
  harness: Awaited<ReturnType<typeof createHarness>>,
  quantityXaut: number,
) {
  const state = await harness.store.readState();
  const execution = createNeutralExecutionRecord({
    userId: "user-a",
    accountId,
    userOrderPrefix: `rwa${harness.store.userDomain}`,
    idempotencyKey: `${harness.store.userDomain}:seed:${state.executions.length}`,
    challengeId: `seed:${state.executions.length}`,
    now: harness.now,
  });
  execution.state = "hedged";
  execution.hedgedQuantityXaut = quantityXaut;
  execution.strategyPosition = {
    coverage: "complete",
    spotRemainingXaut: quantityXaut,
    perpetualRemainingXaut: quantityXaut,
    updatedAt: harness.now,
  };
  execution.activityContinuity = createMonitoredActivityContinuity(harness.now, execution.orderLinkPrefix);
  state.executions.push(execution);
  await harness.store.writeState(state);
}

function providerMutationCount(client: FakeBybitClient) {
  return client.leverageWrites + client.requests.length + client.cancelScopes.length;
}

async function createHarness(options: {
  fundingRate?: number;
  failSecondLeg?: boolean;
  ipRestricted?: boolean;
  partialClose?: boolean;
  availableUsdt?: number;
  unrelatedSpotQuantity?: number;
  leaseGuard?: () => void;
  activityMonitoringEnabled?: () => boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-execution-"));
  const credentialPath = join(directory, "credentials.enc.json");
  const statePath = join(directory, "state.json");
  const keyProvider = new FakeCredentialKeyProvider();
  const store = new RwaAutomationPersistentStore({
    userId: "user-a",
    keyProvider,
    credentialPath,
    statePath,
  });
  const now = 1_800_000_000_000;
  const client = new FakeBybitClient({ ...options, now });
  const service = new RwaNeutralExecutionService(
    store,
    () => client,
    () => now,
    () => false,
    options.leaseGuard,
    options.activityMonitoringEnabled,
  );
  await service.putCredentials({ apiKey: "owner-api-key-123", apiSecret: "owner-secret-value-123" });
  await service.updateConfig({ accountId, globalExecutionEnabled: true, strategyEnabled: true });
  await service.setKillSwitch(false, accountId);
  return {
    service,
    client,
    keyProvider,
    store,
    statePath,
    now,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class FakeBybitClient implements RwaBybitTradingClient {
  readonly requests: RwaProviderOrderRequest[] = [];
  readonly cancelScopes: string[] = [];
  spotQuantity = 0;
  perpetualQuantity = 0;
  leverageWrites = 0;
  preflightReads = 0;
  attributionReads = 0;
  validateCalls = 0;
  accessUnavailable = false;
  mutationHook: (
    kind: "leverage" | "place" | "cancel_order" | "cancel_strategy",
    request?: RwaProviderOrderRequest,
  ) => void = () => {};
  readonly closeFillAttempts = { spot: 0, linear: 0 };
  private orderCounter = 0;
  private readonly orders = new Map<string, RwaProviderOrderRequest>();
  private readonly fundingRate: number;
  private readonly failSecondLeg: boolean;
  private readonly withdraw: boolean;
  private readonly ipRestricted: boolean;
  private readonly partialClose: boolean;
  private readonly availableUsdt: number;
  private readonly now: number;
  unrelatedSpotQuantity: number;
  unrelatedPerpetualQuantity = 0;
  strategyPnlQuantityOverride: { spot: number; perpetual: number } | null = null;
  attributionCoverage: "complete" | "incomplete" = "complete";
  externalPositionActivity = false;
  attributionCheckedFrom: number | null = null;
  attributionCheckedThrough: number | null = null;
  attributionHook: () => void = () => {};
  invalidPositionQuantity = false;
  openSpotOrderCount = 0;
  openPerpetualOrderCount = 0;
  assetOpenOrders: RwaAssetOrderReference[] = [];
  takeoverSnapshotHook: () => void = () => {};

  constructor(options: {
    fundingRate?: number;
    failSecondLeg?: boolean;
    withdraw?: boolean;
    ipRestricted?: boolean;
    partialClose?: boolean;
    availableUsdt?: number;
    unrelatedSpotQuantity?: number;
    now?: number;
  } = {}) {
    this.fundingRate = options.fundingRate ?? 0.0002;
    this.failSecondLeg = options.failSecondLeg ?? false;
    this.withdraw = options.withdraw ?? false;
    this.ipRestricted = options.ipRestricted ?? true;
    this.partialClose = options.partialClose ?? false;
    this.availableUsdt = options.availableUsdt ?? 25;
    this.unrelatedSpotQuantity = options.unrelatedSpotQuantity ?? 0;
    this.now = options.now ?? 1_800_000_000_000;
  }

  async validateAccess() {
    this.validateCalls += 1;
    if (this.accessUnavailable) throw new Error("simulated revoked credential secret=must-not-leak");
    return { permissions: permissions(this.withdraw, this.ipRestricted), accountMode: "uta" as const, accountId, accountFingerprint };
  }

  async readPreflightSnapshot(): Promise<RwaProviderPreflightSnapshot> {
    this.preflightReads += 1;
    return {
      accountId,
      accountFingerprint,
      fetchedAt: this.now,
      accountMode: "uta",
      permissions: permissions(this.withdraw, this.ipRestricted),
      availableUsdt: this.availableUsdt,
      existingSpotQuantityXaut: Math.max(0, this.spotQuantity + this.unrelatedSpotQuantity),
      existingPerpetualQuantityXaut: Math.max(0, this.perpetualQuantity + this.unrelatedPerpetualQuantity),
      spotAvailableQuantityXaut: Math.max(0, this.spotQuantity + this.unrelatedSpotQuantity),
      spotLockedQuantityXaut: 0,
      perpetualPositionSide: this.perpetualQuantity + this.unrelatedPerpetualQuantity > 0 ? "short" : "flat",
      openSpotOrderCount: this.openSpotOrderCount,
      openPerpetualOrderCount: this.openPerpetualOrderCount,
      spot: { status: "Trading", minOrderQty: 0.00001, qtyStep: 0.00001, minNotionalUsd: 5, priceTick: 0.01, bid: 4129, ask: 4130 },
      perpetual: {
        status: "Trading",
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.1,
        bid: 4128,
        ask: 4129,
        mark: 4128.5,
        fundingRate: this.fundingRate,
        fundingIntervalHours: 4,
        liquidationDistancePercent: null,
      },
      fees: { spotTakerBps: 1, perpetualTakerBps: 1 },
    };
  }

  async readAssetTakeoverSnapshot(): Promise<RwaAssetTakeoverProviderSnapshot<RwaBybitPermissions>> {
    const account = await this.readPreflightSnapshot();
    if (account.existingPerpetualQuantityXaut > 0) {
      account.perpetual.liquidationDistancePercent = 50;
    }
    const snapshot = {
      account,
      orders: structuredClone(this.assetOpenOrders),
      spotAskDepth: [{ price: account.spot.ask, quantityBase: 10 }],
      perpetualBidDepth: [{ price: account.perpetual.bid, quantityBase: 10 }],
      fundingRates30d: [0.0001, 0.0002, 0.0003],
      perpetualInitialMarginUsd: account.existingPerpetualQuantityXaut * account.perpetual.mark / 2,
      perpetualLeverage: account.existingPerpetualQuantityXaut > 0 ? 2 : null,
      spotAvailableUsdt: account.availableUsdt,
      perpetualAvailableUsdt: account.availableUsdt,
    };
    this.takeoverSnapshotHook();
    return snapshot;
  }

  async findOrderByClientOrderId() {
    return null;
  }

  async setPerpetualLeverage(_leverage: 1) {
    this.leverageWrites += 1;
    this.mutationHook("leverage");
  }

  async listAssetOpenOrders() {
    return structuredClone(this.assetOpenOrders);
  }

  async placeOrder(request: RwaProviderOrderRequest) {
    this.requests.push(request);
    this.mutationHook("place", request);
    if (this.failSecondLeg && request.category === "linear" && request.side === "Sell") {
      throw new Error("simulated second-leg failure secret=must-not-leak");
    }
    const orderId = `order-${++this.orderCounter}`;
    this.orders.set(orderId, request);
    return { orderId, orderLinkId: request.orderLinkId };
  }

  async awaitOrder(_category: "spot" | "linear", orderId: string, _deadlineAt: number) {
    const request = this.orders.get(orderId)!;
    const closing = (request.category === "spot" && request.side === "Sell") || (request.category === "linear" && request.side === "Buy");
    let filledQuantity = request.quantityXaut;
    if (this.partialClose && closing) {
      this.closeFillAttempts[request.category] += 1;
      if (this.closeFillAttempts[request.category] === 1) filledQuantity = request.quantityXaut / 2;
    }
    if (request.category === "spot") {
      this.spotQuantity += request.side === "Buy" ? filledQuantity : -filledQuantity;
    } else {
      this.perpetualQuantity += request.side === "Sell" ? filledQuantity : -filledQuantity;
    }
    return {
      ...order(orderId, request, this.now),
      status: filledQuantity < request.quantityXaut ? "PartiallyFilled" as const : "Filled" as const,
      filledQuantityXaut: filledQuantity,
      ...(this.invalidPositionQuantity ? { positionQuantityXaut: Number.NaN } : {}),
    };
  }

  async cancelOrder() {
    this.mutationHook("cancel_order");
  }

  async cancelStrategyOrders(scope: string) {
    this.cancelScopes.push(scope);
    this.mutationHook("cancel_strategy");
  }

  async readPositionAttribution(input: {
    strategyOrderPrefix: string;
    strategyOrderPrefixes: string[];
    since: number;
  }) {
    this.attributionReads += 1;
    this.attributionHook();
    const checkedFrom = this.attributionCheckedFrom ?? input.since;
    const checkedThrough = this.attributionCheckedThrough ?? this.now;
    return {
      coverage: this.attributionCoverage,
      externalPositionActivity: this.externalPositionActivity,
      checkedFrom,
      checkedThrough,
      sources: [...new Set([...RWA_SPOT_ACTIVITY_SOURCES, ...RWA_PERPETUAL_ACTIVITY_SOURCES])].map((source) => ({
        source,
        coverage: this.attributionCoverage,
        checkedFrom,
        checkedThrough,
        cursor: null,
        eventIds: [],
        externalActivity: this.externalPositionActivity,
      })),
      providerOrderIds: { spot: [], perpetual: [] },
    };
  }

  async readStrategyPnl(): Promise<RwaStrategyPnlSnapshot> {
    const spotMark = 4130;
    const perpMark = 4128;
    const strategySpotQuantity = this.strategyPnlQuantityOverride?.spot ?? this.spotQuantity;
    const strategyPerpetualQuantity = this.strategyPnlQuantityOverride?.perpetual ?? this.perpetualQuantity;
    return {
      accountId,
      accountFingerprint,
      strategyId: "bybit-xaut-spot-perp-v1",
      capturedAt: this.now,
      legs: {
        spot: { kind: "spot_long", quantityXaut: Math.max(0, strategySpotQuantity), averageEntryPrice: 4130, markPrice: spotMark, notionalUsd: Math.max(0, strategySpotQuantity) * spotMark, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
        perpetual: { kind: "perpetual_short", quantityXaut: Math.max(0, strategyPerpetualQuantity), averageEntryPrice: 4128, markPrice: perpMark, notionalUsd: Math.max(0, strategyPerpetualQuantity) * perpMark, realizedPnlUsd: 0, unrealizedPnlUsd: 0 },
      },
      netDeltaXaut: strategySpotQuantity - strategyPerpetualQuantity,
      netDeltaUsd: strategySpotQuantity * spotMark - strategyPerpetualQuantity * perpMark,
      entryBasisBps: -4.8,
      currentBasisBps: -4.8,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      fundingPnlUsd: 0,
      feesUsd: 0,
      slippageUsd: 0,
      netPnlUsd: 0,
      openOrders: [],
    };
  }
}

function permissions(withdraw = false, ipRestricted = true) {
  return { read: true, spotTrade: true, contractTrade: true, withdraw, uta: true, ipRestricted, ownerSubaccount: true };
}

function order(orderId: string, request: RwaProviderOrderRequest, updatedAt: number): RwaProviderOrder {
  return {
    orderId,
    orderLinkId: request.orderLinkId,
    status: "Filled",
    requestedQuantityXaut: request.quantityXaut,
    filledQuantityXaut: request.quantityXaut,
    averagePrice: request.limitPrice,
    feeUsd: 0.001,
    updatedAt,
  };
}

function opportunity(eligible: boolean): ArbitrageOpportunity {
  const leg = (kind: "spot" | "perpetual") => ({
    id: `bybit-xaut-${kind}`,
    venue: "bybit" as const,
    venueLabel: "Bybit",
    symbol: "XAUTUSDT",
    asset: "XAUT" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 4128,
    ask: 4130,
    fundingRate: kind === "perpetual" ? 0.0002 : null,
    fundingIntervalHours: kind === "perpetual" ? 4 : null,
    currentFundingApr: kind === "perpetual" ? 43 : 0,
    historicalFundingApr: kind === "perpetual" ? 12 : 0,
    nextFundingTime: null,
  });
  return {
    id: "bybit-xaut-spot--bybit-xaut-perp",
    longLeg: leg("spot"),
    shortLeg: leg("perpetual"),
    strategyType: "same_venue_neutral",
    strategyLabel: "同所中性",
    matchQuality: "exact",
    matchLabel: "同一资产",
    currentGrossApr: 10,
    historicalGrossApr: 10,
    netApr: 9,
    persistenceRatio: 0.8,
    annualizedTradingCostApr: 1,
    roundTripCostBps: 20,
    entryBasisBps: -4.8,
    capacityUsd: 1000,
    score: 80,
    historicalQualityScore: 80,
    confidence: "high",
    confidenceLabel: "高",
    opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率驱动",
    recommendation: "recommended",
    entryStatus: eligible ? "favorable" : "cautious",
    scoreBreakdown: {
      conservativeNetReturn: 20,
      driverStrength: 20,
      persistence: 20,
      costEfficiency: 5,
      liquidity: 10,
      confidence: 5,
    },
    disqualifiers: [],
    warnings: [],
    automationEligible: eligible,
    automationDisqualifiers: eligible ? [] : ["blocked"],
  };
}
