import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateConnectivitySmokeBudget,
  RWA_CONNECTIVITY_SMOKE_BUDGET_USD,
} from "./RwaConnectivitySmoke";
import type { RwaBinancePreflightSnapshot } from "./RwaBinanceAutomationTypes";

test("connectivity smoke budget uses the common step and reserves all four action fees and slippage", () => {
  const result = calculateConnectivitySmokeBudget(snapshot(), 20);
  assert.equal(result.quantityXaut, 0.002);
  assert.equal(result.commonQtyStep, 0.001);
  assert.ok(result.spotFeesUsd > 0);
  assert.ok(result.futuresFeesUsd > 0);
  assert.ok(result.spotSlippageReserveUsd > 0);
  assert.ok(result.futuresSlippageReserveUsd > 0);
  assert.ok(result.totalCapitalUsd <= RWA_CONNECTIVITY_SMOKE_BUDGET_USD);
});

test("connectivity smoke budget returns zero provider quantity when the dynamic minimum exceeds 25 USDT", () => {
  const expensive = snapshot();
  expensive.spot.ask = 7_000;
  expensive.perpetual.bid = 7_000;
  expensive.spot.minNotionalUsd = 15;
  expensive.perpetual.minNotionalUsd = 15;
  const result = calculateConnectivitySmokeBudget(expensive, 20);
  assert.equal(result.quantityXaut, 0);
  assert.equal(result.totalCapitalUsd, 0);
});

test("connectivity smoke budget rounds a finer spot step to the futures common step", () => {
  const value = snapshot();
  value.spot.qtyStep = 0.0001;
  value.perpetual.qtyStep = 0.001;
  value.spot.minOrderQty = 0.0001;
  value.perpetual.minOrderQty = 0.001;
  const result = calculateConnectivitySmokeBudget(value, 20);
  assert.equal(result.commonQtyStep, 0.001);
  assert.equal(result.quantityXaut % 0.001, 0);
});

test("connectivity smoke budget never under-reserves the frozen order bounds when config requests one bps", () => {
  const result = calculateConnectivitySmokeBudget(snapshot(), 1);
  assert.equal(result.slippageBpsPerAction, 10);
  assert.ok(result.prices.spotOpenLimit >= 4_104.1);
  assert.ok(result.prices.futuresOpenLimit <= 4_095.9);
  assert.ok(result.prices.futuresCloseLimit >= 4_105.11);
  assert.ok(result.prices.spotCloseLimit <= 4_094.9);
  assert.ok(result.totalCapitalUsd <= RWA_CONNECTIVITY_SMOKE_BUDGET_USD);
});

test("connectivity smoke budget includes adverse price-tick rounding and fails closed at the cap edge", () => {
  const value = snapshot();
  value.spot.priceTick = 1;
  value.perpetual.priceTick = 1;
  value.spot.minNotionalUsd = 12.49;
  value.perpetual.minNotionalUsd = 12.49;
  const result = calculateConnectivitySmokeBudget(value, 1);
  assert.equal(result.quantityXaut, 0);
  assert.equal(result.totalCapitalUsd, 0);
});

function snapshot(): RwaBinancePreflightSnapshot {
  return {
    accountId: "binance:test",
    accountFingerprint: "fingerprint",
    fetchedAt: Date.now(),
    accountMode: "single_asset_one_way",
    permissions: {
      read: true,
      spotTrade: true,
      contractTrade: true,
      withdraw: false,
      ipRestricted: true,
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: true,
    },
    productAvailability: {
      available: true,
      status: "available",
      spotSymbol: "XAUTUSDT",
      perpetualSymbol: "XAUTUSDT",
      checkedAt: Date.now(),
      message: null,
    },
    availableUsdt: 30,
    spotAvailableUsdt: 15,
    futuresAvailableUsdt: 15,
    existingSpotQuantityXaut: 0,
    spotAvailableQuantityXaut: 0,
    spotLockedQuantityXaut: 0,
    spotFreeXaut: 0,
    spotLockedXaut: 0,
    existingPerpetualQuantityXaut: 0,
    perpetualPositionSide: "flat",
    openSpotOrderCount: 0,
    openPerpetualOrderCount: 0,
    spot: {
      status: "Trading",
      minOrderQty: 0.0001,
      qtyStep: 0.0001,
      minNotionalUsd: 5,
      priceTick: 0.01,
      bid: 4_099,
      ask: 4_100,
      depthUsd: 100_000,
    },
    perpetual: {
      status: "Trading",
      minOrderQty: 0.001,
      qtyStep: 0.001,
      minNotionalUsd: 5,
      priceTick: 0.01,
      bid: 4_100,
      ask: 4_101,
      depthUsd: 100_000,
      mark: 4_100,
      fundingRate: 0,
      fundingIntervalHours: 8,
      nextFundingTime: null,
      liquidationDistancePercent: null,
    },
    fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
  };
}
