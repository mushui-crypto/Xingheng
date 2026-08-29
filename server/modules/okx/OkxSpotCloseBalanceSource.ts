import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { SpotCloseBalanceReadError } from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { OkxClient } from "./OkxClient";
import { OkxProviderError } from "./OkxClient";
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
    const client = await this.client(userId, request);
    let identity;
    try {
      identity = await client.getAccountIdentity();
    } catch (error) {
      throw mapReadError(error, "ACCOUNT_IDENTITY_UNAVAILABLE");
    }
    if (identity.accountId !== request.accountId) {
      throw new SpotCloseBalanceReadError(
        "IDENTITY_MISMATCH",
        "Spot close Provider identity does not match the configured OKX account.",
        false,
      );
    }
    const balance = await this.readBalance(client, request.baseAsset);
    return Object.freeze({ ...balance, verifiedAccountId: identity.accountId });
  }

  async readFreshBalance(userId: string, request: SpotCloseAvailableBalanceRequest): Promise<SpotCloseAvailableBalance> {
    const client = await this.client(userId, request);
    return this.readBalance(client, request.baseAsset);
  }

  private async client(userId: string, request: SpotCloseAvailableBalanceRequest) {
    const summary = this.credentials.findSummary(userId, "okx");
    if (!summary || summary.accountId !== request.accountId) {
      throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close account binding is invalid.", false);
    }
    if (request.providerSymbol !== `${request.baseAsset}-USDT`) {
      throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close instrument identity is invalid.", false);
    }
    try {
      const secret = await this.credentials.loadForExecution(userId, "okx");
      return this.clientFactory(normalizeCredential(secret));
    } catch (error) {
      throw mapReadError(error, "ACCOUNT_IDENTITY_UNAVAILABLE");
    }
  }

  private async readBalance(client: BalanceClient, baseAsset: string) {
    try {
      const balance = await client.getSpotBalance(baseAsset);
      return Object.freeze({ ...balance, checkedAt: this.now() });
    } catch (error) {
      throw mapReadError(error, "SPOT_BALANCE_UNAVAILABLE");
    }
  }
}

function normalizeCredential(input: Readonly<{ apiKey: string; apiSecret: string; passphrase?: string }>): OkxCredentials {
  if (!input.passphrase) {
    throw new SpotCloseBalanceReadError("AUTH_OR_PERMISSION_FAILED", "OKX credential is incomplete.", false);
  }
  return Object.freeze({ apiKey: input.apiKey, apiSecret: input.apiSecret, passphrase: input.passphrase });
}

function mapReadError(
  error: unknown,
  unavailable: "ACCOUNT_IDENTITY_UNAVAILABLE" | "SPOT_BALANCE_UNAVAILABLE",
) {
  if (error instanceof SpotCloseBalanceReadError) return error;
  if (error instanceof OkxProviderError) {
    if (error.category === "credential_validation_failed") {
      return new SpotCloseBalanceReadError("AUTH_OR_PERMISSION_FAILED", "OKX account read is not authorized.", false, error.providerCode);
    }
    if (error.category === "provider_response_invalid") {
      return new SpotCloseBalanceReadError("PROVIDER_RESPONSE_INVALID", "OKX account response is invalid.", false, error.providerCode);
    }
    if (error.category === "provider_timeout" || error.category === "provider_transport_error") {
      return new SpotCloseBalanceReadError(unavailable, "OKX account read is temporarily unavailable.", true, error.providerCode);
    }
    return new SpotCloseBalanceReadError(unavailable, "OKX account read was rejected.", false, error.providerCode);
  }
  return new SpotCloseBalanceReadError(unavailable, "OKX account read is unavailable.", false);
}
