/**
 * Hyperliquid perpetual price constraints are derived from the asset's official
 * `szDecimals` metadata. Non-integer order prices are additionally limited to
 * five significant figures; callers must still use the SDK's `formatPrice` for
 * order-price formatting.
 */
export const hyperliquidPerpMaxPriceDecimals = 6;
export const hyperliquidNonIntegerPriceSignificantFigures = 5;

/**
 * Validate official perpetual size precision metadata without coercion.
 * Invalid or missing metadata must not be represented as a usable precision.
 */
export function normalizeHyperliquidPerpSzDecimals(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= hyperliquidPerpMaxPriceDecimals
    ? value
    : null;
}

/**
 * Stable display precision for a Hyperliquid perpetual market.
 * This is the protocol decimal-place ceiling, not a complete tick validator.
 */
export function getHyperliquidPerpDisplayPriceDecimals(szDecimals: number): number {
  const normalized = normalizeHyperliquidPerpSzDecimals(szDecimals);
  if (normalized === null) {
    throw new Error("Hyperliquid perpetual szDecimals is invalid.");
  }
  return hyperliquidPerpMaxPriceDecimals - normalized;
}
