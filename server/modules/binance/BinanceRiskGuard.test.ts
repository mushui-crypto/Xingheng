import assert from "node:assert/strict";
import test from "node:test";
import { BinanceRiskError, BinanceRiskGuard } from "./BinanceRiskGuard";
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

test("cancellation and risk-reducing orders remain available while live trading is disabled", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture({ liveTradingEnabled: false, killSwitchActive: true }));
  assert.doesNotThrow(() => guard.assertOrderAllowed(orderFixture({ category: "spot", side: "Sell" }), snapshotFixture()));
  assert.doesNotThrow(() => guard.assertOrderAllowed(orderFixture({ category: "linear", side: "Buy", reduceOnly: true }), snapshotFixture()));
});

test("new risk requires 1x leverage and no existing open orders", () => {
  const guard = new BinanceRiskGuard(tradingConfigFixture());
  assert.throws(
    () => guard.assertOrderAllowed(orderFixture(), snapshotFixture({
      perpetual: { ...snapshotFixture().perpetual, leverage: 2 },
    })),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "leverage_invalid",
  );
  assert.throws(
    () => guard.assertOrderAllowed(orderFixture(), snapshotFixture({ openSpotOrderCount: 1 })),
    (error: unknown) => error instanceof BinanceRiskError && error.category === "open_orders_present",
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
