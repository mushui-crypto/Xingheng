import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SpotPerpetualFundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { BinanceCapitalTestExecutionContext } from "./BinanceCapitalTestPreflight";
import { executeBinanceCapitalTest } from "./BinanceCapitalTestRuntime";
import type { BoundBinanceExecutionService } from "./BinanceExecutionCapability";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinanceStoredOrder } from "./BinanceOrderStore";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { snapshotFixture } from "./binanceTestFixtures";

const now = 1_800_000_000_000;
const context: BinanceCapitalTestExecutionContext = {
  userId: "capital-test-user",
  accountId: "binance:capital-test",
  venue: "binance",
};

test("confirmed HEDGED execution exits through the bound service and confirms flat", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  const runtime = runtimeFor(service);

  const result = await runtime.execute(context, intentFixture());

  assert.deepEqual(result.preflight, { status: "PASS" });
  assert.equal(result.executionState?.status, "HEDGED");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0");
  assert.equal(result.residualExit?.status, "EXITED");
  assert.equal(result.residualExit?.status === "EXITED" ? result.residualExit.message : null,
    "Capital Test closed successfully");
  assert.equal(service.exitInputs.length, 1);
  assert.equal(service.spotExposure, 0);
  assert.equal(service.perpetualExposure, 0);
  assert.equal(service.placeInputs.length, 2);
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts.every((attempt) => /^funding-arbitrage-attempt:0:/u.test(attempt.executionAttemptId)));
});

test("equal confirmed quantities with an OPEN leg do not become HEDGED or trigger exit", async () => {
  const service = new RuntimeBinanceService(["Filled", "PartiallyFilled"]);
  service.filledQuantities = [0.01, 0.01];

  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "EXECUTING");
  assert.equal(result.executionState?.legs[1].remoteObservation, "OPEN");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0");
  assert.equal(result.residualExit, null);
  assert.equal(service.exitInputs.length, 0);
});

test("HEDGED exit requires zero open orders before reporting a successful closure", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  service.openSpotOrdersAfterExit = 1;
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "HEDGED");
  assert.equal(result.residualExit?.status, "FAILED");
  assert.match(result.residualExit?.reason ?? "", /zero open orders/u);
});

test("HEDGED exit failure is explicit and cannot report a successful closure", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  service.exitError = new Error("fixture hedged exit failed");
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "HEDGED");
  assert.equal(result.residualExit?.status, "FAILED");
  assert.match(result.residualExit?.reason ?? "", /hedged exit failed/u);
  assert.equal(service.spotExposure, 0.01);
  assert.equal(service.perpetualExposure, 0.01);
});

test("a second-leg price jump cannot exceed the 40 USD mutation-time capital limit", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  service.perpetualExecutionPriceAfterFirstLeg = 3_500;
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(service.placeInputs.length, 1);
  assert.equal(result.executionState?.status, "RESIDUAL");
  assert.equal(result.residualExit?.status, "EXITED");
  assert.equal(service.spotExposure, 0);
  assert.equal(service.perpetualExposure, 0);
});

test("both attempt identities exist before the first mutation", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  const runtime = runtimeFor(service);

  const result = await runtime.execute(context, intentFixture());

  assert.equal(result.attempts.length, 2);
  assert.equal(service.placeInputs.length, 2);
  assert.match(String(service.placeInputs[0]?.idempotencyKey), /^funding-arbitrage:/u);
  const source = readFileSync(new URL("./BinanceCapitalTestRuntime.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("const attempts = intent.legs.map") < source.indexOf("for (const [index, leg]"));
});

test("repeated execution of the same intent preserves attempt and idempotency identities", async () => {
  const service = new RuntimeBinanceService(["Rejected", "Rejected"]);
  const runtime = runtimeFor(service);
  const intent = intentFixture();

  const first = await runtime.execute(context, intent);
  const second = await runtime.execute(context, intent);

  assert.deepEqual(second.attempts, first.attempts);
  assert.equal(service.placeInputs.length, 2);
  assert.equal(service.placeInputs[0]?.idempotencyKey, service.placeInputs[1]?.idempotencyKey);
});

test("UNKNOWN enters reconciliation and only confirmed observation completes the hedge", async () => {
  const service = new RuntimeBinanceService(["Filled", "Unknown"]);
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(service.reconciliationCalls, 1);
  assert.equal(result.executionState?.status, "HEDGED");
  assert.equal(result.executionState?.legs[1].remoteObservation, "FILLED");
  assert.notEqual(result.executionState?.status, "FAILED");
});

test("unresolved UNKNOWN remains PENDING_RECONCILIATION and preserves residual exposure", async () => {
  const service = new RuntimeBinanceService(["Filled", "Unknown"], undefined, false);
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "PENDING_RECONCILIATION");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0.01");
  assert.notEqual(result.executionState?.status, "FAILED");
  assert.equal(result.residualExit, null);
  assert.equal(service.exitInputs.length, 0);
});

test("a rejected observation reaches FAILED through the Coordinator without starting the second leg", async () => {
  const service = new RuntimeBinanceService(["Rejected", "Filled"]);
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "FAILED");
  assert.equal(result.executionState?.legs[0].remoteObservation, "REJECTED");
  assert.equal(result.executionState?.legs[1].status, "NOT_STARTED");
  assert.equal(service.placeInputs.length, 1);
});

