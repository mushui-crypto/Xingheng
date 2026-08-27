import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { BybitClient } from "./BybitClient";
import type { BybitCredentials } from "./BybitTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;

export class BybitSpotCloseBalanceSource implements SpotCloseAvailableBalanceSource {
  constructor(
    private readonly credentials: Credentials,
    private readonly now = Date.now,
    private readonly clientFactory: (credential: BybitCredentials) => Pick<BybitClient, "getAccountIdentity" | "getSpotBalance"> =
      (credential) => new BybitClient(() => credential),
  ) {}

  async readAvailableBalance(userId: string, request: SpotCloseAvailableBalanceRequest): Promise<SpotCloseAvailableBalance> {
    const summary = this.credentials.findSummary(userId, "bybit");
    if (!summary || summary.accountId !== request.accountId) throw new Error("Spot close account does not match the authenticated Bybit account.");
    if (request.providerSymbol !== `${request.baseAsset}USDT`) throw new Error("Spot close instrument identity is invalid for Bybit.");
    const secret = await this.credentials.loadForExecution(userId, "bybit");
    const credential = Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret });
    const client = this.clientFactory(credential);
    const identity = await client.getAccountIdentity();
    if (identity.accountId !== request.accountId) throw new Error("Spot close Provider identity does not match the configured Bybit account.");
    const balance = await client.getSpotBalance(request.baseAsset);
    return Object.freeze({ ...balance, checkedAt: this.now() });
  }
}
