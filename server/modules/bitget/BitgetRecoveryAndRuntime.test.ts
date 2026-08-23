import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BitgetProviderError } from "./BitgetClient";
import { BitgetFormalArbitrageExecutionRuntime } from "./BitgetFormalArbitrageExecutionRuntime";
import { createBitgetExecutionTickerSource } from "./BitgetExecutionMarketData";
import {
  createBitgetExecutionOrderReference,
  createBitgetExecutionOrderRecoveryReference,
  InMemoryBitgetExecutionOrderReferenceStore,
  PersistentBitgetExecutionOrderReferenceStore,
} from "./BitgetExecutionOrderReferenceStore";
import { BitgetIntentExecutionRuntime, type BitgetIntentRuntimeService } from "./BitgetIntentExecutionRuntime";
import { BitgetIntentExecutionServiceRegistry } from "./BitgetIntentExecutionServiceRegistry";
import { BitgetRealTradingTestVenuePreparation } from "./BitgetRealTradingTestVenuePreparation";
import type { BitgetGetOrderRequest, BitgetPlaceOrderRequest, BitgetProviderOrder } from "./BitgetTypes";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import { SqliteExecutionRecordStore, type ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { SqliteExecutionOrderReferenceStore } from "../cex/ExecutionOrderReferenceStore";
import { FormalExecutionRuntimeRegistry, formalExecutionRuntime } from "../arbitrage-execution/FormalExecutionRuntimeRegistry";
import { createTradingRules } from "../cex/TradingRules";
import {
  UnifiedRealTradingTestCommand,
  unifiedRealTradingTestExecutionId,
} from "../cex/UnifiedRealTradingTestCommand";
import { bitgetBaseQuantityToProvider } from "./BitgetQuantitySemantics";

const now = 1_800_000_000_000;

test("Bitget recovery anchor is durable before place and upgrades to exact order identity after restart", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  provider.placeFailure = new Error("response lost after write");
  const first = runtime(provider, records, references);
  const submitted = await first.execute(intent());
  assert.equal(submitted.executionRecord.status, "UNKNOWN");
  assert.equal(provider.placeRequests.length, 1);
  assert.equal((await references.loadRecoveryForUser("user-a", "execution-bitget-1"))?.clientOid, provider.placeRequests[0]?.clientOid);

  provider.placeFailure = undefined;
  provider.status = "CONFIRMED";
  provider.filled = "95";
  const recovered = await runtime(provider, records, references).reconcile("user-a", "execution-bitget-1");
  assert.equal(recovered.executionRecord.status, "CONFIRMED");
  assert.equal(recovered.observation?.filledBaseQuantity, "95");
  assert.equal((await references.loadForUser("user-a", "execution-bitget-1"))?.orderId, "order-1");
  assert.equal(provider.placeRequests.length, 1);
  assert.equal(provider.queryRequests.length, 1);
});

test("Bitget IOC partial-cancel and cancel-with-fill retain authoritative Decimal cumulative fill", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  const adapter = new BitgetFormalArbitrageExecutionRuntime(runtime(provider, records, references));
  const executed = await adapter.execute(intent("DOGE-USDT-SPOT", "buy"));
  assert.equal(executed.executionRecord.status, "PENDING_CONFIRMATION");
  provider.status = "FAILED";
  provider.filled = "94.12345678";
  provider.fee = "0.09412345678";
  provider.feeCurrency = "DOGE";
  const reconciled = await adapter.reconcile("user-a", "execution-bitget-1");
  assert.equal(reconciled.executionRecord.status, "FAILED");
  assert.equal(reconciled.confirmedQuantity, "94.12345678");
  const queried = await runtime(provider, records, references).query("user-a", "execution-bitget-1");
  assert.equal(queried.fee, "0.09412345678");
  assert.equal(queried.feeCurrency, "DOGE");
});

test("Bitget UNKNOWN never invents confirmed quantity", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  const adapter = new BitgetFormalArbitrageExecutionRuntime(runtime(provider, records, references));
  await adapter.execute(intent());
  provider.status = "UNKNOWN";
  provider.filled = "0";
  const result = await adapter.reconcile("user-a", "execution-bitget-1");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.confirmedQuantity, null);
});

