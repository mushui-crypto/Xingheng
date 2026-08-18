import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArbitrageExecutionCommandService } from "../arbitrage-execution/ArbitrageExecutionCommandService";
import type { ArbitrageExecutionDraft } from "../arbitrage-execution/ArbitrageExecutionDraft";
import type { FormalExecutionRuntime } from "../arbitrage-execution/FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistry,
  formalExecutionRuntime,
} from "../arbitrage-execution/FormalExecutionRuntimeRegistry";
import { createAsset } from "../cex/Asset";
import { ExecutionMutationSafetyGuard } from "../cex/ExecutionMutationSafetyGuard";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { createExecutionRecord, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordRecoveryStore, ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { InMemoryOkxExecutionOrderReferenceStore } from "../okx/OkxExecutionOrderReferenceStore";
import { OkxFormalArbitrageExecutionRuntime } from "../okx/OkxFormalArbitrageExecutionRuntime";
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
import { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import { registerArbitrageExecutionCommandRoutes } from "./arbitrageExecutionCommandRoutes";
import { registerFundingArbitrageRoutes } from "./fundingArbitrageRoutes";

const now = 1_800_000_000_000;
const okxAccountId = "okx:production-composition-account";
const productionSource = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
const productionEnvironment = readFileSync(
  new URL("../../../.env.production.example", import.meta.url),
  "utf8",
);

test("production composition exposes only the formal arbitrage mutation boundary", () => {
  assert.doesNotMatch(productionSource, /FundingArbitrageManualExecutionService/u);
  assert.doesNotMatch(productionSource, /ManualRequestFundingArbitrageExecutionIntentSource/u);
  assert.doesNotMatch(productionSource, /registerFundingArbitrageManualExecutionRoutes/u);
  assert.doesNotMatch(productionSource, /FundingLegExecutionLinkStore/u);
  assert.doesNotMatch(productionSource, /\/api\/funding-arbitrage\/executions\/manual/u);

  assert.match(productionSource, /new ArbitrageExecutionCommandService\(/u);
  assert.match(productionSource, /new FormalExecutionRuntimeRegistry\(\)/u);
  assert.match(
    productionSource,
    /\.register\(formalExecutionRuntime\("binance", binanceFormalArbitrageExecutionRuntime\)\)/u,
  );
  assert.match(
    productionSource,
    /\.register\(formalExecutionRuntime\("okx", okxFormalArbitrageExecutionRuntime\)\)/u,
  );
  assert.match(productionSource, /new OkxIntentExecutionServiceRegistry\(userExchangeCredentials\)/u);
  assert.match(productionSource, /new OkxIntentExecutionRuntime\(/u);
  assert.match(productionSource, /new OkxFormalArbitrageExecutionRuntime\(okxExecutionRuntime\)/u);
  assert.match(productionSource, /createOkxInstrumentQuantityRulesSource\(\)/u);
  assert.match(productionSource, /createOkxSpotInstrumentQuantityRulesSource\(\)/u);
  assert.match(
    productionSource,
    /new PersistentOkxExecutionOrderReferenceStore\(executionOrderReferenceStore\)/u,
  );
  assert.match(productionSource, /executionRecordStore,/u);
  assert.doesNotMatch(productionSource, /new OkxClient|\.placeOrder\(|\.cancelOrder\(/u);
  assert.match(
    productionSource,
    /new ArbitrageExecutionDraftService\([\s\S]*?formalExecutionRuntimes,\s*\)/u,
  );
  assert.equal(productionSource.match(/formalExecutionRuntimes,/gu)?.length, 4);
  assert.match(
    productionSource,
    /registerArbitrageExecutionCommandRoutes\(app, arbitrageExecutionCommand\)/u,
  );
  assert.match(productionSource, /registerFundingArbitrageRoutes\(app, fundingOpportunityQuery\)/u);
});

test("production configuration keeps the registered OKX runtime dormant", () => {
  assert.match(productionEnvironment, /^OKX_LIVE_TRADING_ENABLED=false$/mu);
  assert.match(productionEnvironment, /^OKX_KILL_SWITCH=true$/mu);
  assert.match(productionEnvironment, /^LIVE_TRADING_ENABLED=false$/mu);
  assert.match(productionEnvironment, /^BINANCE_KILL_SWITCH=true$/mu);
  assert.equal(productionEnvironment.match(/^OKX_LIVE_TRADING_ENABLED=/gmu)?.length, 1);
  assert.equal(productionEnvironment.match(/^OKX_KILL_SWITCH=/gmu)?.length, 1);
});

test("production-equivalent OKX Formal Runtime selects Spot and Perpetual capabilities", async () => {
  const fixture = okxRuntimeFixture(openOkxGuard());
  const binance = new SentinelFormalRuntime();
  const runtimes = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", binance))
    .register(formalExecutionRuntime("okx", fixture.formalRuntime));

  const spot = await runtimes.resolve("okx").execute(okxIntent("DOGE-USDT-SPOT", "buy", "100"));
  const perpetual = await runtimes.resolve("okx").execute(okxIntent("DOGE-USDT-PERP", "sell", "100"));

  assert.equal(spot.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(perpetual.executionRecord.status, "PENDING_CONFIRMATION");
  assert.deepEqual(fixture.provider.placeRequests, [
    {
      instId: "DOGE-USDT",
      tdMode: "cash",
      side: "buy",
      ordType: "market",
      quantity: "100",
      clOrdId: fixture.provider.placeRequests[0]?.clOrdId,
      targetCurrency: "base_ccy",
    },
    {
      instId: "DOGE-USDT-SWAP",
      tdMode: "cross",
      side: "sell",
      ordType: "market",
      quantity: "1000",
      clOrdId: fixture.provider.placeRequests[1]?.clOrdId,
      reduceOnly: false,
    },
  ]);
  assert.equal(fixture.provider.identityReads, 2);
  assert.equal(binance.executeCalls, 0);
});

test("production-equivalent OKX Spot mutation remains behind Mutation Safety Guard", async () => {
  const fixture = okxRuntimeFixture(new ExecutionMutationSafetyGuard({
    liveTradingEnabled: false,
    killSwitchActive: true,
  }));

  const result = await fixture.formalRuntime.execute(okxIntent("DOGE-USDT-SPOT", "buy", "100"));

  assert.equal(result.executionRecord.status, "UNKNOWN");
  assert.equal(fixture.provider.identityReads, 0);
  assert.equal(fixture.provider.placeRequests.length, 0);
});

test("Funding Command sends an OKX Spot leg through the registered OKX Formal Runtime", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "funding-production-composition-"));
  const instances = new ArbitrageInstanceStore({ dbPath: join(directory, "instances.sqlite") });
  context.after(() => {
    instances.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const fixture = okxRuntimeFixture(openOkxGuard());
  const binance = new SentinelFormalRuntime();
  let okxFormalCalls = 0;
  const trackedOkx: FormalExecutionRuntime = {
    execute: async (intent) => {
      okxFormalCalls += 1;
      return fixture.formalRuntime.execute(intent);
    },
    reconcile: (userId, executionId) => fixture.formalRuntime.reconcile(userId, executionId),
    cancel: (userId, executionId) => fixture.formalRuntime.cancel(userId, executionId),
  };
  const runtimes = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", binance))
    .register(formalExecutionRuntime("okx", trackedOkx));
  const draft = okxFundingDraft();
  const command = new ArbitrageExecutionCommandService(
    { preview: async () => draft, createDraft: async () => draft },
    instances,
    fixture.credentials,
    fixture.records,
    runtimes,
    {
      contexts: { load: async () => { throw new Error("not used by the first leg"); } },
      spotAttributions: {},
    },
    { clock: () => now, intentTtlMs: 30_000 },
  );
  const request = fundingConfirmationRequest();
  const confirmed = await command.confirm("user-a", request);

  const executed = await command.executeLeg("user-a", {
    ...request,
    arbitrageId: confirmed.instance.arbitrageId,
    legId: "okx-spot-leg",
    commandId: "okx-spot-command",
  });

  assert.equal(okxFormalCalls, 1);
  assert.equal(executed.executionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(executed.secondLegAllowed, false);
  assert.equal(fixture.provider.placeRequests.length, 1);
  assert.equal(fixture.provider.placeRequests[0]?.instId, "DOGE-USDT");
  assert.equal(fixture.provider.placeRequests[0]?.tdMode, "cash");
  assert.equal(fixture.provider.identityReads, 1);
  assert.equal(binance.executeCalls, 0);
});

test("the removed manual endpoint cannot call a mutation while read-only funding and formal routes remain", async () => {
  const routes = new Map<string, (request: any, response: any) => Promise<void>>();
  const app = {
    get(path: string, handler: (request: any, response: any) => Promise<void>) {
      routes.set(`GET ${path}`, handler);
    },
    post(path: string, handler: (request: any, response: any) => Promise<void>) {
      routes.set(`POST ${path}`, handler);
    },
  };
  let fundingReads = 0;
  let formalCalls = 0;
  let providerMutations = 0;
  registerFundingArbitrageRoutes(app as never, {
    async list() {
      fundingReads += 1;
      return { generatedAt: 1_900_000_000_000, opportunities: [] };
    },
  } as never);
  registerArbitrageExecutionCommandRoutes(app as never, {
    async confirm() {
      formalCalls += 1;
      return { instance: { arbitrageId: "arbitrage-1" }, created: true } as never;
    },
    async executeLeg() {
      providerMutations += 1;
      throw new Error("provider mutation is forbidden in this composition test");
    },
    async reconcileLeg() {
      throw new Error("reconciliation is not expected in this composition test");
    },
  });

  assert.equal(routes.has("POST /api/funding-arbitrage/executions/manual"), false);
  assert.equal(formalCalls, 0);
  assert.equal(providerMutations, 0);

  const opportunityResponse = response();
  await routes.get("GET /api/funding-arbitrage/opportunities")!({ query: {} }, opportunityResponse);
  assert.equal(opportunityResponse.statusCode, 200);
  assert.equal(fundingReads, 1);

  const formalResponse = response();
  await routes.get("POST /api/arbitrage-execution/confirm")!(
    { user: { id: "user-a" }, body: { opportunityId: "opportunity-1", confirmed: true } },
    formalResponse,
  );
  assert.equal(formalResponse.statusCode, 200);
  assert.equal(formalCalls, 1);
  assert.equal(providerMutations, 0);
});

test("legacy manual service and route stay explicitly production-not-wired", () => {
  const service = readFileSync(new URL("./FundingArbitrageManualExecutionService.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("./fundingArbitrageManualExecutionRoutes.ts", import.meta.url), "utf8");
  assert.match(service, /PRODUCTION_NOT_WIRED/u);
  assert.match(route, /PRODUCTION_NOT_WIRED/u);
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
  };
}

function okxRuntimeFixture(mutationSafetyGuard: ExecutionMutationSafetyGuard) {
  const provider = new FakeOkxProvider();
  const credentials = new OkxCredentialFixture();
  const records = new MemoryExecutionRecordStore();
  let executionSequence = 0;
  const runtime = new OkxIntentExecutionRuntime(
    new OkxIntentExecutionServiceRegistry(credentials, { clientFactory: () => provider }),
    records,
    new InMemoryOkxExecutionOrderReferenceStore(),
    {
      createExecutionId: () => `production-composition-execution-${++executionSequence}`,
      clock: () => now,
      quantityRulesSource: okxTestQuantityRulesSource(now),
      spotQuantityRulesSource: async () => ({
        instType: "SPOT",
        instId: "DOGE-USDT",
        baseCcy: "DOGE",
        quoteCcy: "USDT",
        lotSz: "0.1",
        minSz: "1",
        tickSz: "0.00001",
        state: "live",
        fetchedAt: now,
      }),
      mutationSafetyGuard,
    },
  );
  return Object.freeze({
    provider,
    credentials,
    records,
    formalRuntime: new OkxFormalArbitrageExecutionRuntime(runtime),
  });
}

function openOkxGuard() {
  return new ExecutionMutationSafetyGuard({ liveTradingEnabled: true, killSwitchActive: false });
}

function okxIntent(
  instrumentId: "DOGE-USDT-SPOT" | "DOGE-USDT-PERP",
  side: "buy" | "sell",
  quantity: string,
) {
  return createExecutionIntent({
    intentId: `production-composition-${instrumentId.toLowerCase()}`,
    userId: "user-a",
    venue: "okx",
    accountId: okxAccountId,
    instrumentId,
    side,
    quantity: { asset: { symbol: "DOGE", type: "DIGITAL_ASSET" }, quantity },
    orderConstraints: { reduceOnly: false },
    executionMode: "EXECUTION_PRIORITY",
    createdAt: now,
    expiresAt: now + 30_000,
  });
}

class OkxCredentialFixture {
  findSummary(userId: string, venue: string) {
    if (userId !== "user-a" || venue !== "okx") return null;
    return {
      userId,
      venue: "okx" as const,
      accountId: okxAccountId,
      accountFingerprint: "production-composition-fingerprint",
      maskedApiKey: "okx-...-test",
      environment: "test" as const,
      permissions: {
        executionEnabled: true,
        providerVerified: true,
        read: true,
        contractTrade: true,
        withdraw: false,
        ipRestricted: true,
        accountLevelSupported: true,
        positionModeSupported: true,
      },
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async loadForExecution(userId: string, venue: string) {
    if (userId !== "user-a" || venue !== "okx") throw new Error("unexpected credential lookup");
    return { apiKey: "fake-api-key", apiSecret: "fake-api-secret", passphrase: "fake-passphrase" };
  }
}

class FakeOkxProvider {
  readonly placeRequests: OkxPlaceOrderRequest[] = [];
  identityReads = 0;

  async getAccountIdentity(): Promise<OkxAccountIdentity> {
    this.identityReads += 1;
    return {
      accountId: okxAccountId,
      accountFingerprint: "production-composition-fingerprint",
      uidHash: "production-composition-uid-hash",
      accountLevel: "2",
    };
  }

  async placeOrder(request: OkxPlaceOrderRequest): Promise<OkxCancelOrderResult> {
    this.placeRequests.push(request);
    return { instId: request.instId, ordId: String(9_000 + this.placeRequests.length), clOrdId: request.clOrdId };
  }

  async getOrder(request: OkxGetOrderRequest): Promise<OkxProviderOrder> {
    return {
      instId: request.instId,
      ordId: request.ordId ?? "9001",
      clOrdId: request.clOrdId ?? "productioncompositionorder",
      side: "buy",
      status: "PENDING_CONFIRMATION",
      statusReason: null,
      rawState: "live",
      requestedQuantity: "100",
      filledQuantity: "0",
      averagePrice: null,
      fee: "0",
      feeCcy: null,
      updatedAt: now,
    };
  }

  async cancelOrder(request: OkxCancelOrderRequest): Promise<OkxCancelOrderResult> {
    return { instId: request.instId, ordId: request.ordId ?? "9001", clOrdId: request.clOrdId ?? "productioncompositionorder" };
  }
}

class MemoryExecutionRecordStore implements ExecutionRecordStore, ExecutionRecordRecoveryStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord) {
    const normalized = createExecutionRecord(record);
    this.records.set(normalized.executionId, normalized);
  }

  update(record: ExecutionRecord) {
    const normalized = createExecutionRecord(record);
    this.records.set(normalized.executionId, normalized);
  }

  loadForUser(userId: string, executionId: string) {
    const record = this.records.get(executionId);
    return record?.userId === userId ? record : null;
  }

  findByIntentId(intentId: string) {
    return [...this.records.values()].filter((record) => record.intentId === intentId);
  }
}

class SentinelFormalRuntime implements FormalExecutionRuntime {
  executeCalls = 0;

  async execute(intent: ExecutionIntent) {
    this.executeCalls += 1;
    return {
      executionRecord: createExecutionRecord({
        executionId: `binance-${intent.intentId}`,
        intentId: intent.intentId,
        userId: intent.userId,
        venue: intent.venue,
        accountId: intent.accountId,
        instrumentId: intent.instrumentId,
        status: "PENDING_CONFIRMATION",
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
      }),
      confirmedQuantity: "0",
    };
  }

  reconcile(): ReturnType<FormalExecutionRuntime["reconcile"]> {
    throw new Error("sentinel Binance reconcile was not expected");
  }

  cancel(): ReturnType<FormalExecutionRuntime["cancel"]> {
    throw new Error("sentinel Binance cancel was not expected");
  }
}

function okxFundingDraft(): ArbitrageExecutionDraft {
  const leg = (
    legId: string,
    role: "LONG" | "SHORT",
    instrumentId: "DOGE-USDT-SPOT" | "DOGE-USDT-PERP",
  ) => ({
    legId,
    role,
    venue: "okx" as const,
    instrumentId,
    providerSymbol: instrumentId.endsWith("SPOT") ? "DOGE-USDT" : "DOGE-USDT-SWAP",
    side: role === "LONG" ? "buy" as const : "sell" as const,
    marketType: instrumentId.endsWith("SPOT") ? "spot" as const : "perpetual" as const,
    quote: { bid: "0.1", ask: "0.1", updatedAt: now },
    tradingRules: {
      quantityStep: "0.1",
      minQuantity: "1",
      priceTick: "0.00001",
      minNotional: "5",
      precision: {},
    },
    capability: { status: "AVAILABLE" as const, reasonCode: "AVAILABLE" as const },
    planning: {
      status: "PLANNED" as const,
      plan: {
        instrumentId,
        providerSymbol: instrumentId.endsWith("SPOT") ? "DOGE-USDT" : "DOGE-USDT-SWAP",
        baseAsset: "DOGE",
        quantityInput: { mode: "ASSET_QUANTITY" as const, quantity: "100" },
        sizingPrice: "0.1",
        plannedAssetQuantity: { asset: createAsset({ symbol: "DOGE", type: "DIGITAL_ASSET" }), quantity: "100" },
        estimatedNotionalUsdt: "10",
        generatedAt: now,
      },
    },
    executionAvailable: true,
  });
  return {
    opportunityId: "okx-spot-perp-opportunity",
    sourceIdentity: `arbitrage-dashboard:okx-spot-perp-opportunity:${now}`,
    sourceSnapshotGeneratedAt: now,
    horizonDays: 90,
    strategyType: "SPOT_PERPETUAL",
    quantityInput: { mode: "ASSET_QUANTITY", quantity: "100" },
    legs: [
      leg("okx-spot-leg", "LONG", "DOGE-USDT-SPOT"),
      leg("okx-perpetual-leg", "SHORT", "DOGE-USDT-PERP"),
    ],
    allLegsExecutable: true,
    generatedAt: now,
  };
}

function fundingConfirmationRequest() {
  return {
    confirmationId: "okx-production-composition-confirmation",
    opportunityId: "okx-spot-perp-opportunity",
    horizonDays: 90,
    quantityInput: { mode: "ASSET_QUANTITY" as const, quantity: "100" },
    executionMode: "EXECUTION_PRIORITY" as const,
    confirmed: true as const,
  };
}
