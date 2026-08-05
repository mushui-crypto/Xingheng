import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArbitrageOpportunity } from "../arbitrageTypes";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import { RwaAutomationExecutionLeaseError } from "./RwaAutomationExecutionLease";
import { RwaAutomationGovernanceError } from "./RwaAutomationGovernance";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import { RwaBinanceAutomationConnector } from "./RwaBinanceAutomationConnector";
import {
  isFreshConnectivitySmokeSnapshot,
  RwaBinanceAutomationService,
} from "./RwaBinanceAutomationService";
import { RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS } from "./RwaBinanceAutomationTypes";
import { RwaBinanceProviderError } from "./RwaBinanceMainnetClient";
import type {
  RwaBinanceClient,
  RwaBinanceCredentials,
  RwaBinancePermissions,
  RwaBinancePreflightSnapshot,
} from "./RwaBinanceAutomationTypes";
import { RwaNeutralExecutionError } from "./RwaNeutralExecutionService";
import { createNeutralExecutionRecord } from "./RwaNeutralHedgeExecutionEngine";
import type { RwaProviderOrder, RwaProviderOrderRequest, RwaStrategyPnlSnapshot } from "./RwaNeutralExecutionTypes";
import {
  createMonitoredActivityContinuity,
  RWA_SPOT_ACTIVITY_SOURCES,
  RWA_PERPETUAL_ACTIVITY_SOURCES,
} from "./RwaProviderActivityContinuity";
import type { RwaAssetOrderReference } from "./RwaAccountAssetAuthorization";
import {
  createRwaAssetTakeoverRecord,
  type RwaAssetTakeoverPreview,
  type RwaAssetTakeoverRecord,
  type RwaAssetTakeoverProviderSnapshot,
} from "./RwaAssetTakeover";
import {
  createRwaAssetTakeoverRuntime,
  createRwaAssetTakeoverRuntimeManual,
  createRwaAssetTakeoverRuntimeRecovery,
} from "./RwaAssetTakeoverRuntime";
import {
  RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
  RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
} from "./RwaConnectivitySmoke";
import {
  binanceAccountBindingSha256,
  productionSelfTestPermitDigest,
  type RwaBinanceProductionSelfTestPermit,
} from "./RwaBinanceProductionSelfTestPermit";

const masterKey = "11".repeat(32);
const now = 20_000;
const capitalTestPermitLimits = {
  leverage: 1,
  maxPositionUsd: 40,
  maxOrderSizeUsd: 40,
  maxOrderCount: 4,
  maxSlippageBps: 20,
  maxFeeBps: 100,
  lossLimitUsd: 40,
  executionId: "7".repeat(32),
};

test("Binance connectivity smoke policy discovery is static and performs no provider or KMS read", () => {
  const client = new FakeBinanceClient();
  const current = service("/tmp/not-read-policy-discovery", "user-a", client);
  const before = client.readCount;
  const policy = current.getConnectivitySmokePolicy("binance:test-account");
  assert.equal(policy.accountId, "binance:test-account");
  assert.equal(policy.executionAuthorized, false);
  assert.equal(policy.policy.digest, RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST);
  assert.equal(client.readCount, before);
});

test("Binance connectivity smoke snapshot freshness accepts the exact boundary and rejects future or invalid time", () => {
  const value = new FakeBinanceClient().snapshot;
  value.fetchedAt = now - RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS;
  assert.equal(isFreshConnectivitySmokeSnapshot(value, now), true);
  value.fetchedAt -= 1;
  assert.equal(isFreshConnectivitySmokeSnapshot(value, now), false);
  value.fetchedAt = now + 1;
  assert.equal(isFreshConnectivitySmokeSnapshot(value, now), false);
  value.fetchedAt = Number.NaN;
  assert.equal(isFreshConnectivitySmokeSnapshot(value, now), false);
});

