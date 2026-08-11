import type { BinancePreflightSnapshot } from "./BinanceTypes";
import type { BinanceOrderRequest } from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export class BinanceRiskError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class BinanceRiskGuard {
  constructor(private readonly config: BinanceTradingConfig) {}

  assertMutationAllowed(riskEffect: "risk_increasing" | "risk_reducing") {
    if (riskEffect === "risk_reducing") return;
    if (!this.config.liveTradingEnabled) {
      throw new BinanceRiskError("live_trading_disabled", "LIVE_TRADING_ENABLED is not true.");
    }
    if (this.config.killSwitchActive) {
      throw new BinanceRiskError("kill_switch_active", "Binance kill switch is active.");
    }
  }

  assertCancellationAllowed() {
    this.assertMutationAllowed("risk_reducing");
  }

  assertOrderAllowed(request: BinanceOrderRequest, snapshot: BinancePreflightSnapshot) {
    validateOrderShape(request);
    this.assertMutationAllowed(isRiskReducing(request) ? "risk_reducing" : "risk_increasing");
    if (isRiskReducing(request)) return;
    if (!permissionsSafe(snapshot)) {
      throw new BinanceRiskError("permissions_invalid", "Binance API permissions are not safe for live trading.");
    }
    if (snapshot.perpetual.leverage !== 1) {
      throw new BinanceRiskError("leverage_invalid", "Binance XAUTUSDT perpetual leverage must be 1x.");
    }
    if (snapshot.openSpotOrderCount > 0 || snapshot.openPerpetualOrderCount > 0) {
      throw new BinanceRiskError("open_orders_present", "Existing Binance XAUTUSDT orders must be reconciled before new risk.");
    }
    if (Date.now() - snapshot.fetchedAt > 10_000) {
      throw new BinanceRiskError("snapshot_stale", "Binance account snapshot is stale.");
    }

    const orderNotionalUsd = request.quantityXaut * request.limitPrice;
    if (orderNotionalUsd > this.config.maxOrderUsd + 1e-9) {
      throw new BinanceRiskError("max_order_usd", `Order notional exceeds MAX_ORDER_USD (${this.config.maxOrderUsd}).`);
    }
    const currentGrossUsd = snapshot.existingSpotQuantityXaut * snapshot.spot.bid
      + snapshot.existingPerpetualQuantityXaut * snapshot.perpetual.mark;
    if (currentGrossUsd + orderNotionalUsd > this.config.maxPositionUsd + 1e-9) {
      throw new BinanceRiskError("max_position_usd", `Projected gross exposure exceeds MAX_POSITION_USD (${this.config.maxPositionUsd}).`);
    }
  }

  status() {
    return {
      liveTradingEnabled: this.config.liveTradingEnabled,
      killSwitchActive: this.config.killSwitchActive,
      maxOrderUsd: this.config.maxOrderUsd,
      maxPositionUsd: this.config.maxPositionUsd,
    };
  }
}

function isRiskReducing(request: BinanceOrderRequest) {
  return request.reduceOnly || (request.category === "spot" && request.side === "Sell");
}

function permissionsSafe(snapshot: BinancePreflightSnapshot) {
  const permissions = snapshot.permissions;
  return permissions.read
    && permissions.spotTrade
    && permissions.contractTrade
    && !permissions.withdraw
    && permissions.ipRestricted
    && permissions.positionModeSupported;
}

function validateOrderShape(request: BinanceOrderRequest) {
  if (!Number.isFinite(request.quantityXaut) || request.quantityXaut <= 0) {
    throw new BinanceRiskError("invalid_order", "Order quantity must be positive.");
  }
  if (!Number.isFinite(request.limitPrice) || request.limitPrice <= 0) {
    throw new BinanceRiskError("invalid_order", "Order price must be positive.");
  }
}
