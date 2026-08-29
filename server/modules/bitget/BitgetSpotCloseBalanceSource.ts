import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { SpotCloseBalanceReadError } from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { BitgetClient, BitgetProviderError } from "./BitgetClient";
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
    return Object.freeze({
      ...(await client.getSpotBalance(request.baseAsset)), checkedAt, verifiedAccountId: identity.accountId,
    });
  }

  async readFreshBalance(
    userId: string,
    request: SpotCloseAvailableBalanceRequest,
  ): Promise<SpotCloseAvailableBalance> {
    const client = await this.balanceClient(userId, request);
    try {
      const checkedAt = this.now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
        throw new SpotCloseBalanceReadError("PROVIDER_RESPONSE_INVALID", "Spot close balance clock is invalid.", false);
      }
      return Object.freeze({ ...(await client.getSpotBalance(request.baseAsset)), checkedAt });
    } catch (error) {
      throw mapBalanceError(error);
    }
  }

  private async balanceClient(userId: string, request: SpotCloseAvailableBalanceRequest) {
    const summary = this.credentials.findSummary(userId, "bitget");
    if (!summary || summary.accountId !== request.accountId || summary.permissions.providerVerified !== true) {
      throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close account binding is invalid.", false);
    }
    if (request.providerSymbol !== `${request.baseAsset}USDT`) {
      throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close instrument binding is invalid.", false);
    }
    try {
      const secret = await this.credentials.loadForExecution(userId, "bitget");
      return this.clientFactory(bitgetCredential(secret));
    } catch (error) {
      throw mapBalanceError(error);
    }
  }
}

function mapBalanceError(error: unknown) {
  if (error instanceof SpotCloseBalanceReadError) return error;
  if (error instanceof BitgetProviderError) {
    if (error.category === "credential_validation_failed") {
      return new SpotCloseBalanceReadError("AUTH_OR_PERMISSION_FAILED", "Bitget balance read is not authorized.", false, error.providerCode);
    }
    if (error.category === "provider_response_invalid") {
      return new SpotCloseBalanceReadError("PROVIDER_RESPONSE_INVALID", "Bitget balance response is invalid.", false, error.providerCode);
    }
    if (error.category === "provider_transport_error" || error.category === "provider_unavailable") {
      return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Bitget balance read is temporarily unavailable.", true, error.providerCode);
    }
    return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Bitget balance read was rejected.", false, error.providerCode);
  }
  return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Bitget balance read is unavailable.", false);
}

function bitgetCredential(secret: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): BitgetCredentials {
  if (!secret.passphrase?.trim()) throw new Error("Bitget credential passphrase is not configured.");
  return Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret, passphrase: secret.passphrase });
}
