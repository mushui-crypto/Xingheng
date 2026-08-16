import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createExecutionRecord } from "../cex/ExecutionRecord";
import { OkxProductionReadinessService } from "./OkxProductionReadiness";
import type {
  OkxAccountIdentity,
  OkxGetOrderRequest,
  OkxPerpetualPosition,
  OkxProviderOrder,
} from "./OkxTypes";

const now = 1_800_000_000_000;

test("production readiness verifies OKX execution prerequisites through read-only paths", async () => {
  const credentials = new MemoryCredentialStore();
  const client = new FakeReadinessClient();
  const createdCredentials: unknown[] = [];
  const service = new OkxProductionReadinessService(credentials, {
    clientFactory: (credential) => {
      createdCredentials.push(credential);
      return client;
    },
  });

  const result = await service.verify({
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
    orderQuery: {
      instId: "DOGE-USDT-SWAP",
      ordId: "9101",
      clOrdId: "sxokxreadiness00000000000000",
    },
    reconciliation: {
      record: createExecutionRecord({
        executionId: "execution-readiness-1",
        intentId: "intent-readiness-1",
        executionAttemptId: "intent-readiness-1",
        userId: "user-a",
        venue: "okx",
        accountId: "okx:account-user-a",
        instrumentId: "DOGE-USDT-PERP",
        status: "PENDING_CONFIRMATION",
        remoteOrderId: "9101",
        createdAt: now,
        updatedAt: now,
      }),
      reference: {
        executionId: "execution-readiness-1",
        intentId: "intent-readiness-1",
        userId: "user-a",
        accountId: "okx:account-user-a",
        instrumentId: "DOGE-USDT-PERP",
        instId: "DOGE-USDT-SWAP",
        ordId: "9101",
        clOrdId: "sxokxreadiness00000000000000",
        createdAt: now,
        updatedAt: now,
      },
    },
  });

  assert.deepEqual(credentials.summaryCalls, [{ userId: "user-a", venue: "okx" }]);
  assert.deepEqual(credentials.executionCalls, [{ userId: "user-a", venue: "okx" }]);
  assert.deepEqual(createdCredentials, [{
    apiKey: "okx-api-user-a",
    apiSecret: "okx-secret-user-a",
    passphrase: "okx-pass-user-a",
  }]);
  assert.deepEqual(result.checks, {
    credentialLoading: "PASS",
    accountIdentity: "PASS",
    instrumentResolution: "PASS",
    positionRead: "PASS",
    openOrderRead: "PASS",
    orderQuery: "PASS",
    reconciliationRead: "PASS",
  });
  assert.equal(result.instrumentId, "DOGE-USDT-PERP");
  assert.equal(result.instId, "DOGE-USDT-SWAP");
  assert.equal(result.positions[0]?.quantity, "12.5");
  assert.equal(result.openOrders[0]?.ordId, "9102");
  assert.equal(result.orderQuery?.ordId, "9101");
  assert.equal(result.reconciliationOrder?.ordId, "9101");
  assert.equal(result.providerMutations, 0);
  assert.deepEqual(client.calls, [
    "getAccountIdentity",
    "getPosition:DOGE-USDT-SWAP",
    "getOpenOrders:DOGE-USDT-SWAP",
    "getOrder:DOGE-USDT-SWAP:9101:sxokxreadiness00000000000000",
    "getOrder:DOGE-USDT-SWAP:9101:sxokxreadiness00000000000000",
  ]);
  assert.equal(client.providerMutations, 0);
});

test("production readiness skips optional order reads but still verifies account and instrument GET paths", async () => {
  const client = new FakeReadinessClient();
  const service = new OkxProductionReadinessService(new MemoryCredentialStore(), {
    clientFactory: () => client,
  });

  const result = await service.verify({
    userId: "user-a",
    accountId: "okx:account-user-a",
    instrumentId: "DOGE-USDT-PERP",
  });

  assert.equal(result.checks.orderQuery, "SKIPPED");
  assert.equal(result.checks.reconciliationRead, "SKIPPED");
  assert.equal(result.orderQuery, null);
  assert.equal(result.reconciliationOrder, null);
  assert.deepEqual(client.calls, [
    "getAccountIdentity",
    "getPosition:DOGE-USDT-SWAP",
    "getOpenOrders:DOGE-USDT-SWAP",
  ]);
});

