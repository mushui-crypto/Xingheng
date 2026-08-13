import type { Asset } from "../cex/Asset";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { FundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { FundingArbitrageExecutionState } from "../cex/funding-arbitrage/FundingArbitrageExecutionState";
import { FundingArbitrageIntentAdapter } from "../cex/funding-arbitrage/FundingArbitrageIntentAdapter";
import type { FundingLegExecutionLink } from "../cex/funding-arbitrage/FundingLegExecutionLinkStore";
import { FundingLegExecutionStateBridge } from "../cex/funding-arbitrage/FundingLegExecutionStateBridge";
import {
  BINANCE_CAPITAL_TEST_MAX_TOTAL_PLANNED_CAPITAL_USD,
  preflightBinanceCapitalTest,
  type BinanceCapitalTestExecutionContext,
  type BinanceCapitalTestPreflightResult,
} from "./BinanceCapitalTestPreflight";
import {
  BinanceIntentExecutionRuntime,
  type BinanceIntentExecutionRecordStore,
  type BinanceIntentExecutionRuntimeOptions,
  type BinanceIntentExecutionRuntimeRegistry,
  type BinanceIntentExecutionRuntimeResult,
} from "./BinanceIntentExecutionRuntime";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinancePreflightSnapshot } from "./BinanceTypes";

type FundingLeg = FundingArbitrageExecutionIntent["legs"][number];

export type BinanceCapitalTestLegRequest = Readonly<{
  confirmed: true;
  arbitrageId: string;
  legId: string;
  executionIntentId: string;
  quantityAsset: Asset;
  orderConstraints: ExecutionIntent["orderConstraints"];
  executionMode: ExecutionIntent["executionMode"];
  expiresAt: number;
}>;

export type BinanceCapitalTestSubmitResult = Readonly<{
  preflight: BinanceCapitalTestPreflightResult;
  executionIntent: ExecutionIntent | null;
  executionRecord: ExecutionRecord | null;
  execution: BinanceIntentExecutionRuntimeResult["execution"] | null;
  observation: ExecutionQueryObservation | null;
  executionState: FundingArbitrageExecutionState;
  link: FundingLegExecutionLink | null;
}>;

export type BinanceCapitalTestStateSyncResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionQueryObservation | null;
  executionState: FundingArbitrageExecutionState;
}>;

export type BinanceCapitalTestRuntimeOptions = Readonly<{
  maxSlippageBps: number;
  clock?: () => number;
  createExecutionId?: () => string;
  createCapability?: BinanceIntentExecutionRuntimeOptions["createCapability"];
  managedExposure?: Readonly<{
    fundingExecutionId: string;
    exposureOwnerFundingExecutionId: string | null;
    userId: string;
    accountId: string;
    venue: "binance";
    instrumentIds: readonly ["XAUT-USDT-SPOT", "XAUT-USDT-PERP"];
    spotBaseQuantity: string;
    perpetualBaseQuantity: string;
  }>;
}>;

export class BinanceCapitalTestRuntime {
  private readonly adapter = new FundingArbitrageIntentAdapter();
  private readonly bridge = new FundingLegExecutionStateBridge();
  private readonly clock: () => number;

