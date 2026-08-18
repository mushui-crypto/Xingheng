import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type {
  SpotOpeningAttributionRequest,
  SpotOpeningAttributionSource,
} from "../arbitrage-execution/BinanceSpotOpeningAttributionSource";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { OkxClient } from "./OkxClient";
import type { OkxCredentials } from "./OkxTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;

/** Verifies the confirmed OKX Spot opening order before allowing a Spot close. */
export class OkxSpotOpeningAttributionSource implements SpotOpeningAttributionSource {
  constructor(
    private readonly executionRecords: Pick<ExecutionRecordStore, "loadForUser">,
    private readonly credentials: Credentials,
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
      || record.status !== "CONFIRMED"
      || !record.remoteOrderId) {
      throw new Error("Spot opening ExecutionRecord identity is unavailable.");
    }
    const summary = this.credentials.findSummary(userId, "okx");
    if (!summary || summary.accountId !== request.accountId) {
      throw new Error("Spot opening account does not match the authenticated OKX account.");
    }
    const secret = await this.credentials.loadForExecution(userId, "okx");
    const credential = normalizeCredential(secret);
    const client = new OkxClient(() => credential);
    const identity = await client.getAccountIdentity();
    if (identity.accountId !== request.accountId) {
      throw new Error("Spot opening Provider identity does not match the configured OKX account.");
    }
    const order = await client.getOrder({ instId: request.providerSymbol, ordId: record.remoteOrderId });
    if (order.instId !== request.providerSymbol
      || order.ordId !== record.remoteOrderId
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