test("spot fill and perpetual rejection preserve RESIDUAL, exit through the service, and confirm flat", async () => {
  const service = new RuntimeBinanceService(["Filled", "Rejected"]);
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "RESIDUAL");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0.01");
  assert.equal(result.residualExit?.status, "EXITED");
  assert.match(result.residualExit?.identity?.executionAttemptId ?? "", /^funding-arbitrage-residual-exit:/u);
  assert.match(result.residualExit?.identity?.operationId ?? "", /^funding-arbitrage-residual-exit:/u);
  assert.equal(service.exitInputs[0]?.idempotencyKey, result.residualExit?.identity?.operationId);
  assert.equal(service.spotExposure, 0);
  assert.equal(service.perpetualExposure, 0);
  assert.ok(result.attempts.every(
    (attempt) => attempt.executionAttemptId !== result.residualExit?.identity?.executionAttemptId,
  ));
  assert.ok(service.placeInputs.every(
    (input) => input.idempotencyKey !== result.residualExit?.identity?.operationId,
  ));
});

test("reconciliation-confirmed partial fill produces RESIDUAL and exits both confirmed exposures", async () => {
  const service = new RuntimeBinanceService(["Filled", "Unknown"]);
  service.unknownResolutionStatus = "Cancelled";
  service.unknownResolutionFilledQuantity = 0.004;
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(service.reconciliationCalls, 1);
  assert.equal(result.executionState?.status, "RESIDUAL");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0.006");
  assert.equal(result.residualExit?.status, "EXITED");
  assert.equal(service.exitInputs.length, 1);
  assert.equal(service.spotExposure, 0);
  assert.equal(service.perpetualExposure, 0);
});

test("confirmed residual at or below tolerance remains RESIDUAL without forced exit", async () => {
  const service = new RuntimeBinanceService(["Filled", "Cancelled"]);
  service.filledQuantities = [0.01, 0.0095];
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "RESIDUAL");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0.0005");
  assert.equal(result.residualExit?.status, "NOT_REQUIRED");
  assert.match(result.residualExit?.reason ?? "", /within the approved maximum tolerance/u);
  assert.equal(service.exitInputs.length, 0);
});

test("intent expiry during the second leg safety window blocks provider mutation but permits residual exit", async () => {
  const times = [now + 1, now + 2, now + 3, now + 4, now + 60, now + 61];
  const service = new RuntimeBinanceService(["Filled", "Filled"], () => times.shift());
  const intent = { ...intentFixture(), expiresAt: now + 50 };
  const result = await runtimeFor(service, () => times.shift() ?? now + 61).execute(context, intent);

  assert.equal(service.placeInputs.length, 1);
  assert.equal(result.executionState?.status, "RESIDUAL");
  assert.equal(result.residualExit?.status, "EXITED");
  assert.equal(service.exitInputs.length, 1);
});

test("exit failure is explicit and preserves the confirmed RESIDUAL state", async () => {
  const service = new RuntimeBinanceService(["Filled", "Rejected"]);
  service.exitError = new Error("fixture exit rejected by existing safety chain");
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.executionState?.status, "RESIDUAL");
  assert.equal(result.executionState?.residualExposure.residualQuantity, "0.01");
  assert.equal(result.residualExit?.status, "FAILED");
  assert.match(result.residualExit?.reason ?? "", /existing safety chain/u);
  assert.equal(service.spotExposure, 0.01);
  assert.equal(service.exitInputs.length, 1);
});

test("preflight failure performs no mutation and creates no execution state", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  service.snapshotOverride = { existingSpotQuantityXaut: 0.01 };
  const result = await runtimeFor(service).execute(context, intentFixture());

  assert.equal(result.preflight.status, "FAIL");
  assert.equal(result.executionState, null);
  assert.deepEqual(result.attempts, []);
  assert.equal(service.placeInputs.length, 0);
});

test("registry binding rejects authenticated user mismatch before service access", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  const runtime = runtimeFor(service);

  await assert.rejects(
    () => runtime.execute(context, intentFixture(), "different-user"),
    /authenticated user does not match/u,
  );
  assert.deepEqual(runtime.registryUserIds, []);
  assert.equal(service.accountCalls, 0);
});

