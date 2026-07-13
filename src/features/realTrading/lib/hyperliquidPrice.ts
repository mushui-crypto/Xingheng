import { formatPrice } from "@nktkas/hyperliquid/utils";

export type HyperliquidPriceDirection = "up" | "down";

export function normalizeHyperliquidPrice(
  value: string | number,
  szDecimals: number,
  direction: HyperliquidPriceDirection = "down",
) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error("请输入有效的价格。");
  }

  const normalizedSizeDecimals = Math.max(0, Math.trunc(szDecimals));
  const formattedDown = formatPrice(value, normalizedSizeDecimals, "perp");
  if (direction === "down" || Number(formattedDown) >= numericValue) {
    return formattedDown;
  }

  const maxDecimals = Math.max(0, 6 - normalizedSizeDecimals);
  const exponent = Math.floor(Math.log10(numericValue));
  const significantDecimals = Math.max(0, 4 - exponent);
  const allowedDecimals = Math.min(maxDecimals, significantDecimals);
  const scale = 10 ** allowedDecimals;
  const scaledValue = numericValue * scale;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaledValue));
  const roundedUp = Math.ceil(scaledValue - tolerance) / scale;

  return formatPrice(roundedUp.toFixed(allowedDecimals), normalizedSizeDecimals, "perp");
}
