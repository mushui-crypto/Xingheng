import type { HyperliquidTriggerOrderInput } from "./hyperliquidSdk";
import { normalizeHyperliquidPrice } from "./hyperliquidPrice";

export function buildPositionTpslOrders({
  asset,
  closingIsBuy,
  referencePrice,
  size,
  slPrice,
  szDecimals,
  tpPrice,
}: {
  asset: number;
  closingIsBuy: boolean;
  referencePrice: number;
  size: string;
  slPrice?: string;
  szDecimals: number;
  tpPrice?: string;
}) {
  const tp = parseOptionalPrice(tpPrice);
  const sl = parseOptionalPrice(slPrice);
  if (tp === null && sl === null) throw new Error("至少填写一个止盈或止损价格。");
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error("缺少有效的参考价格。");
  validateTriggerDirection({ closingIsBuy, referencePrice, sl, tp });

  const orders: HyperliquidTriggerOrderInput[] = [];
  if (tp !== null) orders.push(buildTriggerOrder(asset, closingIsBuy, size, tp, "tp", szDecimals));
  if (sl !== null) orders.push(buildTriggerOrder(asset, closingIsBuy, size, sl, "sl", szDecimals));
  return orders;
}

function buildTriggerOrder(
  asset: number,
  isBuy: boolean,
  size: string,
  triggerPrice: number,
  tpsl: "sl" | "tp",
  szDecimals: number,
): HyperliquidTriggerOrderInput {
  const price = triggerPrice * (isBuy ? 1.1 : 0.9);
  return {
    asset,
    isBuy,
    price: normalizeHyperliquidPrice(price, szDecimals, isBuy ? "up" : "down"),
    size,
    tpsl,
    triggerPrice: normalizeHyperliquidPrice(triggerPrice, szDecimals, isBuy ? "up" : "down"),
  };
}

function parseOptionalPrice(value?: string) {
  if (!value?.trim()) return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) throw new Error("请输入有效的止盈止损价格。");
  return price;
}

function validateTriggerDirection({
  closingIsBuy,
  referencePrice,
  sl,
  tp,
}: {
  closingIsBuy: boolean;
  referencePrice: number;
  sl: number | null;
  tp: number | null;
}) {
  if (!closingIsBuy) {
    if (tp !== null && tp <= referencePrice) throw new Error("多仓止盈价必须高于参考价格。");
    if (sl !== null && sl >= referencePrice) throw new Error("多仓止损价必须低于参考价格。");
    return;
  }
  if (tp !== null && tp >= referencePrice) throw new Error("空仓止盈价必须低于参考价格。");
  if (sl !== null && sl <= referencePrice) throw new Error("空仓止损价必须高于参考价格。");
}
