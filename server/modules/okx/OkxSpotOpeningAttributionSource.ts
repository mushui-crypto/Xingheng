import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type {
  SpotOpeningAttributionRequest,
  SpotOpeningAttributionSource,
} from "../arbitrage-execution/BinanceSpotOpeningAttributionSource";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { OkxClient } from "./OkxClient";
import type { OkxExecutionOrderReferenceStore } from "./OkxExecutionOrderReferenceStore";
import type { OkxCredentials } from "./OkxTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;
type OpeningOrderClient = Pick<OkxClient, "getAccountIdentity" | "getOrder">;

/** Verifies the confirmed OKX Spot opening order before allowing a Spot close. */
export class OkxSpotOpeningAttributionSource implements SpotOpeningAttributionSource {
  constructor(
    private readonly executionRecords: Pick<ExecutionRecordStore, "loadForUser">,
    private readonly credentials: Credentials,
    private readonly orderReferences: Pick<OkxExecutionOrderReferenceStore, "loadForUser">,
    private readonly clientFactory: (credential: OkxCredentials) => OpeningOrderClient = (credential) =>
      new OkxClient(() => credential),
  ) {}

  async readAttributableBaseQuantity(userId: string, request: SpotOpeningAttributionRequest) {
    const record = await this.executionRecords.loadForUser(userId, request.executionRecordId);
    if (!record
      || record.executionId !== request.executionRecordId
      || record.intentId !== request.executionIntentId
      || record.userId !== userId
      || record.venue !== "okx"
      || record.accountId !== request.accountId
      || record.instrumentId !== request.instrumentId
      || record.status !== "CONFIRMED") {
      throw new Error("Spot opening ExecutionRecord identity is unavailable.");
    }
    const reference = await this.orderReferences.loadForUser(userId, request.executionRecordId);
    if (!reference
      || reference.executionId !== record.executionId
      || reference.intentId !== record.intentId
      || reference.userId !== userId
      || reference.accountId !== request.accountId
      || reference.instrumentId !== request.instrumentId
      || reference.instId !== request.providerSymbol
      || reference.expectedSide !== "buy"
      || reference.expectedProviderQuantity === undefined
      || !decimalEquals(reference.expectedProviderQuantity, request.grossConfirmedQuantity)
      || (record.remoteOrderId !== undefined && record.remoteOrderId !== reference.ordId)) {
      throw new Error("Spot opening order reference identity is unavailable.");
    }
    const summary = this.credentials.findSummary(userId, "okx");
    if (!summary || summary.accountId !== request.accountId) {
      throw new Error("Spot opening account does not match the authenticated OKX account.");
    }
    const secret = await this.credentials.loadForExecution(userId, "okx");
    const credential = normalizeCredential(secret);
    const client = this.clientFactory(credential);
    const identity = await client.getAccountIdentity();
    if (identity.accountId !== request.accountId) {
      throw new Error("Spot opening Provider identity does not match the configured OKX account.");
    }
    const order = await client.getOrder({
      instId: reference.instId,
      ordId: reference.ordId,
      clOrdId: reference.clOrdId,
    });
    if (order.instId !== request.providerSymbol
      || order.ordId !== reference.ordId
      || order.clOrdId !== reference.clOrdId
      || order.side !== reference.expectedSide
      || order.status !== "CONFIRMED"
      || !decimalEquals(order.filledQuantity, request.grossConfirmedQuantity)) {
      throw new Error("Spot opening provider order does not match the confirmed execution.");
    }
    return request.grossConfirmedQuantity;
  }
}

function normalizeCredential(input: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): OkxCredentials {
  if (!input.passphrase) throw new Error("OKX credential passphrase is not configured.");
  return Object.freeze({ apiKey: input.apiKey, apiSecret: input.apiSecret, passphrase: input.passphrase });
}

function decimalEquals(left: string, right: string) {
  return canonicalDecimal(left) === canonicalDecimal(right);
}

function canonicalDecimal(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/u, "");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return `${normalizedInteger}.${normalizedFraction}`.replace(/\.0*$/u, "");
}
