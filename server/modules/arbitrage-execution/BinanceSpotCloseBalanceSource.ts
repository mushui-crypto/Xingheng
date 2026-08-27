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
}>;

export interface SpotCloseAvailableBalanceSource {
  readAvailableBalance(
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
    return this.registry.run(userId, async (service) => {
      const snapshot = await service.readSpotCloseBalance(request.baseAsset);
      if (snapshot.accountId !== request.accountId
        || snapshot.baseAsset !== request.baseAsset
      ) {
        throw new Error("Spot close available balance identity is invalid.");
      }
      return Object.freeze({
        totalQuantity: positiveOrZeroDecimal(snapshot.totalQuantity),
        availableQuantity: positiveOrZeroDecimal(snapshot.availableQuantity),
        checkedAt: snapshot.fetchedAt,
      });
    });
  }
}

function positiveOrZeroDecimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Spot close available balance is not a Decimal string.");
  }
  return value;
}
