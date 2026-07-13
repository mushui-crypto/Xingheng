import type { RealPosition, RealTradingSymbol } from "../../../api/realTrading";
import type { RealPositionCloseRequest, RealPositionTpslRequest } from "../model/types";
import type { HyperliquidLimitOrderInput, HyperliquidSessionSigner } from "./hyperliquidSdk";
import { normalizeHyperliquidPrice } from "./hyperliquidPrice";
import { buildPositionTpslOrders } from "./tpslOrders";

export async function submitPositionCloseRequest(
  signer: HyperliquidSessionSigner,
  request: RealPositionCloseRequest,
  symbols: RealTradingSymbol[],
) {
  if (request.positions.length === 0) throw new Error("没有可平仓的真实持仓。");
  if (request.mode === "reverse") {
    const position = request.positions[0];
    const config = resolvePositionSymbol(position, symbols);
    const closeOrder = buildCloseOrder(position, config, true);
    await signer.placeOrder(closeOrder);
    await signer.placeOrder({ ...closeOrder, reduceOnly: false });
    return;
  }

  const orders = request.positions.map((position) => {
    const config = resolvePositionSymbol(position, symbols);
    if (request.mode === "limit") {
      const price = Number(request.limitPrice);
      if (!Number.isFinite(price) || price <= 0) throw new Error("请输入有效的限价平仓价格。");
      return buildCloseOrder(position, config, false, request.limitPrice);
    }
    return buildCloseOrder(position, config, true);
  });
  await signer.placeOrders(orders);
}

export function resolvePositionSymbol(position: RealPosition, symbols: RealTradingSymbol[]) {
  const config = symbols.find((item) => item.symbol === position.symbol)
    ?? symbols.find((item) => item.providerCoin === position.coin);
  if (!config || typeof config.assetId !== "number") {
    throw new Error(`${position.coin} 缺少真实交易资产映射。`);
  }
  return config;
}

export async function submitPositionTpslRequest(
  signer: HyperliquidSessionSigner,
  request: RealPositionTpslRequest,
  symbols: RealTradingSymbol[],
) {
  const config = resolvePositionSymbol(request.position, symbols);
  const markPrice = request.position.markPx ?? request.position.markPrice;
  if (typeof markPrice !== "number" || !Number.isFinite(markPrice)) throw new Error(`${request.position.coin} 缺少有效标记价格。`);
  const triggers = buildPositionTpslOrders({
    asset: config.assetId!,
    closingIsBuy: request.position.side === "short",
    referencePrice: markPrice,
    size: formatOrderSize(request.position.size, config.szDecimals ?? 0),
    slPrice: request.slPrice,
    szDecimals: config.szDecimals ?? 0,
    tpPrice: request.tpPrice,
  });
  await signer.placePositionTpsl(triggers);
}

function buildCloseOrder(
  position: RealPosition,
  config: RealTradingSymbol,
  market: boolean,
  limitPrice?: string,
): HyperliquidLimitOrderInput {
  const isBuy = position.side === "short";
  const markPrice = position.markPx ?? position.markPrice;
  const rawPrice = market
    ? typeof markPrice === "number" && Number.isFinite(markPrice)
      ? markPrice * (isBuy ? 1.01 : 0.99)
      : NaN
    : Number(limitPrice);
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    throw new Error(`${position.coin} 缺少有效的平仓价格。`);
  }
  return {
    asset: config.assetId!,
    isBuy,
    market,
    price: normalizeHyperliquidPrice(rawPrice, config.szDecimals ?? 0, isBuy ? "up" : "down"),
    reduceOnly: true,
    size: formatOrderSize(position.size, config.szDecimals ?? 0),
  };
}

function formatOrderSize(value: number, decimals: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("持仓数量无效。");
  const fixed = value.toFixed(Math.max(0, decimals));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