  constructor(
    private readonly registry: BinanceIntentExecutionRuntimeRegistry,
    private readonly recordStore: BinanceIntentExecutionRecordStore,
    private readonly options: BinanceCapitalTestRuntimeOptions,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  async submitLeg(
    authenticatedUserId: string,
    context: BinanceCapitalTestExecutionContext,
    fundingIntent: FundingArbitrageExecutionIntent,
    fundingState: FundingArbitrageExecutionState,
    request: BinanceCapitalTestLegRequest,
  ): Promise<BinanceCapitalTestSubmitResult> {
    const userId = assertExecutionContext(authenticatedUserId, context);
    assertFundingStateIdentity(fundingIntent, fundingState);
    const leg = fundingLeg(fundingIntent, request.legId);
    const snapshot = await this.registry.run(userId, (service) => service.account());
    const confirmedAt = this.now();
    const preflightSnapshot = capitalTestPreflightSnapshot(
      context,
      snapshot,
      fundingIntent,
      fundingState,
      this.options.managedExposure,
    );
    const preflight = preflightSnapshot
      ? preflightBinanceCapitalTest(
        context,
        fundingIntent,
        preflightSnapshot,
        confirmedAt,
        this.options.maxSlippageBps,
      )
      : {
        status: "FAIL" as const,
        reason: "EXISTING_EXPOSURE" as const,
        message: "Binance exposure does not match the confirmed capital-test funding flow.",
      };
    if (preflight.status === "FAIL") {
      return Object.freeze({
        preflight,
        executionIntent: null,
        executionRecord: null,
        execution: null,
        observation: null,
        executionState: fundingState,
        link: null,
      });
    }

    const executionIntent = this.adapter.createExecutionIntent(fundingIntent, {
      confirmed: request.confirmed,
      intentId: request.executionIntentId,
      arbitrageId: request.arbitrageId,
      legId: request.legId,
      userId,
      accountId: context.accountId,
      venue: leg.venue,
      quantityAsset: request.quantityAsset,
      orderConstraints: request.orderConstraints,
      executionMode: request.executionMode,
      confirmedAt,
      expiresAt: request.expiresAt,
    });
    const runtime = this.executionRuntime((prepared) => {
      assertCapitalMutationAllowed(
        prepared,
        leg,
        fundingIntent,
        snapshot,
        this.options.maxSlippageBps,
        this.now(),
      );
    });
    const submitted = await runtime.execute(executionIntent);
    const link = Object.freeze({
      executionIntentId: executionIntent.intentId,
      executionRecordId: submitted.executionRecord.executionId,
    });
    const queried = await runtime.query(userId, submitted.executionRecord.executionId);
    const executionState = this.bridge.apply({
      authenticatedUserId: userId,
      fundingState,
      legId: leg.legId,
      link,
      executionRecord: queried.executionRecord,
      observation: queried.observation,
    });

    return Object.freeze({
      preflight,
      executionIntent,
      executionRecord: queried.executionRecord,
      execution: submitted.execution,
      observation: queried.observation,
      executionState,
      link,
    });
  }

  async queryLeg(
    authenticatedUserId: string,
    fundingState: FundingArbitrageExecutionState,
    legId: string,
    link: FundingLegExecutionLink,
  ): Promise<BinanceCapitalTestStateSyncResult> {
    const result = await this.executionRuntime().query(authenticatedUserId, link.executionRecordId);
    return this.applyObservation(authenticatedUserId, fundingState, legId, link, result);
  }

  async reconcileLeg(
    authenticatedUserId: string,
    fundingState: FundingArbitrageExecutionState,
    legId: string,
    link: FundingLegExecutionLink,
  ): Promise<BinanceCapitalTestStateSyncResult> {
    const result = await this.executionRuntime().reconcile(authenticatedUserId, link.executionRecordId);
    if (!result.observation) {
      return Object.freeze({
        executionRecord: result.executionRecord,
        observation: null,
        executionState: fundingState,
      });
    }
    return this.applyObservation(authenticatedUserId, fundingState, legId, link, {
      executionRecord: result.executionRecord,
      observation: result.observation,
    });
  }

  async cancelLeg(
    authenticatedUserId: string,
    fundingState: FundingArbitrageExecutionState,
    legId: string,
    link: FundingLegExecutionLink,
  ): Promise<BinanceCapitalTestStateSyncResult> {
    const result = await this.executionRuntime().cancel(authenticatedUserId, link.executionRecordId);
    const leg = fundingState.legs.find((candidate) => candidate.legId === legId);
    if (!leg) throw new Error("Funding leg does not belong to the funding flow state.");
    const observation = createExecutionQueryObservation({
      state: executionObservationState(result.executionRecord.status),
      filledBaseQuantity: leg.confirmedExecutedQuantity,
      observedAt: result.executionRecord.updatedAt,
    });
    return this.applyObservation(authenticatedUserId, fundingState, legId, link, {
      executionRecord: result.executionRecord,
      observation,
    });
  }

  private applyObservation(
    authenticatedUserId: string,
    fundingState: FundingArbitrageExecutionState,
    legId: string,
    link: FundingLegExecutionLink,
    result: Readonly<{ executionRecord: ExecutionRecord; observation: ExecutionQueryObservation }>,
  ) {
    return Object.freeze({
      executionRecord: result.executionRecord,
      observation: result.observation,
      executionState: this.bridge.apply({
        authenticatedUserId,
        fundingState,
        legId,
        link,
        executionRecord: result.executionRecord,
        observation: result.observation,
      }),
    });
  }

  private executionRuntime(
    assertSubmitAllowed?: BinanceIntentExecutionRuntimeOptions["assertSubmitAllowed"],
  ) {
    return new BinanceIntentExecutionRuntime(
      this.registry,
      { maxSlippageBps: this.options.maxSlippageBps },
      this.recordStore,
      {
        clock: this.clock,
        createExecutionId: this.options.createExecutionId,
        assertSubmitAllowed,
        createCapability: this.options.createCapability,
      },
    );
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Capital test runtime clock must return a non-negative integer timestamp.");
    }
    return value;
  }
}

