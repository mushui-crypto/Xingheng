import { createHash } from "node:crypto";
import {
  classifyBinanceEntryExposure,
  classifyBinanceExposure,
} from "./BinanceExposureClassifier";
import {
  BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT,
  BINANCE_MAX_UNHEDGED_DURATION_MS,
  BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY,
  type BinanceExecutionPriceMode,
} from "./BinanceExecutionPolicy";
import type { BinancePreflightSnapshot } from "./BinanceTypes";
import type { BinanceProviderOrder } from "./BinanceTypes";
import { BinanceOrderManager } from "./BinanceOrderManager";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export class BinanceFundingArbitrageStrategy {
  constructor(
    private readonly orders: BinanceOrderManager,
    private readonly config: BinanceTradingConfig,
  ) {}

  async status() {
    const snapshot = await this.orders.syncPositions();
    return {
      snapshot,
      opportunity: assessOpportunity(snapshot, this.config),
      entryExposure: classifyBinanceEntryExposure(snapshot),
    };
  }

  async enter(input: {
    idempotencyKey: string;
    executionPriceMode: BinanceExecutionPriceMode;
    existingExposureRiskAcknowledgement?: typeof BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT;
    budgetUsd?: number;
  }) {
    const snapshot = await this.orders.syncPositions();
    const opportunity = assessOpportunity(snapshot, this.config);
    if (!opportunity.eligible) throw new Error(`Funding arbitrage entry rejected: ${opportunity.reasons.join(", ")}`);
    const entryExposure = classifyBinanceEntryExposure(snapshot);
    if (!entryExposure.rulesValid) {
      throw new Error("Binance trading rules are invalid; entry is blocked.");
    }
    if (entryExposure.requiresAcknowledgement
      && input.existingExposureRiskAcknowledgement !== BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT) {
      throw new Error("Existing tradable XAUT exposure requires explicit total-account recovery acknowledgement.");
    }
    const requestedBudget = input.budgetUsd ?? this.config.maxPositionUsd;
    const legBudget = Math.min(requestedBudget / 2, this.config.maxOrderUsd, this.config.maxPositionUsd / 2);
    const quantity = commonQuantity(legBudget / snapshot.spot.ask, snapshot);
    assertTradableQuantity(quantity, snapshot);

    let spot: BinanceProviderOrder | null = null;
    let perpetual: BinanceProviderOrder | null = null;
    try {
      spot = await this.orders.place({
        idempotencyKey: `${input.idempotencyKey}:spot-entry`,
        category: "spot",
        symbol: "XAUTUSDT",
        side: "Buy",
        quantityXaut: quantity,
        limitPrice: ceilStep(snapshot.spot.ask * slippageMultiplier(this.config.maxSlippageBps, 1), snapshot.spot.priceTick),
        executionPriceMode: input.executionPriceMode,
        reduceOnly: false,
      }, async () => {
        const mutationSnapshot = await this.orders.syncPositions();
        assertEntryExposureSnapshotUnchanged(snapshot, mutationSnapshot);
      });
      const firstLegSnapshot = await this.orders.syncPositions();
      if (spot.filledQuantityXaut <= 0) {
        return {
          state: "not_filled" as const,
          spot,
          perpetual: null,
          snapshot: firstLegSnapshot,
        };
      }
      const firstConfirmedExposureAt = Date.now();
      const futuresQuantity = floorStep(spot.filledQuantityXaut, snapshot.perpetual.qtyStep);
      perpetual = await this.orders.place({
        idempotencyKey: `${input.idempotencyKey}:perpetual-entry`,
        category: "linear",
        symbol: "XAUTUSDT",
        side: "Sell",
        quantityXaut: futuresQuantity,
        limitPrice: floorStep(snapshot.perpetual.bid * slippageMultiplier(this.config.maxSlippageBps, -1), snapshot.perpetual.priceTick),
        executionPriceMode: input.executionPriceMode,
        reduceOnly: false,
      }, async () => {
        if (Date.now() - firstConfirmedExposureAt > BINANCE_MAX_UNHEDGED_DURATION_MS) {
          throw new Error("Maximum unhedged duration elapsed before the second provider mutation.");
        }
        const mutationSnapshot = await this.orders.syncPositions();
        assertEntryExposureSnapshotUnchanged(firstLegSnapshot, mutationSnapshot);
      });
      const confirmedResidual = Math.abs(spot.filledQuantityXaut - perpetual.filledQuantityXaut);
      if (confirmedResidual > BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY + Number.EPSILON) {
        throw new Error("Binance entry exceeded the confirmed XAUT residual tolerance.");
      }
      return { state: "hedged" as const, spot, perpetual, snapshot: await this.orders.syncPositions() };
    } catch (error) {
      await this.recoverEntry(input.idempotencyKey);
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
        executionPriceMode: "IOC_LIMIT",
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
        executionPriceMode: "IOC_LIMIT",
        reduceOnly: false,
      });
    }
    const finalSnapshot = await this.orders.syncPositions();
    const exposureClassification = classifyBinanceExposure(finalSnapshot);
    const state = exposureClassification === "TRADABLE_RESIDUAL" ? "residual" as const : "closed" as const;
    return { state, ...results, snapshot: finalSnapshot };
  }

  private async recoverEntry(key: string) {
    await this.orders.reconcile();
    const entryOrders = this.orders.listOrders().filter((order) =>
      order.idempotencyKey === `${key}:spot-entry`
      || order.idempotencyKey === `${key}:perpetual-entry`);
    const unresolved = entryOrders.some((order) => order.status === "processing"
      || order.order?.status === "New"
      || order.order?.status === "PartiallyFilled"
      || order.order?.status === "Unknown");
    if (unresolved) {
      throw new Error("Entry recovery is blocked until authoritative reconciliation resolves all entry orders.");
    }

    const hasConfirmedEntryFill = entryOrders.some((order) =>
      order.order !== null
      && order.order.filledQuantityXaut > 0
      && ["Filled", "Cancelled", "Rejected", "Expired"].includes(order.order.status));
    if (!hasConfirmedEntryFill) return;

    const snapshot = await this.orders.syncPositions();
    if (classifyBinanceExposure(snapshot) === "TRADABLE_RESIDUAL") {
      const recoveryKey = `entry-recovery:${createHash("sha256")
        .update(`${key}\u0000binance-entry-recovery\u00001`)
        .digest("hex")}`;
      await this.exit({ idempotencyKey: recoveryKey });
      const recovered = await this.orders.syncPositions();
      if (classifyBinanceExposure(recovered) === "TRADABLE_RESIDUAL") {
        throw new Error("Entry recovery left a tradable Binance residual exposure.");
      }
    }
  }
}

function assertEntryExposureSnapshotUnchanged(
  expected: BinancePreflightSnapshot,
  actual: BinancePreflightSnapshot,
) {
  const expectedClassification = classifyBinanceEntryExposure(expected).classification;
  const actualClassification = classifyBinanceEntryExposure(actual).classification;
  if (actual.accountId !== expected.accountId
    || actual.accountFingerprint !== expected.accountFingerprint
    || actual.existingSpotQuantityXaut !== expected.existingSpotQuantityXaut
    || actual.existingPerpetualQuantityXaut !== expected.existingPerpetualQuantityXaut
    || actual.perpetualPositionSide !== expected.perpetualPositionSide
    || actualClassification !== expectedClassification
    || actual.openSpotOrderCount !== expected.openSpotOrderCount
    || actual.openPerpetualOrderCount !== expected.openPerpetualOrderCount) {
    throw new Error("Binance account exposure changed before provider mutation; refresh and confirm again.");
  }
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
