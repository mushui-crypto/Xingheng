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

test("does not expose configuration actions for unimplemented venues", async () => {
  const store = new MemoryCredentialStore();
  const service = new UserExchangeCredentialService(store as never);
  const bybit = service.list("user-1").find((credential) => credential.venue === "bybit");
  assert.equal(bybit?.implemented, false);
  await assert.rejects(
    service.put("user-1", "bybit", { apiKey: "key", apiSecret: "secret" }),
    (error: unknown) => error instanceof UserExchangeCredentialServiceError
      && error.category === "credential_adapter_not_implemented",
  );
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
  saved: SaveUserExchangeCredentialInput | null = null;

  findSummary(userId: string, venue: string) {
    return this.values.get(`${userId}:${venue}`) ?? null;
  }

  listForUser(userId: string) {
    return [...this.values.values()].filter((summary) => summary.userId === userId);
  }

  async save(input: SaveUserExchangeCredentialInput) {
    this.saved = input;
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
