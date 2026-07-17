import type { RealPosition, RealTradingSymbol } from "../../../api/realTrading";
import type { RealPositionCloseRequest, RealPositionTpslRequest } from "../model/types";
import type { HyperliquidLimitOrderInput, HyperliquidSessionSigner } from "./hyperliquidSdk";
import { normalizeHyperliquidPrice } from "./hyperliquidPrice";
import { assertValidHyperliquidSizeDecimals, formatHyperliquidOrderSizeFloor } from "./hyperliquidSize";
import { resolveRealTradingSymbolForRecord } from "./realTradingMarket";
import { buildPositionTpslOrders } from "./tpslOrders";
import { deriveHyperliquidCloid, type HyperliquidCloid } from "./hyperliquidCloid";

export async function submitPositionCloseRequest(
  signer: HyperliquidSessionSigner,
  request: RealPositionCloseRequest,
  symbols: RealTradingSymbol[],
) {
  if (request.positions.length === 0) throw new Error("没有可平仓的真实持仓。");
  if (request.mode === "reverse") {
    const position = request.positions[0];
    const config = resolvePositionSymbol(position, symbols);
    const closeOrder = buildCloseOrder(position, config, true, undefined, deriveHyperliquidCloid(request.cloid, "reverse-close"));
    await signer.placeOrder(closeOrder);
    await signer.placeOrder({ ...closeOrder, cloid: deriveHyperliquidCloid(request.cloid, "reverse-open"), reduceOnly: false });
    return;
  }

  const orders = request.positions.map((position, index) => {
    const config = resolvePositionSymbol(position, symbols);
    if (request.mode === "limit") {
      const price = Number(request.limitPrice);
      if (!Number.isFinite(price) || price <= 0) throw new Error("请输入有效的限价平仓价格。");
      return buildCloseOrder(position, config, false, request.limitPrice, deriveHyperliquidCloid(request.cloid, `close:${index}`));
    }
    return buildCloseOrder(position, config, true, undefined, deriveHyperliquidCloid(request.cloid, `close:${index}`));
  });
  await signer.placeOrders(orders);
}

export function resolvePositionSymbol(position: RealPosition, symbols: RealTradingSymbol[]) {
  const config = resolveRealTradingSymbolForRecord(position, symbols);
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
  const szDecimals = assertValidHyperliquidSizeDecimals(config.szDecimals, config.symbol);
  const triggers = buildPositionTpslOrders({
    asset: config.assetId!,
    closingIsBuy: request.position.side === "short",
    parentCloid: request.cloid,
    referencePrice: markPrice,
    size: formatPositionOrderSize(request.position.size, szDecimals, config.symbol),
    slPrice: request.slPrice,
    szDecimals,
    tpPrice: request.tpPrice,
  });
  await signer.placePositionTpsl(triggers);
}

function buildCloseOrder(
  position: RealPosition,
  config: RealTradingSymbol,
  market: boolean,
  limitPrice?: string,
  cloid?: HyperliquidCloid,
): HyperliquidLimitOrderInput {
  if (!cloid) throw new Error("平仓请求缺少 Hyperliquid cloid。");
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
  const szDecimals = assertValidHyperliquidSizeDecimals(config.szDecimals, config.symbol);
  return {
    asset: config.assetId!,
    cloid,
    isBuy,
    market,
    price: normalizeHyperliquidPrice(rawPrice, szDecimals, isBuy ? "up" : "down"),
    reduceOnly: true,
    size: formatPositionOrderSize(position.size, szDecimals, config.symbol),
  };
}

function formatPositionOrderSize(value: number, decimals: number, symbol: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("持仓数量无效。");
  const formatted = formatHyperliquidOrderSizeFloor(value, decimals, symbol);
  if (!formatted) throw new Error("持仓数量无效。");
  return formatted;
}
