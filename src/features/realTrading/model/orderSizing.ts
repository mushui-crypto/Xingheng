import { formatHyperliquidOrderSizeFloor } from "../lib/hyperliquidSize";

export const defaultRealTradingOrderType = "market" as const;

export type RealTradingOrderSizingInput = {
  availableMargin?: number | null;
  leverage?: number | null;
  orderPrice?: number | null;
  positionSize?: number | null;
  reduceOnly: boolean;
  symbol: string;
  szDecimals?: number | null;
};

export function resolveMaximumOrderQuantity(input: RealTradingOrderSizingInput) {
  const rawMaximum = input.reduceOnly
    ? positiveNumber(input.positionSize)
    : resolveOpenQuantity(input);
  try {
    return formatHyperliquidOrderSizeFloor(rawMaximum, input.szDecimals, input.symbol);
  } catch {
    return "";
  }
}

export function resolveQuantityForPercent(
  maximumQuantity: string,
  percent: number,
  szDecimals: number | null | undefined,
  symbol: string,
) {
  const normalizedPercent = normalizeOrderPercent(percent);
  const maximum = Number(maximumQuantity);
  if (!(maximum > 0) || normalizedPercent <= 0) return "";
  if (normalizedPercent === 100) return maximumQuantity;
  try {
    return formatHyperliquidOrderSizeFloor(maximum * (normalizedPercent / 100), szDecimals, symbol);
  } catch {
    return "";
  }
}

export function resolvePercentForQuantity(quantity: string, maximumQuantity: string) {
  const numericQuantity = Number(quantity);
  const maximum = Number(maximumQuantity);
  if (!(numericQuantity > 0) || !(maximum > 0)) return 0;
  return normalizeOrderPercent((numericQuantity / maximum) * 100);
}

export function resolveOrderValue(quantity: string, orderPrice?: number | null) {
  const numericQuantity = Number(quantity);
  const price = positiveNumber(orderPrice);
  if (!(numericQuantity > 0) || !(price > 0)) return null;
  const notional = numericQuantity * price;
  return Number.isFinite(notional) ? notional : null;
}

export function normalizeOrderPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function resolveOpenQuantity(input: RealTradingOrderSizingInput) {
  const margin = positiveNumber(input.availableMargin);
  const leverage = positiveNumber(input.leverage);
  const price = positiveNumber(input.orderPrice);
  if (!(margin > 0) || !(leverage > 0) || !(price > 0)) return 0;
  return (margin * leverage) / price;
}

function positiveNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