function assertExecutionContext(
  authenticatedUserId: string,
  context: BinanceCapitalTestExecutionContext,
) {
  const userId = identifier(authenticatedUserId, "authenticated userId");
  if (userId !== context.userId) {
    throw new Error("Capital test authenticated user does not match the execution context.");
  }
  if (!identifier(context.accountId, "accountId") || context.venue !== "binance") {
    throw new Error("Capital test execution context is invalid.");
  }
  return userId;
}

function assertFundingStateIdentity(
  intent: FundingArbitrageExecutionIntent,
  state: FundingArbitrageExecutionState,
) {
  if (state.intentId !== intent.intentId || state.sourcePlanId !== intent.sourcePlanId) {
    throw new Error("Funding execution state does not match the funding intent.");
  }
}

function fundingLeg(intent: FundingArbitrageExecutionIntent, legId: string): FundingLeg {
  const normalizedLegId = identifier(legId, "legId");
  const leg = intent.legs.find((candidate) => candidate.legId === normalizedLegId);
  if (!leg) throw new Error("Funding leg does not belong to the funding intent.");
  if (leg.venue !== "binance") throw new Error("Capital test supports Binance legs only.");
  return leg;
}

function capitalTestPreflightSnapshot(
  context: BinanceCapitalTestExecutionContext,
  snapshot: BinancePreflightSnapshot,
  fundingIntent: FundingArbitrageExecutionIntent,
  fundingState: FundingArbitrageExecutionState,
  managedExposure: BinanceCapitalTestRuntimeOptions["managedExposure"],
) {
  const binding = managedExposure ?? {
    fundingExecutionId: fundingIntent.sourcePlanId,
    exposureOwnerFundingExecutionId: fundingIntent.sourcePlanId,
    userId: context.userId,
    accountId: context.accountId,
    venue: "binance" as const,
    instrumentIds: ["XAUT-USDT-SPOT", "XAUT-USDT-PERP"] as const,
    spotBaseQuantity: "0",
    perpetualBaseQuantity: "0",
  };
  if (!fundingIntent.sourcePlanId.startsWith(`${binding.fundingExecutionId}:`)
    && fundingIntent.sourcePlanId !== binding.fundingExecutionId) {
    return null;
  }
  const baselineSpot = decimalNumber(binding.spotBaseQuantity);
  const baselinePerpetual = decimalNumber(binding.perpetualBaseQuantity);
  const spotLeg = fundingState.legs.find((leg) => leg.role === "long")!;
  const perpetualLeg = fundingState.legs.find((leg) => leg.role === "short")!;
  const expectedSpot = baselineSpot + decimalNumber(spotLeg.confirmedExecutedQuantity);
  const expectedPerpetual = baselinePerpetual + decimalNumber(perpetualLeg.confirmedExecutedQuantity);
  try {
    assertNoUnexpectedExposure(context, snapshot, {
      ...binding,
      spotBaseQuantity: String(expectedSpot),
      perpetualBaseQuantity: String(expectedPerpetual),
    });
  } catch {
    return null;
  }
  return {
    ...snapshot,
    existingSpotQuantityXaut: 0,
    existingPerpetualQuantityXaut: 0,
    perpetualPositionSide: "flat" as const,
  };
}

