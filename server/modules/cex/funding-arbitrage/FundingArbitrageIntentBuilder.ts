import { randomUUID } from "node:crypto";
import type {
  PerpetualPerpetualFundingArbitrageExecutionIntent,
} from "./FundingArbitrageExecutionIntent";
import type { FundingArbitragePlan } from "./FundingArbitragePlan";

export type FundingArbitrageIntentBuildParameters = Readonly<{
  now: number;
  maxResidualBaseQuantity: string;
  expiresAt?: number;
}>;

export function buildFundingArbitrageExecutionIntent(
  plan: FundingArbitragePlan,
  parameters: FundingArbitrageIntentBuildParameters,
): PerpetualPerpetualFundingArbitrageExecutionIntent {
  assertLifecycle(plan, parameters);
  if (plan.strategyType !== "PERPETUAL_PERPETUAL") {
    throw new Error(`Unsupported funding arbitrage strategy type: ${plan.strategyType}.`);
  }
  assertPerpetualPair(plan);

  const maxResidualBaseQuantity = normalizeDecimalString(parameters.maxResidualBaseQuantity);

  return {
    intentId: randomUUID(),
    sourcePlanId: plan.planId,
    strategyType: "PERPETUAL_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: parameters.now,
    expiresAt: parameters.expiresAt ?? plan.expiresAt,
    constraints: {
      maxResidualBaseQuantity,
    },
    legs: [
      {
        legId: randomUUID(),
        role: plan.legs[0].role,
        venue: plan.legs[0].venue,
        instrumentId: plan.legs[0].instrumentId,
        marketType: plan.legs[0].marketType,
        targetDeltaBaseQuantity: normalizeNumberAsDecimal(plan.legs[0].baseQuantity),
      },
      {
        legId: randomUUID(),
        role: plan.legs[1].role,
        venue: plan.legs[1].venue,
        instrumentId: plan.legs[1].instrumentId,
        marketType: plan.legs[1].marketType,
        targetDeltaBaseQuantity: normalizeNumberAsDecimal(plan.legs[1].baseQuantity),
      },
    ],
  };
}

function assertLifecycle(
  plan: FundingArbitragePlan,
  parameters: FundingArbitrageIntentBuildParameters,
) {
  if (!Number.isFinite(parameters.now) || !Number.isInteger(parameters.now)) {
    throw new Error("Intent creation time must be an integer timestamp.");
  }
  if (plan.expiresAt <= parameters.now) throw new Error("Funding arbitrage plan has expired.");
  const expiresAt = parameters.expiresAt ?? plan.expiresAt;
  if (!Number.isFinite(expiresAt) || !Number.isInteger(expiresAt) || expiresAt <= parameters.now) {
    throw new Error("Funding arbitrage intent expiry must be after its creation time.");
  }
  if (expiresAt > plan.expiresAt) {
    throw new Error("Funding arbitrage intent expiry cannot exceed its source plan expiry.");
  }
}

function assertPerpetualPair(plan: FundingArbitragePlan) {
  const legs = plan.legs as readonly unknown[];
  if (legs.length !== 2) throw new Error("Funding arbitrage intent requires exactly two legs.");
  const [longLeg, shortLeg] = plan.legs;
  if (longLeg.role !== "long" || shortLeg.role !== "short") {
    throw new Error("Funding arbitrage intent requires one ordered long leg and one ordered short leg.");
  }
  if (longLeg.marketType !== "perpetual" || shortLeg.marketType !== "perpetual") {
    throw new Error("PERPETUAL_PERPETUAL intent requires two perpetual legs.");
  }
  if (!Number.isFinite(longLeg.baseQuantity) || longLeg.baseQuantity <= 0
    || !Number.isFinite(shortLeg.baseQuantity) || shortLeg.baseQuantity <= 0) {
    throw new Error("Funding arbitrage leg quantities must be positive.");
  }
}

function normalizeNumberAsDecimal(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Funding arbitrage leg quantities must be positive.");
  }
  return expandExponent(String(value));
}

function normalizeDecimalString(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Maximum residual base quantity must be an unsigned decimal string.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
}

function expandExponent(value: string) {
  if (!/[eE]/u.test(value)) return value;
  const [coefficient, exponentText] = value.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer!.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}
