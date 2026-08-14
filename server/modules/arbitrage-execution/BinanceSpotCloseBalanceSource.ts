import type { BinanceGenericRiskSnapshotRequest } from "../binance/BinanceTypes";

export type SpotCloseAvailableBalanceRequest = Readonly<{
  accountId: string;
  instrumentId: string;
  providerSymbol: string;
  baseAsset: string;
}>;

export type SpotCloseAvailableBalance = Readonly<{
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
      executionAccountIdentity(): Promise<Readonly<{ accountId: string }>>;
      readExecutionRiskSnapshot(request: BinanceGenericRiskSnapshotRequest): Promise<Readonly<{
        accountId: string;
        category: "spot" | "linear";
        symbol: string;
        baseAsset: string;
        availableBaseAsset: string | null;
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
      const identity = await service.executionAccountIdentity();
      if (identity.accountId !== request.accountId) {
        throw new Error("Spot close account does not match the authenticated Binance account.");
      }
      const snapshot = await service.readExecutionRiskSnapshot({
        category: "spot",
        symbol: request.providerSymbol,
        baseAsset: request.baseAsset,
      });
      if (snapshot.accountId !== request.accountId
        || snapshot.category !== "spot"
        || snapshot.symbol !== request.providerSymbol
        || snapshot.baseAsset !== request.baseAsset
        || snapshot.availableBaseAsset === null) {
        throw new Error("Spot close available balance identity is invalid.");
      }
      return Object.freeze({
        availableQuantity: positiveOrZeroDecimal(snapshot.availableBaseAsset),
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
