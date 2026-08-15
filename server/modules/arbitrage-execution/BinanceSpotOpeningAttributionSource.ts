import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { subtractUnsignedDecimals } from "../cex/arbitrage-instance/ArbitrageInstance";
import { binanceExecutionIdempotencyKeyFor } from "../binance/BinanceIntentExecutionService";
import { BinanceStoredOrderManualReconciliationError } from "../binance/BinanceOrderStore";

export type SpotOpeningAttributionRequest = Readonly<{
  accountId: string;
  instrumentId: string;
  providerSymbol: string;
  baseAsset: string;
  executionIntentId: string;
  executionRecordId: string;
  grossConfirmedQuantity: string;
}>;

export interface SpotOpeningAttributionSource {
  readAttributableBaseQuantity(userId: string, request: SpotOpeningAttributionRequest): Promise<string>;
}

type Registry = Readonly<{
  run<T>(
    userId: string,
    operation: (service: Readonly<{
      executionAccountIdentity(): Promise<Readonly<{ accountId: string }>>;
      executionOrderState(idempotencyKey: string):
        | { kind: "missing" }
        | { kind: "isolated"; isolation: ConstructorParameters<typeof BinanceStoredOrderManualReconciliationError>[0] }
        | { kind: "found"; order: Readonly<{
          category: "spot" | "linear";
          symbol: string;
          providerOrderId: string | null;
          clientOrderId: string;
        }> };
      readSpotOrderFills(symbol: string, orderId: string, baseAsset: string): Promise<Readonly<{
        symbol: string;
        providerOrderId: string;
        grossBaseQuantity: string;
        baseCommissionQuantity: string;
      }>>;
    }>) => Promise<T> | T,
  ): Promise<T>;
}>;

/** Resolves one confirmed Spot opening reference to its exact Binance order and authoritative fills. */
export class BinanceSpotOpeningAttributionSource implements SpotOpeningAttributionSource {
  constructor(
    private readonly executionRecords: Pick<ExecutionRecordStore, "loadForUser">,
    private readonly registry: Registry,
  ) {}

  async readAttributableBaseQuantity(userId: string, request: SpotOpeningAttributionRequest) {
    const record = await this.executionRecords.loadForUser(userId, request.executionRecordId);
    if (!record
      || record.executionId !== request.executionRecordId
      || record.intentId !== request.executionIntentId
      || record.userId !== userId
      || record.venue !== "binance"
      || record.accountId !== request.accountId
      || record.instrumentId !== request.instrumentId
      || record.status !== "CONFIRMED"
      || !record.remoteOrderId) {
      throw new Error("Spot opening ExecutionRecord identity is unavailable.");
    }
    return this.registry.run(userId, async (service) => {
      const identity = await service.executionAccountIdentity();
      if (identity.accountId !== request.accountId) {
        throw new Error("Spot opening account does not match the authenticated Binance account.");
      }
      const local = service.executionOrderState(binanceExecutionIdempotencyKeyFor(record));
      if (local.kind === "isolated") throw new BinanceStoredOrderManualReconciliationError(local.isolation);
      if (local.kind !== "found"
        || local.order.category !== "spot"
        || local.order.symbol !== request.providerSymbol
        || local.order.providerOrderId !== record.remoteOrderId) {
        throw new Error("Spot opening provider order identity is unavailable.");
      }
      const fills = await service.readSpotOrderFills(
        request.providerSymbol,
        record.remoteOrderId,
        request.baseAsset,
      );
      if (fills.symbol !== request.providerSymbol
        || fills.providerOrderId !== record.remoteOrderId
        || fills.grossBaseQuantity !== request.grossConfirmedQuantity) {
        throw new Error("Spot opening fills do not match the confirmed execution identity.");
      }
      return subtractUnsignedDecimals(fills.grossBaseQuantity, fills.baseCommissionQuantity);
    });
  }
}