export function assertNoUnexpectedExposure(
  context: BinanceCapitalTestExecutionContext,
  snapshot: BinancePreflightSnapshot,
  binding: NonNullable<BinanceCapitalTestRuntimeOptions["managedExposure"]>,
) {
  if (!identifier(binding.fundingExecutionId, "fundingExecutionId")
    || binding.userId !== context.userId
    || binding.accountId !== context.accountId
    || binding.venue !== context.venue
    || snapshot.accountId !== binding.accountId) {
    throw new Error("Capital test exposure ownership identity does not match the execution context.");
  }
  if (binding.instrumentIds[0] !== "XAUT-USDT-SPOT"
    || binding.instrumentIds[1] !== "XAUT-USDT-PERP") {
    throw new Error("Capital test exposure ownership does not match the supported canonical instruments.");
  }
  const expectedSpot = decimalNumber(binding.spotBaseQuantity);
  const expectedPerpetual = decimalNumber(binding.perpetualBaseQuantity);
  if ((expectedSpot > 1e-9 || expectedPerpetual > 1e-9)
    && binding.exposureOwnerFundingExecutionId !== binding.fundingExecutionId) {
    throw new Error("Binance exposure belongs to a different funding execution.");
  }
  const expectedSide = expectedPerpetual > 1e-9 ? "short" : "flat";
  if (!sameQuantity(snapshot.existingSpotQuantityXaut, expectedSpot)
    || !sameQuantity(snapshot.existingPerpetualQuantityXaut, expectedPerpetual)
    || snapshot.perpetualPositionSide !== expectedSide) {
    throw new Error("Binance account contains exposure not managed by the current funding execution.");
  }
}

function decimalNumber(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Capital test expected exposure must be an unsigned decimal string.");
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("Capital test expected exposure is out of range.");
  return result;
}

function sameQuantity(actual: number, expected: number) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9;
}

function assertCapitalMutationAllowed(
  prepared: Readonly<{ quantity: string; limitPrice: number }>,
  leg: FundingLeg,
  intent: FundingArbitrageExecutionIntent,
  snapshot: BinancePreflightSnapshot,
  maxSlippageBps: number,
  checkedAt: number,
) {
  if (checkedAt >= intent.expiresAt) {
    throw new Error("Capital test intent expired before risk-increasing mutation.");
  }
  const otherLeg = intent.legs.find((candidate) => candidate.legId !== leg.legId)!;
  const otherReferencePrice = otherLeg.marketType === "spot"
    ? snapshot.spot.ask
    : Math.max(snapshot.perpetual.ask, snapshot.perpetual.mark);
  const otherCapitalUsd = Number(otherLeg.targetDeltaBaseQuantity)
    * otherReferencePrice
    * (1 + maxSlippageBps / 10_000);
  const mutationCapitalUsd = decimalNumber(prepared.quantity) * prepared.limitPrice;
  const totalPlannedCapitalUsd = mutationCapitalUsd + otherCapitalUsd;
  if (!Number.isFinite(totalPlannedCapitalUsd)
    || totalPlannedCapitalUsd <= 0
    || totalPlannedCapitalUsd > BINANCE_CAPITAL_TEST_MAX_TOTAL_PLANNED_CAPITAL_USD + 1e-9) {
    throw new Error("Capital test mutation would exceed the 40 USD total planned capital limit.");
  }
}

function executionObservationState(status: ExecutionRecord["status"]): ExecutionQueryObservation["state"] {
  if (status === "CONFIRMED") return "CONFIRMED";
  if (status === "FAILED") return "FAILED";
  if (status === "UNKNOWN") return "UNKNOWN";
  return "PENDING_CONFIRMATION";
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
