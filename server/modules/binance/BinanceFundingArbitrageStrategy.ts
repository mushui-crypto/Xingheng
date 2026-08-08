import type { BinanceClientAdapter, BinancePreflightSnapshot } from "./BinanceTypes";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { BinanceOrderManager } from "./BinanceOrderManager";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export class BinanceFundingArbitrageStrategy {
  constructor(
    private readonly client: BinanceClientAdapter,
    private readonly orders: BinanceOrderManager,
    private readonly config: BinanceTradingConfig,
  ) {}

  async status() {
    const snapshot = await this.orders.syncPositions();
    return { snapshot, opportunity: assessOpportunity(snapshot, this.config) };
  }

  async enter(input: { idempotencyKey: string; budgetUsd?: number }) {
    const snapshot = await this.orders.syncPositions();
    const opportunity = assessOpportunity(snapshot, this.config);
    if (!opportunity.eligible) throw new Error(`Funding arbitrage entry rejected: ${opportunity.reasons.join(", ")}`);
    if (hasBlockingEntryExposure(snapshot, this.config.allowUntradeableSpotDustEntry)) {
      throw new Error("Existing XAUT exposure must be closed before a new arbitrage entry.");
    }
    const requestedBudget = input.budgetUsd ?? this.config.maxPositionUsd;
    const legBudget = Math.min(requestedBudget / 2, this.config.maxOrderUsd, this.config.maxPositionUsd / 2);
    const quantity = commonQuantity(legBudget / snapshot.spot.ask, snapshot);
    assertTradableQuantity(quantity, snapshot);

    const spot = await this.orders.place({
      idempotencyKey: `${input.idempotencyKey}:spot-entry`,
      category: "spot",
      symbol: "XAUTUSDT",
      side: "Buy",
      quantityXaut: quantity,
      limitPrice: ceilStep(snapshot.spot.ask * slippageMultiplier(this.config.maxSlippageBps, 1), snapshot.spot.priceTick),
      reduceOnly: false,
    });
    if (spot.filledQuantityXaut <= 0) throw new Error("Binance spot entry did not fill.");

    let perpetual: BinanceProviderOrder | null = null;
    try {
      const futuresQuantity = floorStep(spot.filledQuantityXaut, snapshot.perpetual.qtyStep);
      perpetual = await this.orders.place({
        idempotencyKey: `${input.idempotencyKey}:perpetual-entry`,
        category: "linear",
        symbol: "XAUTUSDT",
        side: "Sell",
        quantityXaut: futuresQuantity,
        limitPrice: floorStep(snapshot.perpetual.bid * slippageMultiplier(this.config.maxSlippageBps, -1), snapshot.perpetual.priceTick),
        reduceOnly: false,
      });
      if (perpetual.filledQuantityXaut + 1e-9 < futuresQuantity) {
        throw new Error("Binance perpetual entry was not fully hedged.");
      }
      return { state: "hedged" as const, spot, perpetual, snapshot: await this.orders.syncPositions() };
    } catch (error) {
      await this.compensateEntry(input.idempotencyKey, spot, perpetual, snapshot).catch(() => undefined);
      throw error;
    }
  }

  async exit(input: { idempotencyKey: string }) {
    const snapshot = await this.orders.syncPositions();
    const results: { spot: BinanceProviderOrder | null; perpetual: BinanceProviderOrder | null } = { spot: null, perpetual: null };
    const perpetualExitQuantity = floorStep(snapshot.existingPerpetualQuantityXaut, snapshot.perpetual.qtyStep);
    if (isTradableLeg(perpetualExitQuantity, snapshot.perpetual.minOrderQty, snapshot.perpetual.ask, snapshot.perpetual.minNotionalUsd)) {
      results.perpetual = await this.orders.place({
        idempotencyKey: `${input.idempotencyKey}:perpetual-exit`,
        category: "linear",
        symbol: "XAUTUSDT",
        side: "Buy",
        quantityXaut: perpetualExitQuantity,
        limitPrice: ceilStep(snapshot.perpetual.ask * slippageMultiplier(this.config.maxSlippageBps, 1), snapshot.perpetual.priceTick),
        reduceOnly: true,
      });
    }
    const current = await this.orders.syncPositions();
    const closableSpot = Math.min(current.spotFreeXaut, current.existingSpotQuantityXaut);
    const spotExitQuantity = floorStep(closableSpot, current.spot.qtyStep);
    if (isTradableLeg(spotExitQuantity, current.spot.minOrderQty, current.spot.bid, current.spot.minNotionalUsd)) {
      results.spot = await this.orders.place({
        idempotencyKey: `${input.idempotencyKey}:spot-exit`,
        category: "spot",
        symbol: "XAUTUSDT",
        side: "Sell",
        quantityXaut: spotExitQuantity,
        limitPrice: floorStep(current.spot.bid * slippageMultiplier(this.config.maxSlippageBps, -1), current.spot.priceTick),
        reduceOnly: false,
      });
    }
    const finalSnapshot = await this.orders.syncPositions();
    const state = finalSnapshot.existingSpotQuantityXaut <= 1e-9
      && finalSnapshot.existingPerpetualQuantityXaut <= 1e-9
      ? "closed" as const
      : "residual" as const;
    return { state, ...results, snapshot: finalSnapshot };
  }

  private async compensateEntry(
    key: string,
    spot: BinanceProviderOrder,
    perpetual: BinanceProviderOrder | null,
    snapshot: BinancePreflightSnapshot,
  ) {
    if (perpetual && perpetual.filledQuantityXaut > 0) {
      await this.orders.place({
        idempotencyKey: `${key}:perpetual-compensation`, category: "linear", symbol: "XAUTUSDT", side: "Buy",
        quantityXaut: floorStep(perpetual.filledQuantityXaut, snapshot.perpetual.qtyStep),
        limitPrice: ceilStep(snapshot.perpetual.ask * slippageMultiplier(this.config.maxSlippageBps, 1), snapshot.perpetual.priceTick), reduceOnly: true,
      });
    }
    if (spot.filledQuantityXaut > 0) {
      await this.orders.place({
        idempotencyKey: `${key}:spot-compensation`, category: "spot", symbol: "XAUTUSDT", side: "Sell",
        quantityXaut: floorStep(spot.filledQuantityXaut, snapshot.spot.qtyStep),
        limitPrice: floorStep(snapshot.spot.bid * slippageMultiplier(this.config.maxSlippageBps, -1), snapshot.spot.priceTick), reduceOnly: false,
      });
    }
  }
}

