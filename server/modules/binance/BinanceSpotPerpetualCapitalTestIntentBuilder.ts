import { randomUUID } from "node:crypto";
import type { CanonicalInstrument } from "../cex/CexCanonicalModels";
import type { SpotPerpetualFundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { SpotPerpetualFundingArbitragePlan } from "../cex/funding-arbitrage/FundingArbitragePlan";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";

export type BinanceSpotPerpetualCapitalTestQuantities = Readonly<{
  spotBaseQuantity: string;
  perpetualBaseQuantity: string;
}>;

export type BinanceSpotPerpetualCapitalTestIntentBuildParameters = Readonly<{
  now: number;
  expiresAt?: number;
  quantities: BinanceSpotPerpetualCapitalTestQuantities;
  maxResidualBaseQuantity: string;
  maxLegStartSkewMs: number;
  identityFactory?: (identity: "intent" | "spot-leg" | "perpetual-leg") => string;
}>;

export function buildBinanceSpotPerpetualCapitalTestIntent(
  instruments: readonly CanonicalInstrument[],
  decision: SpotPerpetualFundingArbitragePlan,
  parameters: BinanceSpotPerpetualCapitalTestIntentBuildParameters,
): SpotPerpetualFundingArbitrageExecutionIntent {
  assertLifecycle(decision, parameters);
  const [spotInstrument, perpetualInstrument] = assertCanonicalPair(instruments);
  const [spotLeg, perpetualLeg] = assertDecision(decision, spotInstrument, perpetualInstrument);
  const spotQuantity = normalizePositiveDecimal(parameters.quantities.spotBaseQuantity, "Spot base quantity");
  const perpetualQuantity = normalizePositiveDecimal(
    parameters.quantities.perpetualBaseQuantity,
    "Perpetual base quantity",
  );
  if (spotQuantity !== perpetualQuantity) {
    throw new Error("Binance capital test spot and perpetual quantities must match.");
  }
  if (normalizeNumberAsDecimal(spotLeg.baseQuantity) !== spotQuantity
    || normalizeNumberAsDecimal(perpetualLeg.baseQuantity) !== perpetualQuantity) {
    throw new Error("Binance capital test quantities must match the approved strategy decision.");
  }
  const maxResidualBaseQuantity = normalizeUnsignedDecimal(
    parameters.maxResidualBaseQuantity,
    "Maximum residual base quantity",
  );
  const identityFactory = parameters.identityFactory ?? (() => randomUUID());
  const intentId = identityFactory("intent");
  const spotLegId = identityFactory("spot-leg");
  const perpetualLegId = identityFactory("perpetual-leg");
  assertIdentities(intentId, spotLegId, perpetualLegId);

  return {
    intentId,
    sourcePlanId: decision.planId,
    strategyType: "SPOT_PERPETUAL",
    objective: "ESTABLISH_HEDGE",
    createdAt: parameters.now,
    expiresAt: parameters.expiresAt ?? decision.expiresAt,
    constraints: {
      maxResidualBaseQuantity,
      maxLegStartSkewMs: parameters.maxLegStartSkewMs,
    },
    legs: [
      {
        legId: spotLegId,
        role: "long",
        venue: "binance",
        instrumentId: spotInstrument.instrumentId,
        marketType: "spot",
        targetDeltaBaseQuantity: spotQuantity,
      },
      {
        legId: perpetualLegId,
        role: "short",
        venue: "binance",
        instrumentId: perpetualInstrument.instrumentId,
        marketType: "perpetual",
        targetDeltaBaseQuantity: perpetualQuantity,
      },
    ],
  };
}

function assertCanonicalPair(instruments: readonly CanonicalInstrument[]) {
  const spot = instruments.find((instrument) => instrument.instrumentId === BINANCE_SPOT_INSTRUMENT_ID);
  const perpetual = instruments.find((instrument) => instrument.instrumentId === BINANCE_PERPETUAL_INSTRUMENT_ID);
  if (!spot || !perpetual
    || spot.venue !== "binance"
    || perpetual.venue !== "binance"
    || spot.marketType !== "spot"
    || spot.contractType !== "spot"
    || perpetual.marketType !== "perpetual"
    || perpetual.contractType !== "linear_perpetual"
    || spot.baseAsset !== "XAUT"
    || perpetual.baseAsset !== "XAUT"
    || spot.quoteAsset !== "USDT"
    || perpetual.quoteAsset !== "USDT"
    || spot.settlementAsset !== "USDT"
    || perpetual.settlementAsset !== "USDT"
    || spot.quantityUnit !== "base"
    || perpetual.quantityUnit !== "base"
    || spot.status !== "trading"
    || perpetual.status !== "trading") {
    throw new Error("Binance capital test requires matching canonical XAUT/USDT spot and linear perpetual instruments.");
  }
  return [spot, perpetual] as const;
}

function assertDecision(
  decision: SpotPerpetualFundingArbitragePlan,
  spotInstrument: CanonicalInstrument,
  perpetualInstrument: CanonicalInstrument,
) {
  if (decision.strategyType !== "SPOT_PERPETUAL") {
    throw new Error(`Unsupported capital test strategy type: ${decision.strategyType}.`);
  }
  const legs = decision.legs as readonly SpotPerpetualFundingArbitragePlan["legs"][number][];
  if (legs.length !== 2) throw new Error("SPOT_PERPETUAL capital test decision requires exactly two legs.");
  const [spotLeg, perpetualLeg] = legs;
  if (!spotLeg || !perpetualLeg
    || spotLeg.role !== "long"
    || spotLeg.marketType !== "spot"
    || spotLeg.venue !== "binance"
    || spotLeg.instrumentId !== spotInstrument.instrumentId
    || spotLeg.fundingSnapshot !== null
    || perpetualLeg.role !== "short"
    || perpetualLeg.marketType !== "perpetual"
    || perpetualLeg.venue !== "binance"
    || perpetualLeg.instrumentId !== perpetualInstrument.instrumentId
    || perpetualLeg.fundingSnapshot === null
    || perpetualLeg.fundingSnapshot.venue !== "binance"
    || perpetualLeg.fundingSnapshot.instrumentId !== perpetualInstrument.instrumentId) {
    throw new Error("Binance capital test decision must be ordered spot-long and perpetual-short XAUT/USDT legs.");
  }
  if (decision.instrument.baseAsset !== "XAUT"
    || decision.instrument.quoteAsset !== "USDT"
    || decision.instrument.settlementAsset !== "USDT") {
    throw new Error("Binance capital test decision instrument identity does not match XAUT/USDT.");
  }
  return [spotLeg, perpetualLeg] as const;
}

function assertLifecycle(
  decision: SpotPerpetualFundingArbitragePlan,
  parameters: BinanceSpotPerpetualCapitalTestIntentBuildParameters,
) {
  if (!Number.isFinite(parameters.now) || !Number.isInteger(parameters.now) || parameters.now < 0) {
    throw new Error("Capital test intent creation time must be a non-negative integer timestamp.");
  }
  if (decision.expiresAt <= parameters.now) throw new Error("Capital test strategy decision has expired.");
  const expiresAt = parameters.expiresAt ?? decision.expiresAt;
  if (!Number.isFinite(expiresAt) || !Number.isInteger(expiresAt) || expiresAt <= parameters.now) {
    throw new Error("Capital test intent expiry must be after its creation time.");
  }
  if (expiresAt > decision.expiresAt) {
    throw new Error("Capital test intent expiry cannot exceed its strategy decision expiry.");
  }
  if (!Number.isFinite(parameters.maxLegStartSkewMs)
    || !Number.isInteger(parameters.maxLegStartSkewMs)
    || parameters.maxLegStartSkewMs < 0) {
    throw new Error("Maximum leg start skew must be a non-negative integer.");
  }
}

function normalizeNumberAsDecimal(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Approved strategy decision quantities must be positive.");
  }
  return expandExponent(String(value));
}

function normalizePositiveDecimal(value: string, label: string) {
  const normalized = normalizeUnsignedDecimal(value, label);
  if (normalized === "0") throw new Error(`${label} must be positive.`);
  return normalized;
}

function normalizeUnsignedDecimal(value: string, label: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
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

function assertIdentities(...identities: string[]) {
  if (identities.some((identity) => typeof identity !== "string" || !identity.trim() || identity.length > 200)) {
    throw new Error("Capital test intent identity is invalid.");
  }
  if (new Set(identities).size !== identities.length) {
    throw new Error("Capital test intent identities must be unique.");
  }
}