test("Bitget recovery keeps a fresh missing order UNKNOWN, then fails it after the settle window", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  provider.placeFailure = new Error("response lost after write");
  assert.equal((await runtime(provider, records, references).execute(intent())).executionRecord.status, "UNKNOWN");

  provider.queryFailure = new BitgetProviderError("provider_rejected", "Order does not exist", "25204");
  const fresh = await runtime(provider, records, references, undefined, () => now + 59_999)
    .reconcile("user-a", "execution-bitget-1");
  assert.equal(fresh.executionRecord.status, "UNKNOWN");
  assert.equal(fresh.executionRecord.executionAttemptId, undefined);

  const settled = await runtime(provider, records, references, undefined, () => now + 60_000)
    .reconcile("user-a", "execution-bitget-1");
  assert.equal(settled.executionRecord.status, "FAILED");
  assert.equal(settled.executionRecord.executionAttemptId, "intent-bitget-1");
  assert.equal(settled.executionRecord.remoteOrderId, undefined);
  assert.equal(settled.observation?.filledBaseQuantity, "0");
  assert.equal(provider.placeRequests.length, 1);
  assert.equal(provider.queryRequests.length, 2);
});

test("Bitget recovery keeps non-not-found Provider failures UNKNOWN", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  provider.placeFailure = new Error("response lost after write");
  await runtime(provider, records, references).execute(intent());
  provider.queryFailure = new BitgetProviderError("provider_transport_error", "Bitget request failed");

  const result = await runtime(provider, records, references, undefined, () => now + 120_000)
    .reconcile("user-a", "execution-bitget-1");
  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(result.executionRecord.executionAttemptId, undefined);
});

test("Bitget deterministic pre-mutation safety rejection is FAILED/0 with no recovery anchor or place", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  const closed = runtime(provider, records, references, new ExecutionMutationSafetyGuard({
    liveTradingEnabled: false, killSwitchActive: true,
    venues: { bitget: { liveTradingEnabled: false, killSwitchActive: true } },
  }));
  const result = await new BitgetFormalArbitrageExecutionRuntime(closed).execute(intent());
  assert.equal(result.executionRecord.status, "FAILED");
  assert.equal(result.confirmedQuantity, "0");
  assert.equal(result.mutationDisposition, "NOT_DISPATCHED");
  assert.equal(provider.placeRequests.length, 0);
  assert.equal(await references.loadRecoveryForUser("user-a", "execution-bitget-1"), null);
});

test("Bitget known-order cancel uses persisted identity and later reconcile preserves fill", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  const active = runtime(provider, records, references);
  await active.execute(intent());
  const cancelled = await active.cancel("user-a", "execution-bitget-1");
  assert.equal(cancelled.observation.state, "CANCEL_REQUESTED");
  assert.equal(provider.cancelCount, 1);
  provider.status = "FAILED";
  provider.filled = "20.5";
  const reconciled = await new BitgetFormalArbitrageExecutionRuntime(active).reconcile("user-a", "execution-bitget-1");
  assert.equal(reconciled.confirmedQuantity, "20.5");
  assert.equal(provider.placeRequests.length, 1);
});