export function hasBlockingEntryExposure(
  snapshot: BinancePreflightSnapshot,
  allowUntradeableSpotDustEntry: boolean,
) {
  if (snapshot.existingPerpetualQuantityXaut > 1e-9) return true;
  if (snapshot.existingSpotQuantityXaut <= 1e-9) return false;
  if (!allowUntradeableSpotDustEntry) return true;
  const availableQuantity = Math.min(snapshot.spotAvailableQuantityXaut, snapshot.existingSpotQuantityXaut);
  const tradableQuantity = floorStep(availableQuantity, snapshot.spot.qtyStep);
  return isTradableLeg(
    tradableQuantity,
    snapshot.spot.minOrderQty,
    snapshot.spot.bid,
    snapshot.spot.minNotionalUsd,
  );
}

export function assessOpportunity(snapshot: BinancePreflightSnapshot, config: BinanceTradingConfig) {
  const entryBasisBps = (snapshot.perpetual.bid - snapshot.spot.ask) / snapshot.spot.ask * 10_000;
  const periodsPerYear = snapshot.perpetual.fundingIntervalHours > 0 ? 24 / snapshot.perpetual.fundingIntervalHours * 365 : 0;
  const estimatedNetAprPercent = snapshot.perpetual.fundingRate * periodsPerYear * 100
    - (snapshot.fees.spotTakerBps + snapshot.fees.perpetualTakerBps + config.maxSlippageBps) / 100;
  const reasons: string[] = [];
  if (!snapshot.productAvailability.available) reasons.push("product_unavailable");
  if (snapshot.perpetual.fundingRate <= 0) reasons.push("funding_not_positive");
  if (Math.abs(entryBasisBps) > config.maxEntryBasisBps) reasons.push("entry_basis_too_wide");
  if (estimatedNetAprPercent < config.minNetAprPercent) reasons.push("net_apr_too_low");
  if (snapshot.spot.status !== "Trading" || snapshot.perpetual.status !== "Trading") reasons.push("market_not_trading");
  return { eligible: reasons.length === 0, entryBasisBps, estimatedNetAprPercent, fundingRate: snapshot.perpetual.fundingRate, reasons };
}

function commonQuantity(value: number, snapshot: BinancePreflightSnapshot) {
  return floorStep(floorStep(value, snapshot.spot.qtyStep), snapshot.perpetual.qtyStep);
}

function assertTradableQuantity(quantity: number, snapshot: BinancePreflightSnapshot) {
  if (quantity <= 0
    || quantity < snapshot.spot.minOrderQty
    || quantity < snapshot.perpetual.minOrderQty
    || quantity * snapshot.spot.ask < snapshot.spot.minNotionalUsd
    || quantity * snapshot.perpetual.bid < snapshot.perpetual.minNotionalUsd) {
    throw new Error("Configured risk budget is below the Binance minimum tradable hedge size.");
  }
}

function isTradableLeg(quantity: number, minQuantity: number, price: number, minNotionalUsd: number) {
  return quantity > 0 && quantity >= minQuantity && quantity * price >= minNotionalUsd;
}

function slippageMultiplier(bps: number, direction: 1 | -1) {
  return 1 + direction * bps / 10_000;
}

function floorStep(value: number, step: number) {
  return Math.floor((value + 1e-12) / step) * step;
}

function ceilStep(value: number, step: number) {
  return Math.ceil((value - 1e-12) / step) * step;
}
