import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { OkxClient } from "./OkxClient";
import type { OkxCredentials } from "./OkxTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;
type BalanceClient = Pick<OkxClient, "getAccountIdentity" | "getSpotBalance">;

/** Reads OKX Spot available base balance through the authenticated, user-scoped GET client. */
export class OkxSpotCloseBalanceSource implements SpotCloseAvailableBalanceSource {
  constructor(
    private readonly credentials: Credentials,
    private readonly now = Date.now,
    private readonly clientFactory: (credential: OkxCredentials) => BalanceClient =
      (credential) => new OkxClient(() => credential),
  ) {}

  async readAvailableBalance(userId: string, request: SpotCloseAvailableBalanceRequest): Promise<SpotCloseAvailableBalance> {
    const summary = this.credentials.findSummary(userId, "okx");
    if (!summary || summary.accountId !== request.accountId) {
      throw new Error("Spot close account does not match the authenticated OKX account.");
    }
    if (request.providerSymbol !== `${request.baseAsset}-USDT`) {
      throw new Error("Spot close instrument identity is invalid for OKX.");
    }
    const secret = await this.credentials.loadForExecution(userId, "okx");
    const credential = normalizeCredential(secret);
    const client = this.clientFactory(credential);
    const [identity, balance] = await Promise.all([
      client.getAccountIdentity(),
      client.getSpotBalance(request.baseAsset),
    ]);
    if (identity.accountId !== request.accountId) {
      throw new Error("Spot close Provider identity does not match the configured OKX account.");
    }
    return Object.freeze({ ...balance, checkedAt: this.now() });
  }
}

function normalizeCredential(input: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): OkxCredentials {
  if (!input.passphrase) throw new Error("OKX credential passphrase is not configured.");
  return Object.freeze({ apiKey: input.apiKey, apiSecret: input.apiSecret, passphrase: input.passphrase });
}
