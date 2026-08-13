import type {
  BinanceExecutionOrderRequest,
  BinanceGenericRiskContext,
  BinanceGenericRiskSnapshot,
  BinanceOrderRequest,
  BinancePreflightSnapshot,
} from "./BinanceTypes";
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

  assertGenericOrderAllowed(
    request: BinanceExecutionOrderRequest,
    context: BinanceGenericRiskContext,
    snapshot: BinanceGenericRiskSnapshot,
  ) {
    validateGenericIdentity(request, context, snapshot);
    validateGenericSnapshot(snapshot);
    const quantity = positiveDecimal(request.quantity, "Order quantity");
    const valuationPrice = positiveDecimal(context.valuationPrice, "Order valuation price");
    if (request.executionPriceMode !== "MARKET"
      && compare(valuationPrice, positiveDecimal(request.limitPrice, "Order limit price")) !== 0) {
      throw new BinanceRiskError("risk_price_mismatch", "IOC risk valuation price must match the provider limit price.");
    }
    const orderNotional = multiply(quantity, valuationPrice);

    if (snapshot.openOrderCount > 0) {
      throw new BinanceRiskError(
        "open_orders_present",
        `Existing Binance ${request.symbol} orders must be reconciled before mutation.`,
      );
    }
    if (request.category === "spot") {
      assertGenericSpotOrder(request, snapshot, quantity, orderNotional);
      this.assertMutationAllowed("risk_increasing");
      return;
    }

    const position = snapshot.position;
    if (!position) {
      throw new BinanceRiskError("position_unavailable", "Binance perpetual position state is unavailable.");
    }
    if (!snapshot.permissions.positionModeSupported
      || !["single_asset_one_way", "multi_assets_one_way"].includes(snapshot.accountMode)) {
      throw new BinanceRiskError("position_mode_unsupported", "Binance generic execution supports one-way position mode only.");
    }
    positiveDecimal(position.leverage, "Perpetual leverage");

    if (request.reduceOnly) {
      assertReduceOnly(request, position.side, nonNegativeDecimal(position.quantity, "Perpetual position quantity"), quantity);
      this.assertMutationAllowed("risk_reducing");
      return;
    }
    this.assertMutationAllowed("risk_increasing");
    const availableMargin = nonNegativeDecimal(snapshot.availableUsdt, "Perpetual available USDT margin");
    if (compare(availableMargin, orderNotional) < 0) {
      throw new BinanceRiskError("insufficient_margin", "Binance perpetual available USDT margin is insufficient.");
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

function validateGenericIdentity(
  request: BinanceExecutionOrderRequest,
  context: BinanceGenericRiskContext,
  snapshot: BinanceGenericRiskSnapshot,
) {
  if (!context.userId.trim() || !context.accountId.trim() || !context.instrumentId.trim()) {
    throw new BinanceRiskError("identity_invalid", "Binance generic risk identity is incomplete.");
  }
  if (context.instrumentStatus !== "trading") {
    throw new BinanceRiskError("instrument_not_trading", "Binance instrument is not trading.");
  }
  if (request.category !== context.category
    || request.category !== snapshot.category
    || request.symbol !== context.providerSymbol
    || request.symbol !== snapshot.symbol
    || context.baseAsset !== snapshot.baseAsset) {
    throw new BinanceRiskError("instrument_mismatch", "Binance generic risk instrument identity does not match.");
  }
  if (context.accountId !== snapshot.accountId) {
    throw new BinanceRiskError("account_mismatch", "Execution account does not match the Binance risk snapshot.");
  }
  if (!Number.isSafeInteger(context.quoteFetchedAt) || context.quoteFetchedAt < 0
    || Date.now() - context.quoteFetchedAt > 10_000) {
    throw new BinanceRiskError("quote_stale", "Binance execution quote is stale.");
  }
}

function validateGenericSnapshot(snapshot: BinanceGenericRiskSnapshot) {
  if (!Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt < 0
    || Date.now() - snapshot.fetchedAt > 10_000) {
    throw new BinanceRiskError("snapshot_stale", "Binance account risk snapshot is stale.");
  }
  const permissions = snapshot.permissions;
  const tradingPermission = snapshot.category === "spot" ? permissions.spotTrade : permissions.contractTrade;
  const accountPermission = snapshot.category === "spot" ? permissions.spotAccount : permissions.futuresAccount;
  if (!permissions.read || !tradingPermission || !accountPermission
    || permissions.withdraw || !permissions.ipRestricted) {
    throw new BinanceRiskError("permissions_invalid", "Binance API permissions are not safe for generic execution.");
  }
}

function assertGenericSpotOrder(
  request: BinanceExecutionOrderRequest,
  snapshot: BinanceGenericRiskSnapshot,
  quantity: Decimal,
  orderNotional: Decimal,
) {
  if (request.reduceOnly || snapshot.position !== null || snapshot.availableBaseAsset === null) {
    throw new BinanceRiskError("invalid_order", "Binance Spot order risk context is invalid.");
  }
  if (request.side === "Buy") {
    const availableUsdt = nonNegativeDecimal(snapshot.availableUsdt, "Spot available USDT balance");
    if (compare(availableUsdt, orderNotional) < 0) {
      throw new BinanceRiskError("insufficient_balance", "Binance Spot USDT balance is insufficient.");
    }
    return;
  }
  const availableBaseAsset = nonNegativeDecimal(snapshot.availableBaseAsset, "Spot available base asset balance");
  if (compare(availableBaseAsset, quantity) < 0) {
    throw new BinanceRiskError("insufficient_balance", "Binance Spot base asset balance is insufficient.");
  }
}

function assertReduceOnly(
  request: BinanceExecutionOrderRequest,
  positionSide: "long" | "short" | "flat",
  positionQuantity: Decimal,
  requestedQuantity: Decimal,
) {
  if (positionSide === "flat" || positionQuantity.coefficient === 0n) {
    throw new BinanceRiskError("reduce_only_position_missing", "Binance reduceOnly order requires a real open position.");
  }
  const expectedSide = positionSide === "long" ? "Sell" : "Buy";
  if (request.side !== expectedSide) {
    throw new BinanceRiskError("reduce_only_side_invalid", "Binance reduceOnly side does not reduce the real position.");
  }
  if (compare(requestedQuantity, positionQuantity) > 0) {
    throw new BinanceRiskError("reduce_only_quantity_exceeded", "Binance reduceOnly quantity exceeds the real position.");
  }
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;

function positiveDecimal(value: string, label: string) {
  const result = decimal(value);
  if (result.coefficient <= 0n) throw new BinanceRiskError("invalid_order", `${label} must be positive.`);
  return result;
}

function nonNegativeDecimal(value: string, label: string) {
  const result = decimal(value);
  if (result.coefficient < 0n) throw new BinanceRiskError("snapshot_invalid", `${label} cannot be negative.`);
  return result;
}

function decimal(value: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new BinanceRiskError("decimal_invalid", "Binance risk Decimal value is invalid.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return Object.freeze({ coefficient: BigInt(`${integer}${normalizedFraction}`), scale: normalizedFraction.length });
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return Object.freeze({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * powerOfTen(scale - left.scale);
  const rightValue = right.coefficient * powerOfTen(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function powerOfTen(exponent: number) {
  return 10n ** BigInt(exponent);
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
