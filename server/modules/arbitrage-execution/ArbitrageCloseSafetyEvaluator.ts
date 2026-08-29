import {
  activeManagedQuantity,
  compareUnsignedDecimals,
  subtractUnsignedDecimals,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import type { ArbitrageLegVerificationResult } from "../cex/arbitrage-instance/ArbitragePositionVerification";
import type { ArbitragePositionVerificationService } from "../cex/arbitrage-instance/ArbitragePositionVerificationService";
import { ExecutionQuantityPlanner } from "../cex/ExecutionQuantityPlanner";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type {
  ArbitrageExecutionPlanningContext,
  ArbitrageExecutionPlanningContextSource,
} from "./ArbitrageExecutionPlanningContext";
import type { SpotCloseAvailableBalanceSource } from "./BinanceSpotCloseBalanceSource";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";

type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify"> &
  Partial<Pick<ArbitragePositionVerificationService, "verifyLeg">>;
type SpotSource<T> = T | Partial<Record<ExecutionIntent["venue"], T>>;
type PersistedAttributionStore = Readonly<{
  readSpotOpeningAttributionEvidence(userId: string, arbitrageId: string, legId: string): readonly Readonly<{
    arbitrageId: string;
    legId: string;
    executionIntentId: string;
    executionRecordId: string;
    attributableBaseQuantity: string;
    venue: ArbitrageInstanceLeg["venue"];
    accountId: string;
    instrumentId: string;
  }>[];
}>;

export type ArbitrageCloseSafetyReason =
  | "FULL_MANAGED_CLOSE_AVAILABLE"
  | "NO_ACTIVE_MANAGED_EXPOSURE"
  | "PROVIDER_REALITY_UNAVAILABLE"
  | "CLOSE_CAPABILITY_UNAVAILABLE"
  | "INSTRUMENT_RULES_UNAVAILABLE"
  | "INSTRUMENT_NOT_TRADABLE"
  | "INSTRUMENT_RULES_INVALID"
  | "ONE_WAY_REALITY_INSUFFICIENT"
  | "HEDGE_BUCKET_INSUFFICIENT"
  | "SPOT_ROLE_UNSUPPORTED"
  | "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
  | "SPOT_AVAILABLE_BALANCE_UNAVAILABLE"
  | "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT"
  | "QUANTITY_STEP_DUST"
  | "TRADING_RULES_REJECT_FULL_QUANTITY";

export type ArbitrageCloseSafetyResult = Readonly<{
  activeManagedQuantity: string;
  safeClosableQuantity: string;
  fullManagedCloseAvailable: boolean;
  reason: ArbitrageCloseSafetyReason;
  checkedAt: number;
  positionMode: "ONE_WAY" | "HEDGE" | null;
  actualQuantity: string | null;
  actualSignedNetQuantity: string | null;
  actualLongQuantity: string | null;
  actualShortQuantity: string | null;
  availableQuantity: string | null;
  verifiedAccountId?: string;
  transientReadFailure?: true;
}>;

export type ArbitrageCloseSafetyAssessment = Readonly<{
  result: ArbitrageCloseSafetyResult;
  context: ArbitrageExecutionPlanningContext | null;
  planner: ExecutionQuantityPlanner | null;
  market: "SPOT" | "PERPETUAL" | null;
  side: "buy" | "sell";
}>;

export class ArbitrageCloseSafetyEvaluator {
  constructor(
    private readonly positions: PositionVerifier,
    private readonly planningContexts: ArbitrageExecutionPlanningContextSource,
    private readonly spotBalances: SpotSource<SpotCloseAvailableBalanceSource>,
    private readonly spotAttributions: SpotSource<SpotOpeningAttributionSource>,
    private readonly now: () => number = Date.now,
    private readonly persistedAttributions?: PersistedAttributionStore,
  ) {}

  async evaluate(
    userId: string,
    instance: ArbitrageInstance,
    leg: ArbitrageInstanceLeg,
  ): Promise<ArbitrageCloseSafetyAssessment> {
    const activeQuantity = activeManagedQuantity(instance, leg);
    const side = leg.role === "LONG" ? "sell" as const : "buy" as const;
    const startedAt = checkedTimestamp(this.now());
    if (activeQuantity === "0") {
      return assessment(result(activeQuantity, "0", false, "NO_ACTIVE_MANAGED_EXPOSURE", startedAt), side);
    }

    let context: ArbitrageExecutionPlanningContext;
    try {
      context = await this.planningContexts.load(leg.venue, leg.instrumentId);
    } catch (error) {
      return assessment(result(
        activeQuantity, "0", false, planningContextFailureReason(error),
        startedAt,
      ), side);
    }
    const spot = context.instrument.marketType === "spot" && context.instrument.contractType === "spot";
    const perpetual = context.instrument.marketType === "perpetual"
      && context.instrument.contractType === "linear_perpetual"
      && context.instrument.settlementAsset === "USDT";
    if (context.instrument.quoteAsset !== "USDT" || (!spot && !perpetual)) {
      return assessment(result(
        activeQuantity, "0", false, "CLOSE_CAPABILITY_UNAVAILABLE",
        Math.max(startedAt, context.quote.fetchedAt),
      ), side, context);
    }

    const planner = new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === leg.instrumentId ? context.instrument : null },
      { getTradingRules: async () => context.tradingRules },
      { now: () => checkedTimestamp(this.now()) },
    );
    let candidate = activeQuantity;
    let unavailableReason: ArbitrageCloseSafetyReason = "TRADING_RULES_REJECT_FULL_QUANTITY";
    let verifiedLeg: ArbitrageLegVerificationResult | null = null;
    let availableQuantity: string | null = null;
    let checkedAt = Math.max(startedAt, context.quote.fetchedAt);

    if (perpetual) {
      try {
        verifiedLeg = this.positions.verifyLeg
          ? await this.positions.verifyLeg(userId, instance.arbitrageId, leg.legId)
          : (await this.positions.verify(userId, instance.arbitrageId))?.legs
            .find((candidate) => candidate.legId === leg.legId) ?? null;
      } catch {
        // A read failure is an explicit unknown safety result, never release eligibility.
      }
      if (!verifiedLeg || !reliableReality(verifiedLeg)) {
        return assessment(result(
          activeQuantity, "0", false, "PROVIDER_REALITY_UNAVAILABLE",
          verifiedLeg?.checkedAt ?? checkedAt, verifiedLeg,
        ), side, context, planner, "PERPETUAL");
      }
      availableQuantity = verifiedLeg.availableQuantity;
      checkedAt = Math.max(checkedAt, verifiedLeg.checkedAt);
      if (verifiedLeg.positionMode === "ONE_WAY") {
        candidate = sameDirectionOneWayQuantity(leg.role, verifiedLeg.actualSignedNetQuantity, activeQuantity);
        unavailableReason = "ONE_WAY_REALITY_INSUFFICIENT";
      } else if (verifiedLeg.positionMode === "HEDGE") {
        const bucket = leg.role === "LONG" ? verifiedLeg.actualLongQuantity : verifiedLeg.actualShortQuantity;
        candidate = minimum(activeQuantity, bucket);
        unavailableReason = "HEDGE_BUCKET_INSUFFICIENT";
      } else {
        return assessment(result(
          activeQuantity, "0", false, "PROVIDER_REALITY_UNAVAILABLE", checkedAt, verifiedLeg,
        ), side, context, planner, "PERPETUAL");
      }
    } else {
      if (leg.role !== "LONG") {
        return assessment(result(
          activeQuantity, "0", false, "SPOT_ROLE_UNSUPPORTED", checkedAt, verifiedLeg,
        ), side, context, planner, "SPOT");
      }
      const opening = exactSpotOpeningReference(instance, leg.legId);
      if (!opening) {
        return assessment(result(
          activeQuantity, "0", false, "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE", checkedAt, verifiedLeg,
        ), side, context, planner, "SPOT");
      }
      let attributableQuantity: string;
      try {
        const persisted = this.persistedAttributions?.readSpotOpeningAttributionEvidence(
          userId, instance.arbitrageId, leg.legId,
        ).find((candidate) => candidate.executionIntentId === opening.executionIntentId);
        if (persisted) {
          if (persisted.arbitrageId !== instance.arbitrageId || persisted.legId !== leg.legId
            || persisted.executionRecordId !== opening.executionRecordId || persisted.venue !== leg.venue
            || persisted.accountId !== leg.accountId || persisted.instrumentId !== leg.instrumentId) {
            throw new Error("Persisted Spot attribution identity is invalid.");
          }
          attributableQuantity = persisted.attributableBaseQuantity;
        } else if (this.persistedAttributions) {
          throw new Error("Persisted Spot attribution is unavailable.");
        } else {
          attributableQuantity = await resolveSpotSource(this.spotAttributions, leg.venue, "attribution")
            .readAttributableBaseQuantity(userId, {
            accountId: leg.accountId,
            instrumentId: leg.instrumentId,
            providerSymbol: context.instrument.providerSymbol,
            baseAsset: context.instrument.baseAsset.symbol,
            executionIntentId: opening.executionIntentId,
            executionRecordId: opening.executionRecordId!,
            grossConfirmedQuantity: opening.confirmedQuantity,
          });
        }
      } catch {
        return assessment(result(
          activeQuantity, "0", false, "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE", checkedAt, verifiedLeg,
        ), side, context, planner, "SPOT");
      }
      try {
        const balance = await resolveSpotSource(this.spotBalances, leg.venue, "balance")
          .readAvailableBalance(userId, {
            accountId: leg.accountId,
            instrumentId: leg.instrumentId,
            providerSymbol: context.instrument.providerSymbol,
            baseAsset: context.instrument.baseAsset.symbol,
          });
        availableQuantity = balance.availableQuantity;
        checkedAt = Math.max(checkedAt, balance.checkedAt);
        verifiedLeg = spotAccountReality(
          instance.arbitrageId,
          leg.legId,
          activeQuantity,
          balance.totalQuantity ?? balance.availableQuantity,
          balance.availableQuantity,
          checkedAt,
        );
      } catch (error) {
        return assessment(result(
          activeQuantity, "0", false, "SPOT_AVAILABLE_BALANCE_UNAVAILABLE", checkedAt, verifiedLeg,
          null, isTransientProviderReadFailure(error),
        ), side, context, planner, "SPOT");
      }
      candidate = minimum(activeQuantity, minimum(attributableQuantity, availableQuantity));
      unavailableReason = "SPOT_ATTRIBUTABLE_AVAILABLE_INSUFFICIENT";
    }

    if (candidate === "0") {
      return assessment(result(
        activeQuantity, "0", false, unavailableReason, checkedAt, verifiedLeg, availableQuantity,
      ), side, context, planner, spot ? "SPOT" : "PERPETUAL");
    }
    const planned = await planner.plan({
      instrumentId: leg.instrumentId,
      side,
      quantityInput: { mode: "ASSET_QUANTITY", quantity: candidate },
      quantityAlignment: "FLOOR",
      quote: context.quote,
    });
    if (!planned.ok) {
      const quantityStepDust = spot
        && candidate === activeQuantity
        && isQuantityRuleDust(activeQuantity, context.tradingRules.quantityStep, context.tradingRules.minQuantity);
      return assessment(result(
        activeQuantity, "0", false,
        quantityStepDust ? "QUANTITY_STEP_DUST" : "TRADING_RULES_REJECT_FULL_QUANTITY",
        checkedAt,
        verifiedLeg, availableQuantity,
      ), side, context, planner, spot ? "SPOT" : "PERPETUAL");
    }
    const safeClosableQuantity = planned.plan.plannedAssetQuantity.quantity;
    const fullManagedCloseAvailable = safeClosableQuantity === activeQuantity;
    const residualQuantity = fullManagedCloseAvailable
      ? "0"
      : subtractUnsignedDecimals(activeQuantity, safeClosableQuantity);
    const quantityStepDust = spot
      && candidate === activeQuantity
      && residualQuantity !== "0"
      && isQuantityRuleDust(residualQuantity, context.tradingRules.quantityStep, context.tradingRules.minQuantity);
    return assessment(result(
      activeQuantity,
      safeClosableQuantity,
      fullManagedCloseAvailable,
      fullManagedCloseAvailable
        ? "FULL_MANAGED_CLOSE_AVAILABLE"
        : quantityStepDust
          ? "QUANTITY_STEP_DUST"
          : unavailableReason,
      checkedAt,
      verifiedLeg,
      availableQuantity,
    ), side, context, planner, spot ? "SPOT" : "PERPETUAL");
  }
}

