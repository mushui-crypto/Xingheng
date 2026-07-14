import type { HyperliquidLimitOrderInput } from "./hyperliquidSdk";
import { normalizeHyperliquidPrice } from "./hyperliquidPrice";
import { assertValidHyperliquidSizeDecimals, normalizeHyperliquidOrderSizeInput } from "./hyperliquidSize";

export type RealTradingEntryOrderValidationInput = {
  assetId?: number;
  orderSide: "buy" | "sell";
  orderType: "limit" | "market";
  orderPrice: string;
  reduceOnly: boolean;
  size: string;
  szDecimals?: number;
  symbol: string;
};

export function buildRealTradingEntryOrderInput({
  assetId,
  orderSide,
  orderType,
  orderPrice,
  reduceOnly,
  size,
  szDecimals,
  symbol,
}: RealTradingEntryOrderValidationInput): HyperliquidLimitOrderInput {
  if (typeof assetId !== "number" || !Number.isFinite(assetId)) {
    throw new Error(`${symbol} 缺少真实交易资产映射，禁止提交真实交易。`);
  }
  const decimals = assertValidHyperliquidSizeDecimals(szDecimals, symbol);
  const normalizedSize = normalizeHyperliquidOrderSizeInput(size, decimals, symbol);
  const normalizedPrice = normalizeHyperliquidPrice(orderPrice, decimals, orderSide === "buy" ? "up" : "down");
  return {
    asset: assetId,
    isBuy: orderSide === "buy",
    market: orderType === "market",
    price: normalizedPrice,
    reduceOnly,
    size: normalizedSize,
  };
}
