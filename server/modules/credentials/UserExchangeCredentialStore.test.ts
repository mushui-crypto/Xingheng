import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CredentialKeyProviderError,
  canonicalCredentialAad,
  equalCredentialAad,
  type CreatedCredentialDataKey,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";
import { UserExchangeCredentialStore } from "./UserExchangeCredentialStore";

test("stores only encrypted credentials and decrypts only for explicit runtime consumers", async () => {
  const fixture = createFixture();
  try {
    const summary = await fixture.store.save(credential());
    assert.equal(summary.maskedApiKey, "api-...-001");
    assert.equal("apiSecret" in summary, false);
    assert.equal(fixture.provider.unwrapCalls, 0);

    const listed = fixture.store.listForUser("user-1");
    assert.equal(listed.length, 1);
    assert.equal(fixture.provider.unwrapCalls, 0);
    const databaseBytes = readFileSync(fixture.dbPath).toString("utf8");
    assert.equal(databaseBytes.includes("secret-value-001"), false);
    assert.equal(databaseBytes.includes("api-key-value-001"), false);

    assert.deepEqual(await fixture.store.loadForAccountRead("user-1", "binance"), {
      apiKey: "api-key-value-001",
      apiSecret: "secret-value-001",
    });
    assert.equal(fixture.provider.unwrapCalls, 1);
    assert.deepEqual(await fixture.store.loadForExecution("user-1", "binance"), {
      apiKey: "api-key-value-001",
      apiSecret: "secret-value-001",
    });
    assert.equal(fixture.provider.unwrapCalls, 2);
  } finally {
    fixture.close();
  }
});

test("stores Bitget passphrase inside the encrypted payload only", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save({
      ...credential(),
      venue: "bitget",
      accountId: "bitget:credential-only:account-001",
      accountFingerprint: "BITGET-FINGERPRINT-001",
      apiKey: "bitget-api-key-value-001",
      apiSecret: "bitget-secret-value-001",
      passphrase: "bitget-passphrase-value-001",
      permissions: { read: false, executionEnabled: false, providerVerified: false },
    });

    const databaseBytes = readFileSync(fixture.dbPath).toString("utf8");
    assert.equal(databaseBytes.includes("bitget-secret-value-001"), false);
    assert.equal(databaseBytes.includes("bitget-passphrase-value-001"), false);
    assert.deepEqual(await fixture.store.loadForExecution("user-1", "bitget"), {
      apiKey: "bitget-api-key-value-001",
      apiSecret: "bitget-secret-value-001",
      passphrase: "bitget-passphrase-value-001",
    });
  } finally {
    fixture.close();
  }
});

test("AAD prevents moving a credential to another user", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save(credential());
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("UPDATE user_exchange_credentials SET userId = 'user-2' WHERE userId = 'user-1'").run();
    db.close();
    await assert.rejects(
      fixture.store.loadForExecution("user-2", "binance"),
      (error: unknown) => error instanceof CredentialKeyProviderError && error.category === "credential_key_identity_mismatch",
    );
  } finally {
    fixture.close();
  }
});

test("AES-GCM rejects tampered ciphertext", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save(credential());
    const db = new DatabaseSync(fixture.dbPath);
    const row = db.prepare("SELECT ciphertext FROM user_exchange_credentials").get() as { ciphertext: string };
    const ciphertext = Buffer.from(row.ciphertext, "base64url");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    db.prepare("UPDATE user_exchange_credentials SET ciphertext = ?").run(ciphertext.toString("base64url"));
    db.close();
    await assert.rejects(
      fixture.store.loadForExecution("user-1", "binance"),
      (error: unknown) => error instanceof Error && "category" in error && error.category === "credential_decryption_failed",
    );
  } finally {
    fixture.close();
  }
});

test("environment mismatch fails before KMS decrypt", async () => {
  const fixture = createFixture();
  let productionStore: UserExchangeCredentialStore | null = null;
  try {
    await fixture.store.save(credential());
    productionStore = new UserExchangeCredentialStore({
      dbPath: fixture.dbPath,
      environment: "production",
      keyProvider: fixture.provider,
    });
    await assert.rejects(
      productionStore.loadForExecution("user-1", "binance"),
      (error: unknown) => error instanceof Error && "category" in error && error.category === "credential_environment_mismatch",
    );
    assert.equal(fixture.provider.unwrapCalls, 0);
  } finally {
    productionStore?.close();
    fixture.close();
  }
});

test("one exchange account cannot be bound to two users", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save(credential());
    await assert.rejects(
      fixture.store.save({ ...credential(), userId: "user-2", apiKey: "api-key-value-002" }),
      (error: unknown) => error instanceof Error && "category" in error && error.category === "credential_account_already_bound",
    );
  } finally {
    fixture.close();
  }
});

test("an existing user venue credential cannot be overwritten", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save(credential());
    await assert.rejects(
      fixture.store.save({ ...credential(), accountId: "binance:account-002", apiSecret: "replacement-secret" }),
      (error: unknown) => error instanceof Error && "category" in error && error.category === "credential_already_configured",
    );
    assert.deepEqual(await fixture.store.loadForExecution("user-1", "binance"), {
      apiKey: "api-key-value-001",
      apiSecret: "secret-value-001",
    });
  } finally {
    fixture.close();
  }
});

