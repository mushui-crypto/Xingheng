import type { ArbitrageDashboardService } from "../arbitrage/ArbitrageDashboardService";
import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { ExchangeVenue } from "../credentials/CredentialKeyProvider";
import type { AccountReadSnapshot, VenueAccountReadSnapshot } from "./AccountReadTypes";

export type UsdtSpotPriceSource = {
  loadPrices(assets: readonly string[], preferredVenue: ExchangeVenue): Promise<ReadonlyMap<string, number>>;
};

export type AccountReadValuation = {
  value(snapshot: VenueAccountReadSnapshot): Promise<AccountReadSnapshot>;
};

export class AccountUsdtValuationService implements AccountReadValuation {
  constructor(private readonly prices: UsdtSpotPriceSource) {}

  async value(snapshot: VenueAccountReadSnapshot): Promise<AccountReadSnapshot> {
    const requestedAssets = [...new Set(snapshot.balances
      .map(({ asset }) => asset.trim().toUpperCase())
      .filter((asset) => asset && asset !== "USDT"))];
    let prices: ReadonlyMap<string, number> = new Map();
    try {
      prices = await this.prices.loadPrices(requestedAssets, snapshot.venue);
    } catch {
      prices = new Map();
    }
    let valuedCount = 0;
    let estimatedTotalValueUsdt = 0;
    const balances = snapshot.balances.map((balance) => {
      const asset = balance.asset.trim().toUpperCase();
      const price = asset === "USDT" ? 1 : validPrice(prices.get(asset));
      const estimatedValueUsdt = price === null ? null : validValue(balance.total * price);
      if (estimatedValueUsdt !== null) {
        valuedCount += 1;
        estimatedTotalValueUsdt += estimatedValueUsdt;
      }
      return {
        ...balance,
        estimatedValueUsdt,
        valuationStatus: estimatedValueUsdt === null ? "UNAVAILABLE" as const : "VALUED" as const,
      };
    });
    return {
      ...snapshot,
      balances,
      estimatedTotalValueUsdt: valuedCount > 0 ? estimatedTotalValueUsdt : null,
      valuationCoverage: valuedCount === 0
        ? "UNAVAILABLE"
        : valuedCount === balances.length ? "COMPLETE" : "PARTIAL",
    };
  }
}

export class ArbitrageDashboardUsdtSpotPriceSource implements UsdtSpotPriceSource {
  constructor(
    private readonly dashboard: Pick<ArbitrageDashboardService, "getSnapshot">,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs = 60_000,
  ) {}

  async loadPrices(assets: readonly string[], preferredVenue: ExchangeVenue) {
    const requested = new Set(assets.map((asset) => asset.trim().toUpperCase()).filter(Boolean));
    if (requested.size === 0) return new Map<string, number>();
    const snapshot = await this.dashboard.getSnapshot(90);
    const prices = new Map<string, number>();
    const candidates = snapshot.markets
      .filter((market) => requested.has(market.asset.toUpperCase()))
      .filter(reliableUsdtSpotMarket)
      .filter((market) => Math.abs(this.now() - market.fetchedAt) <= this.maxAgeMs)
      .sort((left, right) => venueRank(left.venue, preferredVenue) - venueRank(right.venue, preferredVenue));
    for (const market of candidates) {
      const asset = market.asset.toUpperCase();
      if (!prices.has(asset)) prices.set(asset, (market.bid! + market.ask!) / 2);
    }
    return prices;
  }
}

function reliableUsdtSpotMarket(market: ArbitrageMarket) {
  return market.kind === "spot"
    && market.quoteAsset === "USDT"
    && market.status !== "disconnected"
    && validPrice(market.bid) !== null
    && validPrice(market.ask) !== null;
}

function venueRank(venue: ArbitrageMarket["venue"], preferredVenue: ExchangeVenue) {
  if (venue === preferredVenue) return 0;
  const fallbackOrder: ArbitrageMarket["venue"][] = ["binance", "okx", "bybit", "bitget"];
  const index = fallbackOrder.indexOf(venue);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index + 1;
}

function validPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function validValue(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}
