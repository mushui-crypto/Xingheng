import assert from "node:assert/strict";
import test from "node:test";
import { BinanceRiskError, BinanceRiskGuard } from "./BinanceRiskGuard";
import type { BinanceExecutionOrderRequest, BinanceGenericRiskSnapshot } from "./BinanceTypes";
import { snapshotFixture, tradingConfigFixture } from "./binanceTestFixtures";

test("new risk requires the live switch and an inactive kill switch", () => {
  const request = orderFixture();
  assert.throws(
    () => new BinanceRiskGuard(tradingConfigFixture({ liveTradingEnabled: false })).assertOrderAllowed(request, snapshotFixture()),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "live_trading_disabled",
  );
  assert.throws(
    () => new BinanceRiskGuard(tradingConfigFixture({ killSwitchActive: true })).assertOrderAllowed(request, snapshotFixture()),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "kill_switch_active",
  );
});

test("MAX_ORDER_USD and MAX_POSITION_USD are enforced", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture({ maxOrderUsd: 10, maxPositionUsd: 15 }));
  assert.throws(
    () => guard.assertOrderAllowed(orderFixture({ quantityXaut: 1, limitPrice: 11 }), snapshotFixture()),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "max_order_usd",
  );
  assert.throws(
    () => guard.assertOrderAllowed(orderFixture({ quantityXaut: 0.5, limitPrice: 10 }), snapshotFixture({ existingSpotQuantityXaut: 1 })),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "max_position_usd",
  );
});

test("live and kill-switch gates allow only perpetual reduceOnly mutations and cancel", () => {
  for (const guard of [
    new BinanceRiskGuard(tradingConfigFixture({ liveTradingEnabled: false })),
    new BinanceRiskGuard(tradingConfigFixture({ killSwitchActive: true })),
  ]) {
    assert.doesNotThrow(() => guard.assertCancellationAllowed());
    assert.throws(
      () => guard.assertOrderAllowed(orderFixture({ category: "spot", side: "Sell" }), snapshotFixture()),
      (error: unknown) => error instanceof BinanceRiskError
        && ["live_trading_disabled", "kill_switch_active"].includes(error.category),
    );
    assert.doesNotThrow(
      () => guard.assertOrderAllowed(
        orderFixture({ category: "linear", side: "Buy", reduceOnly: true }),
        snapshotFixture(),
      ),
    );
  }

  assert.doesNotThrow(() => new BinanceRiskGuard(
    tradingConfigFixture({ liveTradingEnabled: true, killSwitchActive: false }),
  ).assertOrderAllowed(orderFixture({ category: "spot", side: "Sell" }), snapshotFixture()));

  const killSwitchActive = new BinanceRiskGuard(tradingConfigFixture({ killSwitchActive: true }));
  assert.throws(
    () => killSwitchActive.assertOrderAllowed(orderFixture({ category: "spot", side: "Buy" }), snapshotFixture()),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "kill_switch_active",
  );
  assert.throws(
    () => killSwitchActive.assertOrderAllowed(
      orderFixture({ category: "linear", side: "Sell", reduceOnly: false }),
      snapshotFixture(),
    ),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "kill_switch_active",
  );
});

test("new risk rejects existing open orders", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture());
  assert.throws(
    () => guard.assertOrderAllowed(orderFixture(), snapshotFixture({ openSpotOrderCount: 1 })),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "open_orders_present",
  );
});

test("generic Spot BUY checks instrument-scoped USDT balance without legacy fixed caps", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture({ maxOrderUsd: 1, maxPositionUsd: 1 }));
  for (const [symbol, asset, quantity, price] of [
    ["BTCUSDT", "BTC", "0.000123456789012345", "65000.123456789012345"],
    ["ETHUSDT", "ETH", "0.001", "3500.000000000000001"],
    ["DOGEUSDT", "DOGE", "10.123456789", "0.123456789012345"],
  ] as const) {
    const request = genericOrder({ symbol, quantity, limitPrice: price });
    assert.doesNotThrow(() => guard.assertGenericOrderAllowed(
      request,
      genericContext({ providerSymbol: symbol, baseAsset: asset, valuationPrice: price }),
      genericSnapshot({ symbol, baseAsset: asset, availableUsdt: "1000000" }),
    ));
  }

  assert.throws(
    () => guard.assertGenericOrderAllowed(
      genericOrder({ symbol: "BTCUSDT", quantity: "0.001", limitPrice: "65000" }),
      genericContext({ providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
      genericSnapshot({ symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "64.999999999999999" }),
    ),
    riskCategory("insufficient_balance"),
  );
});

