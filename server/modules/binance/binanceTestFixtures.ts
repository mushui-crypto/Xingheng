import type { BinancePreflightSnapshot } from "./BinanceTypes";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

export function tradingConfigFixture(overrides: Partial<BinanceTradingConfig> = {}): BinanceTradingConfig {
  return {
    liveTradingEnabled: true,
    killSwitchActive: false,
    maxOrderUsd: 25,
    maxPositionUsd: 100,
    maxEntryBasisBps: 30,
    minNetAprPercent: 8,
    maxSlippageBps: 20,
    orderTimeoutMs: 100,
    processingTimeoutMs: 1_000,
    allowUntradeableSpotDustEntry: false,
    gitCommit: "774c500",
    ...overrides,
  };
}

export function snapshotFixture(overrides: Partial<BinancePreflightSnapshot> = {}): BinancePreflightSnapshot {
  return {
    accountId: "binance:test",
    accountFingerprint: "test",
    fetchedAt: Date.now(),
    accountMode: "single_asset_one_way",
    permissions: {
      read: true, spotTrade: true, contractTrade: true, withdraw: false, ipRestricted: true,
      spotAccount: true, futuresAccount: true, positionModeSupported: true,
    },
    productAvailability: {
      available: true, status: "available", spotSymbol: "XAUTUSDT", perpetualSymbol: "XAUTUSDT", checkedAt: Date.now(), message: null,
    },
    availableUsdt: 1_000,
    spotAvailableUsdt: 500,
    futuresAvailableUsdt: 500,
    spotFreeXaut: 0,
    spotLockedXaut: 0,
    existingSpotQuantityXaut: 0,
    spotAvailableQuantityXaut: 0,
    spotLockedQuantityXaut: 0,
    existingPerpetualQuantityXaut: 0,
    perpetualPositionSide: "flat",
    openSpotOrderCount: 0,
    openPerpetualOrderCount: 0,
    spot: { status: "Trading", minOrderQty: 0.001, qtyStep: 0.001, minNotionalUsd: 5, priceTick: 0.1, quantityPrecision: 3, bid: 999, ask: 1_000, depthUsd: 10_000 },
    perpetual: {
      status: "Trading", minOrderQty: 0.001, qtyStep: 0.001, minNotionalUsd: 5, priceTick: 0.1, quantityPrecision: 3,
      bid: 1_001, ask: 1_002, depthUsd: 10_000, leverage: 1, marginMode: "cross", mark: 1_001, fundingRate: 0.0002,
      fundingIntervalHours: 8, nextFundingTime: Date.now() + 1_000, liquidationDistancePercent: null,
    },
    fees: { spotTakerBps: 10, perpetualTakerBps: 5 },
    ...overrides,
  };
}