test("Bitget opaque clientOid recovery reference survives SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-bitget-reference-"));
  const dbPath = join(directory, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const generic = new SqliteExecutionOrderReferenceStore({ dbPath });
  try {
    records.create({ executionId: "execution-bitget-1", intentId: "intent-bitget-1", userId: "user-a", venue: "bitget",
      accountId: "bitget:account-a", instrumentId: "DOGE-USDT-PERP", status: "CREATED",
      createdAt: now, updatedAt: now });
    const store = new PersistentBitgetExecutionOrderReferenceStore(generic);
    await store.createRecovery(createBitgetExecutionOrderRecoveryReference({
      executionId: "execution-bitget-1", intentId: "intent-bitget-1", userId: "user-a", accountId: "bitget:account-a",
      instrumentId: "DOGE-USDT-PERP", category: "USDT-FUTURES", symbol: "DOGEUSDT", clientOid: "sxbgpersisted1",
      expectedProviderQuantity: "95", expectedSide: "sell", createdAt: now, updatedAt: now,
    }));
    const reopened = new PersistentBitgetExecutionOrderReferenceStore(generic);
    assert.equal((await reopened.loadRecoveryForUser("user-a", "execution-bitget-1"))?.clientOid, "sxbgpersisted1");
  } finally {
    generic.close(); records.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("Bitget persistent recovery upgrades when the completed reference has a later observation time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-bitget-reference-upgrade-"));
  const dbPath = join(directory, "trading.sqlite");
  const records = new SqliteExecutionRecordStore({ dbPath });
  const generic = new SqliteExecutionOrderReferenceStore({ dbPath });
  try {
    const recovery = createBitgetExecutionOrderRecoveryReference({
      executionId: "execution-bitget-upgrade", intentId: "intent-bitget-upgrade", userId: "user-a",
      accountId: "bitget:account-a", instrumentId: "DOGE-USDT-SPOT", category: "SPOT", symbol: "DOGEUSDT",
      clientOid: "sxbgupgrade1", expectedProviderQuantity: "64.5", expectedSide: "buy",
      createdAt: now, updatedAt: now,
    });
    records.create({
      executionId: recovery.executionId, intentId: recovery.intentId, userId: recovery.userId, venue: "bitget",
      accountId: recovery.accountId, instrumentId: recovery.instrumentId, status: "CREATED",
      createdAt: recovery.createdAt, updatedAt: recovery.updatedAt,
    });
    const store = new PersistentBitgetExecutionOrderReferenceStore(generic);
    await store.createRecovery(recovery);
    await store.create(createBitgetExecutionOrderReference({
      ...recovery, orderId: "1475522063476211712", updatedAt: now + 1_000,
    }));
    assert.equal((await store.loadRecoveryForUser("user-a", recovery.executionId)), null);
    assert.equal((await store.loadForUser("user-a", recovery.executionId))?.orderId, "1475522063476211712");
  } finally {
    generic.close(); records.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("Bitget recovery upgrade rejects a completed reference with an earlier observation time", () => {
  const store = new InMemoryBitgetExecutionOrderReferenceStore();
  const recovery = createBitgetExecutionOrderRecoveryReference({
    executionId: "execution-bitget-stale", intentId: "intent-bitget-stale", userId: "user-a",
    accountId: "bitget:account-a", instrumentId: "DOGE-USDT-SPOT", category: "SPOT", symbol: "DOGEUSDT",
    clientOid: "sxbgstale1", expectedProviderQuantity: "64.5", expectedSide: "buy",
    createdAt: now, updatedAt: now + 1_000,
  });
  store.createRecovery(recovery);
  assert.throws(() => store.create(createBitgetExecutionOrderReference({
    ...recovery, orderId: "1475522063476211712", updatedAt: now,
  })), /predates its recovery reference/u);
});

test("Bitget HEDGE recovery persists the resolved posSide bucket", () => {
  const store = new InMemoryBitgetExecutionOrderReferenceStore();
  const recovery = createBitgetExecutionOrderRecoveryReference({
    executionId: "execution-bitget-hedge", intentId: "intent-bitget-hedge", userId: "user-a", accountId: "bitget:account-a",
    instrumentId: "DOGE-USDT-PERP", category: "USDT-FUTURES", symbol: "DOGEUSDT", clientOid: "sxbghedgerecovery",
    expectedProviderQuantity: "10", expectedSide: "buy", createdAt: now, updatedAt: now,
    positionMode: "HEDGE", positionDirection: "LONG", posSide: "long",
  });
  store.createRecovery(recovery);
  assert.equal(store.loadRecoveryForUser("user-a", recovery.executionId)?.posSide, "long");
});

test("Bitget duplicate execution identity is rejected before a second place", async () => {
  const provider = new FakeBitgetRuntimeService();
  const records = new MemoryExecutionRecordStore();
  const references = new InMemoryBitgetExecutionOrderReferenceStore();
  const active = runtime(provider, records, references);
  await active.execute(intent());
  await assert.rejects(() => active.execute(intent()), /duplicate execution/u);
  assert.equal(provider.placeRequests.length, 1);
});

test("Bitget production-equivalent registry is lazy and resolves the formal runtime", () => {
  let secretReads = 0;
  const services = new BitgetIntentExecutionServiceRegistry({
    findSummary: () => ({ accountId: "bitget:account-a", permissions: {
      executionEnabled: true, providerVerified: true, positionModeSupported: true,
    } }) as never,
    loadForExecution: async () => { secretReads += 1; return { apiKey: "key", apiSecret: "secret", passphrase: "pass" }; },
  });
  const formal = new BitgetFormalArbitrageExecutionRuntime(new BitgetIntentExecutionRuntime(
    services, new MemoryExecutionRecordStore(), new InMemoryBitgetExecutionOrderReferenceStore(),
    { quantityRulesSource: rules, limitPriceResolver: async () => "0.085" },
  ));
  const registry = new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("bitget", formal));
  assert.equal(registry.resolve("bitget"), formal);
  assert.equal(secretReads, 0);
});

test("Bitget execution service registry validates persisted readiness and Provider UID identity", async () => {
  let identityReads = 0;
  const registry = new BitgetIntentExecutionServiceRegistry({
    findSummary: () => ({ accountId: "bitget:account-a", permissions: {
      executionEnabled: true, providerVerified: true, positionModeSupported: true,
    } }) as never,
    loadForExecution: async () => ({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }),
  }, { clientFactory: () => ({
    assertOneWayMode: async () => undefined,
    placeOrder: async (request) => ({ category: request.category, symbol: request.symbol, orderId: "1", clientOid: request.clientOid }),
    getOrder: async () => { throw new Error("not used"); },
    cancelOrder: async (request) => ({ category: request.category, symbol: request.symbol, orderId: request.orderId ?? "1", clientOid: request.clientOid }),
    getAccountIdentity: async () => { identityReads += 1; return { accountId: "bitget:account-a", accountFingerprint: "a", uidHash: "b" }; },
  }) });
  await registry.run("user-a", async (service) => service.validateExecutionProviderIdentity({
    venue: "bitget", operation: "placeOrder", userId: "user-a", accountId: "bitget:account-a",
    instrumentId: "DOGE-USDT-PERP", providerInstrumentId: "DOGEUSDT",
  }));
  assert.equal(identityReads, 1);
});

test("Bitget execution ticker reads exact UTA category/symbol and preserves Decimal bid/ask", async () => {
  let requested = "";
  const source = createBitgetExecutionTickerSource({ baseUrl: "https://bitget.test", clock: () => now,
    fetchImpl: (async (input) => { requested = String(input); return Response.json({ code: "00000", data: [{
      category: "SPOT", symbol: "DOGEUSDT", bid1Price: "0.08400001", ask1Price: "0.08400002",
    }] }); }) as typeof fetch });
  const ticker = await source("SPOT", "DOGEUSDT");
  assert.equal(ticker.bid, "0.08400001");
  assert.equal(ticker.ask, "0.08400002");
  assert.equal(requested, "https://bitget.test/api/v3/market/tickers?category=SPOT&symbol=DOGEUSDT");
});

test("Bitget Unified real-trading preparation plans through the shared quantity planner with zero mutation", async () => {
  const preparation = new BitgetRealTradingTestVenuePreparation({
    findSummary: () => ({ accountId: "bitget:account-a", permissions: {
      executionEnabled: true, providerVerified: true, positionModeSupported: true,
    } }) as never,
  }, {
    now: () => now,
    tradingRules: { getTradingRules: async () => createTradingRules({
      quantityStep: "1", minQuantity: "1", minNotional: "5", priceTick: "0.0001", precision: {},
    }) },
    tickerSource: async (category, symbol) => ({ category, symbol, bid: "0.084", ask: "0.085", fetchedAt: now }),
  });
  const result = await preparation.prepare({ userId: "user-a", venue: "bitget", instrumentId: "DOGE-USDT-SPOT",
    side: "buy", quantityInput: { mode: "ASSET_QUANTITY", quantity: "95" }, reduceOnly: false,
    executionMode: "EXECUTION_PRIORITY" });
  assert.equal(result.accountId, "bitget:account-a");
  assert.equal(result.quantityPlan.plannedAssetQuantity.quantity, "95");
  assert.equal(result.quantityPlan.estimatedNotionalUsdt, "8.075");
});

test("Bitget Unified PREVIEW covers Spot/Perp directions and reduceOnly without resolving mutation runtime", async (t) => {
  let runtimeCalls = 0;
  const previewRuntime = {
    execute: async () => { runtimeCalls += 1; throw new Error("PREVIEW must not execute."); },
    reconcile: async () => { runtimeCalls += 1; throw new Error("PREVIEW must not reconcile."); },
    cancel: async () => { runtimeCalls += 1; throw new Error("PREVIEW must not cancel."); },
  };
  const preparation = new BitgetRealTradingTestVenuePreparation({
    findSummary: () => ({ accountId: "bitget:account-a", permissions: {
      executionEnabled: true, providerVerified: true, positionModeSupported: true,
    } }) as never,
  }, {
    now: () => now,
    tradingRules: { getTradingRules: async () => createTradingRules({
      quantityStep: "1", minQuantity: "1", minNotional: "5", priceTick: "0.0001", precision: {},
    }) },
    tickerSource: async (category, symbol) => ({ category, symbol, bid: "0.084", ask: "0.085", fetchedAt: now }),
  });
  const command = new UnifiedRealTradingTestCommand(
    new FormalExecutionRuntimeRegistry().register(formalExecutionRuntime("bitget", previewRuntime)),
    { findByIntentId: async () => [] }, [preparation], { now: () => now },
  );
  for (const scenario of [
    { name: "spot-buy", instrumentId: "DOGE-USDT-SPOT", side: "buy" as const, reduceOnly: false },
    { name: "spot-sell", instrumentId: "DOGE-USDT-SPOT", side: "sell" as const, reduceOnly: false },
    { name: "perp-buy", instrumentId: "DOGE-USDT-PERP", side: "buy" as const, reduceOnly: false },
    { name: "perp-sell", instrumentId: "DOGE-USDT-PERP", side: "sell" as const, reduceOnly: false },
    { name: "perp-reduce-only", instrumentId: "DOGE-USDT-PERP", side: "buy" as const, reduceOnly: true },
  ]) await t.test(scenario.name, async () => {
    const result = await command.run({
      requestId: `bitget-preview-${scenario.name}`, userId: "user-a", venue: "bitget",
      instrumentId: scenario.instrumentId, side: scenario.side,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: "95" }, reduceOnly: scenario.reduceOnly,
      executionMode: "EXECUTION_PRIORITY", executeLive: false,
    });
    assert.equal(result.action, "PREVIEW");
    assert.equal(result.runtimeResult, null);
    assert.equal(result.intent.quantity.quantity, "95");
    assert.equal(result.intent.orderConstraints.reduceOnly, scenario.reduceOnly);
    assert.match(unifiedRealTradingTestExecutionId(result.intent), /^real-test-execution-/u);
  });
  assert.equal(bitgetBaseQuantityToProvider("95", {
    category: "SPOT", symbol: "DOGEUSDT", status: "online", baseCoin: "DOGE", quoteCoin: "USDT",
    quantityStep: "1", minOrderQty: "1", minNotional: "5",
    contractSize: "1", quantityUnit: "base", fetchedAt: now,
  }), "95");
  assert.equal(bitgetBaseQuantityToProvider("95", {
    category: "USDT-FUTURES", symbol: "DOGEUSDT", status: "online", baseCoin: "DOGE", quoteCoin: "USDT",
    quantityStep: "1", minOrderQty: "1", minNotional: "5",
    contractSize: "1", quantityUnit: "base", fetchedAt: now,
  }), "95");
  assert.equal(runtimeCalls, 0);
});

