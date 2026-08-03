import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import {
  CredentialStoreError,
  RwaAutomationPersistentStore,
  automationCapitalExposuresFromExecutions,
  discoverAutomationUsersWithExposure,
  readRwaAutomationCapitalExposures,
} from "./RwaAutomationPersistentStore";
import {
  RwaAutomationGovernanceError,
  loadRwaAutomationGovernanceConfig,
} from "./RwaAutomationGovernance";
import { defaultRwaExecutionConfig, type RwaExecutionRecord } from "./RwaNeutralExecutionTypes";
import {
  createMonitoredActivityContinuity,
  createUnmonitoredActivityContinuity,
} from "./RwaProviderActivityContinuity";
import {
  RWA_MAX_ASSET_AUTHORIZATIONS_PER_STATE,
  type RwaAccountAssetAuthorization,
} from "./RwaAccountAssetAuthorization";
import {
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
} from "./RwaAutomationAssetProfile";

const permissions = {
  read: true,
  spotTrade: true,
  contractTrade: true,
  withdraw: false,
  uta: true,
  ipRestricted: true,
  ownerSubaccount: true,
};
const identity = { accountId: "bybit:test-account", accountFingerprint: "test-account", accountMode: "uta" as const };
const credentials = { apiKey: "owner-api-key-123456", apiSecret: "owner-secret-never-plaintext" };

test("credential envelope V2 encrypts credentials with an isolated DEK and writes 0600", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    await fixture.store.saveCredentials(credentials, permissions, identity, 1234);
    const raw = await readFile(fixture.credentialPath, "utf8");
    assert.doesNotMatch(raw, /owner-api-key-123456|owner-secret-never-plaintext/);
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(envelope.version, 2);
    assert.equal(envelope.algorithm, "AES-256-GCM");
    assert.equal(envelope.provider, "fake");
    assert.equal(envelope.aadSchema, "rwa-credential:v2:userId:venue:accountId:environment");
    assert.equal(typeof envelope.wrappedDek, "string");
    assert.equal(typeof envelope.wrapReference, "string");
    assert.equal(typeof envelope.wrapBindingTag, "string");
    assert.equal((await stat(fixture.credentialPath)).mode & 0o777, 0o600);
    assert.deepEqual(await fixture.store.loadCredentials(), credentials);
    const metadata = await fixture.store.readCredentialMetadata();
    assert.equal(metadata?.version, 2);
    assert.equal(metadata?.requiresRotation, false);
    assert.equal(metadata?.maskedApiKey, "owne...3456");
    assert.doesNotMatch(JSON.stringify(metadata), /owner-secret|wrappedDek|ciphertext/);
  } finally {
    await fixture.cleanup();
  }
});