test("replaces a credential identity only with a new envelope bound to the new AAD", async () => {
  const fixture = createFixture();
  try {
    const original = await fixture.store.save({
      ...credential(),
      venue: "okx",
      accountId: "okx:credential-only:legacy-account",
      accountFingerprint: "OKX-LEGACY",
      passphrase: "okx-passphrase-value-001",
      permissions: { providerVerified: false, executionEnabled: false },
    });
    const secret = await fixture.store.loadForExecution("user-1", "okx");

    const replaced = await fixture.store.replace({
      userId: "user-1",
      venue: "okx",
      expectedAccountId: "okx:credential-only:legacy-account",
      accountId: "okx:0123456789abcdef",
      accountFingerprint: "0123456789abcdef",
      ...secret,
      permissions: { providerVerified: true, contractTrade: true, executionEnabled: false },
      verifiedAt: 1_800_000_000_000,
    });

    assert.equal(replaced.accountId, "okx:0123456789abcdef");
    assert.equal(replaced.createdAt, original.createdAt);
    assert.deepEqual(await fixture.store.loadForExecution("user-1", "okx"), secret);
    const databaseBytes = readFileSync(fixture.dbPath).toString("utf8");
    assert.equal(databaseBytes.includes("okx-passphrase-value-001"), false);
    assert.equal(fixture.provider.unwrapCalls, 2);
  } finally {
    fixture.close();
  }
});

test("failed credential replacement preserves the old identity and decryptable envelope", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save({
      ...credential(),
      venue: "okx",
      accountId: "okx:credential-only:legacy-account",
      accountFingerprint: "OKX-LEGACY",
      passphrase: "okx-passphrase-value-001",
    });

    await assert.rejects(
      fixture.store.replace({
        ...credential(),
        venue: "okx",
        expectedAccountId: "okx:credential-only:stale-account",
        accountId: "okx:0123456789abcdef",
        accountFingerprint: "0123456789abcdef",
        passphrase: "okx-passphrase-value-001",
      }),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "credential_rebind_conflict",
    );

    assert.equal(fixture.store.findSummary("user-1", "okx")?.accountId, "okx:credential-only:legacy-account");
    assert.deepEqual(await fixture.store.loadForExecution("user-1", "okx"), {
      apiKey: "api-key-value-001",
      apiSecret: "secret-value-001",
      passphrase: "okx-passphrase-value-001",
    });
  } finally {
    fixture.close();
  }
});

test("account binding conflict during replacement leaves the legacy envelope intact", async () => {
  const fixture = createFixture();
  try {
    await fixture.store.save({
      ...credential(),
      venue: "okx",
      accountId: "okx:credential-only:legacy-account",
      accountFingerprint: "OKX-LEGACY",
      passphrase: "okx-passphrase-value-001",
    });
    await fixture.store.save({
      ...credential(),
      userId: "user-2",
      venue: "okx",
      accountId: "okx:0123456789abcdef",
      accountFingerprint: "0123456789abcdef",
      apiKey: "api-key-value-002",
      apiSecret: "secret-value-002",
      passphrase: "okx-passphrase-value-002",
    });

    await assert.rejects(
      fixture.store.replace({
        ...credential(),
        venue: "okx",
        expectedAccountId: "okx:credential-only:legacy-account",
        accountId: "okx:0123456789abcdef",
        accountFingerprint: "0123456789abcdef",
        passphrase: "okx-passphrase-value-001",
      }),
      (error: unknown) => error instanceof Error
        && "category" in error
        && error.category === "credential_account_already_bound",
    );

    assert.equal(fixture.store.findSummary("user-1", "okx")?.accountId, "okx:credential-only:legacy-account");
    assert.deepEqual(await fixture.store.loadForExecution("user-1", "okx"), {
      apiKey: "api-key-value-001",
      apiSecret: "secret-value-001",
      passphrase: "okx-passphrase-value-001",
    });
  } finally {
    fixture.close();
  }
});

function credential() {
  return {
    userId: "user-1",
    venue: "binance" as const,
    accountId: "binance:account-001",
    accountFingerprint: "account-fingerprint-001",
    apiKey: "api-key-value-001",
    apiSecret: "secret-value-001",
    permissions: { read: true, trade: true, withdraw: false },
    verifiedAt: 1_700_000_000_000,
  };
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "user-exchange-credential-"));
  const dbPath = join(directory, "credentials.sqlite");
  const provider = new FakeCredentialKeyProvider();
  const store = new UserExchangeCredentialStore({ dbPath, environment: "test", keyProvider: provider });
  return {
    dbPath,
    provider,
    store,
    close() {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

class FakeCredentialKeyProvider implements CredentialKeyProvider {
  readonly name = "fake-kms";
  readonly keyName = "fake-key";
  readonly configured = true;
  readonly configurationError = null;
  readonly entries = new Map<string, { aad: Buffer; dek: Buffer }>();
  unwrapCalls = 0;

  async createDataKey(context: CredentialKeyContext): Promise<CreatedCredentialDataKey> {
    const plaintextDek = randomBytes(32);
    const wrappedDek = randomBytes(24).toString("base64url");
    this.entries.set(wrappedDek, { aad: canonicalCredentialAad(context), dek: Buffer.from(plaintextDek) });
    return { provider: this.name, keyName: this.keyName, wrapReference: "fake-key/versions/1", wrappedDek, plaintextDek };
  }

  async unwrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext) {
    this.unwrapCalls += 1;
    if (input.provider !== this.name || input.keyName !== this.keyName) {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "Credential key identity does not match.");
    }
    const entry = this.entries.get(input.wrappedDek);
    if (!entry || !equalCredentialAad(entry.aad, canonicalCredentialAad(context))) {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "Credential key identity does not match.");
    }
    return Buffer.from(entry.dek);
  }
}