function planningContextFailureReason(error: unknown): ArbitrageCloseSafetyReason {
  const category = error && typeof error === "object" && "category" in error
    ? (error as { category?: unknown }).category
    : undefined;
  if (category === "instrument_rules_unavailable") return "INSTRUMENT_RULES_UNAVAILABLE";
  if (category === "instrument_not_tradable") return "INSTRUMENT_NOT_TRADABLE";
  if (category === "instrument_rules_invalid") return "INSTRUMENT_RULES_INVALID";
  return "CLOSE_CAPABILITY_UNAVAILABLE";
}

function isQuantityRuleDust(quantity: string, quantityStep: string, minQuantity: string) {
  if (compareUnsignedDecimals(quantity, minQuantity) < 0) return true;
  const scale = Math.max(decimalPlaces(quantity), decimalPlaces(quantityStep));
  const quantityValue = decimalInteger(quantity, scale);
  const stepValue = decimalInteger(quantityStep, scale);
  return stepValue > 0n && (quantityValue / stepValue) * stepValue === 0n;
}

function decimalInteger(value: string, scale: number) {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(`${integer}${fraction.padEnd(scale, "0")}`);
}

function decimalPlaces(value: string) {
  return value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
}

function result(
  activeManagedQuantity: string,
  safeClosableQuantity: string,
  fullManagedCloseAvailable: boolean,
  reason: ArbitrageCloseSafetyReason,
  checkedAt: number,
  reality: ArbitrageLegVerificationResult | null = null,
  availableQuantity: string | null = reality?.availableQuantity ?? null,
  transientReadFailure = false,
): ArbitrageCloseSafetyResult {
  return Object.freeze({
    activeManagedQuantity,
    safeClosableQuantity,
    fullManagedCloseAvailable,
    reason,
    checkedAt: checkedTimestamp(checkedAt),
    positionMode: reality?.positionMode ?? null,
    actualQuantity: reality?.actualQuantity ?? null,
    actualSignedNetQuantity: reality?.actualSignedNetQuantity ?? null,
    actualLongQuantity: reality?.actualLongQuantity ?? null,
    actualShortQuantity: reality?.actualShortQuantity ?? null,
    availableQuantity,
    ...(reality?.verifiedAccountId === undefined ? {} : { verifiedAccountId: reality.verifiedAccountId }),
    ...(transientReadFailure ? { transientReadFailure: true as const } : {}),
  });
}

function isTransientProviderReadFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("category" in error)) return false;
  const category = (error as { category?: unknown }).category;
  return category === "provider_timeout"
    || category === "provider_transport_error"
    || category === "provider_unavailable";
}

function assessment(
  safety: ArbitrageCloseSafetyResult,
  side: "buy" | "sell",
  context: ArbitrageExecutionPlanningContext | null = null,
  planner: ExecutionQuantityPlanner | null = null,
  market: "SPOT" | "PERPETUAL" | null = null,
): ArbitrageCloseSafetyAssessment {
  return Object.freeze({ result: safety, context, planner, market, side });
}

function reliableReality(value: ArbitrageLegVerificationResult) {
  return value !== null
    && value.verificationStatus !== "UNKNOWN"
    && value.actualQuantity !== null
    && value.positionMode !== null
    && value.actualLongQuantity !== null
    && value.actualShortQuantity !== null;
}

function spotAccountReality(
  arbitrageId: string,
  legId: string,
  expectedManagedQuantity: string,
  totalQuantity: string,
  availableQuantity: string,
  checkedAt: number,
): ArbitrageLegVerificationResult {
  return Object.freeze({
    arbitrageId,
    legId,
    expectedManagedQuantity,
    actualQuantity: totalQuantity,
    actualSignedNetQuantity: totalQuantity,
    positionMode: "ONE_WAY",
    actualLongQuantity: totalQuantity,
    actualShortQuantity: "0",
    availableQuantity,
    verificationStatus: "MATCHED",
    reason: null,
    checkedAt,
  });
}

