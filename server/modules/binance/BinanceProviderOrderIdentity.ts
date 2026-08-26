import type { BinanceProviderOrder } from "./BinanceTypes";

type ExpectedOrderIdentity = Readonly<{
  symbol: string;
  clientOrderId: string;
  providerOrderId?: string | null;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  side?: "Buy" | "Sell";
  requestedBaseQuantity?: string;
  reduceOnly?: boolean;
}>;

type SubmissionIdentity = Readonly<{
  orderId?: unknown;
  orderLinkId?: unknown;
  symbol?: unknown;
}>;

export class BinanceProviderOrderIdentityError extends Error {}

export function assertBinanceSubmissionIdentity(
  response: SubmissionIdentity,
  expected: Pick<ExpectedOrderIdentity, "symbol" | "clientOrderId">,
) {
  const orderId = providerOrderId(response.orderId);
  const clientOrderId = providerClientOrderId(response.orderLinkId);
  if (clientOrderId !== expected.clientOrderId) {
    throw new BinanceProviderOrderIdentityError("Binance submit response clientOrderId does not match the exact StellaX order.");
  }
  if (response.symbol !== undefined && providerSymbol(response.symbol) !== expected.symbol) {
    throw new BinanceProviderOrderIdentityError("Binance submit response symbol does not match the exact StellaX order.");
  }
  return Object.freeze({ orderId, orderLinkId: clientOrderId });
}

export function assertBinanceProviderOrderIdentity(
  order: BinanceProviderOrder,
  expected: ExpectedOrderIdentity,
) {
  const symbol = providerSymbol(order.symbol);
  const clientOrderId = providerClientOrderId(order.orderLinkId);
  const orderId = providerOrderId(order.orderId);
  if (symbol !== expected.symbol) {
    throw new BinanceProviderOrderIdentityError("Binance provider response symbol does not match the exact StellaX order.");
  }
  if (clientOrderId !== expected.clientOrderId) {
    throw new BinanceProviderOrderIdentityError("Binance provider response clientOrderId does not match the exact StellaX order.");
  }
  if (expected.providerOrderId !== undefined && expected.providerOrderId !== null
    && orderId !== expected.providerOrderId) {
    throw new BinanceProviderOrderIdentityError("Binance provider response orderId does not match the exact StellaX order.");
  }
  if (expected.positionSide !== undefined && order.positionSide !== expected.positionSide) {
    throw new BinanceProviderOrderIdentityError("Binance provider response positionSide does not match the execution bucket.");
  }
  if (expected.side !== undefined && order.side !== undefined && order.side !== expected.side) {
    throw new BinanceProviderOrderIdentityError("Binance provider response side does not match the execution order.");
  }
  if (expected.requestedBaseQuantity !== undefined && order.requestedBaseQuantity !== undefined
    && canonicalDecimal(order.requestedBaseQuantity) !== canonicalDecimal(expected.requestedBaseQuantity)) {
    throw new BinanceProviderOrderIdentityError("Binance provider response origQty does not match the execution order.");
  }
  if (expected.reduceOnly !== undefined && order.reduceOnly !== undefined && order.reduceOnly !== expected.reduceOnly) {
    throw new BinanceProviderOrderIdentityError("Binance provider response reduceOnly does not match the execution semantic.");
  }
  if (expected.requestedBaseQuantity !== undefined
    && compareDecimal(order.filledBaseQuantity ?? String(order.filledQuantity), expected.requestedBaseQuantity) > 0) {
    throw new BinanceProviderOrderIdentityError("Binance provider cumulative fill exceeds the execution quantity.");
  }
  return order;
}

function canonicalDecimal(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new BinanceProviderOrderIdentityError("Binance provider quantity evidence is missing or malformed.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalized = fraction.replace(/0+$/u, "");
  return normalized ? `${integer}.${normalized}` : integer!;
}

function compareDecimal(left: string, right: string) {
  const [li, lf = ""] = canonicalDecimal(left).split(".");
  const [ri, rf = ""] = canonicalDecimal(right).split(".");
  const scale = Math.max(lf.length, rf.length);
  const a = BigInt(`${li}${lf.padEnd(scale, "0")}`);
  const b = BigInt(`${ri}${rf.padEnd(scale, "0")}`);
  return a < b ? -1 : a > b ? 1 : 0;
}

function providerSymbol(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{4,30}$/u.test(value)) {
    throw new BinanceProviderOrderIdentityError("Binance provider response symbol is missing or malformed.");
  }
  return value;
}

function providerClientOrderId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,36}$/u.test(value)) {
    throw new BinanceProviderOrderIdentityError("Binance provider response clientOrderId is missing or malformed.");
  }
  return value;
}

function providerOrderId(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new BinanceProviderOrderIdentityError("Binance provider response orderId is missing or malformed.");
  }
  return value;
}
