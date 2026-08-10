import type { FundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinancePreflightSnapshot } from "./BinanceTypes";

export const BINANCE_CAPITAL_TEST_MAX_TOTAL_PLANNED_CAPITAL_USD = 40;

export type BinanceCapitalTestExecutionContext = Readonly<{
  userId: string;
  accountId: string;
  venue: "binance";
}>;

export type BinanceCapitalTestPreflightReason =
  | "EXECUTION_CONTEXT_INVALID"
  | "ACCOUNT_BINDING_MISMATCH"
  | "INTENT_EXPIRED"
  | "STRATEGY_UNSUPPORTED"
  | "OBJECTIVE_UNSUPPORTED"
  | "LEGS_INVALID"
  | "INSTRUMENT_UNSUPPORTED"
  | "PRODUCT_UNAVAILABLE"
  | "PERMISSIONS_INVALID"
  | "POSITION_MODE_INVALID"
  | "LEVERAGE_INVALID"
  | "MARGIN_MODE_UNCONFIRMED"
  | "QUANTITY_INVALID"
  | "QUANTITY_MISMATCH"
  | "QUANTITY_STEP_INVALID"
  | "QUANTITY_BELOW_MINIMUM"
  | "NOTIONAL_BELOW_MINIMUM"
  | "CAPITAL_ESTIMATE_UNAVAILABLE"
  | "CAPITAL_LIMIT_EXCEEDED"
  | "EXISTING_EXPOSURE"
  | "OPEN_ORDERS"
  | "CONSTRAINT_INVALID";

export type BinanceCapitalTestPreflightResult =
  | Readonly<{
    status: "PASS";
    dustEvidence?: Readonly<{
      classification: "untradeable_spot_dust";
      quantityXaut: number;
      referencePriceUsd: number;
      notionalUsd: number;
      venueMinQuantityXaut: number;
      venueMinNotionalUsd: number;
    }>;
  }>
  | Readonly<{
    status: "FAIL";
    reason: BinanceCapitalTestPreflightReason;
    message: string;
  }>;

