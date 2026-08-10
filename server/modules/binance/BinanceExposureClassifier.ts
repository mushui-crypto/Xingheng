import type { BinancePreflightSnapshot } from "./BinanceTypes";

export type BinanceExposureClassification = "FLAT" | "FLAT_WITH_DUST" | "TRADABLE_RESIDUAL";
export type BinanceEntryExposureClassification = "FLAT" | "FLAT_WITH_DUST" | "TRADABLE_EXPOSURE";

export type BinanceEntryExposureSummary = Readonly<{
  classification: BinanceEntryExposureClassification;
  rulesValid: boolean;
  blockingReason: "INVALID_TRADING_RULES" | null;
  requiresAcknowledgement: boolean;
  spot: Readonly<{
    totalQuantityXaut: number;
    freeQuantityXaut: number;
    lockedQuantityXaut: number;
    notionalUsd: number | null;
  }>;
  perpetual: Readonly<{
    quantityXaut: number;
    direction: BinancePreflightSnapshot["perpetualPositionSide"];
  }>;
}>;

export function classifyBinanceEntryExposure(
  snapshot: BinancePreflightSnapshot,
): BinanceEntryExposureSummary {
  const spotQuantity = snapshot.existingSpotQuantityXaut;
  const perpetualQuantity = Math.abs(snapshot.existingPerpetualQuantityXaut);
  const spotRulesValid = validNonNegative(spotQuantity)
    && validPositive(snapshot.spot.minOrderQty)
    && validPositive(snapshot.spot.minNotionalUsd)
    && validPositive(snapshot.spot.bid);
  const perpetualRulesValid = Number.isFinite(perpetualQuantity)
    && validPositive(snapshot.perpetual.minOrderQty)
    && validPerpetualDirection(perpetualQuantity, snapshot.perpetualPositionSide);
  const rulesValid = spotRulesValid && perpetualRulesValid;
  const spotNotionalUsd = spotRulesValid ? spotQuantity * snapshot.spot.bid : null;
  const spotTradable = spotRulesValid
    && (spotQuantity >= snapshot.spot.minOrderQty
      || spotQuantity * snapshot.spot.bid >= snapshot.spot.minNotionalUsd);
  const perpetualTradable = perpetualRulesValid
    && perpetualQuantity > 0
    && perpetualQuantity >= snapshot.perpetual.minOrderQty;
  const hasQuantity = spotQuantity > 0 || perpetualQuantity > 0;
  const classification: BinanceEntryExposureClassification = !rulesValid || spotTradable || perpetualTradable
    ? "TRADABLE_EXPOSURE"
    : hasQuantity
      ? "FLAT_WITH_DUST"
      : "FLAT";

  return {
    classification,
    rulesValid,
    blockingReason: rulesValid ? null : "INVALID_TRADING_RULES",
    requiresAcknowledgement: rulesValid && classification === "TRADABLE_EXPOSURE",
    spot: {
      totalQuantityXaut: spotQuantity,
      freeQuantityXaut: snapshot.spotFreeXaut,
      lockedQuantityXaut: snapshot.spotLockedXaut,
      notionalUsd: spotNotionalUsd,
    },
    perpetual: {
      quantityXaut: perpetualQuantity,
      direction: snapshot.perpetualPositionSide,
    },
  };
}

export function classifyBinanceExposure(
  snapshot: BinancePreflightSnapshot,
): BinanceExposureClassification {
  if (!validOpenOrderCount(snapshot.openSpotOrderCount)
    || !validOpenOrderCount(snapshot.openPerpetualOrderCount)
    || snapshot.openSpotOrderCount + snapshot.openPerpetualOrderCount > 0) {
    return "TRADABLE_RESIDUAL";
  }
  const entry = classifyBinanceEntryExposure(snapshot);
  if (entry.classification === "TRADABLE_EXPOSURE") return "TRADABLE_RESIDUAL";
  return entry.classification;
}

function validNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function validPositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function validOpenOrderCount(value: number) {
  return Number.isInteger(value) && value >= 0;
}

function validPerpetualDirection(
  quantity: number,
  direction: BinancePreflightSnapshot["perpetualPositionSide"],
) {
  return quantity > 0 ? direction === "long" || direction === "short" : direction === "flat";
}
