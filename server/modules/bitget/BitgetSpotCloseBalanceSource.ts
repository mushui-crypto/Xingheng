import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { BitgetClient } from "./BitgetClient";
import type { BitgetCredentials } from "./BitgetTypes";

type Credentials = Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution">;
type BalanceClient = Pick<BitgetClient, "getAccountIdentity" | "getSpotBalance">;

/** Reads one exact Decimal UTA Spot balance for a user-owned Bitget account. */
export class BitgetSpotCloseBalanceSource implements SpotCloseAvailableBalanceSource {
  constructor(
    private readonly credentials: Credentials,
    private readonly now: () => number = Date.now,
    private readonly clientFactory: (credential: BitgetCredentials) => BalanceClient =
      (credential) => new BitgetClient(() => credential),
  ) {}

  async readAvailableBalance(
    userId: string,
    request: SpotCloseAvailableBalanceRequest,
  ): Promise<SpotCloseAvailableBalance> {
    const summary = this.credentials.findSummary(userId, "bitget");
    if (!summary || summary.accountId !== request.accountId || summary.permissions.providerVerified !== true) {
      throw new Error("Spot close account does not match the authenticated Bitget account.");
    }
    if (request.providerSymbol !== `${request.baseAsset}USDT`) {
      throw new Error("Spot close instrument identity is invalid for Bitget.");
    }
    const secret = await this.credentials.loadForExecution(userId, "bitget");
    const client = this.clientFactory(bitgetCredential(secret));
    const identity = await client.getAccountIdentity();
    if (identity.accountId !== request.accountId) {
      throw new Error("Spot close Provider identity does not match the configured Bitget account.");
    }
    const checkedAt = this.now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new Error("Spot close balance clock is invalid.");
    return Object.freeze({ ...(await client.getSpotBalance(request.baseAsset)), checkedAt });
  }
}

function bitgetCredential(secret: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): BitgetCredentials {
  if (!secret.passphrase?.trim()) throw new Error("Bitget credential passphrase is not configured.");
  return Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret, passphrase: secret.passphrase });
}