function runtime(
  provider: FakeBitgetRuntimeService,
  records: ExecutionRecordStore,
  references: InMemoryBitgetExecutionOrderReferenceStore,
  guard = new ExecutionMutationSafetyGuard({ liveTradingEnabled: false, killSwitchActive: true,
    venues: { bitget: { liveTradingEnabled: true, killSwitchActive: false } } }),
  clock: () => number = () => now,
) {
  return new BitgetIntentExecutionRuntime(
    { run: async (_userId, operation) => operation(provider) }, records, references,
    { createExecutionId: () => "execution-bitget-1", clock,
      mutationSafetyGuard: guard, quantityRulesSource: rules,
      limitPriceResolver: async () => "0.085" },
  );
}

function intent(instrumentId = "DOGE-USDT-PERP", side: "buy" | "sell" = "sell"): ExecutionIntent {
  return createExecutionIntent({ intentId: "intent-bitget-1", userId: "user-a", venue: "bitget",
    accountId: "bitget:account-a", instrumentId, side,
    ...(instrumentId.endsWith("-PERP") ? { positionDirection: side === "buy" ? "LONG" as const : "SHORT" as const } : {}),
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity: "95" },
    orderConstraints: { reduceOnly: false }, executionMode: "EXECUTION_PRIORITY",
    createdAt: now, expiresAt: now + 60_000 });
}
const rules = async (category: "SPOT" | "USDT-FUTURES", symbol: string) => ({
  category, symbol, status: "online", baseCoin: "DOGE", quoteCoin: "USDT", quantityStep: "0.00000001",
  minOrderQty: "0.00000001", minNotional: "1", contractSize: "1", quantityUnit: "base" as const, fetchedAt: now,
});

