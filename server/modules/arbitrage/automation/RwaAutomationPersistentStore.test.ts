import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import { CredentialStoreError, RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";
import {
  RwaAutomationGovernanceError,
  loadRwaAutomationGovernanceConfig,
} from "./RwaAutomationGovernance";
import { defaultRwaExecutionConfig, type RwaExecutionRecord } from "./RwaNeutralExecutionTypes";

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
    const persisted = JSON.parse(await readFile(current.statePath, "utf8"));
    assert.equal(persisted.executions[0]?.reconciliation, null);
    assert.equal(persisted.executions[0]?.finalizeIdempotency, null);
  } finally {
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
    createdAt: updatedAt,
    updatedAt,
  };
}