test("generic Spot SELL requires the real base-asset available balance and never bypasses gates", () => {
  const request = genericOrder({ symbol: "ETHUSDT", side: "Sell", quantity: "0.01", limitPrice: "3500" });
  const context = genericContext({ providerSymbol: "ETHUSDT", baseAsset: "ETH", valuationPrice: "3500" });
  const snapshot = genericSnapshot({ symbol: "ETHUSDT", baseAsset: "ETH", availableBaseAsset: "0.01" });
  assert.doesNotThrow(() => new BinanceRiskGuard(tradingConfigFixture()).assertGenericOrderAllowed(request, context, snapshot));
  assert.throws(
    () => new BinanceRiskGuard(tradingConfigFixture()).assertGenericOrderAllowed(
      request,
      context,
      genericSnapshot({ symbol: "ETHUSDT", baseAsset: "ETH", availableBaseAsset: "0.009999999999999999" }),
    ),
    riskCategory("insufficient_balance"),
  );
  assert.throws(
    () => new BinanceRiskGuard(tradingConfigFixture({ liveTradingEnabled: false }))
      .assertGenericOrderAllowed(request, context, snapshot),
    riskCategory("live_trading_disabled"),
  );
  assert.throws(
    () => new BinanceRiskGuard(tradingConfigFixture({ killSwitchActive: true }))
      .assertGenericOrderAllowed(request, context, snapshot),
    riskCategory("kill_switch_active"),
  );
});

test("generic perpetual OPEN validates one-way state, permissions, margin and safety gates", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture({ maxOrderUsd: 1, maxPositionUsd: 1 }));
  for (const side of ["Buy", "Sell"] as const) {
    const request = genericOrder({ category: "linear", symbol: "BTCUSDT", side, quantity: "0.001", limitPrice: "65000" });
    assert.doesNotThrow(() => guard.assertGenericOrderAllowed(
      request,
      genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
      genericSnapshot({
        category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "65",
        availableBaseAsset: null, position: genericPosition(),
      }),
    ));
  }
  assert.throws(
    () => guard.assertGenericOrderAllowed(
      genericOrder({ category: "linear", symbol: "BTCUSDT", quantity: "0.001", limitPrice: "65000" }),
      genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
      genericSnapshot({
        category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "64.999999999999999",
        availableBaseAsset: null, position: genericPosition(),
      }),
    ),
    riskCategory("insufficient_margin"),
  );
  assert.throws(
    () => new BinanceRiskGuard(tradingConfigFixture({ killSwitchActive: true })).assertGenericOrderAllowed(
      genericOrder({ category: "linear", symbol: "BTCUSDT", quantity: "0.001", limitPrice: "65000" }),
      genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
      genericSnapshot({
        category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "65",
        availableBaseAsset: null, position: genericPosition(),
      }),
    ),
    riskCategory("kill_switch_active"),
  );
  assert.throws(
    () => guard.assertGenericOrderAllowed(
      genericOrder({ category: "linear", symbol: "BTCUSDT", quantity: "0.001", limitPrice: "65000" }),
      genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
      genericSnapshot({
        category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "65",
        availableBaseAsset: null, accountMode: "single_asset_hedge", position: genericPosition(),
      }),
    ),
    riskCategory("position_mode_unsupported"),
  );
});

test("generic perpetual accepts any reliably reported positive leverage", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture());
  const request = genericOrder({ category: "linear", symbol: "BTCUSDT", quantity: "0.001", limitPrice: "65000" });
  const context = genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" });
  const snapshot = (leverage: unknown) => genericSnapshot({
    category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableUsdt: "65",
    availableBaseAsset: null, position: genericPosition({ leverage }),
  });

  for (const leverage of ["1", "2", "5"] as const) {
    assert.doesNotThrow(() => guard.assertGenericOrderAllowed(request, context, snapshot(leverage)));
  }
  for (const leverage of [undefined, "", "0", "-1", "not-a-decimal"] as const) {
    assert.throws(
      () => guard.assertGenericOrderAllowed(request, context, snapshot(leverage)),
      (error: unknown) => error instanceof BinanceRiskError
        && ["decimal_invalid", "invalid_order"].includes(error.category),
    );
  }

});

test("generic perpetual reduceOnly proves real position, side, and quantity before allowing risk reduction", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: true }));
  const run = (side: "Buy" | "Sell", positionSide: "long" | "short", requested = "0.01") => guard.assertGenericOrderAllowed(
    genericOrder({ category: "linear", symbol: "BTCUSDT", side, quantity: requested, limitPrice: "65000", reduceOnly: true }),
    genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
    genericSnapshot({
      category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableBaseAsset: null,
      position: genericPosition({ side: positionSide, quantity: "0.01" }),
    }),
  );
  assert.doesNotThrow(() => run("Sell", "long"));
  assert.doesNotThrow(() => run("Buy", "short"));
  assert.doesNotThrow(() => guard.assertGenericOrderAllowed(
    genericOrder({ category: "linear", symbol: "BTCUSDT", side: "Sell", quantity: "0.01", limitPrice: "65000", reduceOnly: true }),
    genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
    genericSnapshot({
      category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableBaseAsset: null,
      position: genericPosition({ side: "long", quantity: "0.01", leverage: "5" }),
    }),
  ));
  assert.throws(() => run("Buy", "long"), riskCategory("reduce_only_side_invalid"));
  assert.throws(() => run("Sell", "long", "0.010000000000000001"), riskCategory("reduce_only_quantity_exceeded"));
  assert.throws(
    () => guard.assertGenericOrderAllowed(
      genericOrder({ category: "linear", symbol: "BTCUSDT", side: "Sell", quantity: "0.01", limitPrice: "65000", reduceOnly: true }),
      genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC", valuationPrice: "65000" }),
      genericSnapshot({
        category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableBaseAsset: null,
        position: genericPosition({ side: "flat", quantity: "0" }),
      }),
    ),
    riskCategory("reduce_only_position_missing"),
  );
});

