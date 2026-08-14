import type { BinanceProviderOrder } from "./BinanceTypes";

type ExpectedOrderIdentity = Readonly<{
  symbol: string;
  clientOrderId: string;
  providerOrderId?: string | null;
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
  return order;
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