test("each account receives a distinct random DEK without exposing it in metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-v2-dek-"));
  const provider = new FakeCredentialKeyProvider();
  const first = store(directory, "user-a", "bybit", provider, "first");
  const second = store(directory, "user-a", "binance", provider, "second");
  try {
    await first.saveCredentials(credentials, permissions, identity, 10);
    await second.saveCredentials(credentials, permissions, {
      ...identity,
      accountId: "binance:test-account",
      accountMode: "single_asset_one_way",
    }, 11);
    assert.equal(provider.createdDekFingerprints.length, 2);
    assert.notEqual(provider.createdDekFingerprints[0], provider.createdDekFingerprints[1]);
    const firstDigest = digest(await readFile(first.credentialPath));
    const secondDigest = digest(await readFile(second.credentialPath));
    assert.notEqual(firstDigest, secondDigest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AAD rejects cross-user, venue, and account envelope replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-v2-aad-"));
  const provider = new FakeCredentialKeyProvider();
  const source = store(directory, "user-a", "bybit", provider, "source");
  try {
    await source.saveCredentials(credentials, permissions, identity, 1234);
    for (const [name, userId, venue] of [
      ["user", "user-b", "bybit"],
      ["venue", "user-a", "binance"],
    ] as const) {
      const target = store(directory, userId, venue, provider, name);
      await copyFile(source.credentialPath, target.credentialPath);
      await assert.rejects(target.loadCredentials(), /身份|AAD|解密/);
    }
    const account = store(directory, "user-a", "bybit", provider, "account");
    const parsed = JSON.parse(await readFile(source.credentialPath, "utf8"));
    parsed.accountId = "bybit:other-account";
    await writeFile(account.credentialPath, JSON.stringify(parsed), { mode: 0o600 });
    await assert.rejects(account.loadCredentials(), /身份|AAD|解密/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("KMS rewrap changes only the wrapped DEK fields and keeps credential ciphertext", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    await fixture.store.saveCredentials(credentials, permissions, identity, 1234);
    const before = JSON.parse(await readFile(fixture.credentialPath, "utf8"));
    await fixture.store.rewrapCredentials();
    const after = JSON.parse(await readFile(fixture.credentialPath, "utf8"));
    assert.equal(after.ciphertext, before.ciphertext);
    assert.equal(after.nonce, before.nonce);
    assert.equal(after.tag, before.tag);
    assert.notEqual(digest(after.wrappedDek), digest(before.wrappedDek));
    assert.notEqual(after.wrapBindingTag, before.wrapBindingTag);
    assert.deepEqual(await fixture.store.loadCredentials(), credentials);
  } finally {
    await fixture.cleanup();
  }
});

test("wrap reference tampering is rejected before credential plaintext is used", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    await fixture.store.saveCredentials(credentials, permissions, identity, 1234);
    const envelope = JSON.parse(await readFile(fixture.credentialPath, "utf8"));
    envelope.wrapReference = "fake:test-key/versions/2";
    await writeFile(fixture.credentialPath, JSON.stringify(envelope), { mode: 0o600 });
    await assert.rejects(
      fixture.store.loadCredentials(),
      hasCategory("credential_key_identity_mismatch"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("legacy state defaults to no asset authorization while new exact state persists it", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    const legacy = await fixture.store.readState();
    const { assetAuthorizations: _assetAuthorizations, ...legacyWithoutAuthorization } = legacy;
    await writeFile(fixture.store.statePath, JSON.stringify(legacyWithoutAuthorization), { mode: 0o600 });
    assert.deepEqual((await fixture.store.readState()).assetAuthorizations, []);

    const state = await fixture.store.readState();
    state.assetAuthorizations.push(authorizationRecord(fixture.store.userDomain, "bybit"));
    await fixture.store.writeState(state);
    assert.deepEqual(
      (await fixture.store.readState()).assetAuthorizations,
      state.assetAuthorizations,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("production self-test permit consumptions are exact, unique, and never compacted", async () => {
  const fixture = await createFixture("user-a", "binance");
  try {
    const legacy = await fixture.store.readState();
    const {
      productionSelfTestPermitConsumptions: _consumptions,
      ...legacyWithoutConsumptions
    } = legacy;
    await writeFile(
      fixture.store.statePath,
      JSON.stringify(legacyWithoutConsumptions),
      { mode: 0o600 },
    );
    assert.deepEqual(
      (await fixture.store.readState()).productionSelfTestPermitConsumptions,
      [],
    );

    const consumption = {
      permitId: "a".repeat(32),
      digest: "b".repeat(64),
      consumedAt: 1,
    };
    const state = await fixture.store.readState();
    state.productionSelfTestPermitConsumptions.push(consumption);
    await fixture.store.writeState(state);
    fixture.store.setClock(() => Number.MAX_SAFE_INTEGER - 1);
    assert.deepEqual(
      (await fixture.store.readState()).productionSelfTestPermitConsumptions,
      [consumption],
    );

    for (const invalid of [
      [{ ...consumption, extra: true }],
      [consumption, { ...consumption, digest: "c".repeat(64) }],
      [consumption, { ...consumption, permitId: "c".repeat(32) }],
      [{ ...consumption, permitId: "A".repeat(32) }],
      [{ ...consumption, digest: "B".repeat(64) }],
      [{ ...consumption, consumedAt: 0 }],
    ]) {
      const candidate = await fixture.store.readState();
      candidate.productionSelfTestPermitConsumptions = invalid as typeof candidate.productionSelfTestPermitConsumptions;
      await assert.rejects(
        fixture.store.writeState(candidate),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_risk_state_invalid",
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("readStateView validates and normalizes in memory without persisting maintenance", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    const state = await fixture.store.readState();
    await fixture.store.writeState(state);
    const persisted = JSON.parse(await readFile(fixture.store.statePath, "utf8"));
    delete persisted.assetAuthorizations;
    persisted.credentialAudit = Array.from({ length: 501 }, (_, index) => ({
      userId: "user-a",
      action: "rotated",
      accountId: "bybit:test-account",
      accountFingerprint: "test-account",
      maskedApiKey: null,
      occurredAt: index,
    }));
    await writeFile(fixture.store.statePath, JSON.stringify(persisted), { mode: 0o600 });
    const before = await fileIdentity(fixture.store.statePath);
    const originalWriteState = fixture.store.writeState.bind(fixture.store);
    let writes = 0;
    fixture.store.writeState = async (nextState) => {
      writes += 1;
      return originalWriteState(nextState);
    };

    const view = await fixture.store.readStateView();
    assert.deepEqual(view.assetAuthorizations, []);
    assert.equal(view.credentialAudit.length, 500);
    assert.equal(writes, 0);
    assert.deepEqual(await fileIdentity(fixture.store.statePath), before);

    await fixture.store.readState();
    assert.equal(writes, 1);
    assert.notDeepEqual(await fileIdentity(fixture.store.statePath), before);
  } finally {
    await fixture.cleanup();
  }
});

test("partial or cross-domain authorization schema and capacity overflow fail closed", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    const state = await fixture.store.readState();
    const valid = authorizationRecord(fixture.store.userDomain, "bybit");
    state.assetAuthorizations = [{ ...valid, userDomain: "ffffffffffffffff" }];
    await assert.rejects(
      fixture.store.writeState(state),
      (error: unknown) => error instanceof RwaAutomationGovernanceError
        && error.category === "automation_risk_state_invalid",
    );

    const partial = { ...valid } as Record<string, unknown>;
    delete partial.policyDigest;
    await writeFile(fixture.store.statePath, JSON.stringify({
      ...(await fixture.store.readState()),
      assetAuthorizations: [partial],
    }), { mode: 0o600 });
    await assert.rejects(fixture.store.readState(), /fail-closed/);

    const clean = await createFixture("user-b", "bybit");
    try {
      const capacity = await clean.store.readState();
      capacity.assetAuthorizations = Array.from(
        { length: RWA_MAX_ASSET_AUTHORIZATIONS_PER_STATE + 1 },
        (_, index) => ({
          ...authorizationRecord(clean.store.userDomain, "bybit"),
          authorizationId: `authorization-${index}`,
          revokedAt: 2_000 + index,
        }),
      );
      await assert.rejects(
        clean.store.writeState(capacity),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_capacity_exceeded",
      );
    } finally {
      await clean.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("KMS failure and permission revocation fail closed without leaking credential material", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    fixture.provider.failCategory = "credential_key_provider_permission_denied";
    await assert.rejects(
      fixture.store.saveCredentials(credentials, permissions, identity, 1234),
      (error: unknown) => error instanceof CredentialStoreError
        && error.category === "credential_key_provider_permission_denied"
        && !JSON.stringify(error).includes(credentials.apiSecret),
    );
    assert.equal(await fixture.store.hasCredentials(), false);
    fixture.provider.failCategory = null;
    await fixture.store.saveCredentials(credentials, permissions, identity, 1234);
    fixture.provider.failCategory = "credential_key_provider_unavailable";
    await assert.rejects(fixture.store.loadCredentials(), /provider 不可用/);
  } finally {
    await fixture.cleanup();
  }
});

test("legacy V1 metadata is detected but online decrypt, rewrap, and overwrite are rejected", async () => {
  const fixture = await createFixture("user-a", "bybit");
  try {
    await writeFile(fixture.credentialPath, JSON.stringify({
      version: 1,
      nonce: "legacy-nonce",
      tag: "legacy-tag",
      ciphertext: "legacy-ciphertext",
      maskedApiKey: "lega...-key",
      accountId: identity.accountId,
      accountFingerprint: identity.accountFingerprint,
      accountMode: identity.accountMode,
      permissions,
      lastVerifiedAt: 1,
      updatedAt: 1,
    }), { mode: 0o600 });
    const metadata = await fixture.store.readCredentialMetadata();
    assert.equal(metadata?.requiresRotation, true);
    await assert.rejects(fixture.store.loadCredentials(), hasCategory("credential_rotation_required"));
    await assert.rejects(fixture.store.rewrapCredentials(), hasCategory("credential_rotation_required"));
    await assert.rejects(
      fixture.store.saveCredentials(credentials, permissions, identity, 2),
      hasCategory("credential_rotation_required"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fake key provider is unavailable in production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => new FakeCredentialKeyProvider(), /生产环境禁止/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("persistent governance deterministically expires challenges and old tombstones without deleting protected recovery state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-state-gc-"));
  const now = Date.now();
  const governanceConfig = {
    ...loadRwaAutomationGovernanceConfig({}),
    maxChallengesPerUser: 1,
    stateCompletedExecutionRetentionMs: 30_000,
    stateMaxPnlPoints: 1,
    stateMaxCredentialAuditEntries: 1,
  };
  const current = new RwaAutomationPersistentStore({
    userId: "user-a",
    venue: "bybit",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credential.enc.json"),
    statePath: join(directory, "state.json"),
    governanceConfig,
  });
  try {
    await writeFile(current.statePath, JSON.stringify({
      version: 1,
      config: defaultRwaExecutionConfig,
      challenges: [
        challenge("expired", now - 1),
        challenge("future-a", now + 30_000),
        challenge("future-b", now + 40_000),
      ],
      executions: [
        execution("old-closed", "closed", now - 60_000),
        execution("recent-failed", "failed", now - 1_000),
        execution("manual", "manual_intervention", now - 60_000),
        execution("open", "hedged", now - 60_000),
      ],
      pnlSeries: [{ capturedAt: 1 }, { capturedAt: 2 }],
      credentialLifecycle: "active",
      credentialAlert: null,
      credentialAudit: [
        { userId: "user-a", action: "activated", accountId: "a", accountFingerprint: "a", maskedApiKey: null, occurredAt: 1 },
        { userId: "user-a", action: "rotated", accountId: "a", accountFingerprint: "a", maskedApiKey: null, occurredAt: 2 },
      ],
    }), { mode: 0o600 });
    const state = await current.readState();
    assert.deepEqual(state.challenges.map((item) => item.id), ["future-b"]);
    assert.deepEqual(state.executions.map((item) => item.executionId), ["manual", "open", "recent-failed"]);
    assert.deepEqual(state.pnlSeries.map((item) => item.capturedAt), [2]);
    assert.deepEqual(state.credentialAudit.map((item) => item.occurredAt), [2]);
    assert.doesNotMatch(await readFile(current.statePath, "utf8"), /old-closed|expired|future-a/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("risk capacity preserves the idempotency retention window and hard reserve fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-state-capacity-"));
  const governanceConfig = {
    ...loadRwaAutomationGovernanceConfig({}),
    stateCompletedExecutionRetentionMs: 30 * 24 * 60 * 60_000,
    stateMaxCompletedExecutions: 1,
    stateMaxCompletedExecutionsHard: 2,
    stateMaxActiveExecutions: 2,
    stateMaxBytes: 8 * 1024 * 1024,
    stateMaxBytesHard: 10 * 1024 * 1024,
  };
  const current = new RwaAutomationPersistentStore({
    userId: "user-a",
    venue: "bybit",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credential.enc.json"),
    statePath: join(directory, "state.json"),
    governanceConfig,
  });
  try {
    const state = await current.readState();
    state.executions.push(execution("recent-failed", "failed", Date.now()));
    await current.writeState(state);
    await assert.rejects(
      current.assertRiskCapacity(),
      (error: unknown) => error instanceof RwaAutomationGovernanceError
        && error.category === "automation_capacity_exceeded",
    );

    const restarted = new RwaAutomationPersistentStore({
      userId: "user-a",
      venue: "bybit",
      keyProvider: new FakeCredentialKeyProvider(),
      credentialPath: current.credentialPath,
      statePath: current.statePath,
      governanceConfig,
    });
    assert.equal((await restarted.readState()).executions[0]?.idempotencyKey, "idempotency:recent-failed");

    state.executions.push(
      execution("second", "closed", Date.now()),
      execution("third", "closed", Date.now()),
    );
    await assert.rejects(
      current.writeState(state),
      (error: unknown) => error instanceof RwaAutomationGovernanceError
        && error.category === "automation_capacity_exceeded",
    );
    assert.equal((await restarted.readState()).executions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restart retains completed execution tombstones for the full 30-day retry window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-state-restart-retention-"));
  const now = 1_800_000_000_000;
  const governanceConfig = loadRwaAutomationGovernanceConfig({
    RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS: String(30 * 86_400),
  });
  const paths = {
    credentialPath: join(directory, "credential.enc.json"),
    statePath: join(directory, "state.json"),
  };
  const createStore = () => {
    const store = new RwaAutomationPersistentStore({
      userId: "user-a",
      venue: "bybit",
      keyProvider: new FakeCredentialKeyProvider(),
      ...paths,
      governanceConfig,
    });
    store.setClock(() => now);
    return store;
  };
  try {
    const current = createStore();
    const state = await current.readState();
    state.executions.push(
      execution("retained-29-days", "closed", now - (29 * 86_400_000)),
      execution("expired-30-days", "failed", now - (30 * 86_400_000) - 1),
    );
    await current.writeState(state);

    const restarted = createStore();
    const executionIds = (await restarted.readState()).executions.map((item) => item.executionId);
    assert.deepEqual(executionIds, ["retained-29-days"]);
    assert.match(await readFile(paths.statePath, "utf8"), /idempotency:retained-29-days/);
    assert.doesNotMatch(await readFile(paths.statePath, "utf8"), /idempotency:expired-30-days/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy execution schema is migrated with null reconciliation fields and persisted atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-state-legacy-execution-"));
  const current = new RwaAutomationPersistentStore({
    userId: "user-a",
    venue: "bybit",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credential.enc.json"),
    statePath: join(directory, "state.json"),
  });
  try {
    await writeFile(current.statePath, JSON.stringify({
      version: 1,
      config: defaultRwaExecutionConfig,
      challenges: [],
      executions: [{
        userId: "user-a",
        accountId: "bybit:test-account",
        executionId: "legacy-execution",
        idempotencyKey: "idempotency:legacy",
        challengeId: "challenge:legacy",
        state: "manual_intervention",
        orderLinkPrefix: "order:legacy",
        spotOrder: null,
        perpetualOrders: [],
        compensationOrders: [],
        hedgedQuantityXaut: 0,
        unhedgedDurationMs: null,
        errorCategory: null,
        message: "legacy",
        createdAt: 1,
        updatedAt: 1,
      }],
      pnlSeries: [],
      credentialLifecycle: "active",
      credentialAlert: null,
      credentialAudit: [],
    }), { mode: 0o600 });
    const state = await current.readState();
    assert.equal(state.executions[0]?.reconciliation, null);
    assert.equal(state.executions[0]?.finalizeIdempotency, null);
    assert.equal(state.executions[0]?.asset, "XAUT");
    assert.equal(state.executions[0]?.profileId, "xaut:bybit-xaut-spot-perp-v1");
    assert.equal(state.executions[0]?.reservedCapitalUsd, 0);
    assert.deepEqual(state.executions[0]?.strategyPosition, {
      coverage: "ambiguous",
      spotRemainingXaut: 0,
      perpetualRemainingXaut: 0,
      updatedAt: 1,
    });
    const persisted = JSON.parse(await readFile(current.statePath, "utf8"));
    assert.equal(persisted.executions[0]?.reconciliation, null);
    assert.equal(persisted.executions[0]?.finalizeIdempotency, null);
    assert.equal(persisted.executions[0]?.asset, "XAUT");
    assert.equal(persisted.executions[0]?.profileId, "xaut:bybit-xaut-spot-perp-v1");
    assert.equal(persisted.executions[0]?.reservedCapitalUsd, 0);
    assert.equal(persisted.executions[0]?.strategyPosition?.coverage, "ambiguous");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime execution profile fields reject partial, unknown, and invalid capital without washing evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-state-profile-schema-"));
  const statePath = join(directory, "state.json");
  const current = new RwaAutomationPersistentStore({
    userId: "user-a",
    venue: "bybit",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credential.enc.json"),
    statePath,
  });
  const validExecution = execution("profile-schema", "manual_intervention", 1);
  const fileState = (item: unknown) => ({
    version: 1,
    config: defaultRwaExecutionConfig,
    challenges: [],
    executions: [item],
    pnlSeries: [],
    credentialLifecycle: "active",
    credentialAlert: null,
    credentialAudit: [],
  });
  const invalidPersisted = [
    { ...structuredClone(validExecution), asset: "DOGE" },
    omit(structuredClone(validExecution), "profileId"),
    { ...structuredClone(validExecution), reservedCapitalUsd: -1 },
    { ...structuredClone(validExecution), reservedCapitalUsd: null },
  ];
  try {
    for (const item of invalidPersisted) {
      await writeFile(statePath, JSON.stringify(fileState(item)), { mode: 0o600 });
      await assert.rejects(
        current.readState(),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_risk_state_invalid",
      );
    }

    const validState = fileState(validExecution);
    await writeFile(statePath, JSON.stringify(validState), { mode: 0o600 });
    const inMemory = await current.readState();
    for (const invalidCapital of [Number.NaN, Number.POSITIVE_INFINITY]) {
      inMemory.executions[0]!.reservedCapitalUsd = invalidCapital;
      await assert.rejects(
        current.writeState(inMemory),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_risk_state_invalid",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capital exposure rejects cross-asset profile substitution", () => {
  const current = execution("risk-profile", "hedged", 1);
  current.reservedCapitalUsd = 25;
  current.profileId = "btc:binance-btc-spot-perp-v1";
  assert.throws(
    () => automationCapitalExposuresFromExecutions([current]),
    (error: unknown) => error instanceof RwaAutomationGovernanceError
      && error.category === "automation_risk_state_invalid",
  );
});

test("global capital scan rejects invalid profiled execution fields before aggregation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-global-risk-schema-"));
  const previousDataDir = process.env.RWA_AUTOMATION_DATA_DIR;
  process.env.RWA_AUTOMATION_DATA_DIR = directory;
  const userId = "user-global-risk";
  const domain = createHash("sha256").update(`rwa-user:${userId}`).digest("hex").slice(0, 16);
  const statePath = join(directory, `${domain}-bybit-state.json`);
  const current = execution("global-risk", "manual_intervention", 1);
  current.userId = userId;
  current.reservedCapitalUsd = 25;
  const invalid = [
    { ...structuredClone(current), asset: "DOGE" },
    omit(structuredClone(current), "reservedCapitalUsd"),
    { ...structuredClone(current), reservedCapitalUsd: -1 },
    { ...structuredClone(current), reservedCapitalUsd: null },
  ];
  try {
    for (const item of invalid) {
      await writeFile(statePath, JSON.stringify({ executions: [item] }), { mode: 0o600 });
      await assert.rejects(
        readRwaAutomationCapitalExposures(),
        (error: unknown) => error instanceof RwaAutomationGovernanceError
          && error.category === "automation_risk_state_invalid",
      );
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.RWA_AUTOMATION_DATA_DIR;
    else process.env.RWA_AUTOMATION_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized persistent state is rejected before JSON parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-state-oversized-"));
  const governanceConfig = {
    ...loadRwaAutomationGovernanceConfig({}),
    stateMaxBytes: 512,
    stateMaxBytesHard: 1_024,
  };
  const current = new RwaAutomationPersistentStore({
    userId: "user-a",
    venue: "bybit",
    keyProvider: new FakeCredentialKeyProvider(),
    credentialPath: join(directory, "credential.enc.json"),
    statePath: join(directory, "state.json"),
    governanceConfig,
  });
  try {
    await writeFile(current.statePath, "not-json".repeat(300), { mode: 0o600 });
    await assert.rejects(
      current.readState(),
      (error: unknown) => error instanceof RwaAutomationGovernanceError
        && error.category === "automation_capacity_exceeded",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exposure discovery includes unmonitored recovery state but only accepts domain-bound regular files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-monitor-discovery-"));
  const previousDataDir = process.env.RWA_AUTOMATION_DATA_DIR;
  process.env.RWA_AUTOMATION_DATA_DIR = directory;
  const exposureState = (userId: string, monitored = true) => {
    const item = execution("monitored", "hedged", 1_000);
    item.userId = userId;
    item.strategyPosition.spotRemainingXaut = 0.002;
    item.strategyPosition.perpetualRemainingXaut = 0.002;
    item.activityContinuity = monitored
      ? createMonitoredActivityContinuity(1_000, item.orderLinkPrefix)
      : createUnmonitoredActivityContinuity(1_000);
    return JSON.stringify({ executions: [item] });
  };
  const stateName = (userId: string) => {
    const domain = createHash("sha256").update(`rwa-user:${userId}`).digest("hex").slice(0, 16);
    return `${domain}-bybit-state.json`;
  };
  try {
    const validPath = join(directory, stateName("user-a"));
    await writeFile(validPath, exposureState("user-a"), { mode: 0o600 });
    await writeFile(join(directory, stateName("user-b")), exposureState("wrong-domain-user"), { mode: 0o600 });
    await writeFile(join(directory, stateName("user-c")), "{malformed", { mode: 0o600 });
    await writeFile(join(directory, stateName("user-d")), "x".repeat(10 * 1024 * 1024 + 1), { mode: 0o600 });
    const symlinkSource = join(directory, "symlink-source.json");
    await writeFile(symlinkSource, exposureState("user-e"), { mode: 0o600 });
    await symlink(symlinkSource, join(directory, stateName("user-e")));
    await writeFile(join(directory, stateName("user-f")), exposureState("user-f", false), { mode: 0o600 });
    assert.deepEqual(await discoverAutomationUsersWithExposure(), ["user-a", "user-f"]);

    await link(validPath, join(directory, "hardlink-copy.json"));
    assert.deepEqual(await discoverAutomationUsersWithExposure(), ["user-f"]);
  } finally {
    if (previousDataDir === undefined) delete process.env.RWA_AUTOMATION_DATA_DIR;
    else process.env.RWA_AUTOMATION_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

async function createFixture(userId: string, venue: "bybit" | "binance") {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-v2-"));
  const provider = new FakeCredentialKeyProvider();
  const current = store(directory, userId, venue, provider, "credential");
  return {
    store: current,
    provider,
    credentialPath: current.credentialPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function store(
  directory: string,
  userId: string,
  venue: "bybit" | "binance",
  keyProvider: FakeCredentialKeyProvider,
  name: string,
) {
  return new RwaAutomationPersistentStore({
    userId,
    venue,
    keyProvider,
    credentialPath: join(directory, `${name}.enc.json`),
    statePath: join(directory, `${name}.state.json`),
  });
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function hasCategory(category: string) {
  return (error: unknown) => error instanceof CredentialStoreError && error.category === category;
}

function challenge(id: string, expiresAt: number) {
  return {
    id,
    tokenHash: `hash:${id}`,
    report: {},
    expiresAt,
    consumedAt: null,
  };
}

function execution(id: string, state: RwaExecutionRecord["state"], updatedAt: number): RwaExecutionRecord {
  return {
    userId: "user-a",
    accountId: "bybit:test-account",
    asset: "XAUT",
    profileId: "xaut:bybit-xaut-spot-perp-v1",
    reservedCapitalUsd: 0,
    executionId: id,
    idempotencyKey: `idempotency:${id}`,
    challengeId: `challenge:${id}`,
    state,
    orderLinkPrefix: `order:${id}`,
    spotOrder: null,
    perpetualOrders: [],
    compensationOrders: [],
    hedgedQuantityXaut: 0,
    unhedgedDurationMs: null,
    errorCategory: null,
    message: "test",
    reconciliation: null,
    finalizeIdempotency: null,
    strategyPosition: {
      coverage: "complete",
      spotRemainingXaut: 0,
      perpetualRemainingXaut: 0,
      updatedAt,
    },
    activityContinuity: createUnmonitoredActivityContinuity(updatedAt),
    createdAt: updatedAt,
    updatedAt,
  };
}

function authorizationRecord(
  userDomain: string,
  venue: "bybit" | "binance",
): RwaAccountAssetAuthorization {
  const profile = requireRwaAutomationExecutionProfile("xaut", venue);
  return {
    authorizationId: "authorization-1",
    userDomain,
    venue,
    accountId: `${venue}:test-account`,
    accountFingerprint: "test-account",
    assetId: "xaut",
    profileId: rwaAutomationProfileId(profile),
    policyVersion: profile.asset.authorizationPolicy.version,
    policyDigest: profile.asset.authorizationPolicy.digest,
    previewDigest: "1".repeat(64),
    spotQuantity: 0.2,
    spotAvailableQuantity: 0.1,
    spotLockedQuantity: 0.1,
    perpetualQuantity: 0.2,
    perpetualSide: "short",
    spotOrderCount: 1,
    perpetualOrderCount: 1,
    ordersDigest: "2".repeat(64),
    maxManagedSpotQuantity: 0.2,
    maxManagedPerpetualQuantity: 0.2,
    maxManagedNotionalUsd: 1_700,
    previewedAt: 1_000,
    createdAt: 1_001,
    revokedAt: null,
  };
}

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  delete value[key];
  return value;
}

async function fileIdentity(path: string) {
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