export function preflightBinanceCapitalTest(
  context: BinanceCapitalTestExecutionContext,
  intent: FundingArbitrageExecutionIntent,
  snapshot: BinancePreflightSnapshot,
  now: number,
  maxSlippageBps: number,
): BinanceCapitalTestPreflightResult {
  if (!validIdentity(context.userId) || !validIdentity(context.accountId) || context.venue !== "binance") {
    return fail("EXECUTION_CONTEXT_INVALID", "Binance capital test requires a valid user-scoped execution context.");
  }
  if (snapshot.accountId !== context.accountId) {
    return fail("ACCOUNT_BINDING_MISMATCH", "Binance snapshot does not match the bound execution account.");
  }
  if (!Number.isFinite(now) || !Number.isInteger(now) || intent.expiresAt <= now) {
    return fail("INTENT_EXPIRED", "Funding arbitrage execution intent has expired.");
  }
  if (intent.strategyType !== "SPOT_PERPETUAL") {
    return fail("STRATEGY_UNSUPPORTED", "Binance capital test supports only SPOT_PERPETUAL.");
  }
  if (intent.objective !== "ESTABLISH_HEDGE") {
    return fail("OBJECTIVE_UNSUPPORTED", "Binance capital test supports only ESTABLISH_HEDGE.");
  }

  const legs = intent.legs as readonly FundingArbitrageExecutionIntent["legs"][number][];
  if (legs.length !== 2
    || !legs.every((leg) => validIdentity(leg.legId))
    || legs[0]!.legId === legs[1]!.legId) {
    return fail("LEGS_INVALID", "Binance capital test requires two uniquely identified legs.");
  }
  const spotLeg = legs.find((leg) => leg.marketType === "spot");
  const perpetualLeg = legs.find((leg) => leg.marketType === "perpetual");
  if (!spotLeg || !perpetualLeg
    || spotLeg.role !== "long"
    || perpetualLeg.role !== "short"
    || spotLeg.venue !== "binance"
    || perpetualLeg.venue !== "binance"
    || spotLeg.instrumentId !== BINANCE_SPOT_INSTRUMENT_ID
    || perpetualLeg.instrumentId !== BINANCE_PERPETUAL_INSTRUMENT_ID) {
    return fail("INSTRUMENT_UNSUPPORTED", "Binance capital test requires XAUTUSDT spot-long and perpetual-short legs.");
  }
  if (!snapshot.productAvailability.available
    || snapshot.productAvailability.spotSymbol !== "XAUTUSDT"
    || snapshot.productAvailability.perpetualSymbol !== "XAUTUSDT"
    || snapshot.spot.status !== "Trading"
    || snapshot.perpetual.status !== "Trading") {
    return fail("PRODUCT_UNAVAILABLE", "Binance XAUTUSDT spot and perpetual products must both be tradable.");
  }
  const permissions = snapshot.permissions;
  if (!permissions.read
    || !permissions.spotTrade
    || !permissions.contractTrade
    || permissions.withdraw
    || !permissions.ipRestricted
    || !permissions.spotAccount
    || !permissions.futuresAccount) {
    return fail(
      "PERMISSIONS_INVALID",
      "Binance capital test requires read, Spot/Futures trading, withdrawal-disabled, and IP-restricted permissions.",
    );
  }
  if (!snapshot.permissions.positionModeSupported || !snapshot.accountMode.endsWith("_one_way")) {
    return fail("POSITION_MODE_INVALID", "Binance XAUTUSDT perpetual position mode must be ONE_WAY.");
  }
  if (snapshot.perpetual.leverage !== 1) {
    return fail("LEVERAGE_INVALID", "Binance XAUTUSDT perpetual leverage must be 1x.");
  }
  if (snapshot.perpetual.marginMode !== "cross" && snapshot.perpetual.marginMode !== "isolated") {
    return fail("MARGIN_MODE_UNCONFIRMED", "Binance XAUTUSDT perpetual margin mode must be confirmed read-only.");
  }

  const spotQuantity = normalizeUnsignedDecimal(spotLeg.targetDeltaBaseQuantity);
  const perpetualQuantity = normalizeUnsignedDecimal(perpetualLeg.targetDeltaBaseQuantity);
  if (!spotQuantity || !perpetualQuantity || spotQuantity === "0" || perpetualQuantity === "0") {
    return fail("QUANTITY_INVALID", "Both Binance capital test quantities must be positive decimal strings.");
  }
  if (compareDecimals(spotQuantity, perpetualQuantity) !== 0) {
    return fail("QUANTITY_MISMATCH", "Binance capital test legs must have equal base quantities.");
  }
  if (!isDecimalMultiple(spotQuantity, numberToDecimal(snapshot.spot.qtyStep))
    || !isDecimalMultiple(perpetualQuantity, numberToDecimal(snapshot.perpetual.qtyStep))) {
    return fail("QUANTITY_STEP_INVALID", "Binance capital test quantity must align with both venue quantity steps.");
  }
  if (compareDecimals(spotQuantity, numberToDecimal(snapshot.spot.minOrderQty)) < 0
    || compareDecimals(perpetualQuantity, numberToDecimal(snapshot.perpetual.minOrderQty)) < 0) {
    return fail("QUANTITY_BELOW_MINIMUM", "Binance capital test quantity is below a venue minimum.");
  }
  const numericQuantity = Number(spotQuantity);
  if (!Number.isFinite(numericQuantity)
    || numericQuantity * snapshot.spot.ask < snapshot.spot.minNotionalUsd
    || numericQuantity * snapshot.perpetual.bid < snapshot.perpetual.minNotionalUsd) {
    return fail("NOTIONAL_BELOW_MINIMUM", "Binance capital test leg notional is below a venue minimum.");
  }
  const totalPlannedCapitalUsd = estimateTotalPlannedCapitalUsd(
    numericQuantity,
    snapshot,
    maxSlippageBps,
  );
  if (totalPlannedCapitalUsd === null) {
    return fail("CAPITAL_ESTIMATE_UNAVAILABLE", "Binance capital test planned capital cannot be estimated safely.");
  }
  if (totalPlannedCapitalUsd > BINANCE_CAPITAL_TEST_MAX_TOTAL_PLANNED_CAPITAL_USD + 1e-9) {
    return fail("CAPITAL_LIMIT_EXCEEDED", "Binance capital test total planned capital exceeds 40 USD.");
  }

  const dustEvidence = spotDustEvidence(snapshot);
  if ((snapshot.existingSpotQuantityXaut > 1e-9 && !dustEvidence)
    || Math.abs(snapshot.existingPerpetualQuantityXaut) > 1e-9) {
    return fail("EXISTING_EXPOSURE", "Existing Binance XAUT exposure must be closed before the capital test.");
  }
  if (snapshot.openSpotOrderCount > 0 || snapshot.openPerpetualOrderCount > 0) {
    return fail("OPEN_ORDERS", "Existing Binance XAUT orders must be reconciled before the capital test.");
  }

  const maxResidual = normalizeUnsignedDecimal(intent.constraints.maxResidualBaseQuantity);
  if (!maxResidual) {
    return fail("CONSTRAINT_INVALID", "Binance capital test execution constraints are invalid.");
  }

  return dustEvidence ? { status: "PASS", dustEvidence } : { status: "PASS" };
}

