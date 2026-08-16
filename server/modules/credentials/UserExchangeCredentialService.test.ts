import assert from "node:assert/strict";
import test from "node:test";
import type { BinanceAccountIdentity, BinancePermissions } from "../binance/BinanceTypes";
import { OkxProviderError } from "../okx/OkxClient";
import type { OkxAccountAccess, OkxPermissions } from "../okx/OkxTypes";
import { UserExchangeCredentialService, UserExchangeCredentialServiceError } from "./UserExchangeCredentialService";
import type {
  ReplaceUserExchangeCredentialInput,
  SaveUserExchangeCredentialInput,
  UserExchangeCredentialSecret,
  UserExchangeCredentialSummary,
} from "./UserExchangeCredentialStore";

test("validates Binance access and returns only credential metadata", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never, {
    binanceClientFactory: () => ({ validateAccess: async () => access() }),
  });
  const result = await service.put("user-1", "binance", {
    apiKey: "api-key-value-001",
    apiSecret: "api-secret-value-001",
  });

  assert.equal(result.configured, true);
  assert.equal(result.accountId, "binance:account-1");
  assert.equal(JSON.stringify(result).includes("api-secret-value-001"), false);
  assert.equal(JSON.stringify(service.list("user-1")).includes("api-secret-value-001"), false);
  assert.equal(store.saved?.userId, "user-1");
  assert.equal(store.saved?.venue, "binance");
});

test("rejects credentials with withdrawal permission", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never, {
    binanceClientFactory: () => ({
      validateAccess: async () => access({ withdraw: true }),
    }),
  });
  await assert.rejects(
    service.put("user-1", "binance", { apiKey: "api-key", apiSecret: "api-secret" }),
    (error: unknown) => error instanceof UserExchangeCredentialServiceError
      && error.category === "credential_permissions_invalid",
  );
  assert.equal(store.saved, null);
});

test("keeps Bybit and Bitget credential-only behavior unchanged", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never);

  const bybit = await service.put("user-1", "bybit", {
    apiKey: "bybit-api-key-001",
    apiSecret: "bybit-api-secret-001",
  });
  const bitget = await service.put("user-1", "bitget", {
    apiKey: "bitget-api-key-001",
    apiSecret: "bitget-api-secret-001",
    passphrase: "bitget-passphrase-001",
  });
  assert.equal(bybit.implemented, true);
  assert.equal(bybit.configured, true);
  assert.match(bybit.accountId ?? "", /^bybit:credential-only:/u);
  assert.equal(bybit.permissions?.executionEnabled, false);
  assert.equal(bitget.configured, true);
  assert.equal(JSON.stringify([bybit, bitget]).includes("passphrase-001"), false);
  assert.equal(store.savedItems.length, 2);
  assert.equal(store.savedItems[1]?.passphrase, "bitget-passphrase-001");
});

test("binds a new OKX credential to Provider-derived identity before saving", async () => {
  const store = new MemoryCredentialStore();
  let providerReads = 0;
  let providerMutations = 0;
  const service = new UserExchangeCredentialService(store as never, {
    okxClientFactory: () => ({
      validateAccess: async () => {
        providerReads += 1;
        return okxAccess();
      },
    }),
  });

  const result = await service.put("user-1", "okx", {
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
  });

  assert.equal(result.accountId, "okx:0123456789abcdef");
  assert.equal(result.accountFingerprint, "0123456789abcdef");
  assert.equal(result.permissions?.providerVerified, true);
  assert.equal(result.permissions?.executionEnabled, true);
  assert.equal(store.saved?.accountId, "okx:0123456789abcdef");
  assert.equal(store.saved?.passphrase, "okx-passphrase-001");
  assert.equal(JSON.stringify(result).includes("okx-api-secret-001"), false);
  assert.equal(providerReads, 1);
  assert.equal(providerMutations, 0);
});

test("saves Provider-verified OKX identity with execution disabled when permissions are insufficient", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never, {
    okxClientFactory: () => ({
      validateAccess: async () => okxAccess({ contractTrade: false, executionEnabled: false }),
    }),
  });

  const result = await service.put("user-1", "okx", {
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
  });

  assert.equal(result.accountId, "okx:0123456789abcdef");
  assert.equal(result.permissions?.providerVerified, true);
  assert.equal(result.permissions?.contractTrade, false);
  assert.equal(result.permissions?.executionEnabled, false);
});

test("requires passphrase only for Bitget and OKX credential-only storage", async () => {
  const service = new UserExchangeCredentialService(new MemoryCredentialStore() as never);
  await assert.rejects(
    service.put("user-1", "bitget", { apiKey: "key", apiSecret: "secret" }),
    (error: unknown) => error instanceof UserExchangeCredentialServiceError
      && error.category === "credential_input_invalid",
  );
  await assert.rejects(
    service.put("user-1", "bybit", { apiKey: "key", apiSecret: "secret", passphrase: "not-used" }),
    (error: unknown) => error instanceof UserExchangeCredentialServiceError
      && error.category === "credential_input_invalid",
  );
});