class FakeBitgetRuntimeService implements BitgetIntentRuntimeService {
  placeRequests: BitgetPlaceOrderRequest[] = [];
  queryRequests: BitgetGetOrderRequest[] = [];
  cancelCount = 0;
  placeFailure?: Error;
  queryFailure?: Error;
  status: BitgetProviderOrder["status"] = "PENDING_CONFIRMATION";
  filled = "0";
  fee = "0";
  feeCurrency: string | null = null;
  private placed?: BitgetPlaceOrderRequest;
  executionAccountIdentity() { return { accountId: "bitget:account-a" }; }
  validateExecutionProviderIdentity() {}
  async assertOneWayMode() {}
  async placeOrder(request: BitgetPlaceOrderRequest) {
    this.placeRequests.push(request); this.placed = request;
    if (this.placeFailure) throw this.placeFailure;
    return { category: request.category, symbol: request.symbol, orderId: "order-1", clientOid: request.clientOid };
  }
  async getOrder(request: BitgetGetOrderRequest): Promise<BitgetProviderOrder> {
    this.queryRequests.push(request);
    if (this.queryFailure) throw this.queryFailure;
    const placed = this.placed;
    if (!placed) throw new Error("No fake Bitget order exists.");
    return { category: placed.category, symbol: placed.symbol, orderId: "order-1", clientOid: placed.clientOid,
      side: placed.side, status: this.status, rawStatus: this.status, requestedQuantity: placed.qty,
      filledQuantity: this.filled, averagePrice: this.filled === "0" ? null : "0.085",
      fee: this.fee, feeCurrency: this.feeCurrency, updatedAt: now };
  }
  async cancelOrder(request: BitgetGetOrderRequest) {
    this.cancelCount += 1;
    return { category: request.category, symbol: request.symbol, orderId: request.orderId ?? "order-1", clientOid: request.clientOid };
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore {
  private readonly records = new Map<string, ExecutionRecord>();
  create(record: ExecutionRecord) { if (this.records.has(record.executionId)) throw new Error("duplicate execution"); this.records.set(record.executionId, record); }
  update(record: ExecutionRecord) { if (!this.records.has(record.executionId)) throw new Error("missing execution"); this.records.set(record.executionId, record); }
  loadForUser(userId: string, executionId: string) { const record = this.records.get(executionId); return record?.userId === userId ? record : null; }
}