function spotDustEvidence(snapshot: BinancePreflightSnapshot) {
  const quantityXaut = snapshot.existingSpotQuantityXaut;
  const referencePriceUsd = snapshot.spot.bid;
  const notionalUsd = quantityXaut * referencePriceUsd;
  if (!(quantityXaut > 1e-9)
    || !Number.isFinite(referencePriceUsd)
    || referencePriceUsd <= 0
    || !Number.isFinite(notionalUsd)
    || !(quantityXaut < snapshot.spot.minOrderQty)
    || !(notionalUsd < snapshot.spot.minNotionalUsd)) {
    return null;
  }
  return {
    classification: "untradeable_spot_dust" as const,
    quantityXaut,
    referencePriceUsd,
    notionalUsd,
    venueMinQuantityXaut: snapshot.spot.minOrderQty,
    venueMinNotionalUsd: snapshot.spot.minNotionalUsd,
  };
}

function estimateTotalPlannedCapitalUsd(
  quantity: number,
  snapshot: BinancePreflightSnapshot,
  maxSlippageBps: number,
) {
  const spotReferencePrice = snapshot.spot.ask;
  const perpetualReferencePrice = Math.max(snapshot.perpetual.ask, snapshot.perpetual.mark);
  if (!Number.isFinite(quantity)
    || quantity <= 0
    || !Number.isFinite(spotReferencePrice)
    || spotReferencePrice <= 0
    || !Number.isFinite(perpetualReferencePrice)
    || perpetualReferencePrice <= 0
    || !Number.isFinite(maxSlippageBps)
    || maxSlippageBps < 0) {
    return null;
  }
  const estimate = quantity
    * (spotReferencePrice + perpetualReferencePrice)
    * (1 + maxSlippageBps / 10_000);
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

function fail(reason: BinanceCapitalTestPreflightReason, message: string): BinanceCapitalTestPreflightResult {
  return { status: "FAIL", reason, message };
}

function validIdentity(value: string) {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 200;
}

function normalizeUnsignedDecimal(value: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

function compareDecimals(left: string, right: string) {
  const aligned = alignDecimals(left, right);
  return aligned.left === aligned.right ? 0 : aligned.left > aligned.right ? 1 : -1;
}

function isDecimalMultiple(value: string, step: string) {
  const aligned = alignDecimals(value, step);
  return aligned.right > 0n && aligned.left % aligned.right === 0n;
}

function alignDecimals(left: string, right: string) {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return {
    left: parsedLeft.value * 10n ** BigInt(scale - parsedLeft.scale),
    right: parsedRight.value * 10n ** BigInt(scale - parsedRight.scale),
  };
}

function parseDecimal(value: string) {
  const normalized = normalizeUnsignedDecimal(value);
  if (!normalized) throw new Error("Invalid internal decimal value.");
  const [integer, fraction = ""] = normalized.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function numberToDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid Binance numeric constraint.");
  const text = String(value);
  if (!/[eE]/u.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer!.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}