test("deletes non-Binance credentials through the common store when the Binance hook does not handle them", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never, {
    deleteCredential: async () => false,
  });
  await service.put("user-1", "bitget", {
    apiKey: "bitget-api-key-001",
    apiSecret: "bitget-api-secret-001",
    passphrase: "bitget-passphrase-001",
  });
  const deleted = await service.delete("user-1", "bitget");
  assert.equal(deleted.configured, false);
  assert.equal(store.findSummary("user-1", "bitget"), null);
});

test("preserves Binance-specific guarded delete hook semantics", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never, {
    binanceClientFactory: () => ({ validateAccess: async () => access() }),
    deleteCredential: async (userId, venue) => {
      store.delete(userId, venue);
      return true;
    },
  });
  await service.put("user-1", "binance", {
    apiKey: "api-key-value-001",
    apiSecret: "api-secret-value-001",
  });
  const deleted = await service.delete("user-1", "binance");
  assert.equal(deleted.configured, false);
  assert.equal(store.findSummary("user-1", "binance"), null);
});

test("lists every venue and reports that unconfigured OKX requires Provider validation", async () => {
  const service = new UserExchangeCredentialService(new MemoryCredentialStore() as never);
  const list = service.list("user-1");
  assert.deepEqual(list.map((credential) => [credential.venue, credential.implemented]), [
    ["bybit", true],
    ["bitget", true],
    ["binance", true],
    ["okx", true],
  ]);
  assert.match(list.find((credential) => credential.venue === "okx")?.message ?? "", /Provider identity validation/u);
  assert.equal(list.find((credential) => credential.venue === "binance")?.message, null);
});

test("KMS failures fail closed after OKX Provider validation without exposing secrets", async () => {
  const store = new MemoryCredentialStore();
  store.failSave = true;
  const service = new UserExchangeCredentialService(store as never, {
    okxClientFactory: () => ({ validateAccess: async () => okxAccess() }),
  });
  await assert.rejects(
    service.put("user-1", "okx", {
      apiKey: "okx-api-key-001",
      apiSecret: "must-not-leak",
      passphrase: "okx-passphrase-001",
    }),
    (error: unknown) => error instanceof Error
      && !String(error.message).includes("must-not-leak"),
  );
  assert.equal(store.saved, null);
});

test("invalid API Key and Provider identity query failure do not save OKX credential", async (t) => {
  for (const fixture of [
    new OkxProviderError("credential_validation_failed", "fake invalid API Key", "50113"),
    new OkxProviderError("provider_transport_error", "fake identity query failure"),
  ]) {
    await t.test(fixture.category, async () => {
      const store = new MemoryCredentialStore();
      let providerMutations = 0;
      const service = new UserExchangeCredentialService(store as never, {
        okxClientFactory: () => ({ validateAccess: async () => { throw fixture; } }),
      });

      await assert.rejects(
        service.put("user-1", "okx", {
          apiKey: "okx-api-key-001",
          apiSecret: "okx-api-secret-001",
          passphrase: "okx-passphrase-001",
        }),
        (error: unknown) => error === fixture,
      );
      assert.equal(store.saved, null);
      assert.equal(providerMutations, 0);
    });
  }
});

test("rebinds a legacy OKX credential with a new envelope and keeps execution disabled", async () => {
  const store = new MemoryCredentialStore();
  await store.save({
    userId: "user-1",
    venue: "okx",
    accountId: "okx:credential-only:0123456789abcdef0123",
    accountFingerprint: "OKX-LEGACY",
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
    permissions: { providerVerified: false, executionEnabled: false },
  });
  let providerReads = 0;
  let providerMutations = 0;
  const service = new UserExchangeCredentialService(store as never, {
    okxClientFactory: () => ({
      validateAccess: async () => {
        providerReads += 1;
        return okxAccess();
      },
    }),
  });

  const first = await service.rebindOkx("user-1");
  const repeated = await service.rebindOkx("user-1");

  assert.equal(first.accountId, "okx:0123456789abcdef");
  assert.equal(first.permissions?.providerVerified, true);
  assert.equal(first.permissions?.contractTrade, true);
  assert.equal(first.permissions?.executionEnabled, false);
  assert.equal(repeated.accountId, first.accountId);
  assert.equal(repeated.permissions?.executionEnabled, false);
  assert.equal(store.replacedItems.length, 2);
  assert.equal(store.replacedItems[0]?.expectedAccountId, "okx:credential-only:0123456789abcdef0123");
  assert.equal(store.replacedItems[1]?.expectedAccountId, "okx:0123456789abcdef");
  assert.deepEqual(await store.loadForExecution("user-1", "okx"), {
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
  });
  assert.equal(providerReads, 2);
  assert.equal(providerMutations, 0);
});

