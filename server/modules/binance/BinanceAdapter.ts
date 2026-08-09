import type {
  AccountReadPort,
  FundingRatePort,
  InstrumentCatalogPort,
  MarketDataPort,
  OrderQueryPort,
} from "../cex/CexCapabilityPorts";
import type {
  CanonicalAccountSnapshot,
  CanonicalOrder,
  CanonicalOrderScope,
  CanonicalPosition,
} from "../cex/CexCanonicalModels";
import {
  type BinanceClientAdapter,
  type BinancePreflightSnapshot,
  type BinanceProviderOrder,
} from "./BinanceTypes";
import { BinanceFundingRate } from "./BinanceFundingRate";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
  BinanceInstrumentCatalog,
} from "./BinanceInstrumentCatalog";

export { BINANCE_PERPETUAL_INSTRUMENT_ID, BINANCE_SPOT_INSTRUMENT_ID } from "./BinanceInstrumentCatalog";

export class BinanceAdapter {
  readonly instrumentCatalog: InstrumentCatalogPort;
  readonly marketData: MarketDataPort;
  readonly fundingRate: FundingRatePort;
  readonly accountRead: AccountReadPort;
  readonly orderQuery: OrderQueryPort;

  constructor(client: BinanceClientAdapter) {
    const readSnapshot = () => client.readPreflightSnapshot();
    const snapshotSource = { readPreflightSnapshot: readSnapshot };
    this.instrumentCatalog = new BinanceInstrumentCatalog(snapshotSource);
    this.marketData = {
      venue: "binance",
      getTopOfBook: async (instrumentId) => topOfBookFromSnapshot(instrumentId, await readSnapshot()),
    };
    this.fundingRate = new BinanceFundingRate(snapshotSource);
    this.accountRead = {
      venue: "binance",
      getAccountSnapshot: async () => accountFromSnapshot(await readSnapshot()),
    };
    this.orderQuery = {
      venue: "binance",
      findByClientOrderId: async (scope, clientOrderId) => {
        const order = await client.findOrderByClientOrderId(categoryForScope(scope), clientOrderId);
        return order ? toCanonicalOrder(scope, order) : null;
      },
      awaitOrder: async (scope, providerOrderId, deadlineAt) => toCanonicalOrder(
        scope,
        await client.awaitOrder(categoryForScope(scope), providerOrderId, deadlineAt),
      ),
    };
  }
}

function topOfBookFromSnapshot(instrumentId: string, snapshot: BinancePreflightSnapshot) {
  const instrument = instrumentId === BINANCE_SPOT_INSTRUMENT_ID
    ? snapshot.spot
    : instrumentId === BINANCE_PERPETUAL_INSTRUMENT_ID
      ? snapshot.perpetual
      : null;
  if (!instrument) throw new Error(`Unsupported Binance instrument: ${instrumentId}.`);
  return {
    venue: "binance" as const,
    instrumentId,
    bid: instrument.bid,
    ask: instrument.ask,
    markPrice: instrumentId === BINANCE_PERPETUAL_INSTRUMENT_ID ? snapshot.perpetual.mark : null,
    depthUsd: instrument.depthUsd,
    fetchedAt: snapshot.fetchedAt,
  };
}

function accountFromSnapshot(snapshot: BinancePreflightSnapshot): CanonicalAccountSnapshot {
  const positions: CanonicalPosition[] = [
    {
      venue: "binance",
      accountId: snapshot.accountId,
      instrumentId: BINANCE_SPOT_INSTRUMENT_ID,
      side: snapshot.existingSpotQuantityXaut > 0 ? "long" : "flat",
      baseQuantity: snapshot.existingSpotQuantityXaut,
      notionalUsd: snapshot.existingSpotQuantityXaut * snapshot.spot.bid,
      entryPrice: null,
      markPrice: snapshot.spot.bid,
      liquidationPrice: null,
      leverage: null,
      marginMode: "unknown",
      unrealizedPnlUsd: null,
      fetchedAt: snapshot.fetchedAt,
    },
    {
      venue: "binance",
      accountId: snapshot.accountId,
      instrumentId: BINANCE_PERPETUAL_INSTRUMENT_ID,
      side: snapshot.perpetualPositionSide,
      baseQuantity: snapshot.existingPerpetualQuantityXaut,
      notionalUsd: snapshot.existingPerpetualQuantityXaut * snapshot.perpetual.mark,
      entryPrice: null,
      markPrice: snapshot.perpetual.mark,
      liquidationPrice: null,
      leverage: snapshot.perpetual.leverage,
      marginMode: snapshot.perpetual.marginMode,
      unrealizedPnlUsd: null,
      fetchedAt: snapshot.fetchedAt,
    },
  ];
  return {
    venue: "binance",
    accountId: snapshot.accountId,
    accountFingerprint: snapshot.accountFingerprint,
    fetchedAt: snapshot.fetchedAt,
    balances: [
      {
        asset: "USDT",
        available: snapshot.availableUsdt,
        locked: 0,
        total: snapshot.availableUsdt,
      },
      {
        asset: "XAUT",
        available: snapshot.spotFreeXaut,
        locked: snapshot.spotLockedXaut,
        total: snapshot.existingSpotQuantityXaut,
      },
    ],
    positions,
    openOrderCount: snapshot.openSpotOrderCount + snapshot.openPerpetualOrderCount,
  };
}

function toCanonicalOrder(scope: CanonicalOrderScope, order: BinanceProviderOrder): CanonicalOrder {
  return {
    venue: "binance",
    accountId: scope.accountId,
    instrumentId: scope.instrumentId,
    clientOrderId: order.orderLinkId,
    providerOrderId: order.orderId,
    status: order.status === "New"
      ? "NEW"
      : order.status === "PartiallyFilled"
        ? "PARTIALLY_FILLED"
        : order.status === "Filled"
          ? "FILLED"
          : order.status === "Cancelled"
            ? "CANCELED"
            : order.status === "Rejected"
              ? "REJECTED"
              : order.status === "Expired"
                ? "EXPIRED"
                : "UNKNOWN",
    requestedBaseQuantity: order.requestedQuantityXaut,
    filledBaseQuantity: order.filledQuantityXaut,
    averagePrice: order.averagePrice,
    feeAmount: order.feeUsd,
    feeAsset: "USD",
    updatedAt: order.updatedAt,
  };
}

function categoryForScope(scope: CanonicalOrderScope) {
  if (scope.venue !== "binance") throw new Error(`Unsupported venue for Binance adapter: ${scope.venue}.`);
  return categoryForInstrument(scope.instrumentId);
}

function categoryForInstrument(instrumentId: string): "spot" | "linear" {
  if (instrumentId === BINANCE_SPOT_INSTRUMENT_ID) return "spot";
  if (instrumentId === BINANCE_PERPETUAL_INSTRUMENT_ID) return "linear";
  throw new Error(`Unsupported Binance instrument: ${instrumentId}.`);
}
