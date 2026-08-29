export type SpotCloseAvailableBalanceRequest = Readonly<{
  accountId: string;
  instrumentId: string;
  providerSymbol: string;
  baseAsset: string;
}>;

export type SpotCloseAvailableBalance = Readonly<{
  totalQuantity?: string;
  availableQuantity: string;
  checkedAt: number;
  verifiedAccountId?: string;
}>;

export type SpotCloseBalanceReadFailureCategory =
  | "BALANCE_READER_UNAVAILABLE"
  | "ACCOUNT_IDENTITY_UNAVAILABLE"
  | "SPOT_BALANCE_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "IDENTITY_MISMATCH"
  | "AUTH_OR_PERMISSION_FAILED";

export class SpotCloseBalanceReadError extends Error {
  constructor(
    readonly category: SpotCloseBalanceReadFailureCategory,
    message: string,
    readonly transient: boolean,
    readonly providerCode: string | null = null,
  ) {
    super(message);
  }
}

export interface SpotCloseAvailableBalanceSource {
  readAvailableBalance(
    userId: string,
    request: SpotCloseAvailableBalanceRequest,
  ): Promise<SpotCloseAvailableBalance>;
  /**
   * Final, attempt-scoped balance refresh after the account identity has
   * already been authoritatively verified by the same close-safety pass.
   */
  readFreshBalance(
    userId: string,
    request: SpotCloseAvailableBalanceRequest,
  ): Promise<SpotCloseAvailableBalance>;
}

type Registry = Readonly<{
  run<T>(
    userId: string,
    operation: (service: Readonly<{
      readSpotCloseBalance(baseAsset: string): Promise<Readonly<{
        accountId: string;
        baseAsset: string;
        totalQuantity: string;
        availableQuantity: string;
        fetchedAt: number;
      }>>;
    }>) => Promise<T> | T,
  ): Promise<T>;
}>;

/** Reads Binance's exact Decimal `free` balance through the existing user-scoped execution client. */
export class BinanceSpotCloseBalanceSource implements SpotCloseAvailableBalanceSource {
  constructor(private readonly registry: Registry) {}

  readAvailableBalance(userId: string, request: SpotCloseAvailableBalanceRequest) {
    return this.readBalance(userId, request, true);
  }

  readFreshBalance(userId: string, request: SpotCloseAvailableBalanceRequest) {
    return this.readBalance(userId, request, false);
  }

  private readBalance(userId: string, request: SpotCloseAvailableBalanceRequest, includeVerifiedIdentity: boolean) {
    return this.registry.run(userId, async (service) => {
      let snapshot;
      try {
        snapshot = await service.readSpotCloseBalance(request.baseAsset);
      } catch (error) {
        throw mapBalanceError(error);
      }
      if (snapshot.accountId !== request.accountId
        || snapshot.baseAsset !== request.baseAsset
      ) {
        throw new SpotCloseBalanceReadError("IDENTITY_MISMATCH", "Spot close balance scope is invalid.", false);
      }
      try {
        return Object.freeze({
          totalQuantity: positiveOrZeroDecimal(snapshot.totalQuantity),
          availableQuantity: positiveOrZeroDecimal(snapshot.availableQuantity),
          checkedAt: snapshot.fetchedAt,
          ...(includeVerifiedIdentity ? { verifiedAccountId: snapshot.accountId } : {}),
        });
      } catch {
        throw new SpotCloseBalanceReadError("PROVIDER_RESPONSE_INVALID", "Spot close balance response is invalid.", false);
      }
    });
  }
}

function mapBalanceError(error: unknown) {
  if (error instanceof SpotCloseBalanceReadError) return error;
  const category = error && typeof error === "object" && "category" in error
    ? String((error as { category: unknown }).category) : "";
  const providerCode = error && typeof error === "object" && "providerCode" in error
    ? controlledProviderCode((error as { providerCode: unknown }).providerCode) : null;
  if (category === "credential_validation_failed" || category === "provider_permission_error") {
    return new SpotCloseBalanceReadError("AUTH_OR_PERMISSION_FAILED", "Binance balance read is not authorized.", false, providerCode);
  }
  if (category === "provider_response_invalid") {
    return new SpotCloseBalanceReadError("PROVIDER_RESPONSE_INVALID", "Binance balance response is invalid.", false, providerCode);
  }
  if (category === "provider_timeout" || category === "provider_transport_error" || category === "provider_unavailable") {
    return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Binance balance read is temporarily unavailable.", true, providerCode);
  }
  return new SpotCloseBalanceReadError("SPOT_BALANCE_UNAVAILABLE", "Binance balance read is unavailable.", false, providerCode);
}

function controlledProviderCode(value: unknown) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(text) ? text : null;
}

function positiveOrZeroDecimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Spot close available balance is not a Decimal string.");
  }
  return value;
}
