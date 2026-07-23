import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RwaAutomationPersistentStore } from "./RwaAutomationPersistentStore";

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

test("credential vault encrypts both key and secret, writes atomically with 0600, and decrypts with the master key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-vault-"));
  const credentialPath = join(directory, "credentials.enc.json");
  const statePath = join(directory, "state.json");
  const masterKey = Buffer.alloc(32, 7).toString("base64url");
  const store = new RwaAutomationPersistentStore({ userId: "user-a", masterKey, credentialPath, statePath });
  try {
    await store.saveCredentials({ apiKey: "owner-api-key-123456", apiSecret: "owner-secret-never-plaintext" }, permissions, identity, 1234);
    const raw = await readFile(credentialPath, "utf8");
    assert.doesNotMatch(raw, /owner-api-key-123456|owner-secret-never-plaintext/);
    assert.match(raw, /"version":1/);
    assert.match(raw, /"nonce":/);
    assert.match(raw, /"tag":/);
    assert.match(raw, /"ciphertext":/);
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    assert.deepEqual(await store.loadCredentials(), {
      apiKey: "owner-api-key-123456",
      apiSecret: "owner-secret-never-plaintext",
    });
    const metadata = await store.readCredentialMetadata();
    assert.equal(metadata?.maskedApiKey, "owne...3456");
    assert.equal(metadata?.accountId, "bybit:test-account");
    assert.doesNotMatch(JSON.stringify(metadata), /owner-secret|apiSecret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential vault fails closed when master key is missing or malformed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-vault-closed-"));
  try {
    for (const masterKey of ["", "too-short"]) {
      const store = new RwaAutomationPersistentStore({
        userId: "user-a",
        masterKey,
        credentialPath: join(directory, `${masterKey.length}.enc.json`),
        statePath: join(directory, `${masterKey.length}.state.json`),
      });
      assert.equal(store.masterKeyConfigured, false);
      await assert.rejects(
        store.saveCredentials({ apiKey: "never-written", apiSecret: "never-written-secret" }, permissions, identity, 1),
        /主密钥|MASTER_KEY/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential ciphertext AAD prevents cross-user replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xingheng-rwa-vault-aad-"));
  const masterKey = Buffer.alloc(32, 8).toString("base64url");
  const firstPath = join(directory, "user-a.enc.json");
  const secondPath = join(directory, "user-b.enc.json");
  const first = new RwaAutomationPersistentStore({ userId: "user-a", masterKey, credentialPath: firstPath, statePath: join(directory, "a.state.json") });
  const second = new RwaAutomationPersistentStore({ userId: "user-b", masterKey, credentialPath: secondPath, statePath: join(directory, "b.state.json") });
  try {
    await first.saveCredentials({ apiKey: "owner-api-key-123456", apiSecret: "owner-secret-never-plaintext" }, permissions, identity, 1234);
    await copyFile(firstPath, secondPath);
    await assert.rejects(second.loadCredentials(), /无法解密/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
