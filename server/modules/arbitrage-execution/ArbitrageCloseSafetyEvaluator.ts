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

type PositionVerifier = Pick<ArbitragePositionVerificationService, "verify">;
type SpotSource<T> = T | Partial<Record<ExecutionIntent["venue"], T>>;

export type ArbitrageCloseSafetyReason =
  | "FULL_MANAGED_CLOSE_AVAILABLE"
  | "NO_ACTIVE_MANAGED_EXPOSURE"
  | "PROVIDER_REALITY_UNAVAILABLE"
  | "CLOSE_CAPABILITY_UNAVAILABLE"
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

    let verifiedLeg: ArbitrageLegVerificationResult | null = null;
    try {
      const verification = await this.positions.verify(userId, instance.arbitrageId);
      verifiedLeg = verification?.legs.find((candidate) => candidate.legId === leg.legId) ?? null;
    } catch {
      // A read failure is an explicit unknown safety result, never release eligibility.
    }
    if (!verifiedLeg || !reliableReality(verifiedLeg)) {
      return assessment(result(
        activeQuantity,
        "0",
        false,
        "PROVIDER_REALITY_UNAVAILABLE",
        verifiedLeg?.checkedAt ?? startedAt,
        verifiedLeg,
      ), side);
    }

    let context: ArbitrageExecutionPlanningContext;
    try {
      context = await this.planningContexts.load(leg.venue, leg.instrumentId);
    } catch {
      return assessment(result(
        activeQuantity, "0", false, "CLOSE_CAPABILITY_UNAVAILABLE",
        verifiedLeg.checkedAt, verifiedLeg,
      ), side);
    }
    const spot = context.instrument.marketType === "spot" && context.instrument.contractType === "spot";
    const perpetual = context.instrument.marketType === "perpetual"
      && context.instrument.contractType === "linear_perpetual"
      && context.instrument.settlementAsset === "USDT";
    if (context.instrument.quoteAsset !== "USDT" || (!spot && !perpetual)) {
      return assessment(result(
        activeQuantity, "0", false, "CLOSE_CAPABILITY_UNAVAILABLE",
        Math.max(verifiedLeg.checkedAt, context.quote.fetchedAt), verifiedLeg,
      ), side, context);
    }

    const planner = new ExecutionQuantityPlanner(
      { resolve: async (instrumentId) => instrumentId === leg.instrumentId ? context.instrument : null },
      { getTradingRules: async () => context.tradingRules },
      { now: () => checkedTimestamp(this.now()) },
    );
    let candidate = activeQuantity;
    let unavailableReason: ArbitrageCloseSafetyReason = "TRADING_RULES_REJECT_FULL_QUANTITY";
    let availableQuantity = verifiedLeg.availableQuantity;
    let checkedAt = Math.max(verifiedLeg.checkedAt, context.quote.fetchedAt);

    if (perpetual) {
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
      } catch {
        return assessment(result(
          activeQuantity, "0", false, "SPOT_AVAILABLE_BALANCE_UNAVAILABLE", checkedAt, verifiedLeg,
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
  });
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