function sameDirectionOneWayQuantity(
  role: ArbitrageInstanceLeg["role"],
  signedNet: string | null,
  ceiling: string,
) {
  if (signedNet === null || signedNet === "0") return "0";
  const negative = signedNet.startsWith("-");
  if ((role === "SHORT") !== negative) return "0";
  return minimum(ceiling, negative ? signedNet.slice(1) : signedNet);
}

function minimum(left: string, right: string | null) {
  if (right === null) return "0";
  return compareUnsignedDecimals(left, right) <= 0 ? left : right;
}

function exactSpotOpeningReference(instance: ArbitrageInstance, legId: string) {
  const openings = instance.executionReferences.filter((reference) => reference.legId === legId
    && reference.phase === "OPENING"
    && reference.quantityEffect === "INCREASE"
    && reference.status === "CONFIRMED"
    && reference.executionRecordId !== null);
  return openings.length === 1 ? openings[0]! : null;
}

function resolveSpotSource<T extends object>(source: SpotSource<T>, venue: ExecutionIntent["venue"], kind: string): T {
  if (kind === "balance" && "readAvailableBalance" in source) return source as T;
  if (kind === "attribution" && "readAttributableBaseQuantity" in source) return source as T;
  const selected = (source as Partial<Record<ExecutionIntent["venue"], T>>)[venue];
  if (!selected) throw new Error(`Spot ${kind} source is not configured for ${venue}.`);
  return selected;
}

function checkedTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Close safety clock is invalid.");
  return value;
}
