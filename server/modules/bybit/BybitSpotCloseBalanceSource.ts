import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import type {
  SpotCloseAvailableBalance,
  SpotCloseAvailableBalanceRequest,
  SpotCloseAvailableBalanceSource,
} from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { SpotCloseBalanceReadError } from "../arbitrage-execution/BinanceSpotCloseBalanceSource";
import { BybitClient, BybitProviderError } from "./BybitClient";
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
    return Object.freeze({ ...balance, checkedAt: this.now(), verifiedAccountId: identity.accountId });
  }

  async readFreshBalance(userId: string, request: SpotCloseAvailableBalanceRequest): Promise<SpotCloseAvailableBalance> {
    const client = await this.balanceClient(userId, request);
    try {
      return Object.freeze({ ...(await client.getSpotBalance(request.baseAsset)), checkedAt: this.now() });
    } catch (error) {
      throw mapBalanceError(error);
    }
  }

  private async balanceClient(userId: string, request: SpotCloseAvailableBalanceRequest) {
    const summary = this.credentials.findSummary(userId, "bybit");
    if (!summary || summary.accountId !== request.accountId) {
      throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close account binding is invalid.", false);
    }
    if (request.providerSymbol !== `${request.baseAsset}USDT`) {
      throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close instrument binding is invalid.", false);
    }
    try {
      const secret = await this.credentials.loadForExecution(userId, "bybit");
      return this.clientFactory(Object.freeze({ apiKey: secret.apiKey, apiSecret: secret.apiSecret }));
    } catch (error) {
      throw mapBalanceError(error);
    }
  }
}

function mapBalanceError(error: unknown) {
  if (error instanceof SpotCloseBalanceReadError) return error;
  if (error instanceof BybitProviderError) {
    const providerCode = controlledProviderCode(error.providerCode);
    if (error.category === "credential_validation_failed") {
      return new SpotCloseBalanceReadError("AUTH_OR_PERMISSION_FAILED", "Bybit balance read is not authorized.", false, providerCode);
    }
    if (error.category === "provider_response_invalid") {
      return new SpotCloseBalanceReadError("PROVIDER_RESPONSE_INVALID", "Bybit balance response is invalid.", false, providerCode);
    }
    if (error.category === "provider_transport_error" || error.category === "provider_unavailable") {
      return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Bybit balance read is temporarily unavailable.", true, providerCode);
    }
    return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Bybit balance read was rejected.", false, providerCode);
  }
  return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Bybit balance read is unavailable.", false);
}

function controlledProviderCode(value: unknown) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(text) ? text : null;
}