test("does not overwrite a Provider-bound OKX credential when UID identity mismatches", async () => {
  const store = new MemoryCredentialStore();
  await store.save({
    userId: "user-1",
    venue: "okx",
    accountId: "okx:0123456789abcdef",
    accountFingerprint: "0123456789abcdef",
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
    permissions: { providerVerified: true, executionEnabled: false },
  });
  const service = new UserExchangeCredentialService(store as never, {
    okxClientFactory: () => ({ validateAccess: async () => okxAccessFor("fedcba9876543210") }),
  });

  await assert.rejects(
    service.rebindOkx("user-1"),
    (error: unknown) => error instanceof UserExchangeCredentialServiceError
      && error.category === "credential_provider_identity_mismatch",
  );
  assert.equal(store.replacedItems.length, 0);
  assert.equal(store.findSummary("user-1", "okx")?.accountId, "okx:0123456789abcdef");
});

function access(overrides: Partial<BinancePermissions> = {}): BinanceAccountIdentity & { permissions: BinancePermissions } {
  return {
    accountId: "binance:account-1",
    accountFingerprint: "account-fingerprint-1",
    accountMode: "single_asset_one_way",
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      ipRestricted: true,
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: true,
      ...overrides,
    },
  };
}

function okxAccess(overrides: Partial<OkxPermissions> = {}): OkxAccountAccess {
  return okxAccessFor("0123456789abcdef", overrides);
}

function okxAccessFor(
  accountFingerprint: string,
  overrides: Partial<OkxPermissions> = {},
): OkxAccountAccess {
  return {
    accountId: `okx:${accountFingerprint}`,
    accountFingerprint,
    uidHash: `${accountFingerprint}${"0".repeat(48)}`,
    accountLevel: "3",
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      ipRestricted: true,
      accountLevelSupported: true,
      positionModeSupported: true,
      providerVerified: true,
      executionEnabled: true,
      ...overrides,
    },
  };
}

class MemoryCredentialStore {
  readonly values = new Map<string, UserExchangeCredentialSummary>();
  readonly secrets = new Map<string, UserExchangeCredentialSecret>();
  readonly savedItems: SaveUserExchangeCredentialInput[] = [];
  readonly replacedItems: ReplaceUserExchangeCredentialInput[] = [];
  saved: SaveUserExchangeCredentialInput | null = null;
  failSave = false;

  findSummary(userId: string, venue: string) {
    return this.values.get(`${userId}:${venue}`) ?? null;
  }

  listForUser(userId: string) {
    return [...this.values.values()].filter((summary) => summary.userId === userId);
  }

  async save(input: SaveUserExchangeCredentialInput) {
    if (this.failSave) throw new Error("GCP KMS is unavailable, unauthorized, or the key version is disabled.");
    this.saved = input;
    this.savedItems.push(input);
    const now = input.verifiedAt ?? Date.now();
    const summary: UserExchangeCredentialSummary = {
      userId: input.userId,
      venue: input.venue,
      accountId: input.accountId,
      accountFingerprint: input.accountFingerprint,
      maskedApiKey: "api-...-001",
      environment: "test",
      permissions: input.permissions,
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const key = `${input.userId}:${input.venue}`;
    this.values.set(key, summary);
    this.secrets.set(key, {
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    });
    return summary;
  }

  async replace(input: ReplaceUserExchangeCredentialInput) {
    const key = `${input.userId}:${input.venue}`;
    const existing = this.values.get(key);
    if (!existing || existing.accountId !== input.expectedAccountId) {
      throw new Error("credential rebind conflict");
    }
    this.replacedItems.push(input);
    const now = input.verifiedAt ?? Date.now();
    const summary: UserExchangeCredentialSummary = {
      userId: input.userId,
      venue: input.venue,
      accountId: input.accountId,
      accountFingerprint: input.accountFingerprint,
      maskedApiKey: "api-...-001",
      environment: "test",
      permissions: input.permissions,
      lastVerifiedAt: now,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    this.values.set(key, summary);
    this.secrets.set(key, {
      apiKey: input.apiKey,
      apiSecret: input.apiSecret,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    });
    return summary;
  }

  async loadForExecution(userId: string, venue: string) {
    const secret = this.secrets.get(`${userId}:${venue}`);
    if (!secret) throw new Error("credential not configured");
    return secret;
  }

  delete(userId: string, venue: string) {
    const key = `${userId}:${venue}`;
    this.values.delete(key);
    this.secrets.delete(key);
  }
}