test("generic risk is instrument scoped and fails closed for mismatch, open orders, and unavailable position", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture());
  const request = genericOrder({ symbol: "BTCUSDT" });
  const context = genericContext({ providerSymbol: "BTCUSDT", baseAsset: "BTC" });
  assert.throws(
    () => guard.assertGenericOrderAllowed(request, context, genericSnapshot({ symbol: "ETHUSDT", baseAsset: "ETH" })),
    riskCategory("instrument_mismatch"),
  );
  assert.throws(
    () => guard.assertGenericOrderAllowed(request, context, genericSnapshot({ symbol: "BTCUSDT", baseAsset: "BTC", openOrderCount: 1 })),
    riskCategory("open_orders_present"),
  );
  assert.throws(
    () => guard.assertGenericOrderAllowed(
      genericOrder({ category: "linear", symbol: "BTCUSDT" }),
      genericContext({ category: "linear", providerSymbol: "BTCUSDT", baseAsset: "BTC" }),
      genericSnapshot({ category: "linear", symbol: "BTCUSDT", baseAsset: "BTC", availableBaseAsset: null, position: null }),
    ),
    riskCategory("position_unavailable"),
  );
});

test("generic MARKET uses the explicit Decimal valuation price and IOC price identity is fail closed", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture());
  assert.doesNotThrow(() => guard.assertGenericOrderAllowed(
    genericOrder({ executionPriceMode: "MARKET", limitPrice: undefined, quantity: "0.0001" }),
    genericContext({ valuationPrice: "65000.123456789012345" }),
    genericSnapshot({ availableUsdt: "6.5000123456789012345" }),
  ));
  assert.throws(
    () => guard.assertGenericOrderAllowed(
      genericOrder({ limitPrice: "65000" }),
      genericContext({ valuationPrice: "65000.01" }),
      genericSnapshot(),
    ),
    riskCategory("risk_price_mismatch"),
  );
});

function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    category: "spot" as const,
    symbol: "XAUTUSDT",
    side: "Buy" as const,
    quantityXaut: 0.01,
    limitPrice: 1_000,
    reduceOnly: false,
    orderLinkId: "ptmtest",
    ...overrides,
  } as any;
}

function genericOrder(overrides: Record<string, unknown> = {}): BinanceExecutionOrderRequest {
  const base = {
    category: "spot" as const,
    symbol: "BTCUSDT",
    side: "Buy" as const,
    quantity: "0.0001",
    executionPriceMode: "IOC_LIMIT" as const,
    limitPrice: "65000",
    reduceOnly: false,
    orderLinkId: "ptmgenericrisk",
    ...overrides,
  };
  return base as BinanceExecutionOrderRequest;
}

function genericContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-a",
    accountId: "binance:test",
    instrumentId: "BTC-USDT-SPOT",
    category: "spot" as const,
    providerSymbol: "BTCUSDT",
    baseAsset: "BTC",
    instrumentStatus: "trading" as const,
    valuationPrice: "65000",
    quoteFetchedAt: Date.now(),
    ...overrides,
  } as any;
}

function genericSnapshot(overrides: Partial<BinanceGenericRiskSnapshot> = {}): BinanceGenericRiskSnapshot {
  return {
    accountId: "binance:test",
    accountFingerprint: "test",
    fetchedAt: Date.now(),
    accountMode: "single_asset_one_way",
    permissions: {
      read: true, spotTrade: true, contractTrade: true, withdraw: false, ipRestricted: true,
      spotAccount: true, futuresAccount: true, positionModeSupported: true,
    },
    category: "spot",
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    availableUsdt: "1000",
    availableBaseAsset: "1",
    openOrderCount: 0,
    position: null,
    ...overrides,
  };
}

function genericPosition(overrides: Record<string, unknown> = {}) {
  return { side: "flat" as const, quantity: "0", leverage: "1", marginMode: "cross" as const, ...overrides } as any;
}

function riskCategory(category: string) {
  return (error: unknown) => error instanceof BinanceRiskError && error.category === category;
}
