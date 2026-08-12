import assert from "node:assert/strict";
import test from "node:test";
import type { BinanceAccountIdentity, BinancePermissions } from "../binance/BinanceTypes";
import { UserExchangeCredentialService, UserExchangeCredentialServiceError } from "./UserExchangeCredentialService";
import type { SaveUserExchangeCredentialInput, UserExchangeCredentialSummary } from "./UserExchangeCredentialStore";

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

test("stores Bybit, Bitget and OKX credentials as credential-only without provider validation", async () => {
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
  const okx = await service.put("user-1", "okx", {
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
  });

  assert.equal(bybit.implemented, true);
  assert.equal(bybit.configured, true);
  assert.match(bybit.accountId ?? "", /^bybit:credential-only:/u);
  assert.equal(bybit.permissions?.executionEnabled, false);
  assert.equal(bitget.configured, true);
  assert.equal(okx.configured, true);
  assert.equal(JSON.stringify([bybit, bitget, okx]).includes("passphrase-001"), false);
  assert.equal(store.savedItems.length, 3);
  assert.equal(store.savedItems[1]?.passphrase, "bitget-passphrase-001");
  assert.equal(store.savedItems[2]?.passphrase, "okx-passphrase-001");
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
  await service.put("user-1", "okx", {
    apiKey: "okx-api-key-001",
    apiSecret: "okx-api-secret-001",
    passphrase: "okx-passphrase-001",
  });
  const deleted = await service.delete("user-1", "okx");
  assert.equal(deleted.configured, false);
  assert.equal(store.findSummary("user-1", "okx"), null);
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

test("lists every venue as configurable while only Binance represents provider-verified execution", async () => {
  const service = new UserExchangeCredentialService(new MemoryCredentialStore() as never);
  const list = service.list("user-1");
  assert.deepEqual(list.map((credential) => [credential.venue, credential.implemented]), [
    ["bybit", true],
    ["bitget", true],
    ["binance", true],
    ["okx", true],
  ]);
  assert.match(list.find((credential) => credential.venue === "okx")?.message ?? "", /credential storage only/u);
  assert.equal(list.find((credential) => credential.venue === "binance")?.message, null);
});

test("KMS failures fail closed for credential-only venues without exposing secrets", async () => {
  const store = new MemoryCredentialStore();
  store.failSave = true;
  const service = new UserExchangeCredentialService(store as never);
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

class MemoryCredentialStore {
  readonly values = new Map<string, UserExchangeCredentialSummary>();
  readonly savedItems: SaveUserExchangeCredentialInput[] = [];
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
    this.values.set(`${input.userId}:${input.venue}`, summary);
    return summary;
  }

  delete(userId: string, venue: string) {
    this.values.delete(`${userId}:${venue}`);
  }
}