test("Binance development exclusive account cannot disable the real-client activity guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-development-guard-"));
  try {
    const client = new FakeBinanceClient();
    const guards: unknown[] = [];
    const keyProvider = new FakeCredentialKeyProvider();
    const store = new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
      userId: "user-a",
      venue: "binance",
      keyProvider,
      credentialPath: join(directory, "credentials.json"),
      statePath: join(directory, "state.json"),
    });
    const current = new RwaBinanceAutomationService(
      store,
      (_credentials, guard) => {
        guards.push(guard);
        return client;
      },
      () => now,
      () => false,
      client,
      () => {},
      () => false,
    );
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await current.getCredentialStatus()).accountId!;
    await current.updateConfig({
      accountId,
      accountIsolationMode: "development_exclusive_account",
      globalExecutionEnabled: false,
      strategyEnabled: false,
    });
    await current.previewAccountAssetAuthorization("xaut");
    assert.ok(guards.at(-1), "private real-client construction must always receive an activity guard");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance production development account requires an exact permit confirmation and expiry blocks new risk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-self-test-permit-"));
  try {
    const client = new FakeBinanceClient();
    const userId = "USR-MOSS1";
    const binding = binanceAccountBindingSha256(
      client.access.accountId,
      client.access.accountFingerprint,
    );
    const permitInput = {
      ...capitalTestPermitLimits,
      permitId: "a".repeat(32),
      ownerUserId: userId,
      accountBindingSha256: binding,
      actionScope: ["READ", "TRADE"] as const,
      authorizationDigest: "1".repeat(64),
      approvedCapitalUsd: 30,
      expiresAt: now + 1_000,
      revision: "b".repeat(40),
    };
    const permit: RwaBinanceProductionSelfTestPermit = {
      ...permitInput,
      digest: productionSelfTestPermitDigest(permitInput),
    };
    const harness = serviceHarness(
      directory,
      userId,
      client,
      () => {},
      () => false,
      () => permit,
      () => true,
    );
    await harness.current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await harness.current.getCredentialStatus()).accountId!;
    await assert.rejects(
      harness.current.updateConfig({
        accountId,
        accountIsolationMode: "development_exclusive_account",
        productionSelfTestPermitId: permit.permitId,
      }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "invalid_request",
    );
    await harness.current.updateConfig({
      accountId,
      accountIsolationMode: "development_exclusive_account",
      globalExecutionEnabled: true,
      strategyEnabled: true,
    });
    const confirmed = (await harness.store.readState()).config.productionSelfTestPermitConfirmation;
    assert.equal(confirmed?.digest, permit.digest);
    assert.equal(confirmed?.ownerUserId, userId);
    assert.deepEqual(confirmed?.actionScope, ["READ", "TRADE"]);
    assert.equal(confirmed?.authorizationDigest, permit.authorizationDigest);
    await harness.current.setKillSwitch(false, accountId);
    assert.equal(client.writeCount, 0);

    const mismatchedState = await harness.store.readState();
    mismatchedState.config.productionSelfTestPermitConfirmation = {
      ...mismatchedState.config.productionSelfTestPermitConfirmation!,
      authorizationDigest: "5".repeat(64),
    };
    await harness.store.writeState(mismatchedState);
    await assert.rejects(
      harness.current.preflight(opportunity(), accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "account_isolation_unconfirmed",
    );
    mismatchedState.config.productionSelfTestPermitConfirmation = confirmed;
    await harness.store.writeState(mismatchedState);

    const expired = new RwaBinanceAutomationService(
      harness.store,
      () => client,
      () => now + 1_000,
      () => false,
      undefined,
      () => {},
      () => false,
      () => permit,
      () => true,
    );
    await assert.rejects(
      expired.preflight(opportunity(), accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "account_isolation_unconfirmed",
    );
    await assert.rejects(
      expired.previewAssetTakeover({ assetId: "xaut", newCapitalUsd: 1, leverage: 2 }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "production_self_test_permit_smoke_only",
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance production self-test blocks ordinary execution before every provider mutation", async () => {
  for (const expiryPoint of ["before_first_mutation", "after_leverage"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `xingheng-binance-permit-mutation-${expiryPoint}-`));
    try {
      let clock = now;
      const client = new FakeBinanceClient();
      const userId = "USR-MOSS3";
      const permitInput = {
        ...capitalTestPermitLimits,
        permitId: "e".repeat(32),
        ownerUserId: userId,
        accountBindingSha256: binanceAccountBindingSha256(
          client.access.accountId,
          client.access.accountFingerprint,
        ),
        actionScope: ["READ", "TRADE"] as const,
        authorizationDigest: "2".repeat(64),
        approvedCapitalUsd: 30,
        expiresAt: now + 1_000,
        revision: "f".repeat(40),
      };
      const permit: RwaBinanceProductionSelfTestPermit = {
        ...permitInput,
        digest: productionSelfTestPermitDigest(permitInput),
      };
      const harness = serviceHarness(
        directory,
        userId,
        client,
        () => {},
        () => false,
        () => permit,
        () => true,
        () => clock,
      );
      await harness.current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
      const accountId = (await harness.current.getCredentialStatus()).accountId!;
      await harness.current.updateConfig({
        accountId,
        accountIsolationMode: "development_exclusive_account",
        globalExecutionEnabled: true,
        strategyEnabled: true,
      });
      await harness.current.setKillSwitch(false, accountId);
      const challenge = await harness.current.preflight(opportunity(), accountId, "manual_entry");
      if (expiryPoint === "before_first_mutation") {
        client.snapshotHook = () => { clock = permit.expiresAt; };
      } else {
        client.leverageHook = () => { clock = permit.expiresAt; };
      }

      await assert.rejects(
        harness.current.execute(
          executeInput(accountId, challenge, `binance:permit-mutation:${expiryPoint}`),
        ),
        (error: unknown) => error instanceof RwaNeutralExecutionError
          && error.category === "production_self_test_permit_smoke_only",
      );
      assert.equal(client.writeCount, 0);
      assert.equal(client.placedRequests.length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Binance production self-test preserves generic takeover and aggregate capital caps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-self-test-takeover-cap-"));
  try {
    const client = new FakeBinanceClient();
    const userId = "USR-MOSS2";
    const permitInput = {
      ...capitalTestPermitLimits,
      permitId: "c".repeat(32),
      ownerUserId: userId,
      accountBindingSha256: binanceAccountBindingSha256(
        client.access.accountId,
        client.access.accountFingerprint,
      ),
      actionScope: ["READ", "TRADE"] as const,
      authorizationDigest: "3".repeat(64),
      approvedCapitalUsd: 40,
      expiresAt: now + 10_000,
      revision: "d".repeat(40),
    };
    const permit: RwaBinanceProductionSelfTestPermit = {
      ...permitInput,
      digest: productionSelfTestPermitDigest(permitInput),
    };
    const harness = serviceHarness(
      directory,
      userId,
      client,
      () => {},
      () => false,
      () => permit,
      () => true,
    );
    await harness.current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await harness.current.getCredentialStatus()).accountId!;
    await harness.current.updateConfig({
      accountId,
      accountIsolationMode: "dedicated_subaccount",
      globalExecutionEnabled: true,
      strategyEnabled: true,
      maxStrategyCapitalUsd: 200,
    });
    await harness.current.setKillSwitch(false, accountId);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    client.snapshot.perpetual.liquidationDistancePercent = 50;
    client.setAuthoritativeExposure({ spotFreeXaut: 0.002 });
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const activePreview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 10,
      leverage: 2,
    });
    assert.ok(activePreview.totalManagedCapitalUsd < 200);
    const state = await harness.store.readState();
    state.assetTakeovers.push(createRwaAssetTakeoverRecord({
      userId,
      userDomain: harness.store.userDomain,
      accountId,
      preview: activePreview,
      idempotencyKey: "selftest-active-takeover",
      orderLinkPrefix: "selftestactive",
      now,
    }));
    await harness.store.writeState(state);
    client.setAuthoritativeExposure({ spotFreeXaut: 0.01 });
    const overCapPreview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 100,
      leverage: 2,
    });
    assert.ok(overCapPreview.totalManagedCapitalUsd < 200);
    await harness.current.updateConfig({
      accountId,
      accountIsolationMode: "development_exclusive_account",
      globalExecutionEnabled: true,
      strategyEnabled: true,
      maxStrategyCapitalUsd: 20,
    });
    const writesBefore = client.writeCount;
    await assert.rejects(
      harness.current.preflight(opportunity(), accountId, "manual_entry"),
      (error: unknown) => {
        if (!(error instanceof RwaNeutralExecutionError)
          || error.category !== "preflight_rejected") return false;
        const checks = (error.details as { report?: { checks?: Array<{ name: string; passed: boolean }> } })
          ?.report?.checks ?? [];
        return checks.some((check) => check.name === "asset_cap" && !check.passed);
      },
    );
    await assert.rejects(
      harness.current.previewAssetTakeover({ assetId: "xaut", newCapitalUsd: 100, leverage: 2 }),
      (error: unknown) => (error as { category?: string }).category
        === "production_self_test_permit_smoke_only",
    );
    await assert.rejects(
      harness.current.startAssetTakeover({
        assetId: "xaut",
        preview: overCapPreview,
        idempotencyKey: "selftest-takeover-over-cap",
      }),
      (error: unknown) => (error as { category?: string }).category
        === "production_self_test_permit_smoke_only",
    );
    assert.equal(client.writeCount, writesBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance asset authorization only reads XAUT state and local authorization persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-asset-authorization-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.setAuthoritativeExposure({
      spotFreeXaut: 0.2,
      spotLockedXaut: 0.1,
      perpetualQuantityXaut: 0.25,
      openSpotOrderCount: 1,
      openPerpetualOrderCount: 1,
    });
    client.assetOpenOrders = [
      { category: "spot", orderId: "manual-spot", clientOrderId: "manual-spot", symbol: "XAUTUSDT" },
      { category: "linear", orderId: "manual-perp", clientOrderId: "manual-perp", symbol: "XAUTUSDT" },
    ];
    const writesBefore = client.writeCount;
    const preview = await harness.current.previewAccountAssetAuthorization("xaut");
    assert.equal(Math.abs(preview.spotQuantity - 0.3) < 1e-12, true);
    assert.equal(preview.spotLockedQuantity, 0.1);
    assert.equal(preview.perpetualQuantity, 0.25);
    assert.equal(preview.spotOrderCount, 1);
    assert.equal(preview.perpetualOrderCount, 1);

    const created = await harness.current.createAccountAssetAuthorization("xaut", preview);
    assert.equal(created.revokedAt, null);
    assert.equal("accountId" in created, false);
    assert.equal((await harness.current.getAccountAssetAuthorization("xaut"))?.authorizationId, created.authorizationId);
    assert.equal(client.writeCount, writesBefore);

    const revoked = await harness.current.revokeAccountAssetAuthorization("xaut");
    assert.equal(revoked.revokedAt, now);
    assert.equal(await harness.current.getAccountAssetAuthorization("xaut"), null);
    assert.equal(client.writeCount, writesBefore);

    const nextPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", nextPreview);
    await assert.rejects(
      harness.current.putCredentials({ apiKey: "replacement-key", apiSecret: "replacement-secret" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "credential_rebind_requires_unbind",
    );
    assert.notEqual(await harness.current.getAccountAssetAuthorization("xaut"), null);
    assert.equal(client.writeCount, writesBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance takeover persists an already strict hedge with zero new provider write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-takeover-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    client.setAuthoritativeExposure({
      spotFreeXaut: 0.1,
      perpetualQuantityXaut: 0.1,
    });
    client.snapshot.perpetual.liquidationDistancePercent = 50;
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 1_000,
      leverage: 2,
    });
    const writesBefore = client.writeCount;
    const result = await harness.current.startAssetTakeover({
      assetId: "xaut",
      preview,
      idempotencyKey: "takeover:binance:0001",
    }) as any;
    assert.equal(result.state, "managed");
    assert.equal(result.totalManagedCapitalUsd > 1_400, true);
    assert.equal(client.writeCount, writesBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance current takeover discovery is scoped and flat awaiting reconfirm can abort and release single-active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-takeover-abort-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    const awaiting: RwaAssetTakeoverRecord = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:awaiting-abort",
      orderLinkPrefix: "takeover-binance-awaiting-abort",
      now,
    });
    awaiting.state = "awaiting_reconfirm";
    state.assetTakeovers.push(awaiting);
    await harness.store.writeState(state);

    const refreshed = new RwaBinanceAutomationService(
      harness.store,
      () => client,
      () => now + 30_001,
      () => false,
    );
    const current = await refreshed.getCurrentAssetTakeover() as any;
    assert.equal(current.takeoverId, awaiting.takeoverId);
    assert.equal(current.requiresReconfirmation, true);
    assert.equal("accountId" in current, false);
    assert.equal("accountFingerprint" in current, false);
    assert.equal("userId" in current, false);
    assert.equal("userDomain" in current, false);

    const writesBefore = client.writeCount;
    const aborted = await refreshed.abortAssetTakeover({ takeoverId: awaiting.takeoverId }) as any;
    assert.equal(aborted.state, "failed");
    assert.equal(aborted.reservedCapitalUsd, 0);
    assert.equal(client.writeCount, writesBefore);
    const abortedState = await harness.store.readState();
    assert.equal(abortedState.config.killSwitchActive, true);
    assert.equal(abortedState.config.globalExecutionEnabled, false);
    assert.equal(abortedState.config.strategyEnabled, false);

    const next = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:after-safe-abort",
      orderLinkPrefix: "takeover-binance-after-safe-abort",
      now: now + 1,
    });
    abortedState.assetTakeovers.push(next);
    await harness.store.writeState(abortedState);
    assert.equal((await harness.store.readState()).assetTakeovers.length, 2);
    refreshed.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance current takeover discovery survives hard refresh for managed, exiting, and manual states", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-takeover-discovery-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    const record: RwaAssetTakeoverRecord = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:discovery",
      orderLinkPrefix: "takeover-binance-discovery",
      now,
    });
    const runtimeSnapshot = {
      capturedAt: now,
      ordersDigest: "0".repeat(64),
      providerStateDigest: "1".repeat(64),
      spotQuantity: 0.002,
      spotAvailableQuantity: 0.002,
      spotLockedQuantity: 0,
      spotBid: 4_100,
      perpetualQuantity: 0.002,
      perpetualSide: "short" as const,
      perpetualAsk: 4_101,
      perpetualMark: 4_100,
      currentFundingRate: 0.0001,
      liquidationDistancePercent: 50,
      reserveUsd: 100,
      managedCapitalUsd: 8.2,
    };
    record.state = "managed";
    record.runtime = createRwaAssetTakeoverRuntime(runtimeSnapshot);
    state.assetTakeovers.push(record);
    await harness.store.writeState(state);
    assert.equal((await harness.current.getCurrentAssetTakeover() as any).state, "managed");

    record.runtime.phase = "exiting";
    record.runtime.reason = "user_exit";
    record.runtime.exitStartedAt = now;
    record.runtime.exitIdempotencyKey = "exit:discovery:0001";
    await harness.store.writeState(state);
    const exiting = await harness.current.getCurrentAssetTakeover() as any;
    assert.equal(exiting.state, "managed");
    assert.equal(exiting.runtime.phase, "exiting");

    record.state = "manual_intervention";
    record.runtime = createRwaAssetTakeoverRuntimeManual(now, "persistent_state_invalid");
    await harness.store.writeState(state);
    const manual = await harness.current.getCurrentAssetTakeover() as any;
    assert.equal(manual.state, "manual_intervention");
    assert.equal(manual.runtime.phase, "manual_intervention");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance awaiting reconfirm abort with exposure is provider-write-free manual intervention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-takeover-manual-abort-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    client.setAuthoritativeExposure({ spotFreeXaut: 0.1 });
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    const awaiting: RwaAssetTakeoverRecord = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:manual-abort",
      orderLinkPrefix: "takeover-binance-manual-abort",
      now,
    });
    awaiting.state = "awaiting_reconfirm";
    state.assetTakeovers.push(awaiting);
    await harness.store.writeState(state);

    const writesBefore = client.writeCount;
    const aborted = await harness.current.abortAssetTakeover({ takeoverId: awaiting.takeoverId }) as any;
    assert.equal(aborted.state, "manual_intervention");
    assert.equal(aborted.reservedCapitalUsd, preview.totalManagedCapitalUsd);
    assert.equal(client.writeCount, writesBefore);
    await assert.rejects(
      harness.current.abortAssetTakeover({ takeoverId: awaiting.takeoverId }),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "asset_takeover_invalid",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance abort persists manual intervention for metadata, fingerprint, and client failures", async () => {
  for (const failure of ["metadata_null", "metadata_throw", "fingerprint_rotation", "client_factory"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `xingheng-binance-abort-${failure}-`));
    try {
      const client = new FakeBinanceClient();
      const harness = serviceHarness(directory, "user-a", client);
      await activate(harness.current);
      const awaiting = await seedAwaitingTakeover(
        harness,
        client,
        `takeover:binance:${failure}`,
      );
      let target = harness.current;
      if (failure === "metadata_null") {
        (target as any).requireMetadata = async () => null;
      } else if (failure === "metadata_throw") {
        (target as any).requireMetadata = async () => {
          throw new Error("simulated metadata failure");
        };
      } else if (failure === "fingerprint_rotation") {
        const metadata = await harness.store.readCredentialMetadata();
        (target as any).requireMetadata = async () => ({
          ...metadata,
          accountFingerprint: "rotated-account-fingerprint",
        });
      } else {
        target = new RwaBinanceAutomationService(
          harness.store,
          () => {
            throw new Error("simulated client factory failure");
          },
          () => now,
          () => false,
          client,
        );
      }
      const writesBefore = client.writeCount;
      const result = await target.abortAssetTakeover({
        takeoverId: awaiting.takeoverId,
      }) as any;
      assert.equal(result.state, "manual_intervention");
      assert.equal(result.reservedCapitalUsd, awaiting.reservedCapitalUsd);
      assert.equal(client.writeCount, writesBefore);
      const persisted = await harness.store.readState();
      assert.equal(persisted.config.killSwitchActive, true);
      assert.equal(persisted.config.globalExecutionEnabled, false);
      assert.equal(persisted.config.strategyEnabled, false);
      assert.equal(persisted.assetTakeovers[0]?.state, "manual_intervention");
      target.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Binance abort propagates lease loss after snapshot with no state write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-abort-lease-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    const awaiting = await seedAwaitingTakeover(
      harness,
      client,
      "takeover:binance:abort-lease",
    );
    let leaseHeld = true;
    client.takeoverSnapshotHook = () => { leaseHeld = false; };
    let stateWrites = 0;
    const originalWriteState = harness.store.writeState.bind(harness.store);
    harness.store.writeState = async (state) => {
      stateWrites += 1;
      return originalWriteState(state);
    };
    const target = new RwaBinanceAutomationService(
      harness.store,
      () => client,
      () => now,
      () => false,
      undefined,
      () => {
        if (!leaseHeld) {
          throw new RwaAutomationExecutionLeaseError(
            "automation_execution_lease_lost",
            "simulated abort lease loss",
          );
        }
      },
    );
    const writesBefore = client.writeCount;
    await assert.rejects(
      target.abortAssetTakeover({ takeoverId: awaiting.takeoverId }),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError,
    );
    assert.equal(client.writeCount, writesBefore);
    assert.equal(stateWrites, 0);
    assert.equal((await harness.store.readState()).assetTakeovers[0]?.state, "awaiting_reconfirm");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance startup recovers an orphaned awaiting reconfirm into a persisted safe terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-takeover-restart-abort-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    const awaiting: RwaAssetTakeoverRecord = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:restart-abort",
      orderLinkPrefix: "takeover-binance-restart-abort",
      now,
    });
    awaiting.state = "awaiting_reconfirm";
    state.assetTakeovers.push(awaiting);
    await harness.store.writeState(state);
    const restarted = new RwaBinanceAutomationService(
      harness.store,
      () => client,
      () => now + 1,
      () => false,
    );
    const writesBefore = client.writeCount;
    await restarted.initialize();
    assert.equal(client.writeCount, writesBefore);
    assert.equal((await harness.store.readState()).assetTakeovers[0]?.state, "failed");
    assert.equal(await restarted.getCurrentAssetTakeover(), null);
    restarted.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance takeover recovery propagates lease loss after provider snapshot without a state write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-takeover-lease-loss-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    client.setAuthoritativeExposure({ spotFreeXaut: 0.1 });
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    state.assetTakeovers.push(createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:recovery-lease",
      orderLinkPrefix: "takeover-binance-recovery-lease",
      now,
    }));
    await harness.store.writeState(state);

    let leaseHeld = true;
    client.takeoverSnapshotHook = () => { leaseHeld = false; };
    let writesAfterLeaseSetup = 0;
    const originalWriteState = harness.store.writeState.bind(harness.store);
    harness.store.writeState = async (next) => {
      writesAfterLeaseSetup += 1;
      return originalWriteState(next);
    };
    const restarted = new RwaBinanceAutomationService(
      harness.store,
      () => client,
      () => now,
      () => false,
      undefined,
      () => {
        if (!leaseHeld) {
          throw new RwaAutomationExecutionLeaseError(
            "automation_execution_lease_lost",
            "simulated takeover recovery lease loss",
          );
        }
      },
    );
    const writesBefore = client.writeCount;
    await assert.rejects(
      restarted.initialize(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
    assert.equal(client.writeCount, writesBefore);
    assert.equal(writesAfterLeaseSetup, 0);
    assert.equal((await harness.store.readState()).assetTakeovers[0]?.state, "planned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance managed takeover monitor startup propagates lease loss without state or provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-managed-monitor-lease-loss-"));
  let restarted: RwaBinanceAutomationService | null = null;
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await activate(harness.current);
    client.snapshot.spotAvailableUsdt = 2_000;
    client.snapshot.futuresAvailableUsdt = 2_000;
    client.snapshot.availableUsdt = 4_000;
    client.setAuthoritativeExposure({
      spotFreeXaut: 0.1,
      perpetualQuantityXaut: 0.1,
    });
    client.snapshot.perpetual.liquidationDistancePercent = 50;
    const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
    await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
    const preview = await harness.current.previewAssetTakeover({
      assetId: "xaut",
      newCapitalUsd: 500,
      leverage: 2,
    });
    const state = await harness.store.readState();
    const record: RwaAssetTakeoverRecord = createRwaAssetTakeoverRecord({
      userId: "user-a",
      userDomain: harness.store.userDomain,
      accountId: client.access.accountId,
      preview,
      idempotencyKey: "takeover:binance:managed-monitor-lease",
      orderLinkPrefix: "takeover-binance-managed-monitor-lease",
      now,
    });
    record.state = "managed";
    record.runtime = createRwaAssetTakeoverRuntimeRecovery(now);
    state.assetTakeovers.push(record);
    await harness.store.writeState(state);

    let leaseHeld = true;
    client.takeoverSnapshotHook = () => { leaseHeld = false; };
    let writesAfterLeaseSetup = 0;
    const originalWriteState = harness.store.writeState.bind(harness.store);
    harness.store.writeState = async (next) => {
      writesAfterLeaseSetup += 1;
      return originalWriteState(next);
    };
    restarted = new RwaBinanceAutomationService(
      harness.store,
      () => client,
      () => now,
      () => false,
      undefined,
      () => {
        if (!leaseHeld) {
          throw new RwaAutomationExecutionLeaseError(
            "automation_execution_lease_lost",
            "simulated managed takeover monitor lease loss",
          );
        }
      },
      () => true,
    );
    const writesBefore = client.writeCount;
    await assert.rejects(
      restarted.initialize(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
    assert.equal(client.writeCount, writesBefore);
    assert.equal(writesAfterLeaseSetup, 0);
    assert.equal(restarted.hasActivityMonitor(), false);
  } finally {
    restarted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance credentials remain user-isolated, default disabled, and reject withdrawal permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-automation-"));
  try {
    const client = new FakeBinanceClient();
    const first = service(directory, "user-a", client);
    const second = service(directory, "user-b", client);
    const connector = new RwaBinanceAutomationConnector(first);

    await first.putCredentials({ apiKey: "fake-key-a", apiSecret: "fake-secret-a" });
    const firstStatus = await connector.getStatus();
    const secondStatus = await second.getCredentialStatus();
    assert.equal(firstStatus.implemented, true);
    assert.equal(firstStatus.enabled, false);
    assert.equal(firstStatus.phase, "execution_capable");
    assert.equal(firstStatus.providerWritesEnabled, true);
    assert.equal((firstStatus.productAvailability as any).available, true);
    assert.equal(firstStatus.credential.lifecycleStatus, "active");
    assert.equal(firstStatus.credential.maskedApiKey?.includes("fake-secret-a"), false);
    assert.equal(secondStatus.lifecycleStatus, "unconfigured");

    const rejectedClient = new FakeBinanceClient({ permissions: permissions({ withdraw: true }) });
    const rejected = service(directory, "user-c", rejectedClient);
    await assert.rejects(
      rejected.putCredentials({ apiKey: "fake-key-c", apiSecret: "must-not-leak" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "permission_rejected"
        && !error.message.includes("must-not-leak"),
    );
    assert.equal((await rejected.getCredentialStatus()).stored, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance credential validation wraps synchronous client construction failures without leaking secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-client-factory-failure-"));
  try {
    const keyProvider = new FakeCredentialKeyProvider();
    const store = new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
      userId: "user-a",
      venue: "binance",
      keyProvider,
      credentialPath: join(directory, "credentials.json"),
      statePath: join(directory, "state.json"),
    });
    const service = new RwaBinanceAutomationService(
      store,
      (credentials) => {
        if (credentials.apiKey) {
          throw new Error("Authorization: Bearer sync-secret file:///tmp/binance.json apiKey leaked-key");
        }
        return new FakeBinanceClient();
      },
      () => now,
      () => false,
    );

    await assert.rejects(
      service.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "provider_unavailable"
        && error.message === "Binance 凭证校验失败。",
    );
    assert.equal((await service.getCredentialStatus()).stored, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance rejects credential overwrite and fixed IP verification gates every new-risk control entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-ip-gates-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "original-key", apiSecret: "original-secret" });
    const originalStatus = await current.getCredentialStatus();
    const accountId = originalStatus.accountId!;

    client.setPermissions({ ipRestricted: false });
    await assert.rejects(
      current.putCredentials({ apiKey: "replacement-key", apiSecret: "replacement-secret" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "credential_rebind_requires_unbind",
    );
    client.setPermissions({ ipRestricted: true });
    const retained = await current.getCredentialStatus();
    assert.equal(retained.lifecycleStatus, "active");
    assert.equal(retained.maskedApiKey, originalStatus.maskedApiKey);

    client.setPermissions({ ipRestricted: false });
    await assert.rejects(
      current.updateConfig({ accountId, accountIsolationMode: "dedicated_subaccount", globalExecutionEnabled: true }),
      permissionRejectedWithoutSecret,
    );
    await assert.rejects(
      current.setKillSwitch(false, accountId),
      permissionRejectedWithoutSecret,
    );
    assert.equal((await current.getConfig()).globalExecutionEnabled, false);
    assert.equal((await current.getConfig()).killSwitchActive, true);

    client.setPermissions({ ipRestricted: true });
    await current.updateConfig({
      accountId,
      accountIsolationMode: "dedicated_subaccount",
      globalExecutionEnabled: true,
      strategyEnabled: true,
    });
    await current.setKillSwitch(false, accountId);
    client.setPermissions({ ipRestricted: false });
    await assert.rejects(
      current.preflight(opportunity(), accountId, "manual_entry"),
      permissionRejectedWithoutSecret,
    );
    assert.equal(client.writeCount, 0);
    assert.equal((await current.getConfig()).killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance rebind validates access again and accepts a changed UID snapshot after unbind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-rebind-identity-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await harness.current.putCredentials({ apiKey: "first-key", apiSecret: "first-secret" });
    const firstMetadata = await harness.store.readCredentialMetadata();
    const readsAfterFirstBind = client.readCount;
    const recovery = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => true);
    assert.deepEqual(await recovery.recoveryUnbind(), { providerVerifiedFlat: true });

    client.access.accountId = "binance:replacement-account";
    client.access.accountFingerprint = "replacement-uid-snapshot";
    const rebound = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => true);
    await rebound.putCredentials({ apiKey: "second-key", apiSecret: "second-secret" });
    const secondMetadata = await harness.store.readCredentialMetadata();
    assert.ok(client.readCount > readsAfterFirstBind);
    assert.notEqual(secondMetadata?.accountFingerprint, firstMetadata?.accountFingerprint);
    assert.equal(secondMetadata?.accountFingerprint, "replacement-uid-snapshot");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance execute rechecks fixed IP verification after challenge issuance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-ip-execute-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    client.setPermissions({ ipRestricted: false });

    const execution = await current.execute(executeInput(accountId, challenge, "binance:ip-recheck:1"));
    assert.notEqual(execution.state, "hedged");
    assert.equal(client.writeCount, 0);
    assert.equal((await current.getConfig()).killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance credential status warns when provider enables IP restriction but does not return ipList", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-ip-warning-"));
  try {
    const client = new FakeBinanceClient();
    client.setIpWhitelistVerificationMode("provider_restriction_only");
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const status = await current.getCredentialStatus();
    assert.equal(status.ipWhitelistConfigured, true);
    assert.match(status.warnings.join(" "), /未返回完整 ipList/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance preflight remains read-only and execute establishes the whitelisted hedge combination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-preflight-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await current.getCredentialStatus()).accountId;
    assert.ok(accountId);

    await current.updateConfig({
      accountId,
      accountIsolationMode: "dedicated_subaccount",
      globalExecutionEnabled: true,
      strategyEnabled: true,
    });
    await current.setKillSwitch(false, accountId!);

    client.snapshot.fetchedAt = 1;
    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any).checks.some((item: any) => item.name === "freshness" && !item.passed),
    );

    client.snapshot.fetchedAt = now;
    client.snapshot.perpetual.minOrderQty = 0.01;
    await assert.rejects(
      current.preflight(opportunity(), accountId!, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any).checks.some((item: any) => item.name === "perpetual_profile_rules" && !item.passed),
    );
    client.snapshot.perpetual.minOrderQty = 0.001;

    const challenge = await current.preflight(opportunity(), accountId!, "manual_entry");
    assert.equal(client.writeCount, 0);
    assert.equal(challenge.report.providerWritesEnabled, true);
    assert.equal(challenge.report.totalBudgetUsd, challenge.report.estimatedCapitalRequiredUsd);
    assert.equal(challenge.report.quantityXaut, 0.002);
    assert.equal(
      challenge.report.checks.some((item) =>
        item.name === "strategy_cap" && item.limit === 2_000 && item.passed),
      true,
    );
    const execution = await current.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "binance:entry:1",
    });
    assert.equal(execution.state, "hedged");
    assert.equal(client.writeCount, 3);
    const repeated = await current.execute({
      accountId,
      challengeId: challenge.challengeId,
      challengeToken: challenge.challengeToken,
      idempotencyKey: "binance:entry:1",
    });
    assert.equal(repeated.executionId, execution.executionId);
    assert.equal(client.writeCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance preflight aggregates reserved capital and rejects new risk at the asset tier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-profile-risk-"));
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    const state = await store.readState();
    const reserved = createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: `rwa${store.userDomain}`,
      idempotencyKey: `${store.userDomain}:risk-reserved`,
      challengeId: "risk-reserved",
      now,
      venue: "binance",
      reservedCapitalUsd: 1_990,
    });
    reserved.state = "manual_intervention";
    state.executions.push(reserved);
    await store.writeState(state);

    await assert.rejects(
      current.preflight(opportunity(), accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "preflight_rejected"
        && (error.details?.report as any)?.checks.some((item: any) =>
          item.name === "asset_cap" && item.passed === false),
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance execute rejects invalid runtime profile fields before provider mutations", async () => {
  const invalidCases: Array<[string, (execution: any) => void]> = [
    ["unknown-asset", (execution) => { execution.asset = "DOGE"; }],
    ["partial-profile", (execution) => { delete execution.profileId; }],
    ["negative-capital", (execution) => { execution.reservedCapitalUsd = -1; }],
    ["nan-capital", (execution) => { execution.reservedCapitalUsd = Number.NaN; }],
    ["infinite-capital", (execution) => { execution.reservedCapitalUsd = Number.POSITIVE_INFINITY; }],
  ];
  for (const [label, corrupt] of invalidCases) {
    const directory = await mkdtemp(join(tmpdir(), `xingheng-binance-invalid-profile-${label}-`));
    try {
      const client = new FakeBinanceClient();
      const { current, store } = serviceHarness(directory, "user-a", client);
      const accountId = await activate(current);
      const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
      const state = await store.readState();
      const invalid = createNeutralExecutionRecord({
        userId: "user-a",
        accountId,
        userOrderPrefix: `rwa${store.userDomain}`,
        idempotencyKey: `${store.userDomain}:invalid:${label}`,
        challengeId: `invalid:${label}`,
        now,
        venue: "binance",
        reservedCapitalUsd: 25,
      });
      invalid.state = "manual_intervention";
      corrupt(invalid);
      state.executions.push(invalid);
      store.readState = async () => state;

      await assert.rejects(
        current.execute(executeInput(accountId, challenge, `binance:invalid:${label}`)),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_risk_state_invalid",
      );
      assert.equal(client.writeCount, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Binance execute rechecks aggregate risk before provider writes and clears a rejected reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-risk-race-"));
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const state = await store.readState();
    const concurrent = createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: `rwa${store.userDomain}`,
      idempotencyKey: `${store.userDomain}:concurrent-risk`,
      challengeId: "concurrent-risk",
      now,
      venue: "binance",
      reservedCapitalUsd: 1_990,
    });
    concurrent.state = "manual_intervention";
    state.executions.push(concurrent);
    await store.writeState(state);

    await assert.rejects(
      current.execute(executeInput(accountId, challenge, "binance:risk-race:1")),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "risk_limit_exceeded",
    );
    assert.equal(client.writeCount, 0);
    const persisted = await store.readState();
    const rejected = persisted.executions.find((item) => item.challengeId === challenge.challengeId);
    assert.equal(rejected?.state, "failed");
    assert.equal(rejected?.reservedCapitalUsd, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance first provider mutation failure creates no orders or strategy exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-first-write-failure-"));
  try {
    const client = new FakeBinanceClient({ failLeverage: true });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:first-write-failure:1"));
    assert.equal(execution.state, "failed");
    assert.equal(client.writeCount, 1);
    assert.equal(client.placedRequests.length, 0);
    const pnl = await client.readStrategyPnl();
    assert.equal(pnl.legs.spot.quantityXaut, 0);
    assert.equal(pnl.legs.perpetual.quantityXaut, 0);
    assert.equal(pnl.openOrders.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance activity ambiguity stops without automatic cancel or close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-activity-stop-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    client.activityFailure = new RwaBinanceProviderError(
      "provider_activity_ambiguous",
      "external activity",
    );

    const execution = await current.execute(executeInput(accountId, challenge, "binance:activity-stop:1"));
    const config = await current.getConfig();
    assert.equal(execution.state, "manual_intervention");
    assert.equal(client.writeCount, 0);
    assert.equal(client.cancelCount, 0);
    assert.equal(config.globalExecutionEnabled, false);
    assert.equal(config.strategyEnabled, false);
    assert.equal(config.killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance partial spot fill sizes the perpetual side from authoritative fill quantity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-partial-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: [0.5, 1] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:partial:1"));
    assert.equal(execution.state, "hedged");
    assert.equal(execution.hedgedQuantityXaut, 0.001);
    assert.equal(client.placedRequests[1]?.category, "linear");
    assert.equal(client.placedRequests[1]?.quantityXaut, 0.001);
    assert.equal(client.cancelCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance perpetual-side failure exits the filled spot side and leaves no strategy exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-compensation-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: [1, "throw", 1] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:compensate:1"));
    assert.equal(execution.state, "failed");
    const pnl = await client.readStrategyPnl();
    assert.equal(pnl.legs.spot.quantityXaut, 0);
    assert.equal(pnl.legs.perpetual.quantityXaut, 0);
    assert.equal(client.strategyCancelScopes.length > 0, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance exit failure enters manual intervention and activates the user kill switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-exit-failure-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["throw"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    const execution = await current.closeAll({
      accountId,
      idempotencyKey: "binance:close-failure:1",
    });
    assert.equal(execution.state, "manual_intervention");
    assert.equal((await current.getConfig()).killSwitchActive, true);
    const pnl = await client.readStrategyPnl();
    assert.equal(pnl.legs.spot.quantityXaut, 0.002);
    assert.equal(pnl.legs.perpetual.quantityXaut, 0.002);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance authoritative order timeout cancels the order and never creates an unhedged position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-timeout-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["new"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const execution = await current.execute(executeInput(accountId, challenge, "binance:timeout:1"));
    assert.equal(execution.state, "failed");
    assert.equal(client.cancelCount > 0, true);
    assert.equal((await client.readStrategyPnl()).netDeltaXaut, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance close-all ignores entry caps, retries partial exits, and restart recovery disarms persisted execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-recovery-"));
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    await seedTrackedHedge(store, accountId, 0.002);
    const overEntryCap = await store.readState();
    overEntryCap.executions[0]!.reservedCapitalUsd = 301;
    await store.writeState(overEntryCap);
    client.fillPlan.push(0.5, 1, 1);
    const closed = await current.closeAll({ accountId, idempotencyKey: "binance:close:1" });
    assert.equal(closed.state, "closed");
    assert.equal(client.cancelCount, 1);
    assert.equal((await client.readStrategyPnl()).netDeltaXaut, 0);

    client.seedStrategyExposure(0.002, 0.002);
    const state = await store.readState();
    const pending = createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: `rwa${store.userDomain}`,
      idempotencyKey: `${store.userDomain}:restart-pending`,
      challengeId: "restart-pending",
      now,
      venue: "binance",
    });
    pending.state = "compensating";
    pending.spotOrder = providerOrder("restart-spot", `${pending.orderLinkPrefix}s1`, 0.002);
    pending.perpetualOrders.push(providerOrder("restart-perp", `${pending.orderLinkPrefix}p1`, 0.002));
    pending.strategyPosition = {
      coverage: "complete",
      spotRemainingXaut: 0.002,
      perpetualRemainingXaut: 0.002,
      updatedAt: now,
    };
    pending.activityContinuity = createMonitoredActivityContinuity(now, pending.orderLinkPrefix);
    state.executions.push(pending);
    await store.writeState(state);
    const restarted = new RwaBinanceAutomationService(store, () => client, () => now, () => false);
    await restarted.initialize();
    const restoredState = await store.readState();
    assert.equal(restoredState.executions.at(-1)?.state, "closed");
    assert.equal((await client.readStrategyPnl()).netDeltaXaut, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance close-all refuses an unexplained authoritative spot delta, including dust", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-close-dust-"));
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    await seedTrackedHedge(store, accountId, 0.002);
    client.setAuthoritativeExposure({ spotFreeXaut: 0.001998, perpetualQuantityXaut: 0.002 });
    const writesBefore = client.placedRequests.length;
    const closed = await current.closeAll({ accountId, idempotencyKey: "binance:close:dust:1" }) as any;
    assert.equal(closed.state, "manual_intervention");
    assert.equal(closed.errorCategory, "strategy_ownership_ambiguous");
    assert.equal(client.placedRequests.length, writesBefore);
    assert.equal(client.strategyCancelScopes.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance close-all blocks same-net external activity and incomplete attribution before writes", async () => {
  for (const mode of ["external", "incomplete"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `xingheng-binance-attribution-${mode}-`));
    try {
      const client = new FakeBinanceClient();
      const { current, store } = serviceHarness(directory, "user-a", client);
      const accountId = await activate(current);
      client.seedStrategyExposure(0.002, 0.002);
      await seedTrackedHedge(store, accountId, 0.002);
      if (mode === "external") client.externalPositionActivity = true;
      else client.attributionCoverage = "incomplete";
      const closed = await current.closeAll({
        accountId,
        idempotencyKey: `binance:close:attribution:${mode}`,
      }) as any;
      assert.equal(closed.state, "manual_intervention");
      assert.equal(closed.errorCategory, "strategy_ownership_ambiguous");
      assert.equal(client.placedRequests.length, 0);
      assert.equal(client.strategyCancelScopes.length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Binance activity monitor propagates lease loss after a scan and blocks startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-monitor-lease-loss-"));
  let loseLease = false;
  try {
    const client = new FakeBinanceClient();
    const { current, store } = serviceHarness(
      directory,
      "user-a",
      client,
      () => {
        if (loseLease) {
          throw new RwaAutomationExecutionLeaseError(
            "automation_execution_lease_lost",
            "simulated lease loss",
          );
        }
      },
      () => true,
    );
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    await seedTrackedHedge(store, accountId, 0.002);
    client.attributionHook = () => { loseLease = true; };

    await assert.rejects(
      current.refreshActivityContinuity(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
    assert.equal(client.placedRequests.length, 0);
    assert.equal(client.strategyCancelScopes.length, 0);
    assert.equal(client.writeCount, 0);

    loseLease = false;
    await assert.rejects(
      current.startActivityMonitoring(),
      (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
        && error.category === "automation_execution_lease_lost",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance persists base-asset fees and automatically exits the exact net spot position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-net-position-"));
  try {
    const client = new FakeBinanceClient({ spotBuyBaseFeeXaut: 0.000002 });
    const { current, store } = serviceHarness(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflight(opportunity(), accountId, "manual_entry");
    const opened = await current.execute(executeInput(accountId, challenge, "binance:net-position:open")) as any;
    assert.equal(opened.state, "hedged");
    const openedState = await store.readState();
    assert.equal(openedState.executions.at(-1)?.strategyPosition.spotRemainingXaut, 0.001998);
    assert.equal(openedState.executions.at(-1)?.strategyPosition.perpetualRemainingXaut, 0.002);

    const closed = await current.closeAll({
      accountId,
      idempotencyKey: "binance:net-position:close",
    }) as any;
    assert.equal(closed.state, "partial_closed");
    assert.equal(
      client.placedRequests.filter((request) => request.category === "spot" && request.side === "Sell").at(-1)?.quantityXaut,
      0.0019,
    );
    assert.equal(closed.reconciliation?.dustResidual?.spot?.quantityXaut, 0.000098);
    const closedState = await store.readState();
    const sourceExecution = closedState.executions.find((item) => item.executionId === opened.executionId);
    assert.equal(sourceExecution?.strategyPosition.spotRemainingXaut, 0.000098);
    assert.equal(sourceExecution?.strategyPosition.perpetualRemainingXaut, 0);
    assert.equal(sourceExecution?.state, "partial_closed");
    assert.equal(closedState.config.killSwitchActive, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function seedTrackedHedge(
  store: RwaAutomationPersistentStore<any, any>,
  accountId: string,
  quantityXaut: number,
) {
  const state = await store.readState();
  const execution = createNeutralExecutionRecord({
    userId: "user-a",
    accountId,
    userOrderPrefix: `rwa${store.userDomain}`,
    idempotencyKey: `${store.userDomain}:seed:${state.executions.length}`,
    challengeId: `seed:${state.executions.length}`,
    now,
    venue: "binance",
  });
  execution.state = "hedged";
  execution.hedgedQuantityXaut = quantityXaut;
  execution.strategyPosition = {
    coverage: "complete",
    spotRemainingXaut: quantityXaut,
    perpetualRemainingXaut: quantityXaut,
    updatedAt: now,
  };
  execution.activityContinuity = createMonitoredActivityContinuity(now, execution.orderLinkPrefix);
  state.executions.push(execution);
  await store.writeState(state);
}

function providerOrder(orderId: string, orderLinkId: string, quantityXaut: number): RwaProviderOrder {
  return {
    orderId,
    orderLinkId,
    status: "Filled",
    requestedQuantityXaut: quantityXaut,
    filledQuantityXaut: quantityXaut,
    averagePrice: 4_000,
    feeUsd: 0,
    updatedAt: now,
  };
}

test("Binance reconciliation detects external manual fill and finalize closes manual intervention safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-reconcile-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["throw"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    const failed = await current.closeAll({ accountId, idempotencyKey: "binance:close:manual:1" }) as any;
    assert.match(failed.state, /manual_intervention|partial_closed/);

    client.setAuthoritativeExposure({
      spotFreeXaut: 0.000098,
      spotLockedXaut: 0,
      perpetualQuantityXaut: 0,
      openSpotOrderCount: 0,
      openPerpetualOrderCount: 0,
    });
    const preview = await current.getReconciliation({ accountId, reconciliationId: failed.executionId }) as any;
    assert.equal(preview.items[0]?.canFinalize, true);
    assert.equal(preview.items[0]?.recommendedAction, "manual_finalize");
    assert.equal(preview.items[0]?.dustResidual?.spot?.quantityXaut, 0.000098);

    const finalized = await current.finalizeReconciliation({
      accountId,
      reconciliationId: failed.executionId,
      idempotencyKey: "binance:finalize:1",
    }) as any;
    assert.equal(finalized.state, "reconciled");
    assert.equal(finalized.reconciliation?.canFinalize, true);

    const readCountBeforeReplay = client.readCount;
    const replayed = await current.finalizeReconciliation({
      accountId,
      reconciliationId: failed.executionId,
      idempotencyKey: "binance:finalize:1",
    }) as any;
    assert.equal(replayed.state, "reconciled");
    assert.equal(client.readCount, readCountBeforeReplay);

    await assert.rejects(
      current.finalizeReconciliation({
        accountId,
        reconciliationId: failed.executionId,
        idempotencyKey: "binance:finalize:2",
      }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "reconciliation_already_finalized",
    );

    const restarted = service(directory, "user-a", client);
    const restartedReplay = await restarted.finalizeReconciliation({
      accountId,
      reconciliationId: failed.executionId,
      idempotencyKey: "binance:finalize:1",
    }) as any;
    assert.equal(restartedReplay.state, "reconciled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance reconciliation stays fail-closed when tradable residual, open orders, or stale snapshot remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-reconcile-blocked-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["throw"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    client.seedStrategyExposure(0.002, 0.002);
    const failed = await current.closeAll({ accountId, idempotencyKey: "binance:close:blocked:1" }) as any;
    const preview = await current.getReconciliation({ accountId }) as any;
    assert.equal(preview.items[0]?.canFinalize, false);
    assert.match(String(preview.items[0]?.blockingReasons?.join(" ")), /现货侧仍存在可交易余额/);

    client.setAuthoritativeExposure({ spotFreeXaut: 0.00005, openSpotOrderCount: 1, perpetualQuantityXaut: 0 });
    const previewWithOrders = await current.getReconciliation({ accountId, reconciliationId: failed.executionId }) as any;
    assert.equal(previewWithOrders.items[0]?.canFinalize, false);
    assert.match(String(previewWithOrders.items[0]?.blockingReasons?.join(" ")), /活动委托/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance rejects kill switches, account mismatch, unknown fields, and non-XAUT opportunities before writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-guards-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const accountId = (await current.getCredentialStatus()).accountId!;
    await assert.rejects(
      current.preflight(opportunity(), accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "global_execution_disabled",
    );
    await current.updateConfig({
      accountId,
      accountIsolationMode: "dedicated_subaccount",
      globalExecutionEnabled: true,
      strategyEnabled: true,
    });
    await current.setKillSwitch(false, accountId);
    await assert.rejects(
      current.preflight(opportunity(), "binance:other-account", "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "account_mismatch",
    );
    const unsupported = opportunity();
    unsupported.longLeg.asset = "PAXG";
    await assert.rejects(
      current.preflight(unsupported, accountId, "manual_entry"),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "adapter_opportunity_unsupported",
    );
    await assert.rejects(
      current.execute({ accountId, challengeId: "x", challengeToken: "y", idempotencyKey: "valid-key", symbol: "BTCUSDT" }),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "invalid_request",
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance KMS failure blocks execute and restart recovery without provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-binance-kms-failure-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflight(opportunity(), accountId, "manual_entry");
    harness.keyProvider.failCategory = "credential_key_provider_unavailable";

    const execution = await harness.current.execute(executeInput(accountId, challenge, "binance:kms-failure:1")) as any;
    assert.equal(execution.state, "manual_intervention");
    assert.equal(execution.errorCategory, "credential_key_provider_unavailable");
    assert.equal(client.writeCount, 0);
    let state = await harness.store.readState();
    assert.equal(state.config.globalExecutionEnabled, false);
    assert.equal(state.config.strategyEnabled, false);
    assert.equal(state.config.killSwitchActive, true);

    harness.keyProvider.failCategory = null;
    state.executions = [createNeutralExecutionRecord({
      userId: "user-a",
      accountId,
      userOrderPrefix: "rwa-recovery-test",
      idempotencyKey: "binance:recovery:kms-failure",
      challengeId: "recovery-challenge",
      now,
      venue: "binance",
    })];
    await harness.store.writeState(state);
    harness.keyProvider.failCategory = "credential_key_provider_permission_denied";
    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();
    state = await harness.store.readState();
    assert.equal(state.executions[0]?.state, "manual_intervention");
    assert.equal(state.executions[0]?.errorCategory, "credential_key_provider_unavailable");
    assert.equal(state.config.killSwitchActive, true);
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke opens, authoritatively hedges, immediately exits futures then spot, and returns an isolated receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const result = await harness.current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:normal:0001"),
    ) as any;
    const providerReadsBeforeLookup = client.readCount;
    const providerWritesBeforeLookup = client.writeCount;
    const originalWriteState = harness.store.writeState.bind(harness.store);
    let persistentWriteCalls = 0;
    harness.store.writeState = async (state) => {
      persistentWriteCalls += 1;
      return originalWriteState(state);
    };
    const normalFileBefore = await stateFileIdentity(harness.store.statePath);
    assert.deepEqual(
      await harness.current.lookupConnectivitySmokeExecution({
        accountId,
        challengeId: challenge.challengeId,
        idempotencyKey: "smoke:normal:0001",
      }),
      result,
    );
    assert.equal(
      await harness.current.lookupConnectivitySmokeExecution({
        accountId,
        challengeId: "different-challenge",
        idempotencyKey: "smoke:normal:0001",
      }),
      null,
    );
    assert.equal(
      await harness.current.lookupConnectivitySmokeExecution({
        accountId,
        challengeId: challenge.challengeId,
        idempotencyKey: "smoke:normal:missing",
      }),
      null,
    );
    assert.equal(client.readCount, providerReadsBeforeLookup);
    assert.equal(client.writeCount, providerWritesBeforeLookup);
    assert.equal(persistentWriteCalls, 0);
    assert.deepEqual(await stateFileIdentity(harness.store.statePath), normalFileBefore);

    const compactable = await harness.store.readStateView();
    compactable.credentialAudit = Array.from({ length: 501 }, (_, index) => ({
      userId: "user-a",
      action: "rotated" as const,
      accountId,
      accountFingerprint: "test-account",
      maskedApiKey: null,
      occurredAt: index,
    }));
    await writeFile(harness.store.statePath, JSON.stringify(compactable), { mode: 0o600 });
    const compactableFileBefore = await stateFileIdentity(harness.store.statePath);
    assert.deepEqual(
      await harness.current.lookupConnectivitySmokeExecution({
        accountId,
        challengeId: challenge.challengeId,
        idempotencyKey: "smoke:normal:0001",
      }),
      result,
    );
    assert.equal(persistentWriteCalls, 0);
    assert.deepEqual(await stateFileIdentity(harness.store.statePath), compactableFileBefore);
    assert.equal((await harness.store.readStateView()).credentialAudit.length, 500);
    assert.equal(result.purpose, "connectivity_smoke");
    assert.equal(result.stage, "flat");
    assert.equal(result.receipt.providerFlatConfirmed, true);
    assert.equal(result.budget.limitUsd, 2_000);
    assert.ok(result.budget.totalCapitalUsd <= 2_000);
    assert.equal(result.policyVersion, RWA_CONNECTIVITY_SMOKE_POLICY_VERSION);
    assert.equal(result.policyDigest, RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST);
    assert.equal(result.providerMutationCount, 4);
    assert.equal(
      client.activityPreparations.some((item) => item.mutation === "set_leverage"),
      false,
    );
    assert.deepEqual(
      result.timeline.map((event: { stage: string }) => event.stage),
      [
        "reserved", "spot_opening", "spot_open", "futures_opening", "hedged",
        "futures_closing", "spot_closing", "flat",
      ],
    );
    assert.deepEqual(
      Object.keys(result.orders.spotOpen).sort(),
      [
        "averagePriceUsd", "category", "feeUsd", "filledQuantityXaut", "orderId", "orderLinkId",
        "reduceOnly", "requestedQuantityXaut", "side", "status", "updatedAt",
      ].sort(),
    );
    assert.deepEqual(
      [
        [result.orders.spotOpen.category, result.orders.spotOpen.side, result.orders.spotOpen.reduceOnly,
          result.orders.spotOpen.orderLinkId.endsWith("s1")],
        [result.orders.futuresOpen.category, result.orders.futuresOpen.side, result.orders.futuresOpen.reduceOnly,
          result.orders.futuresOpen.orderLinkId.endsWith("p1")],
        [result.orders.futuresClose.category, result.orders.futuresClose.side, result.orders.futuresClose.reduceOnly,
          result.orders.futuresClose.orderLinkId.endsWith("c1")],
        [result.orders.spotClose.category, result.orders.spotClose.side, result.orders.spotClose.reduceOnly,
          result.orders.spotClose.orderLinkId.endsWith("c2")],
      ],
      [
        ["spot", "Buy", false, true],
        ["linear", "Sell", false, true],
        ["linear", "Buy", true, true],
        ["spot", "Sell", false, true],
      ],
    );
    assert.deepEqual(result.providerState, {
      verificationStatus: "verified",
      observedAt: now,
      residualSpotQuantityXaut: 0,
      residualFuturesQuantityXaut: 0,
      activeSpotOrderCount: 0,
      activeFuturesOrderCount: 0,
      activeTotalOrderCount: 0,
      providerFlatConfirmed: true,
      reason: "provider_flat_confirmed",
    });
    assert.deepEqual(result.receipt.finalProviderState, result.providerState);
    assert.equal(result.receipt.metrics.actualFeesUsd.availability, "available");
    assert.equal(result.receipt.metrics.actualFeesUsd.value, 0.004);
    assert.deepEqual(result.receipt.metrics.actualSlippageUsd, {
      availability: "unavailable",
      value: null,
      reason: "authoritative_reference_prices_not_persisted",
    });
    assert.deepEqual(result.receipt.metrics.actualRealizedPnlUsd, {
      availability: "unavailable",
      value: null,
      reason: "authoritative_pnl_inputs_not_persisted",
    });
    assert.equal(result.receipt.disclosureAvailability, "available");
    assert.equal(JSON.stringify(result).includes("challengeToken"), false);
    assert.equal(JSON.stringify(result).includes("credential"), false);
    assert.deepEqual(
      client.placedRequests.map((item) => [item.category, item.side, item.reduceOnly]),
      [
        ["spot", "Buy", false],
        ["linear", "Sell", false],
        ["linear", "Buy", true],
        ["spot", "Sell", false],
      ],
    );
    const state = await harness.store.readState();
    assert.equal(state.executions.length, 0);
    assert.equal(state.pnlSeries.length, 0);
    assert.equal(state.connectivitySmokes[0]?.receipt?.providerFlatConfirmed, true);
    for (const mutate of [
      (smoke: any) => { smoke.spotOpenOrder.orderLinkId = `${smoke.orderLinkPrefix}p1`; },
      (smoke: any) => { smoke.futuresOpenOrder.filledQuantityXaut = smoke.futuresOpenOrder.requestedQuantityXaut + 1; },
      (smoke: any) => { smoke.exit.futuresCloseOrder.feeUsd = -1; },
      (smoke: any) => { smoke.providerState.verificationStatus = "stale"; smoke.providerState.providerFlatConfirmed = null; },
      (smoke: any) => {
        smoke.providerState.observedAt = null;
        smoke.providerState.residualSpotQuantityXaut = null;
        smoke.providerState.residualFuturesQuantityXaut = null;
        smoke.providerState.activeSpotOrderCount = null;
        smoke.providerState.activeFuturesOrderCount = null;
        smoke.providerState.activeTotalOrderCount = null;
        smoke.providerState.providerFlatConfirmed = null;
      },
      (smoke: any) => {
        smoke.providerState.verificationStatus = "stale";
        smoke.providerState.reason = "provider_snapshot_stale";
        smoke.providerState.providerFlatConfirmed = null;
        smoke.providerState.activeFuturesOrderCount = null;
      },
      (smoke: any) => {
        smoke.providerState.verificationStatus = "ambiguous";
        smoke.providerState.reason = "activity_evidence_incomplete";
        smoke.providerState.providerFlatConfirmed = null;
        smoke.providerState.residualSpotQuantityXaut = null;
      },
      (smoke: any) => {
        smoke.providerState.verificationStatus = "unavailable";
        smoke.providerState.reason = "provider_snapshot_unavailable";
        smoke.providerState.providerFlatConfirmed = null;
      },
      (smoke: any) => { smoke.providerState.observedAt = smoke.updatedAt + 1; },
      (smoke: any) => { smoke.receipt.finalSpotQuantityXaut = 0.1; },
      (smoke: any) => { smoke.timeline.at(-1).code = "invalid"; },
    ]) {
      const invalid = structuredClone(state);
      mutate(invalid.connectivitySmokes[0]);
      await assert.rejects(harness.store.writeState(invalid));
    }
    const historical = state.connectivitySmokes[0] as any;
    historical.policyVersion = "connectivity-smoke-historical-v0";
    historical.policyDigest = "historical-policy-digest";
    historical.receipt.policyVersion = historical.policyVersion;
    historical.receipt.policyDigest = historical.policyDigest;
    await harness.store.writeState(state);
    const historicalReceipt = await harness.current.getConnectivitySmokeReceipt(result.smokeId) as any;
    assert.equal(historicalReceipt.disclosureAvailability, "unavailable_for_historical_digest");
    assert.equal(historicalReceipt.disclosure, null);
    assert.equal(historicalReceipt.disclosureReason, "historical_policy_digest_not_available");
    for (const mutate of [
      (smoke: any) => { smoke.receipt.unknown = true; },
      (smoke: any) => { smoke.receipt.smokeId = "other"; },
      (smoke: any) => { smoke.receipt.completedAt = smoke.updatedAt + 1; },
      (smoke: any) => {
        smoke.receipt.budget = {
          ...smoke.receipt.budget,
          quantityXaut: smoke.receipt.budget.quantityXaut + 0.001,
        };
      },
      (smoke: any) => { smoke.spotOpenOrder.feeUsd = -1; },
      (smoke: any) => { smoke.spotOpenOrder.orderLinkId = `${smoke.orderLinkPrefix}p1`; },
      (smoke: any) => { smoke.budget.totalCapitalUsd = 26; },
      (smoke: any) => { smoke.exit.spotFlatConfirmed = "yes"; },
    ]) {
      const invalidLegacy = structuredClone(state) as any;
      const invalidSmoke = invalidLegacy.connectivitySmokes[0];
      delete invalidSmoke.providerState;
      delete invalidSmoke.timeline;
      mutate(invalidSmoke);
      await writeFile((harness.store as any).statePath, JSON.stringify(invalidLegacy), { mode: 0o600 });
      await assert.rejects(harness.store.readState());
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance production smoke accepts a permit above 25 within generic caps and balances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-approved-capital-"));
  try {
    const harness = await productionSmokeHarness(directory, 30);
    const challenge = await harness.current.preflightConnectivitySmoke(
      harness.accountId,
      smokePolicyAcceptance,
    );
    const executeRequest = smokeExecuteInput(
      harness.accountId,
      challenge,
      "smoke:approved-capital:1",
    );
    const writes: Array<{ writeCount: number; smokeCount: number; consumptionCount: number }> = [];
    const reservedStates: Array<Awaited<ReturnType<typeof harness.store.readState>>> = [];
    const writeState = harness.store.writeState.bind(harness.store);
    harness.store.writeState = async (state) => {
      writes.push({
        writeCount: harness.client.writeCount,
        smokeCount: state.connectivitySmokes.length,
        consumptionCount: state.productionSelfTestPermitConsumptions.length,
      });
      if (state.connectivitySmokes[0]?.stage === "reserved"
        && state.connectivitySmokes[0].authorization.capitalTest) {
        reservedStates.push(structuredClone(state));
      }
      return writeState(state);
    };
    const result = await harness.current.executeConnectivitySmoke(executeRequest) as any;
    assert.equal(result.stage, "flat");
    assert.equal(result.budget.limitUsd, 30);
    assert.ok(result.budget.totalCapitalUsd <= 30);
    assert.equal(harness.client.writeCount, 4);
    assert.deepEqual(writes[0], { writeCount: 0, smokeCount: 1, consumptionCount: 1 });
    const state = await harness.store.readState();
    assert.deepEqual(state.connectivitySmokes[0]?.authorization.capitalTest, {
      accountBindingSha256: binanceAccountBindingSha256(
        harness.client.access.accountId,
        harness.client.access.accountFingerprint,
      ),
      revision: "8".repeat(40),
      approvedCapitalUsd: 30,
      expiresAt: now + 60_000,
      ...capitalTestPermitLimits,
      authorizationDigest: "4".repeat(64),
      permitDigest: state.config.productionSelfTestPermitConfirmation?.digest,
    });
    assert.deepEqual(state.productionSelfTestPermitConsumptions, [{
      permitId: "9".repeat(32),
      digest: state.config.productionSelfTestPermitConfirmation?.digest,
      consumedAt: now,
    }]);
    const historical = structuredClone(state);
    delete historical.connectivitySmokes[0]!.authorization.capitalTest;
    await harness.store.writeState(historical);
    const reservedState = reservedStates[0];
    assert.ok(reservedState);
    const activeWithoutTuple = structuredClone(reservedState);
    delete activeWithoutTuple.connectivitySmokes[0]!.authorization.capitalTest;
    await assert.rejects(harness.store.writeState(activeWithoutTuple));
    for (const mutate of [
      (tuple: any) => { delete tuple.executionId; },
      (tuple: any) => { tuple.revision = "6".repeat(40); },
      (tuple: any) => { tuple.accountBindingSha256 = "5".repeat(64); },
      (tuple: any) => { tuple.authorizationDigest = "3".repeat(64); },
      (tuple: any) => { tuple.maxOrderCount = 5; },
    ]) {
      const invalid = structuredClone(reservedState);
      mutate(invalid.connectivitySmokes[0]!.authorization.capitalTest);
      await assert.rejects(harness.store.writeState(invalid));
    }

    const idempotent = await harness.current.executeConnectivitySmoke(executeRequest) as any;
    assert.equal(idempotent.smokeId, result.smokeId);
    assert.equal(harness.client.writeCount, 4);
    assert.equal((await harness.store.readState()).productionSelfTestPermitConsumptions.length, 1);

    const nextChallenge = await harness.current.preflightConnectivitySmoke(
      harness.accountId,
      smokePolicyAcceptance,
    );
    await assert.rejects(
      harness.current.executeConnectivitySmoke(
        smokeExecuteInput(harness.accountId, nextChallenge, "smoke:approved-capital:2"),
      ),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "production_self_test_permit_consumed",
    );
    assert.equal(harness.client.writeCount, 4);
    assert.equal((await harness.store.readState()).productionSelfTestPermitConsumptions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Capital Test loss limit is not compared with authorized deployed capital", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-loss-limit-"));
  try {
    const harness = await productionSmokeHarness(directory, 40, { lossLimitUsd: 10 });
    const challenge = await harness.current.preflightConnectivitySmoke(
      harness.accountId,
      smokePolicyAcceptance,
    );
    const result = await harness.current.executeConnectivitySmoke(
      smokeExecuteInput(harness.accountId, challenge, "smoke:loss-limit:1"),
    ) as any;
    assert.ok(result.budget.totalCapitalUsd > 10);
    assert.ok(result.budget.totalCapitalUsd <= 40);
    assert.equal(result.stage, "flat");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance production smoke failure permanently consumes the permit without provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-consumed-failure-"));
  try {
    const harness = await productionSmokeHarness(directory, 30);
    const challenge = await harness.current.preflightConnectivitySmoke(
      harness.accountId,
      smokePolicyAcceptance,
    );
    harness.client.snapshot.perpetual.leverage = 2;
    const failed = await harness.current.executeConnectivitySmoke(
      smokeExecuteInput(harness.accountId, challenge, "smoke:consumed-failure:1"),
    ) as any;
    assert.equal(failed.stage, "failed");
    assert.equal(failed.receipt, null);
    assert.equal(harness.client.writeCount, 0);
    assert.equal((await harness.store.readState()).productionSelfTestPermitConsumptions.length, 1);

    harness.client.snapshot.perpetual.leverage = 1;
    const nextChallenge = await harness.current.preflightConnectivitySmoke(
      harness.accountId,
      smokePolicyAcceptance,
    );
    await assert.rejects(
      harness.current.executeConnectivitySmoke(
        smokeExecuteInput(harness.accountId, nextChallenge, "smoke:consumed-failure:2"),
      ),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "production_self_test_permit_consumed",
    );
    assert.equal(harness.client.writeCount, 0);
    assert.equal((await harness.store.readState()).productionSelfTestPermitConsumptions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance production self-test Permit rejects every non-smoke new-risk entry before provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-permit-smoke-only-"));
  try {
    const harness = await productionSmokeHarness(directory, 30);
    const challenge = await harness.current.preflight(
      opportunity(),
      harness.accountId,
      "manual_entry",
    );
    const smokeOnly = (error: unknown) => error instanceof RwaNeutralExecutionError
      && error.category === "production_self_test_permit_smoke_only";
    await assert.rejects(
      harness.current.execute(
        executeInput(harness.accountId, challenge, "permit:ordinary:execute"),
      ),
      smokeOnly,
    );
    assert.equal((await harness.store.readState()).executions.length, 0);

    await assert.rejects(
      harness.current.previewAssetTakeover({ assetId: "xaut", newCapitalUsd: 1, leverage: 2 }),
      smokeOnly,
    );
    await assert.rejects(
      harness.current.startAssetTakeover({
        assetId: "xaut",
        preview: {} as RwaAssetTakeoverPreview,
        idempotencyKey: "permit-takeover-start",
      }),
      smokeOnly,
    );
    await assert.rejects(
      harness.current.reconfirmAssetTakeover({
        takeoverId: "permit-takeover",
        preview: {} as RwaAssetTakeoverPreview,
      }),
      smokeOnly,
    );

    const guardedClient = await (harness.current as any).clientForTakeover() as RwaBinanceClient;
    await assert.rejects(
      guardedClient.placeOrder(
        smokeProviderRequest("spot", "Buy", "permitnonriskentry", false),
      ),
      smokeOnly,
    );
    await assert.rejects(
      guardedClient.placeOrder(
        smokeProviderRequest("linear", "Sell", "permitnonriskfuture", false),
      ),
      smokeOnly,
    );
    assert.equal(harness.client.writeCount, 0);

    await guardedClient.placeOrder(
      smokeProviderRequest("spot", "Sell", "permitspotreduceonly", false),
    );
    await guardedClient.placeOrder(
      smokeProviderRequest("linear", "Buy", "permitfuturereduce", true),
    );
    assert.equal(harness.client.writeCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke rejects changed canonical budget facts before provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-budget-change-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshot.fees.spotTakerBps += 1;
    await assert.rejects(harness.current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:budget-change:1"),
    ));
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke requires a readable existing 1x leverage before provider writes", async () => {
  for (const leverage of [2, null]) {
    const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-leverage-preflight-"));
    try {
      const client = new FakeBinanceClient();
      client.snapshot.perpetual.leverage = leverage;
      const current = service(directory, "user-a", client);
      const accountId = await activate(current);
      await assert.rejects(
        current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance),
        (error: unknown) => error instanceof RwaNeutralExecutionError
          && error.category === "connectivity_smoke_preflight_rejected",
      );
      assert.equal(client.writeCount, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Binance connectivity smoke rejects a 1x to 2x change after challenge and before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-leverage-changed-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshot.perpetual.leverage = 2;
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:leverage:changed"),
    ) as any;
    assert.equal(result.stage, "failed");
    assert.equal(result.receipt, null);
    assert.equal(client.writeCount, 0);
    assert.equal(client.activityPreparations.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke tombstones a leverage race before its first Spot mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-leverage-first-mutation-race-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshotReadCount = 0;
    client.snapshotHook = () => {
      if (client.snapshotReadCount === 2) client.snapshot.perpetual.leverage = 2;
    };
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:leverage:first-mutation-race"),
    ) as any;
    assert.equal(result.stage, "failed");
    assert.equal(result.errorCategory, "connectivity_smoke_leverage_not_1x");
    assert.equal(result.receipt, null);
    assert.equal(client.writeCount, 0);
    assert.equal(client.activityPreparations.length, 0);

    client.snapshotHook = () => {};
    client.snapshot.perpetual.leverage = 1;
    const nextChallenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    assert.ok(nextChallenge.challengeId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke rejects the previous policy version before provider writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-old-policy-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    await assert.rejects(
      current.executeConnectivitySmoke({
        ...smokeExecuteInput(accountId, challenge, "smoke:old-policy:1"),
        policyVersion: "connectivity-smoke-gate2-capital-v3",
      }),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "connectivity_smoke_policy_mismatch",
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke closes owned Spot when leverage changes before Futures entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-leverage-runtime-"));
  try {
    const client = new FakeBinanceClient();
    client.snapshotHook = () => {
      if (client.placedRequests.length === 1) client.snapshot.perpetual.leverage = 2;
    };
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:leverage:runtime"),
    ) as any;
    assert.deepEqual(
      client.placedRequests.map((item) => [item.category, item.side, item.reduceOnly]),
      [
        ["spot", "Buy", false],
        ["spot", "Sell", false],
      ],
    );
    assert.equal(result.stage, "flat");
    assert.equal(result.receipt.providerFlatConfirmed, true);
    assert.equal(
      client.activityPreparations.some((item) => item.mutation === "set_leverage"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke closes both owned legs when leverage changes after hedge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-leverage-hedged-"));
  try {
    const client = new FakeBinanceClient();
    client.snapshotHook = () => {
      if (client.placedRequests.length === 2) client.snapshot.perpetual.leverage = 2;
    };
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:leverage:hedged"),
    ) as any;
    assert.deepEqual(
      client.placedRequests.map((item) => [item.category, item.side, item.reduceOnly]),
      [
        ["spot", "Buy", false],
        ["linear", "Sell", false],
        ["linear", "Buy", true],
        ["spot", "Sell", false],
      ],
    );
    assert.equal(result.stage, "flat");
    assert.equal(result.receipt.providerFlatConfirmed, true);
    assert.equal(
      client.activityPreparations.some((item) => item.mutation === "set_leverage"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance production smoke rejects an old challenge when the permit limit changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-permit-change-"));
  try {
    const harness = await productionSmokeHarness(directory, 30);
    const challenge = await harness.current.preflightConnectivitySmoke(
      harness.accountId,
      smokePolicyAcceptance,
    );
    harness.setApprovedCapitalUsd(31);
    await assert.rejects(harness.current.executeConnectivitySmoke(
      smokeExecuteInput(harness.accountId, challenge, "smoke:permit-change:1"),
    ));
    assert.equal(harness.client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke window verification persists stale evidence and performs no provider mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-stale-window-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshotReadCount = 0;
    client.staleSnapshotReads.add(1);
    const result = await harness.current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:stale:window"),
    ) as any;
    assert.equal(result.stage, "failed");
    assert.equal(result.receipt, null);
    assert.equal(result.providerState.verificationStatus, "stale");
    assert.equal(result.providerState.providerFlatConfirmed, null);
    assert.equal(result.providerState.reason, "provider_snapshot_stale");
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke maps a future provider snapshot time to unavailable without exposing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-future-window-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshotReadCount = 0;
    client.snapshotFetchedAtOverrides.set(1, now + 1);
    const result = await harness.current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:future:window"),
    ) as any;
    assert.equal(result.stage, "failed");
    assert.equal(result.receipt, null);
    assert.deepEqual(result.providerState, {
      verificationStatus: "unavailable",
      observedAt: null,
      residualSpotQuantityXaut: null,
      residualFuturesQuantityXaut: null,
      activeSpotOrderCount: null,
      activeFuturesOrderCount: null,
      activeTotalOrderCount: null,
      providerFlatConfirmed: null,
      reason: "provider_snapshot_time_invalid",
    });
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke final flat confirmation refuses stale snapshots and does not issue a success receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-stale-final-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshotReadCount = 0;
    for (let index = 16; index <= 40; index += 1) client.staleSnapshotReads.add(index);
    const result = await harness.current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:stale:final"),
    ) as any;
    assert.equal(client.placedRequests.length, 4);
    assert.equal(result.stage, "manual_intervention");
    assert.equal(result.receipt, null);
    assert.equal(result.providerState.verificationStatus, "stale");
    assert.equal(result.providerState.providerFlatConfirmed, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke performs zero provider writes when balance cannot satisfy the four-action budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-budget-"));
  try {
    const client = new FakeBinanceClient();
    client.snapshot.spotAvailableUsdt = 1;
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    await assert.rejects(
      current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance),
      (error: unknown) => error instanceof RwaNeutralExecutionError
        && error.category === "connectivity_smoke_preflight_rejected",
    );
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke futures failure only exits filled spot and duplicate execute cannot reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-futures-fail-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: [1, "throw", 1] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const input = smokeExecuteInput(accountId, challenge, "smoke:futures:fail");
    const first = await current.executeConnectivitySmoke(input) as any;
    assert.equal(first.stage, "flat");
    assert.equal(first.openedFuturesQuantityXaut, 0);
    assert.deepEqual(first.receipt.metrics.actualFeesUsd, {
      availability: "unavailable",
      value: null,
      reason: "authoritative_fee_inputs_incomplete",
    });
    const writes = client.writeCount;
    const duplicate = await current.executeConnectivitySmoke(input) as any;
    assert.equal(duplicate.smokeId, first.smokeId);
    assert.equal(client.writeCount, writes);
    assert.equal(client.placedRequests.filter((item) => item.side === "Sell" && item.category === "linear").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "Spot open New", fillPlan: ["new"], cancelSuffix: "s1", expectedStage: "failed" },
  { name: "Spot open Partial", fillPlan: [0.5, 1, 1, 1], cancelSuffix: "s1", expectedStage: "flat" },
  { name: "Futures open New", fillPlan: [1, "new", 1], cancelSuffix: "p1", expectedStage: "flat" },
  { name: "Futures open Partial", fillPlan: [1, 0.5, 1, 1], cancelSuffix: "p1", expectedStage: "flat" },
  { name: "Futures close New", fillPlan: [1, 1, "new"], cancelSuffix: "c1", expectedStage: "manual_intervention" },
  { name: "Futures close Partial", fillPlan: [1, 1, 0.5], cancelSuffix: "c1", expectedStage: "manual_intervention" },
  { name: "Spot close New", fillPlan: [1, 1, 1, "new"], cancelSuffix: "c2", expectedStage: "manual_intervention" },
  { name: "Spot close Partial", fillPlan: [1, 1, 1, 0.5], cancelSuffix: "c2", expectedStage: "manual_intervention" },
] as const) {
  test(`Binance connectivity smoke cancels its exact ${scenario.name} with a real provider open-order count`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-active-ioc-"));
    try {
      const client = new FakeBinanceClient({ fillPlan: [...scenario.fillPlan] });
      const current = service(directory, "user-a", client);
      const accountId = await activate(current);
      const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
      const result = await current.executeConnectivitySmoke(
        smokeExecuteInput(accountId, challenge, `smoke:active:${scenario.cancelSuffix}:${scenario.name.includes("Partial") ? "p" : "n"}`),
      ) as any;
      assert.equal(result.stage, scenario.expectedStage);
      const cancelled = client.placedRequests.find((item) => item.orderLinkId.endsWith(scenario.cancelSuffix));
      assert.ok(cancelled);
      assert.equal(client.cancelCount, 1);
      assert.equal(
        client.placedRequests.filter((item) => item.orderLinkId === cancelled.orderLinkId).length,
        1,
      );
      if (scenario.cancelSuffix === "p1") {
        assert.equal(
          client.placedRequests.filter((item) => item.category === "linear" && item.side === "Sell").length,
          1,
          "Futures open cancel must never supplement or resend entry risk",
        );
      }
      if (scenario.cancelSuffix === "c1" && result.stage === "manual_intervention") {
        assert.equal(
          client.placedRequests.some((item) => item.category === "spot" && item.side === "Sell"),
          false,
          "Spot must not exit before Futures is authoritatively flat",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Binance connectivity smoke refuses cancel when an exact rwacs active IOC coexists with an unknown order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-extra-open-order-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["new"] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.extraUnknownOpenOrderAfterPlace = true;
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:active:unknown"),
    ) as any;
    assert.equal(result.stage, "manual_intervention");
    assert.equal(client.cancelCount, 0);
    assert.equal(client.placedRequests.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [scenarioIndex, scenario] of ([
  { name: "Spot open", fillPlan: ["throw_after_fill", 1] },
  { name: "Futures open", fillPlan: [1, "throw_after_fill", 1, 1] },
  { name: "Futures close", fillPlan: [1, 1, "throw_after_fill", 1] },
  { name: "Spot close", fillPlan: [1, 1, 1, "throw_after_fill"] },
] as const).entries()) {
  test(`Binance connectivity smoke recovers ${scenario.name} accepted-before-persist by client ID without duplicate order`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-uncertain-"));
    try {
      const client = new FakeBinanceClient({ fillPlan: [...scenario.fillPlan] });
      const current = service(directory, "user-a", client);
      const accountId = await activate(current);
      const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
      const result = await current.executeConnectivitySmoke(
        smokeExecuteInput(accountId, challenge, `smoke:uncertain:${scenarioIndex}`),
      ) as any;
      assert.ok(["flat", "manual_intervention"].includes(result.stage));
      const ids = client.placedRequests.map((item) => item.orderLinkId);
      assert.equal(new Set(ids).size, ids.length, "deterministic client ID must be queried, never blindly resent");
      assert.equal(client.snapshot.existingSpotQuantityXaut, 0);
      assert.equal(client.snapshot.existingPerpetualQuantityXaut, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Binance connectivity smoke restart before first mutation tombstones without reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-restart-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const budget = challenge.report.budget;
    const state = await harness.store.readState();
    state.connectivitySmokes.push({
      smokeId: "smoke-reserved",
      userId: "user-a",
      accountId,
      accountFingerprint: client.access.accountFingerprint,
      purpose: "connectivity_smoke",
      mode: "connectivity_smoke",
      idempotencyKey: `${harness.store.userDomain}:smoke:restart`,
      challengeId: challenge.challengeId,
      requestDigest: "test-request-digest",
      policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
      policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
      orderLinkPrefix: "rwacsrestart",
      stage: "reserved",
      budget,
      authorization: {
        operation: "connectivity_smoke_execute",
        consumedBeforeProviderMutation: true,
        exitAuthorized: true,
        reservedAt: now,
      },
      spotOpenOrder: null,
      futuresOpenOrder: null,
      openedSpotQuantityXaut: 0,
      openedFuturesQuantityXaut: 0,
      exit: {
        futuresCloseOrder: null,
        spotCloseOrder: null,
        futuresFlatConfirmed: false,
        spotFlatConfirmed: false,
      },
      providerState: testUnavailableSmokeProviderState(),
      timeline: [{ stage: "reserved", at: now, code: "reserved" }],
      receipt: null,
      noReopen: true,
      providerMutationCount: 0,
      errorCategory: null,
      message: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    await harness.store.writeState(state);
    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();
    const restored = await harness.store.readState();
    assert.equal(restored.connectivitySmokes[0]?.stage, "failed");
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke parent state migrates active and terminal records without fabricating authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-legacy-state-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const active = smokeOpeningRecord({
      accountId,
      challenge,
      prefix: "rwacslegacyactive",
      stage: "spot_opening",
      spotOrder: null,
    }) as any;
    const terminal = smokeOpeningRecord({
      accountId,
      challenge,
      prefix: "rwacslegacyterminal",
      stage: "spot_opening",
      spotOrder: null,
    }) as any;
    terminal.stage = "failed";
    terminal.idempotencyKey = "smoke:legacy:terminal";
    terminal.timeline.push({ stage: "failed", at: now, code: "stage_failed" });
    const state = await harness.store.readState();
    state.connectivitySmokes.push(active, terminal);
    await harness.store.writeState(state);
    const legacy = structuredClone(state) as any;
    for (const smoke of legacy.connectivitySmokes) {
      delete smoke.providerState;
      delete smoke.timeline;
      smoke.receipt = smoke.stage === "failed" ? null : smoke.receipt;
    }
    active.idempotencyKey = `${harness.store.userDomain}:smoke:legacy-r2`;
    legacy.connectivitySmokes[0].idempotencyKey = active.idempotencyKey;
    await writeFile(harness.store.statePath, JSON.stringify(legacy), { mode: 0o600 });
    const legacyFileBefore = await stateFileIdentity(harness.store.statePath);
    const originalWriteState = harness.store.writeState.bind(harness.store);
    let persistentWriteCalls = 0;
    harness.store.writeState = async (nextState) => {
      persistentWriteCalls += 1;
      return originalWriteState(nextState);
    };
    const found = await harness.current.lookupConnectivitySmokeExecution({
      accountId,
      challengeId: challenge.challengeId,
      idempotencyKey: "legacy-r2",
    }) as any;
    assert.equal(found.smokeId, active.smokeId);
    assert.equal(found.providerState.verificationStatus, "unavailable");
    assert.equal(found.timeline.at(-1)?.code, "legacy_migration_current_stage");
    assert.equal(persistentWriteCalls, 0);
    assert.deepEqual(await stateFileIdentity(harness.store.statePath), legacyFileBefore);
    const migrated = await harness.store.readState();
    assert.equal(persistentWriteCalls, 1);
    assert.deepEqual(
      migrated.connectivitySmokes.map((smoke) => [
        smoke.stage,
        smoke.providerState.verificationStatus,
        smoke.providerState.reason,
        smoke.receipt,
        smoke.timeline.at(-1)?.code,
      ]),
      [
        ["spot_opening", "unavailable", "legacy_provider_state_unavailable", null, "legacy_migration_current_stage"],
        ["failed", "unavailable", "legacy_provider_state_unavailable", null, "legacy_migration_current_stage"],
      ],
    );
    const readsBeforeRecovery = client.readCount;
    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();
    const recovered = await harness.store.readState();
    assert.equal(recovered.connectivitySmokes[0]?.stage, "failed");
    assert.equal(recovered.connectivitySmokes[0]?.providerState.verificationStatus, "verified");
    assert.ok(client.readCount > readsBeforeRecovery);
    assert.equal(client.writeCount, 0);

    const partial = structuredClone(recovered) as any;
    delete partial.connectivitySmokes[0].timeline;
    await writeFile((harness.store as any).statePath, JSON.stringify(partial), { mode: 0o600 });
    await assert.rejects(harness.store.readState());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { stage: "spot_opening", behavior: "new", expectedFuturesEntryCount: 0 },
  { stage: "spot_opening", behavior: 0.5, expectedFuturesEntryCount: 0 },
  { stage: "futures_opening", behavior: "new", expectedFuturesEntryCount: 1 },
  { stage: "futures_opening", behavior: 0.5, expectedFuturesEntryCount: 1 },
] as const) {
  test(`Binance connectivity smoke restart recovers ${scenario.stage} ${scenario.behavior} by fixed ID and only reduces risk`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-opening-restart-"));
    try {
      const client = new FakeBinanceClient({
        fillPlan: scenario.stage === "spot_opening"
          ? [scenario.behavior]
          : [1, scenario.behavior],
      });
      const harness = serviceHarness(directory, "user-a", client);
      const accountId = await activate(harness.current);
      const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
      const prefix = `rwacsrestart${scenario.stage === "spot_opening" ? "s" : "p"}${scenario.behavior === "new" ? "n" : "p"}`;
      let spotOrder: RwaProviderOrder | null = null;
      if (scenario.stage === "futures_opening") {
        const acceptedSpot = await client.placeOrder(smokeProviderRequest("spot", "Buy", `${prefix}s1`, false));
        spotOrder = await client.awaitOrder("spot", acceptedSpot.orderId);
      }
      const category = scenario.stage === "spot_opening" ? "spot" : "linear";
      const acceptedOpening = await client.placeOrder(smokeProviderRequest(
        category,
        category === "spot" ? "Buy" : "Sell",
        `${prefix}${category === "spot" ? "s1" : "p1"}`,
        false,
      ));
      await client.awaitOrder(category, acceptedOpening.orderId);
      const state = await harness.store.readState();
      state.connectivitySmokes.push(smokeOpeningRecord({
        accountId,
        challenge,
        prefix,
        stage: scenario.stage,
        spotOrder,
      }));
      await harness.store.writeState(state);
      const writesBeforeRestart = client.writeCount;
      const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
      await restarted.initialize();
      const restored = (await harness.store.readState()).connectivitySmokes[0]!;
      assert.ok(["flat", "failed"].includes(restored.stage));
      assert.equal(client.cancelCount, 1);
      const recoveryCancelPreparation = client.activityPreparations.find(
        (item) => item.mutation === (category === "spot" ? "cancel_spot_order" : "cancel_futures_order")
          && item.providerOrderId === acceptedOpening.orderId,
      );
      assert.ok(recoveryCancelPreparation);
      assert.equal(recoveryCancelPreparation.orderLinkId, `${prefix}${category === "spot" ? "s1" : "p1"}`);
      assert.deepEqual(recoveryCancelPreparation.strategyOrderPrefixes, [prefix]);
      assert.equal(recoveryCancelPreparation.since, state.connectivitySmokes.at(-1)?.createdAt);
      assert.equal(
        client.placedRequests.filter((item) => item.orderLinkId === `${prefix}${category === "spot" ? "s1" : "p1"}`).length,
        1,
      );
      assert.equal(
        client.placedRequests.filter((item) => item.category === "linear" && item.side === "Sell").length,
        scenario.expectedFuturesEntryCount,
        "restart must never create or supplement a Futures entry",
      );
      assert.ok(client.writeCount > writesBeforeRestart);
      assert.equal(client.snapshot.existingSpotQuantityXaut, 0);
      assert.equal(client.snapshot.existingPerpetualQuantityXaut, 0);
      if (scenario.stage === "futures_opening" && scenario.behavior !== "new") {
        const close = client.placedRequests.find((item) => item.orderLinkId === `${prefix}c1`);
        assert.ok(close?.reduceOnly);
        assert.equal(close.quantityXaut, restored.openedFuturesQuantityXaut);
        const futuresCloseIndex = client.placedRequests.findIndex((item) => item.orderLinkId === `${prefix}c1`);
        const spotCloseIndex = client.placedRequests.findIndex((item) => item.orderLinkId === `${prefix}c2`);
        assert.ok(futuresCloseIndex >= 0 && spotCloseIndex > futuresCloseIndex);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const stage of ["spot_opening", "futures_opening"] as const) {
  test(`Binance connectivity smoke restart rebuilds terminal ${stage} order and never resends entry`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-opening-terminal-"));
    try {
      const client = new FakeBinanceClient();
      const harness = serviceHarness(directory, "user-a", client);
      const accountId = await activate(harness.current);
      const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
      const prefix = `rwacsterminal${stage === "spot_opening" ? "s" : "p"}`;
      let spotOrder: RwaProviderOrder | null = null;
      if (stage === "futures_opening") {
        const acceptedSpot = await client.placeOrder(smokeProviderRequest("spot", "Buy", `${prefix}s1`, false));
        spotOrder = await client.awaitOrder("spot", acceptedSpot.orderId);
      }
      const category = stage === "spot_opening" ? "spot" : "linear";
      const openingId = `${prefix}${category === "spot" ? "s1" : "p1"}`;
      const accepted = await client.placeOrder(smokeProviderRequest(
        category,
        category === "spot" ? "Buy" : "Sell",
        openingId,
        false,
      ));
      await client.awaitOrder(category, accepted.orderId);
      const state = await harness.store.readState();
      state.connectivitySmokes.push(smokeOpeningRecord({ accountId, challenge, prefix, stage, spotOrder }));
      await harness.store.writeState(state);
      const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
      await restarted.initialize();
      const restored = (await harness.store.readState()).connectivitySmokes[0]!;
      assert.equal(restored.stage, "flat");
      assert.equal(client.cancelCount, 0);
      assert.equal(client.placedRequests.filter((item) => item.orderLinkId === openingId).length, 1);
      assert.equal(
        client.placedRequests.filter((item) => item.category === "linear" && item.side === "Sell").length,
        stage === "futures_opening" ? 1 : 0,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Binance connectivity smoke restart tombstones missing s1 with authoritative blank state and zero writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-opening-missing-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const state = await harness.store.readState();
    state.connectivitySmokes.push(smokeOpeningRecord({
      accountId,
      challenge,
      prefix: "rwacsmissings",
      stage: "spot_opening",
      spotOrder: null,
    }));
    await harness.store.writeState(state);
    const writes = client.writeCount;
    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();
    const restored = (await harness.store.readState()).connectivitySmokes[0]!;
    assert.equal(restored.stage, "failed");
    assert.equal(restored.noReopen, true);
    assert.equal(client.writeCount, writes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke restart with missing p1 and authoritative Spot only submits c2 risk reduction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-missing-p1-spot-only-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const prefix = "rwacsmissingp1spot";
    const acceptedSpot = await client.placeOrder(
      smokeProviderRequest("spot", "Buy", `${prefix}s1`, false),
    );
    const spotOrder = await client.awaitOrder("spot", acceptedSpot.orderId);
    const authoritativeSpotQuantity = client.snapshot.existingSpotQuantityXaut;
    const state = await harness.store.readState();
    state.connectivitySmokes.push(smokeOpeningRecord({
      accountId,
      challenge,
      prefix,
      stage: "futures_opening",
      spotOrder,
    }));
    await harness.store.writeState(state);

    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();

    const restored = (await harness.store.readState()).connectivitySmokes[0]!;
    const p1Orders = client.placedRequests.filter((item) => item.orderLinkId === `${prefix}p1`);
    const c1Orders = client.placedRequests.filter((item) => item.orderLinkId === `${prefix}c1`);
    const c2Orders = client.placedRequests.filter((item) => item.orderLinkId === `${prefix}c2`);
    assert.equal(p1Orders.length, 0, "missing p1 must never be interpreted as permission to build Futures");
    assert.equal(c1Orders.length, 0, "Spot-only recovery must not submit a Futures close");
    assert.equal(c2Orders.length, 1);
    assert.equal(c2Orders[0]?.category, "spot");
    assert.equal(c2Orders[0]?.side, "Sell");
    assert.equal(c2Orders[0]?.reduceOnly, false);
    assert.ok((c2Orders[0]?.quantityXaut ?? Infinity) <= authoritativeSpotQuantity + 1e-12);
    assert.equal(restored.noReopen, true);
    assert.ok(["flat", "manual_intervention"].includes(restored.stage));
    assert.equal(
      client.placedRequests.filter((item) => item.category === "linear").length,
      0,
      "recovery must remain provider-write-free on the Futures side",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke restart will not cancel active s1 when an unknown order also exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-opening-extra-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: ["new"] });
    client.extraUnknownOpenOrderAfterPlace = true;
    const harness = serviceHarness(directory, "user-a", client);
    const accountId = await activate(harness.current);
    const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const prefix = "rwacsrestartunknown";
    const accepted = await client.placeOrder(smokeProviderRequest("spot", "Buy", `${prefix}s1`, false));
    await client.awaitOrder("spot", accepted.orderId);
    const state = await harness.store.readState();
    state.connectivitySmokes.push(smokeOpeningRecord({
      accountId,
      challenge,
      prefix,
      stage: "spot_opening",
      spotOrder: null,
    }));
    await harness.store.writeState(state);
    const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
    await restarted.initialize();
    const restored = (await harness.store.readState()).connectivitySmokes[0]!;
    assert.equal(restored.stage, "manual_intervention");
    assert.equal(client.cancelCount, 0);
    assert.equal(client.placedRequests.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ["unknown_order", "scanner_incomplete", "provider_unreadable"] as const) {
  test(`Binance connectivity smoke opening recovery fails closed for ${failure} without resend`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-opening-failclosed-"));
    try {
      const client = new FakeBinanceClient({ fillPlan: ["new"] });
      const harness = serviceHarness(directory, "user-a", client);
      const accountId = await activate(harness.current);
      const challenge = await harness.current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
      const prefix = `rwacsfail${failure.replaceAll("_", "")}`;
      const orderLinkId = `${prefix}s1`;
      const accepted = await client.placeOrder(smokeProviderRequest("spot", "Buy", orderLinkId, false));
      await client.awaitOrder("spot", accepted.orderId);
      if (failure === "unknown_order") client.setOrderStatus(orderLinkId, "Unknown");
      if (failure === "scanner_incomplete") client.smokeActivityProtocolComplete = false;
      if (failure === "provider_unreadable") client.findOrderFailure = true;
      const state = await harness.store.readState();
      state.connectivitySmokes.push(smokeOpeningRecord({
        accountId,
        challenge,
        prefix,
        stage: "spot_opening",
        spotOrder: null,
      }));
      await harness.store.writeState(state);
      const writes = client.writeCount;
      const restarted = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => false);
      await restarted.initialize();
      const restored = (await harness.store.readState()).connectivitySmokes[0]!;
      assert.equal(restored.stage, "manual_intervention");
      assert.equal(
        restored.providerState.verificationStatus,
        failure === "scanner_incomplete" ? "ambiguous" : "unavailable",
      );
      assert.equal(client.cancelCount, 0);
      assert.equal(client.writeCount, writes);
      assert.equal(client.placedRequests.filter((item) => item.orderLinkId === orderLinkId).length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Binance connectivity smoke external XAUT activity fails closed with no provider mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-external-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.snapshot.spotFreeXaut = 0.001;
    client.snapshot.spotAvailableQuantityXaut = 0.001;
    client.snapshot.existingSpotQuantityXaut = 0.001;
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:external:activity"),
    ) as any;
    assert.equal(result.stage, "manual_intervention");
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke detects a REST-visible same-net external round trip and performs no mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-external-roundtrip-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.externalPositionActivity = true;
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:external:roundtrip"),
    ) as any;
    assert.equal(result.stage, "manual_intervention");
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke rejects incomplete scanner source coverage before its first provider mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-scanner-incomplete-"));
  try {
    const client = new FakeBinanceClient();
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    client.smokeActivityProtocolComplete = false;
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:scanner:incomplete"),
    ) as any;
    assert.equal(result.stage, "manual_intervention");
    assert.equal(client.writeCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Binance connectivity smoke untradeable futures exit becomes manual intervention and never sells spot first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rwa-binance-smoke-exit-fail-"));
  try {
    const client = new FakeBinanceClient({ fillPlan: [1, 0.25] });
    const current = service(directory, "user-a", client);
    const accountId = await activate(current);
    const challenge = await current.preflightConnectivitySmoke(accountId, smokePolicyAcceptance);
    const result = await current.executeConnectivitySmoke(
      smokeExecuteInput(accountId, challenge, "smoke:exit:failure"),
    ) as any;
    assert.equal(result.stage, "manual_intervention");
    assert.ok(result.openedFuturesQuantityXaut > 0);
    assert.equal(
      client.placedRequests.some((item) => item.category === "spot" && item.side === "Sell"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Recovery Unbind distinguishes provider-verified flat from unreadable provider state", async () => {
  for (const providerReadable of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), `xingheng-recovery-unbind-${providerReadable}-`));
    try {
      const client = new FakeBinanceClient();
      const harness = serviceHarness(directory, "user-a", client);
      await harness.current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
      if (!providerReadable) client.readPreflightSnapshot = async () => { throw new Error("provider unavailable"); };
      const recovery = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => true);
      assert.deepEqual(await recovery.recoveryUnbind(), { providerVerifiedFlat: providerReadable });
      assert.equal(await harness.store.readCredentialMetadata(), null);
      const state = await harness.store.readState();
      assert.equal(state.config.killSwitchActive, true);
      assert.equal(state.config.globalExecutionEnabled, false);
      assert.equal(state.config.strategyEnabled, false);
      assert.equal(providerReadable ? state.credentialAlert : Boolean(state.credentialAlert), providerReadable ? null : true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Recovery Unbind fails closed while automation is not fully stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-recovery-unbind-active-"));
  try {
    const client = new FakeBinanceClient();
    const harness = serviceHarness(directory, "user-a", client);
    await harness.current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
    const state = await harness.store.readState();
    state.config.globalExecutionEnabled = true;
    await harness.store.writeState(state);
    const recovery = new RwaBinanceAutomationService(harness.store, () => client, () => now, () => true);
    await assert.rejects(
      recovery.recoveryUnbind(),
      (error: unknown) => error instanceof RwaNeutralExecutionError && error.category === "recovery_unbind_automation_active",
    );
    assert.notEqual(await harness.store.readCredentialMetadata(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function service(directory: string, userId: string, client: FakeBinanceClient) {
  return serviceHarness(directory, userId, client).current;
}

async function stateFileIdentity(path: string) {
  const [bytes, metadata] = await Promise.all([
    readFile(path),
    stat(path, { bigint: true }),
  ]);
  return {
    bytes: bytes.toString("base64"),
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtNs: metadata.mtimeNs,
    changedAtNs: metadata.ctimeNs,
  };
}

function serviceHarness(
  directory: string,
  userId: string,
  client: FakeBinanceClient,
  leaseGuard: () => void = () => {},
  activityMonitoringEnabled?: () => boolean,
  productionSelfTestPermit?: () => RwaBinanceProductionSelfTestPermit | null,
  productionEnvironment?: () => boolean,
  clock: () => number = () => now,
) {
  const keyProvider = new FakeCredentialKeyProvider();
  const store = new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
    userId,
    venue: "binance",
    keyProvider,
    credentialPath: join(directory, `${userId}-credentials.json`),
    statePath: join(directory, `${userId}-state.json`),
  });
  return {
    current: new RwaBinanceAutomationService(
      store,
      () => client,
      clock,
      () => false,
      undefined,
      leaseGuard,
      activityMonitoringEnabled,
      productionSelfTestPermit,
      productionEnvironment,
    ),
    store,
    keyProvider,
  };
}

async function productionSmokeHarness(
  directory: string,
  approvedCapitalUsd: number,
  permitLimitOverrides: Partial<typeof capitalTestPermitLimits> = {},
) {
  const client = new FakeBinanceClient();
  const userId = "USR-MOSSSMOKE";
  const basePermit = {
    ...capitalTestPermitLimits,
    ...permitLimitOverrides,
    permitId: "9".repeat(32),
    ownerUserId: userId,
    accountBindingSha256: binanceAccountBindingSha256(
      client.access.accountId,
      client.access.accountFingerprint,
    ),
    actionScope: ["READ", "TRADE"] as const,
    authorizationDigest: "4".repeat(64),
    expiresAt: now + 60_000,
    revision: "8".repeat(40),
  };
  let permit = productionSelfTestPermit(approvedCapitalUsd);
  function productionSelfTestPermit(capitalUsd: number): RwaBinanceProductionSelfTestPermit {
    const input = { ...basePermit, approvedCapitalUsd: capitalUsd };
    return { ...input, digest: productionSelfTestPermitDigest(input) };
  }
  const harness = serviceHarness(
    directory,
    userId,
    client,
    () => {},
    () => false,
    () => permit,
    () => true,
  );
  await harness.current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
  const accountId = (await harness.current.getCredentialStatus()).accountId!;
  await harness.current.updateConfig({
    accountId,
    accountIsolationMode: "development_exclusive_account",
    globalExecutionEnabled: true,
    strategyEnabled: true,
  });
  await harness.current.setKillSwitch(false, accountId);
  return {
    ...harness,
    client,
    accountId,
    setApprovedCapitalUsd(capitalUsd: number) {
      permit = productionSelfTestPermit(capitalUsd);
    },
  };
}

async function activate(current: RwaBinanceAutomationService) {
  await current.putCredentials({ apiKey: "fake-key", apiSecret: "fake-secret" });
  const accountId = (await current.getCredentialStatus()).accountId!;
  await current.updateConfig({
    accountId,
    accountIsolationMode: "dedicated_subaccount",
    globalExecutionEnabled: true,
    strategyEnabled: true,
  });
  await current.setKillSwitch(false, accountId);
  return accountId;
}

async function seedAwaitingTakeover(
  harness: ReturnType<typeof serviceHarness>,
  client: FakeBinanceClient,
  idempotencyKey: string,
) {
  client.snapshot.spotAvailableUsdt = 2_000;
  client.snapshot.futuresAvailableUsdt = 2_000;
  client.snapshot.availableUsdt = 4_000;
  const authorizationPreview = await harness.current.previewAccountAssetAuthorization("xaut");
  await harness.current.createAccountAssetAuthorization("xaut", authorizationPreview);
  const preview = await harness.current.previewAssetTakeover({
    assetId: "xaut",
    newCapitalUsd: 500,
    leverage: 2,
  });
  const state = await harness.store.readState();
  const awaiting: RwaAssetTakeoverRecord = createRwaAssetTakeoverRecord({
    userId: "user-a",
    userDomain: harness.store.userDomain,
    accountId: client.access.accountId,
    preview,
    idempotencyKey,
    orderLinkPrefix: idempotencyKey.replaceAll(":", "-"),
    now,
  });
  awaiting.state = "awaiting_reconfirm";
  state.assetTakeovers.push(awaiting);
  await harness.store.writeState(state);
  return awaiting;
}

function executeInput(accountId: string, challenge: { challengeId: string; challengeToken: string }, idempotencyKey: string) {
  return { accountId, challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, idempotencyKey };
}

function smokeExecuteInput(accountId: string, challenge: { challengeId: string; challengeToken: string }, idempotencyKey: string) {
  return {
    accountId,
    challengeId: challenge.challengeId,
    challengeToken: challenge.challengeToken,
    idempotencyKey,
    policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
    policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
    requestDigest: "test-request-digest",
  };
}

function smokeProviderRequest(
  category: "spot" | "linear",
  side: "Buy" | "Sell",
  orderLinkId: string,
  reduceOnly: boolean,
): RwaProviderOrderRequest {
  return {
    category,
    symbol: "XAUTUSDT",
    side,
    quantityXaut: 0.002,
    limitPrice: side === "Buy" ? 4_140 : 4_100,
    reduceOnly,
    orderLinkId,
  };
}

function smokeOpeningRecord(input: {
  accountId: string;
  challenge: any;
  prefix: string;
  stage: "spot_opening" | "futures_opening";
  spotOrder: RwaProviderOrder | null;
}) {
  return {
    smokeId: `smoke-${input.prefix}`,
    userId: "user-a",
    accountId: input.accountId,
    accountFingerprint: "test-account",
    purpose: "connectivity_smoke" as const,
    mode: "connectivity_smoke" as const,
    idempotencyKey: `smoke:restart:${input.prefix}`,
    challengeId: input.challenge.challengeId,
    requestDigest: "test-request-digest",
    policyVersion: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
    policyDigest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
    orderLinkPrefix: input.prefix,
    stage: input.stage,
    budget: input.challenge.report.budget,
    authorization: {
      operation: "connectivity_smoke_execute" as const,
      consumedBeforeProviderMutation: true as const,
      exitAuthorized: true as const,
      reservedAt: now,
    },
    spotOpenOrder: input.spotOrder,
    futuresOpenOrder: null,
    openedSpotQuantityXaut: input.spotOrder ? input.spotOrder.positionQuantityXaut ?? input.spotOrder.filledQuantityXaut : 0,
    openedFuturesQuantityXaut: 0,
    exit: {
      futuresCloseOrder: null,
      spotCloseOrder: null,
      futuresFlatConfirmed: false,
      spotFlatConfirmed: false,
    },
    providerState: testUnavailableSmokeProviderState(),
    timeline: input.stage === "spot_opening"
      ? [
        { stage: "reserved" as const, at: now, code: "reserved" },
        { stage: "spot_opening" as const, at: now, code: "stage_spot_opening" },
      ]
      : [
        { stage: "reserved" as const, at: now, code: "reserved" },
        { stage: "spot_opening" as const, at: now, code: "stage_spot_opening" },
        { stage: "spot_open" as const, at: now, code: "stage_spot_open" },
        { stage: "futures_opening" as const, at: now, code: "stage_futures_opening" },
      ],
    receipt: null,
    noReopen: true as const,
    providerMutationCount: input.stage === "spot_opening" ? 1 : 2,
    errorCategory: null,
    message: "opening crash fixture",
    createdAt: now,
    updatedAt: now,
  };
}

function testUnavailableSmokeProviderState() {
  return {
    verificationStatus: "unavailable" as const,
    observedAt: null,
    residualSpotQuantityXaut: null,
    residualFuturesQuantityXaut: null,
    activeSpotOrderCount: null,
    activeFuturesOrderCount: null,
    activeTotalOrderCount: null,
    providerFlatConfirmed: null,
    reason: "not_yet_observed",
  };
}

const smokePolicyAcceptance = {
  version: RWA_CONNECTIVITY_SMOKE_POLICY_VERSION,
  digest: RWA_CONNECTIVITY_SMOKE_POLICY_DIGEST,
  exclusiveWindowConfirmed: true,
  manualRecoveryConfirmed: true,
  nonAtomicRiskAccepted: true,
} as const;

class FakeBinanceClient implements RwaBinanceClient {
  readCount = 0;
  snapshotReadCount = 0;
  readonly staleSnapshotReads = new Set<number>();
  readonly snapshotFetchedAtOverrides = new Map<number, number>();
  writeCount = 0;
  readonly access: {
    accountId: string;
    accountFingerprint: string;
    accountMode: "single_asset_one_way";
    permissions: RwaBinancePermissions;
    ipWhitelistVerificationMode?: "provider_list_exact" | "provider_restriction_only";
  };
  snapshot: RwaBinancePreflightSnapshot;
  private orderSequence = 0;
  private readonly requests = new Map<string, RwaProviderOrderRequest>();
  private readonly orders = new Map<string, RwaProviderOrder>();
  private spotQuantity = 0;
  private perpetualQuantity = 0;
  readonly fillPlan: Array<number | "throw" | "throw_after_fill" | "new">;
  readonly failLeverage: boolean;
  readonly placedRequests: RwaProviderOrderRequest[] = [];
  readonly strategyCancelScopes: string[] = [];
  cancelCount = 0;
  private readonly spotBuyBaseFeeXaut: number;
  attributionCoverage: "complete" | "incomplete" = "complete";
  externalPositionActivity = false;
  smokeActivityProtocolComplete = true;
  findOrderFailure = false;
  extraUnknownOpenOrderAfterPlace = false;
  private providerMutationStarted = false;
  attributionHook: () => void = () => {};
  assetOpenOrders: RwaAssetOrderReference[] = [];
  takeoverSnapshotHook: () => void = () => {};
  snapshotHook: () => void = () => {};
  leverageHook: () => void = () => {};
  activityFailure: Error | null = null;
  readonly activityPreparations: Array<Parameters<NonNullable<RwaBinanceClient["prepareProviderMutation"]>>[0]> = [];

  constructor(input: {
    permissions?: RwaBinancePermissions;
    fillPlan?: Array<number | "throw" | "throw_after_fill" | "new">;
    failLeverage?: boolean;
    spotBuyBaseFeeXaut?: number;
  } = {}) {
    this.fillPlan = [...input.fillPlan ?? []];
    this.failLeverage = input.failLeverage ?? false;
    this.spotBuyBaseFeeXaut = input.spotBuyBaseFeeXaut ?? 0;
    const currentPermissions = input.permissions ?? permissions();
    this.access = {
      accountId: "binance:test-account",
      accountFingerprint: "test-account",
      accountMode: "single_asset_one_way" as const,
      permissions: currentPermissions,
    };
    this.snapshot = {
      ...this.access,
      fetchedAt: now,
      productAvailability: {
        available: true,
        status: "available",
        spotSymbol: "XAUTUSDT",
        perpetualSymbol: "XAUTUSDT",
        checkedAt: now,
        message: null,
      },
      spotAvailableUsdt: 20,
      futuresAvailableUsdt: 20,
      spotFreeXaut: 0,
      spotLockedXaut: 0,
      availableUsdt: 40,
      existingSpotQuantityXaut: 0,
      existingPerpetualQuantityXaut: 0,
      spotAvailableQuantityXaut: 0,
      spotLockedQuantityXaut: 0,
      perpetualPositionSide: "flat",
      openSpotOrderCount: 0,
      openPerpetualOrderCount: 0,
      spot: {
        status: "Trading",
        minOrderQty: 0.0001,
        qtyStep: 0.0001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 4_129,
        ask: 4_130,
        depthUsd: 100_000,
      },
      perpetual: {
        status: "Trading",
        minOrderQty: 0.001,
        qtyStep: 0.001,
        minNotionalUsd: 5,
        priceTick: 0.01,
        bid: 4_128,
        ask: 4_129,
        depthUsd: 100_000,
        leverage: 1,
        mark: 4_128.5,
        fundingRate: 0.0002,
        fundingIntervalHours: 4,
        nextFundingTime: now + 3_600_000,
        liquidationDistancePercent: null,
      },
      fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
    };
  }

  async validateAccess() {
    this.readCount += 1;
    return this.access;
  }

  setIpWhitelistVerificationMode(mode: "provider_list_exact" | "provider_restriction_only") {
    this.access.ipWhitelistVerificationMode = mode;
  }

  setPermissions(overrides: Partial<RwaBinancePermissions>) {
    Object.assign(this.access.permissions, overrides);
  }

  async readPreflightSnapshot() {
    this.readCount += 1;
    this.snapshotReadCount += 1;
    const result = structuredClone(this.snapshot);
    const fetchedAtOverride = this.snapshotFetchedAtOverrides.get(this.snapshotReadCount);
    if (fetchedAtOverride !== undefined) result.fetchedAt = fetchedAtOverride;
    if (this.staleSnapshotReads.has(this.snapshotReadCount)) {
      result.fetchedAt = now - RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS - 1;
    }
    this.snapshotHook();
    return result;
  }

  async readAssetTakeoverSnapshot(): Promise<RwaAssetTakeoverProviderSnapshot<RwaBinancePermissions>> {
    this.readCount += 1;
    const snapshot = {
      account: structuredClone(this.snapshot),
      orders: structuredClone(this.assetOpenOrders),
      spotAskDepth: [{ price: this.snapshot.spot.ask, quantityBase: 10 }],
      spotBidDepth: [{ price: this.snapshot.spot.bid, quantityBase: 10 }],
      perpetualBidDepth: [{ price: this.snapshot.perpetual.bid, quantityBase: 10 }],
      perpetualAskDepth: [{ price: this.snapshot.perpetual.ask, quantityBase: 10 }],
      fundingRates30d: [0.0001, 0.0002, 0.0003],
      perpetualInitialMarginUsd:
        this.snapshot.existingPerpetualQuantityXaut * this.snapshot.perpetual.mark / 2,
      perpetualLeverage: this.snapshot.existingPerpetualQuantityXaut > 0 ? 2 : null,
      spotAvailableUsdt: this.snapshot.spotAvailableUsdt,
      perpetualAvailableUsdt: this.snapshot.futuresAvailableUsdt,
    };
    this.takeoverSnapshotHook();
    return snapshot;
  }

  async readManagedAssetSnapshot(): Promise<RwaAssetTakeoverProviderSnapshot<RwaBinancePermissions>> {
    return this.readAssetTakeoverSnapshot();
  }

  async findOrderByClientOrderId(_category: "spot" | "linear", orderLinkId: string) {
    if (this.findOrderFailure) throw new Error("fake provider order lookup unavailable");
    return structuredClone([...this.orders.values()].find((item) => item.orderLinkId === orderLinkId) ?? null);
  }

  setOrderStatus(orderLinkId: string, status: RwaProviderOrder["status"]) {
    const order = [...this.orders.values()].find((item) => item.orderLinkId === orderLinkId);
    if (order) order.status = status;
    this.syncOpenOrderCounts();
  }

  async readProductAvailability() {
    this.readCount += 1;
    return this.snapshot.productAvailability;
  }

  async listAssetOpenOrders() {
    this.readCount += 1;
    return structuredClone(this.assetOpenOrders);
  }

  async prepareProviderMutation(
    input: Parameters<NonNullable<RwaBinanceClient["prepareProviderMutation"]>>[0],
  ) {
    if (this.activityFailure) throw this.activityFailure;
    this.activityPreparations.push(structuredClone(input));
  }

  async setPerpetualLeverage() {
    this.writeCount += 1;
    this.leverageHook();
    if (this.failLeverage) throw new Error("fake leverage mutation rejected");
  }

  async placeOrder(request: RwaProviderOrderRequest) {
    this.writeCount += 1;
    this.providerMutationStarted = true;
    const orderId = String(++this.orderSequence);
    this.requests.set(orderId, request);
    this.placedRequests.push(request);
    this.orders.set(orderId, {
      orderId,
      orderLinkId: request.orderLinkId,
      status: "New",
      requestedQuantityXaut: request.quantityXaut,
      filledQuantityXaut: 0,
      positionQuantityXaut: 0,
      averagePrice: 0,
      feeUsd: 0,
      updatedAt: now,
    });
    this.syncOpenOrderCounts();
    return { orderId, orderLinkId: request.orderLinkId };
  }

  async awaitOrder(_category: "spot" | "linear", orderId: string): Promise<RwaProviderOrder> {
    const request = this.requests.get(orderId)!;
    const behavior = this.fillPlan.shift() ?? 1;
    if (behavior === "throw") {
      this.orders.delete(orderId);
      this.syncOpenOrderCounts();
      throw new Error("fake provider rejected order");
    }
    const fillRatio = behavior === "new" ? 0 : behavior === "throw_after_fill" ? 1 : behavior;
    const filledQuantityXaut = request.quantityXaut * fillRatio;
    const positionQuantityXaut = request.category === "spot" && request.side === "Buy"
      ? Math.max(0, filledQuantityXaut - this.spotBuyBaseFeeXaut)
      : filledQuantityXaut;
    if (request.category === "spot") {
      this.spotQuantity += request.side === "Buy" ? positionQuantityXaut : -positionQuantityXaut;
      this.snapshot.spotFreeXaut = Math.max(0, this.snapshot.spotFreeXaut + (request.side === "Buy" ? positionQuantityXaut : -positionQuantityXaut));
      this.snapshot.existingSpotQuantityXaut = Math.max(0, this.snapshot.spotFreeXaut + this.snapshot.spotLockedXaut);
      this.snapshot.spotAvailableQuantityXaut = this.snapshot.spotFreeXaut;
      this.snapshot.spotLockedQuantityXaut = this.snapshot.spotLockedXaut;
    } else {
      this.perpetualQuantity += request.side === "Sell" ? filledQuantityXaut : -filledQuantityXaut;
      this.snapshot.existingPerpetualQuantityXaut = Math.max(0, this.perpetualQuantity);
      this.snapshot.perpetualPositionSide = this.snapshot.existingPerpetualQuantityXaut > 0 ? "short" : "flat";
    }
    const order: RwaProviderOrder = {
      orderId,
      orderLinkId: request.orderLinkId,
      status: behavior === "new" ? "New" : fillRatio < 1 ? "PartiallyFilled" : "Filled",
      requestedQuantityXaut: request.quantityXaut,
      filledQuantityXaut,
      positionQuantityXaut,
      averagePrice: request.limitPrice,
      feeUsd: 0.001,
      updatedAt: now,
    };
    this.orders.set(orderId, order);
    this.syncOpenOrderCounts();
    if (behavior === "throw_after_fill") throw new Error("fake transport uncertainty after provider fill");
    return structuredClone(order);
  }

  async cancelOrder(_category: "spot" | "linear", orderId: string) {
    this.writeCount += 1;
    this.cancelCount += 1;
    const order = this.orders.get(orderId);
    if (order) order.status = "Cancelled";
    this.syncOpenOrderCounts();
  }

  private syncOpenOrderCounts() {
    let spot = 0;
    let linear = 0;
    for (const [orderId, order] of this.orders) {
      if (order.status !== "New" && order.status !== "PartiallyFilled") continue;
      const request = this.requests.get(orderId);
      if (request?.category === "spot") spot += 1;
      if (request?.category === "linear") linear += 1;
    }
    this.snapshot.openSpotOrderCount = spot;
    this.snapshot.openPerpetualOrderCount = linear;
    if (this.extraUnknownOpenOrderAfterPlace && this.providerMutationStarted) {
      if (spot > 0) this.snapshot.openSpotOrderCount += 1;
      else if (linear > 0) this.snapshot.openPerpetualOrderCount += 1;
    }
  }

  async cancelStrategyOrders(scope: string) {
    this.strategyCancelScopes.push(scope);
  }

  async readPositionAttribution(input: {
    strategyOrderPrefix: string;
    strategyOrderPrefixes: string[];
    since: number;
  }) {
    this.attributionHook();
    return {
      coverage: this.attributionCoverage,
      externalPositionActivity: this.externalPositionActivity,
      checkedFrom: input.since,
      checkedThrough: now,
      sources: [...new Set([...RWA_SPOT_ACTIVITY_SOURCES, ...RWA_PERPETUAL_ACTIVITY_SOURCES])].map((source) => ({
        source,
        coverage: this.attributionCoverage,
        checkedFrom: input.since,
        checkedThrough: now,
        cursor: null,
        eventIds: [],
        externalActivity: this.externalPositionActivity,
      })),
      providerOrderIds: { spot: [], perpetual: [] },
    };
  }

  async readConnectivitySmokeActivity(input: {
    strategyOrderPrefix: string;
    strategyOrderPrefixes: string[];
    since: number;
  }) {
    const attribution = await this.readPositionAttribution(input as any);
    return {
      attribution: { ...attribution, coverage: "incomplete" as const },
      protocolComplete: this.smokeActivityProtocolComplete,
      nonAtomic: true as const,
      scannedThrough: now,
    };
  }

  seedStrategyExposure(spotQuantity: number, perpetualQuantity: number) {
    this.spotQuantity = spotQuantity;
    this.perpetualQuantity = perpetualQuantity;
    this.snapshot.spotFreeXaut = Math.max(0, spotQuantity);
    this.snapshot.spotLockedXaut = 0;
    this.snapshot.existingSpotQuantityXaut = Math.max(0, spotQuantity);
    this.snapshot.spotAvailableQuantityXaut = Math.max(0, spotQuantity);
    this.snapshot.spotLockedQuantityXaut = 0;
    this.snapshot.existingPerpetualQuantityXaut = Math.max(0, perpetualQuantity);
    this.snapshot.perpetualPositionSide = perpetualQuantity > 0 ? "short" : "flat";
  }

  setAuthoritativeExposure(input: {
    spotFreeXaut?: number;
    spotLockedXaut?: number;
    perpetualQuantityXaut?: number;
    openSpotOrderCount?: number;
    openPerpetualOrderCount?: number;
  }) {
    if (input.spotFreeXaut !== undefined) this.snapshot.spotFreeXaut = input.spotFreeXaut;
    if (input.spotLockedXaut !== undefined) this.snapshot.spotLockedXaut = input.spotLockedXaut;
    this.snapshot.existingSpotQuantityXaut = this.snapshot.spotFreeXaut + this.snapshot.spotLockedXaut;
    this.snapshot.spotAvailableQuantityXaut = this.snapshot.spotFreeXaut;
    this.snapshot.spotLockedQuantityXaut = this.snapshot.spotLockedXaut;
    if (input.perpetualQuantityXaut !== undefined) {
      this.snapshot.existingPerpetualQuantityXaut = input.perpetualQuantityXaut;
      this.perpetualQuantity = input.perpetualQuantityXaut;
      this.snapshot.perpetualPositionSide = input.perpetualQuantityXaut > 0 ? "short" : "flat";
    }
    if (input.openSpotOrderCount !== undefined) this.snapshot.openSpotOrderCount = input.openSpotOrderCount;
    if (input.openPerpetualOrderCount !== undefined) this.snapshot.openPerpetualOrderCount = input.openPerpetualOrderCount;
  }

  async readStrategyPnl(): Promise<RwaStrategyPnlSnapshot> {
    return {
      accountId: this.access.accountId,
      accountFingerprint: this.access.accountFingerprint,
      strategyId: "binance-xaut-spot-perp-v1",
      capturedAt: now,
      legs: {
        spot: side("spot_long", this.spotQuantity),
        perpetual: side("perpetual_short", this.perpetualQuantity),
      },
      netDeltaXaut: this.spotQuantity - this.perpetualQuantity,
      netDeltaUsd: 0,
      entryBasisBps: null,
      currentBasisBps: null,
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

function side(kind: "spot_long" | "perpetual_short", quantityXaut: number) {
  return {
    kind,
    quantityXaut: Math.max(0, quantityXaut),
    averageEntryPrice: quantityXaut > 0 ? 4_130 : null,
    markPrice: 4_130,
    notionalUsd: Math.max(0, quantityXaut) * 4_130,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
  };
}

function permissions(overrides: Partial<RwaBinancePermissions> = {}): RwaBinancePermissions {
  return {
    read: true,
    spotTrade: true,
    contractTrade: true,
    withdraw: false,
    ipRestricted: true,
    spotAccount: true,
    futuresAccount: true,
    positionModeSupported: true,
    ...overrides,
  };
}

function permissionRejectedWithoutSecret(error: unknown) {
  return error instanceof RwaNeutralExecutionError
    && error.category === "permission_rejected"
    && !error.message.includes("replacement-secret");
}

function opportunity(): ArbitrageOpportunity {
  const leg = (kind: "spot" | "perpetual") => ({
    id: `binance-xaut-${kind}`,
    venue: "binance" as const,
    venueLabel: "Binance",
    symbol: "XAUTUSDT",
    asset: "XAUT" as const,
    kind,
    quoteAsset: "USDT" as const,
    settlementAsset: "USDT" as const,
    bid: 4_128,
    ask: 4_130,
    fundingRate: kind === "perpetual" ? 0.0002 : null,
    fundingIntervalHours: kind === "perpetual" ? 4 : null,
    currentFundingApr: kind === "perpetual" ? 43 : 0,
    historicalFundingApr: kind === "perpetual" ? 12 : 0,
    nextFundingTime: null,
  });
  return {
    id: "binance-xaut-spot--binance-xaut-perp",
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
    capacityUsd: 1_000,
    score: 80,
    historicalQualityScore: 80,
    confidence: "high",
    confidenceLabel: "高",
    opportunityDriver: "funding",
    opportunityDriverLabel: "资金费率驱动",
    recommendation: "recommended",
    entryStatus: "favorable",
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
    automationEligible: true,
    automationDisqualifiers: [],
  };
}