test("production readiness fails closed on account or reconciliation identity mismatch before order read", async () => {
  const wrongAccount = new OkxProductionReadinessService(new MemoryCredentialStore(), {
    clientFactory: () => new FakeReadinessClient({ accountId: "okx:other-account" }),
  });
  await assert.rejects(
    () => wrongAccount.verify({
      userId: "user-a",
      accountId: "okx:account-user-a",
      instrumentId: "DOGE-USDT-PERP",
    }),
    /provider account identity does not match/u,
  );

  const client = new FakeReadinessClient();
  const service = new OkxProductionReadinessService(new MemoryCredentialStore(), {
    clientFactory: () => client,
  });
  await assert.rejects(
    () => service.verify({
      userId: "user-a",
      accountId: "okx:account-user-a",
      instrumentId: "DOGE-USDT-PERP",
      reconciliation: {
        record: createExecutionRecord({
          executionId: "execution-readiness-1",
          intentId: "intent-readiness-1",
          userId: "user-a",
          venue: "okx",
          accountId: "okx:account-user-a",
          instrumentId: "BTC-USDT-PERP",
          status: "PENDING_CONFIRMATION",
          remoteOrderId: "9101",
          createdAt: now,
          updatedAt: now,
        }),
        reference: {
          executionId: "execution-readiness-1",
          intentId: "intent-readiness-1",
          userId: "user-a",
          accountId: "okx:account-user-a",
          instrumentId: "DOGE-USDT-PERP",
          instId: "DOGE-USDT-SWAP",
          ordId: "9101",
          clOrdId: "sxokxreadiness00000000000000",
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
    /reconciliation record identity does not match/u,
  );
  assert.deepEqual(client.calls, [
    "getAccountIdentity",
    "getPosition:DOGE-USDT-SWAP",
    "getOpenOrders:DOGE-USDT-SWAP",
  ]);
});

test("production readiness module exposes no mutation calls or production switch changes", () => {
  const source = readFileSync(new URL("./OkxProductionReadiness.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /placeOrder|cancelOrder|close\(|LIVE_TRADING_ENABLED|BINANCE_KILL_SWITCH/u);
});

class MemoryCredentialStore {
  readonly summaryCalls: Array<{ userId: string; venue: "okx" }> = [];
  readonly executionCalls: Array<{ userId: string; venue: "okx" }> = [];

  findSummary(userId: string, venue: "okx") {
    this.summaryCalls.push({ userId, venue });
    if (userId !== "user-a") return null;
    return {
      userId,
      venue,
      accountId: "okx:account-user-a",
      accountFingerprint: "account-user-a",
      maskedApiKey: "okx-...-a",
      environment: "test" as const,
      permissions: {},
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async loadForExecution(userId: string, venue: "okx") {
    this.executionCalls.push({ userId, venue });
    return {
      apiKey: `okx-api-${userId}`,
      apiSecret: `okx-secret-${userId}`,
      passphrase: `okx-pass-${userId}`,
    };
  }
}

class FakeReadinessClient {
  readonly calls: string[] = [];
  providerMutations = 0;
  private readonly accountId: string;

  constructor(options: Readonly<{ accountId?: string }> = {}) {
    this.accountId = options.accountId ?? "okx:account-user-a";
  }

  async getAccountIdentity(): Promise<OkxAccountIdentity> {
    this.calls.push("getAccountIdentity");
    return {
      accountId: this.accountId,
      accountFingerprint: this.accountId.slice("okx:".length),
      uidHash: `${this.accountId}:uid-hash`,
      accountLevel: "3",
    };
  }

  async getPosition(instId: string): Promise<readonly OkxPerpetualPosition[]> {
    this.calls.push(`getPosition:${instId}`);
    return [{
      instId,
      side: "long",
      quantity: "12.5",
      averagePrice: "0.123",
      markPrice: "0.124",
      liquidationPrice: null,
      updatedAt: now,
    }];
  }

  async getOpenOrders(instId: string): Promise<readonly OkxProviderOrder[]> {
    this.calls.push(`getOpenOrders:${instId}`);
    return [order({ instId, ordId: "9102", clOrdId: "sxokxopen000000000000000000000" })];
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    this.calls.push(`getOrder:${request.instId}:${request.ordId ?? ""}:${request.clOrdId ?? ""}`);
    return order({
      instId: request.instId,
      ordId: request.ordId ?? "9101",
      clOrdId: request.clOrdId ?? "sxokxreadiness00000000000000",
    });
  }
}

function order(input: Readonly<{ instId: string; ordId: string; clOrdId: string }>): OkxProviderOrder {
  return {
    instId: input.instId,
    ordId: input.ordId,
    clOrdId: input.clOrdId,
    status: "SUBMITTED",
    statusReason: null,
    rawState: "live",
    requestedQuantity: "12.5",
    filledQuantity: "0",
    averagePrice: null,
    fee: "0",
    updatedAt: now,
  };
}
