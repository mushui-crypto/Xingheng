import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeCredentialKeyProvider } from "./FakeCredentialKeyProvider";
import { CredentialStoreError, RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";

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
