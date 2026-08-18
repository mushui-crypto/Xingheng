import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { OkxClient } from "./OkxClient";
import type { OkxCredentials } from "./OkxTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;

/** Reads OKX Spot available base balance through the authenticated, user-scoped GET client. */
export class OkxSpotCloseBalanceSource implements SpotCloseAvailableBalanceSource {
  constructor(private readonly credentials: Credentials, private readonly now = Date.now) {}

  async readAvailableBalance(userId: string, request: SpotCloseAvailableBalanceRequest): Promise<SpotCloseAvailableBalance> {
    const summary = this.credentials.findSummary(userId, "okx");
    if (!summary || summary.accountId !== request.accountId) {
      throw new Error("Spot close account does not match the authenticated OKX account.");
    }
    const secret = await this.credentials.loadForExecution(userId, "okx");
    const credential = normalizeCredential(secret);
    const client = new OkxClient(() => credential);
    const identity = await client.getAccountIdentity();
    if (identity.accountId !== request.accountId) {
      throw new Error("Spot close Provider identity does not match the configured OKX account.");
    }
    if (request.providerSymbol !== `${request.baseAsset}-USDT`) {
      throw new Error("Spot close instrument identity is invalid for OKX.");
    }
    const availableQuantity = await client.getSpotAvailableBalance(request.baseAsset);
    return Object.freeze({ availableQuantity, checkedAt: this.now() });
  }
}

function normalizeCredential(input: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): OkxCredentials {
  if (!input.passphrase) throw new Error("OKX credential passphrase is not configured.");
  return Object.freeze({ apiKey: input.apiKey, apiSecret: input.apiSecret, passphrase: input.passphrase });
}
