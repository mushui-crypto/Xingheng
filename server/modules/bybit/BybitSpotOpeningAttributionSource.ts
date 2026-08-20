import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { subtractUnsignedDecimals } from "../cex/arbitrage-instance/ArbitrageInstance";
import type { SpotOpeningAttributionRequest, SpotOpeningAttributionSource } from "../arbitrage-execution/BinanceSpotOpeningAttributionSource";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { BybitClient } from "./BybitClient";
import type { BybitExecutionOrderReferenceStore } from "./BybitExecutionOrderReferenceStore";
import type { BybitCredentials } from "./BybitTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;
type OpeningClient = Pick<BybitClient, "getAccountIdentity" | "getOrder">;

export class BybitSpotOpeningAttributionSource implements SpotOpeningAttributionSource {
  constructor(
    private readonly executionRecords: Pick<ExecutionRecordStore, "loadForUser">,
    private readonly credentials: Credentials,
    private readonly orderReferences: Pick<BybitExecutionOrderReferenceStore, "loadForUser">,
    private readonly clientFactory: (credential: BybitCredentials) => OpeningClient = (credential) => new BybitClient(() => credential),
  ) {}

  async readAttributableBaseQuantity(userId: string, request: SpotOpeningAttributionRequest) {
    const record = await this.executionRecords.loadForUser(userId, request.executionRecordId);
    if (!record || record.executionId !== request.executionRecordId || record.intentId !== request.executionIntentId
      || record.userId !== userId || record.venue !== "bybit" || record.accountId !== request.accountId
      || record.instrumentId !== request.instrumentId || record.status !== "CONFIRMED") {
      throw new Error("Spot opening ExecutionRecord identity is unavailable.");
    }
    const reference = await this.orderReferences.loadForUser(userId, request.executionRecordId);
    if (!reference || reference.category !== "spot" || reference.executionId !== record.executionId
      || reference.intentId !== record.intentId || reference.userId !== userId || reference.accountId !== request.accountId
      || reference.instrumentId !== request.instrumentId || reference.symbol !== request.providerSymbol
      || reference.expectedSide !== "Buy" || !decimalEquals(reference.expectedProviderQuantity, request.grossConfirmedQuantity)
      || (record.remoteOrderId !== undefined && reference.orderId !== record.remoteOrderId)) {
      throw new Error("Spot opening order reference identity is unavailable.");
    }
    const summary = this.credentials.findSummary(userId, "bybit");
    if (!summary || summary.accountId !== request.accountId) throw new Error("Spot opening account does not match the authenticated Bybit account.");
    const secret = await this.credentials.loadForExecution(userId, "bybit");
    const credential = Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret });
    const client = this.clientFactory(credential);
    const identity = await client.getAccountIdentity();
    if (identity.accountId !== request.accountId) throw new Error("Spot opening Provider identity does not match the configured Bybit account.");
    const order = await client.getOrder({
      category: "spot", symbol: reference.symbol, orderId: reference.orderId, orderLinkId: reference.orderLinkId,
    });
    if (order.category !== "spot" || order.symbol !== request.providerSymbol || order.orderId !== reference.orderId
      || order.orderLinkId !== reference.orderLinkId || order.side !== "Buy" || order.status !== "CONFIRMED"
      || !decimalEquals(order.filledQuantity, request.grossConfirmedQuantity)) {
      throw new Error("Spot opening provider order does not match the confirmed execution.");
    }
    if (order.fee === "0") return request.grossConfirmedQuantity;
    if (order.feeCurrency === null) throw new Error("Spot opening fee currency is unavailable.");
    if (order.feeCurrency !== request.baseAsset && order.feeCurrency !== quoteAsset(request.instrumentId)) {
      throw new Error("Spot opening fee currency cannot be attributed to the traded assets.");
    }
    return order.feeCurrency === request.baseAsset
      ? subtractUnsignedDecimals(request.grossConfirmedQuantity, order.fee)
      : request.grossConfirmedQuantity;
  }
}

function quoteAsset(instrumentId: string) {
  const match = /^[A-Z0-9]{2,12}-([A-Z0-9]{2,12})-SPOT$/u.exec(instrumentId);
  if (!match) throw new Error("Spot opening canonical instrument identity is invalid.");
  return match[1]!;
}
function decimalEquals(left: string, right: string) {
  const normalize = (value: string) => {
    const [integer, fraction = ""] = value.split(".");
    const normalized = fraction.replace(/0+$/u, "");
    return normalized ? `${integer}.${normalized}` : integer!;
  };
  return normalize(left) === normalize(right);
}
