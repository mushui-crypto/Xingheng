import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FormalExecutionRuntime } from "../arbitrage-execution/FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistry,
  formalExecutionRuntime,
} from "../arbitrage-execution/FormalExecutionRuntimeRegistry";
import { createExecutionIntent } from "../cex/ExecutionIntent";
import {
  ExecutionMutationSafetyGuard,
  executionMutationSafetyConfigFromEnvironment,
} from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { SqliteExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { SqliteExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";
import {
  InMemoryOkxExecutionOrderReferenceStore,
  PersistentOkxExecutionOrderReferenceStore,
  type OkxExecutionOrderReference,
} from "../okx/OkxExecutionOrderReferenceStore";
import { OkxFormalArbitrageExecutionRuntime } from "../okx/OkxFormalArbitrageExecutionRuntime";
import { createOkxInstrumentQuantityRulesSource } from "../okx/OkxInstrumentQuantityRulesSource";
import { OkxIntentExecutionRuntime } from "../okx/OkxIntentExecutionRuntime";
import { OkxIntentExecutionServiceRegistry } from "../okx/OkxIntentExecutionServiceRegistry";
import { okxTestQuantityRulesSource } from "../okx/OkxTestFixtures";
import type {
  OkxAccountIdentity,
  OkxCancelOrderRequest,
  OkxCancelOrderResult,
  OkxGetOrderRequest,
  OkxPlaceOrderRequest,
  OkxProviderOrder,
} from "../okx/OkxTypes";

const now = 1_800_000_000_000;
const accountId = "okx:provider-account-a";

test("production-equivalent construction registers Binance and OKX without Provider access", () => {
  const root = mkdtempSync(join(tmpdir(), "okx-production-composition-"));
  const dbPath = join(root, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const opaqueReferences = new SqliteExecutionOrderReferenceStore({ dbPath });
  let providerClientCreations = 0;
  let quantityRulesReads = 0;
  const credentials = new CredentialFixture("enabled");
  const services = new OkxIntentExecutionServiceRegistry(credentials, {
    clientFactory: () => {
      providerClientCreations += 1;
      return new FakeOkxProvider(identity(accountId));
    },
  });

  try {
    const okxRuntime = new OkxFormalArbitrageExecutionRuntime(new OkxIntentExecutionRuntime(
      services,
      records,
      new PersistentOkxExecutionOrderReferenceStore(opaqueReferences),
      {
        quantityRulesSource: createOkxInstrumentQuantityRulesSource({
          fetchImpl: async () => {
            quantityRulesReads += 1;
            throw new Error("Provider read is forbidden during composition.");
          },
        }),
      },
    ));
    const binanceRuntime = unusedFormalRuntime();
    const runtimes = new FormalExecutionRuntimeRegistry()
      .register(formalExecutionRuntime("binance", binanceRuntime))
      .register(formalExecutionRuntime("okx", okxRuntime));

    assert.equal(runtimes.resolve("binance"), binanceRuntime);
    assert.equal(runtimes.resolve("okx"), okxRuntime);
    assert.equal(credentials.summaryReads, 0);
    assert.equal(credentials.secretReads, 0);
    assert.equal(providerClientCreations, 0);
    assert.equal(quantityRulesReads, 0);
  } finally {
    opaqueReferences.close();
    records.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("default OKX production safety blocks place but allows a known-order cancel after identity validation", async () => {
  const provider = new FakeOkxProvider(identity(accountId));
  const credentials = new CredentialFixture("enabled");
  const records = new MemoryExecutionRecordStore([cancelRecord()]);
  const references = new InMemoryOkxExecutionOrderReferenceStore();
  references.create(cancelReference());
  const runtime = new OkxFormalArbitrageExecutionRuntime(new OkxIntentExecutionRuntime(
    new OkxIntentExecutionServiceRegistry(credentials, { clientFactory: () => provider }),
    records,
    references,
    {
      createExecutionId: () => "execution-okx-default-place",
      clock: () => now,
      quantityRulesSource: okxTestQuantityRulesSource(now),
      mutationSafetyGuard: new ExecutionMutationSafetyGuard(
        executionMutationSafetyConfigFromEnvironment({}),
      ),
    },
  ));

  const placed = await runtime.execute(intent());
  const cancelled = await runtime.cancel("user-a", "execution-okx-default-cancel");

  assert.equal(placed.executionRecord.status, "FAILED");
  assert.equal(cancelled.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(provider.identityReads, 1);
  assert.equal(provider.placeMutations, 0);
  assert.equal(provider.cancelMutations, 1);
});

test("OKX production runtime fails closed for missing or disabled credentials", async (context) => {
  for (const mode of ["missing", "disabled"] as const) {
    await context.test(mode, async () => {
      const provider = new FakeOkxProvider(identity(accountId));
      const credentials = new CredentialFixture(mode);
      const runtime = runtimeFor(provider, credentials, openOkxGuard());

      await assert.rejects(
        () => runtime.execute(intent()),
        mode === "missing" ? /not configured/u : /not enabled for execution/u,
      );

      assert.equal(credentials.secretReads, 0);
      assert.equal(provider.identityReads, 0);
      assert.equal(provider.placeMutations, 0);
      assert.equal(provider.cancelMutations, 0);
    });
  }
});

test("OKX Provider identity mismatch blocks production runtime mutation", async () => {
  const provider = new FakeOkxProvider(identity("okx:provider-account-other"));
  const runtime = runtimeFor(provider, new CredentialFixture("enabled"), openOkxGuard());

  const result = await runtime.execute(intent());

  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(provider.identityReads, 1);
  assert.equal(provider.placeMutations, 0);
  assert.equal(provider.cancelMutations, 0);
});

test("Binance and OKX environment switches remain isolated", () => {
  const openBinance = new ExecutionMutationSafetyGuard(executionMutationSafetyConfigFromEnvironment({
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
    OKX_LIVE_TRADING_ENABLED: "false",
    OKX_KILL_SWITCH: "true",
  }));
  assert.deepEqual(openBinance.status("binance"), {
    liveTradingEnabled: true,
    killSwitchActive: false,
  });
  assert.deepEqual(openBinance.status("okx"), {
    liveTradingEnabled: false,
    killSwitchActive: true,
  });

  const openOkx = new ExecutionMutationSafetyGuard(executionMutationSafetyConfigFromEnvironment({
    LIVE_TRADING_ENABLED: "false",
    BINANCE_KILL_SWITCH: "true",
    OKX_LIVE_TRADING_ENABLED: "true",
    OKX_KILL_SWITCH: "false",
  }));
  assert.deepEqual(openOkx.status("binance"), {
    liveTradingEnabled: false,
    killSwitchActive: true,
  });
  assert.deepEqual(openOkx.status("okx"), {
    liveTradingEnabled: true,
    killSwitchActive: false,
  });
});

function runtimeFor(
  provider: FakeOkxProvider,
  credentials: CredentialFixture,
  mutationSafetyGuard: ExecutionMutationSafetyGuard,
) {
  return new OkxFormalArbitrageExecutionRuntime(new OkxIntentExecutionRuntime(
    new OkxIntentExecutionServiceRegistry(credentials, { clientFactory: () => provider }),
    new MemoryExecutionRecordStore(),
    new InMemoryOkxExecutionOrderReferenceStore(),
    {
      createExecutionId: () => "execution-okx-production-failure",
      clock: () => now,
      quantityRulesSource: okxTestQuantityRulesSource(now),
      mutationSafetyGuard,
    },
  ));
}

function openOkxGuard() {
  return new ExecutionMutationSafetyGuard(executionMutationSafetyConfigFromEnvironment({
    OKX_LIVE_TRADING_ENABLED: "true",
    OKX_KILL_SWITCH: "false",
  }));
}

class CredentialFixture {
  summaryReads = 0;
  secretReads = 0;

  constructor(private readonly mode: "enabled" | "disabled" | "missing") {}

  findSummary(userId: string, venue: ExchangeVenue) {
    this.summaryReads += 1;
    if (this.mode === "missing") return null;
    return {
      userId,
      venue,
      accountId,
      accountFingerprint: "provider-account-a",
      maskedApiKey: "okx-...-key",
      environment: "test" as const,
      permissions: { executionEnabled: this.mode === "enabled" },
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async loadForExecution() {
    this.secretReads += 1;
    return {
      apiKey: "fake-okx-api-key",
      apiSecret: "fake-okx-api-secret",
      passphrase: "fake-okx-passphrase",
    };
  }
}

class FakeOkxProvider {
  identityReads = 0;
  placeMutations = 0;
  cancelMutations = 0;

  constructor(private readonly providerIdentity: OkxAccountIdentity) {}

  async readPositionMode() {
    return "ONE_WAY" as const;
  }

  async getAccountIdentity() {
    this.identityReads += 1;
    return this.providerIdentity;
  }

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeMutations += 1;
    return { instId: request.instId, ordId: "9001", clOrdId: request.clOrdId };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    this.cancelMutations += 1;
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxproductioncancel0000000001",
    };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "sxokxproductionquery00000000001",
      status: "PENDING_CONFIRMATION",
      statusReason: null,
      rawState: "live",
      requestedQuantity: "125",
      filledQuantity: "0",
      averagePrice: null,
      fee: "0",
      updatedAt: now,
    };
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore {
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(records: readonly ExecutionRecord[] = []) {
    for (const record of records) this.records.set(key(record.userId, record.executionId), record);
  }

  create(record: ExecutionRecord) {
    this.records.set(key(record.userId, record.executionId), record);
  }

  update(record: ExecutionRecord) {
    this.records.set(key(record.userId, record.executionId), record);
  }

  loadForUser(userId: string, executionId: string) {
    return this.records.get(key(userId, executionId)) ?? null;
  }
}

function intent() {
  return createExecutionIntent({
    intentId: "intent-okx-production",
    userId: "user-a",
    venue: "okx",
    accountId,
    instrumentId: "DOGE-USDT-PERP",
    positionDirection: "LONG",
    side: "buy",
    quantity: {
      asset: { symbol: "DOGE", type: "DIGITAL_ASSET" },
      quantity: "12.5",
    },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

function cancelRecord(): ExecutionRecord {
  return createExecutionRecord({
    executionId: "execution-okx-default-cancel",
    intentId: "intent-okx-default-cancel",
    executionAttemptId: "intent-okx-default-cancel",
    userId: "user-a",
    venue: "okx",
    accountId,
    instrumentId: "DOGE-USDT-PERP",
    status: "PENDING_CONFIRMATION",
    remoteOrderId: "9001",
    createdAt: now,
    updatedAt: now,
  });
}

function cancelReference(): OkxExecutionOrderReference {
  return {
    executionId: "execution-okx-default-cancel",
    intentId: "intent-okx-default-cancel",
    userId: "user-a",
    accountId,
    instrumentId: "DOGE-USDT-PERP",
    instId: "DOGE-USDT-SWAP",
    ordId: "9001",
    clOrdId: "sxokxproductioncancel0000000001",
    createdAt: now,
    updatedAt: now,
  };
}

function identity(value: string): OkxAccountIdentity {
  return {
    accountId: value,
    accountFingerprint: "provider-account",
    uidHash: "uid-hash",
    accountLevel: "2",
  };
}

function unusedFormalRuntime(): FormalExecutionRuntime {
  return {
    async execute() { throw new Error("unused Binance execute"); },
    async reconcile() { throw new Error("unused Binance reconcile"); },
    async cancel() { throw new Error("unused Binance cancel"); },
  };
}

function key(userId: string, executionId: string) {
  return `${userId}\u0000${executionId}`;
}