test("registry-bound service owner mismatch fails preflight before mutation", async () => {
  const service = new RuntimeBinanceService(["Filled", "Filled"]);
  service.accountId = "binance:different-owner";
  const runtime = runtimeFor(service);
  const result = await runtime.execute(context, intentFixture());

  assert.equal(result.preflight.status, "FAIL");
  if (result.preflight.status === "FAIL") assert.equal(result.preflight.reason, "ACCOUNT_BINDING_MISMATCH");
  assert.deepEqual(runtime.registryUserIds, [context.userId]);
  assert.equal(service.placeInputs.length, 0);
});

test("runtime composition requires Registry binding and imports no Client, OrderManager, RiskGuard, or credential", () => {
  const source = readFileSync(new URL("./BinanceCapitalTestRuntime.ts", import.meta.url), "utf8");
  const residualSource = readFileSync(new URL("./BinanceCapitalTestResidualExit.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    `${source}\n${residualSource}`,
    /BinanceClient|BinanceOrderManager|BinanceRiskGuard|Credential/iu,
  );
  assert.match(source, /registry\.run\(authenticatedUserId/u);
  assert.match(source, /new BinanceExecutionCapability/u);
  assert.match(source, /this\.service\.account\(\)/u);
  assert.match(residualSource, /this\.service\.exit\(/u);
  assert.match(residualSource, /this\.service\.account\(\)/u);
});

test("capital test dependency surface contains no direct Binance client mutation", () => {
  const sources = [
    "./BinanceCapitalTestPreflight.ts",
    "./BinanceCapitalTestRuntime.ts",
    "./BinanceCapitalTestResidualExit.ts",
    "./BinanceSpotPerpetualCapitalTestIntentBuilder.ts",
    "./BinanceExecutionCapability.ts",
    "./BinanceAdapter.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(sources, /from\s+["']\.\/BinanceClient["']/u);
  assert.doesNotMatch(sources, /(?:this\.)?client\.(?:placeOrder|placeTestOrder|cancelOrder)\s*\(/u);
});

type RuntimeService = BoundBinanceExecutionService & Pick<BinancePersonalTradingService, "account" | "exit">;

class RuntimeBinanceService implements RuntimeService {
  readonly placeInputs: Array<Record<string, unknown>> = [];
  readonly exitInputs: Array<Record<string, unknown>> = [];
  accountCalls = 0;
  reconciliationCalls = 0;
  snapshotOverride: Record<string, unknown> = {};
  accountId = context.accountId;
  spotExposure = 0;
  perpetualExposure = 0;
  filledQuantities: number[] = [];
  unknownResolutionStatus: BinanceProviderOrder["status"] = "Filled";
  unknownResolutionFilledQuantity = 0.01;
  exitError: Error | null = null;
  openSpotOrdersAfterExit = 0;
  openSpotOrderCount = 0;
  perpetualExecutionPriceAfterFirstLeg: number | null = null;
  marketCalls = 0;
  private readonly statuses: BinanceProviderOrder["status"][];
  private readonly beforeMutation?: () => void;
  private readonly resolveUnknown: boolean;
  private orders: BinanceStoredOrder[] = [];

  constructor(
    statuses: BinanceProviderOrder["status"][],
    beforeMutation?: () => void,
    resolveUnknown = true,
  ) {
    this.statuses = [...statuses];
    this.beforeMutation = beforeMutation;
    this.resolveUnknown = resolveUnknown;
  }

  async account() {
    this.accountCalls += 1;
    return snapshotFixture({
      accountId: this.accountId,
      existingSpotQuantityXaut: this.spotExposure,
      spotFreeXaut: this.spotExposure,
      spotAvailableQuantityXaut: this.spotExposure,
      existingPerpetualQuantityXaut: this.perpetualExposure,
      openSpotOrderCount: this.openSpotOrderCount,
      ...this.snapshotOverride,
    });
  }

  async market() {
    const snapshot = snapshotFixture({ accountId: context.accountId });
    this.marketCalls += 1;
    if (this.marketCalls > 1 && this.perpetualExecutionPriceAfterFirstLeg !== null) {
      snapshot.perpetual.bid = this.perpetualExecutionPriceAfterFirstLeg;
      snapshot.perpetual.ask = this.perpetualExecutionPriceAfterFirstLeg;
      snapshot.perpetual.mark = this.perpetualExecutionPriceAfterFirstLeg;
    }
    return {
      fetchedAt: snapshot.fetchedAt,
      productAvailability: snapshot.productAvailability,
      spot: snapshot.spot,
      perpetual: snapshot.perpetual,
      fees: snapshot.fees,
    };
  }

  async placeOrder(input: unknown, beforeProviderMutation?: () => void | Promise<void>) {
    this.beforeMutation?.();
    await beforeProviderMutation?.();
    const prepared = input as Record<string, unknown>;
    this.placeInputs.push(prepared);
    const status = this.statuses[this.placeInputs.length - 1] ?? "Rejected";
    const configuredFilledQuantity = this.filledQuantities[this.placeInputs.length - 1];
    const filledQuantity = configuredFilledQuantity
      ?? (status === "Filled" ? Number(prepared.quantityXaut) : 0);
    const order = providerOrder(status, filledQuantity, now + this.placeInputs.length + 2);
    if (filledQuantity > 0) {
      if (prepared.category === "linear") this.perpetualExposure = filledQuantity;
      else this.spotExposure = filledQuantity;
    }
    this.orders.push(storedOrder(String(prepared.idempotencyKey), prepared.category, order));
    return order;
  }

  async exit(input: unknown) {
    const body = input as Record<string, unknown>;
    this.exitInputs.push(body);
    if (this.exitError) throw this.exitError;
    this.spotExposure = 0;
    this.perpetualExposure = 0;
    this.openSpotOrderCount = this.openSpotOrdersAfterExit;
    return {
      state: "closed" as const,
      spot: null,
      perpetual: null,
      snapshot: await this.account(),
    };
  }

  async cancelOrder() {
    return providerOrder("Cancelled", 0, now + 20);
  }

  ordersState() {
    return { orders: this.orders };
  }

  async reconciliation() {
    this.reconciliationCalls += 1;
    if (this.resolveUnknown) {
      this.orders = this.orders.map((stored) => stored.order?.status === "Unknown"
        ? (() => {
          const resolved = providerOrder(
            this.unknownResolutionStatus,
            this.unknownResolutionFilledQuantity,
            now + 20,
          );
          if (stored.category === "linear") this.perpetualExposure = resolved.filledQuantityXaut;
          else this.spotExposure = resolved.filledQuantityXaut;
          return storedOrder(stored.idempotencyKey, stored.category, resolved);
        })()
        : stored);
    }
    return { reconciled: [], snapshot: snapshotFixture(), orders: this.orders };
  }
}

function runtimeFor(
  service: RuntimeService,
  clock: () => number = () => now + 10,
) {
  const registryUserIds: string[] = [];
  const registry = {
    run: async (userId: string, operation: (boundService: RuntimeService) => unknown) => {
      registryUserIds.push(userId);
      return operation(service);
    },
  } as unknown as Parameters<typeof executeBinanceCapitalTest>[0];
  return {
    registryUserIds,
    execute: (
      executionContext: BinanceCapitalTestExecutionContext,
      intent: SpotPerpetualFundingArbitrageExecutionIntent,
      authenticatedUserId = executionContext.userId,
    ) => executeBinanceCapitalTest(
      registry,
      authenticatedUserId,
      executionContext,
      intent,
      { maxSlippageBps: 20, clock },
    ),
  };
}

function intentFixture(): SpotPerpetualFundingArbitrageExecutionIntent {
  return {
    intentId: "intent-capital-runtime",
    sourcePlanId: "plan-capital-runtime",
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: now,
    expiresAt: now + 60_000,
    constraints: { maxResidualBaseQuantity: "0.001", maxLegStartSkewMs: 500 },
    legs: [
      {
        legId: "leg-spot-long",
        role: "long",
        venue: "binance",
        instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
        marketType: "spot",
        targetDeltaBaseQuantity: "0.01",
      },
      {
        legId: "leg-perpetual-short",
        role: "short",
        venue: "binance",
        instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
        marketType: "perpetual",
        targetDeltaBaseQuantity: "0.01",
      },
    ],
  };
}

function providerOrder(
  status: BinanceProviderOrder["status"],
  filledQuantityXaut: number,
  updatedAt: number,
): BinanceProviderOrder {
  return {
    orderId: "fixture-runtime",
    orderLinkId: "fixture-runtime",
    status,
    requestedQuantityXaut: 0.01,
    filledQuantityXaut,
    averagePrice: filledQuantityXaut > 0 ? 1_000 : null,
    feeUsd: 0,
    updatedAt,
  };
}

function storedOrder(
  idempotencyKey: string,
  category: unknown,
  order: BinanceProviderOrder,
): BinanceStoredOrder {
  return {
    idempotencyKey,
    requestFingerprint: "fixture-runtime",
    clientOrderId: "fixture-runtime",
    providerOrderId: order.orderId,
    category: category === "linear" ? "linear" : "spot",
    executionMode: "production_ioc",
    status: order.status === "Filled" ? "completed" : "processing",
    order,
    error: null,
    createdAt: now,
    updatedAt: order.updatedAt,
  };
}
