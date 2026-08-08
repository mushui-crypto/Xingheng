import assert from "node:assert/strict";
import test from "node:test";
import { loadBinanceTradingConfig } from "./BinanceTradingConfig";

test("personal trading defaults are fail-closed", () => {
  const config = loadBinanceTradingConfig({});
  assert.equal(config.liveTradingEnabled, false);
  assert.equal(config.killSwitchActive, true);
  assert.equal(config.maxOrderUsd, 25);
  assert.equal(config.maxPositionUsd, 100);
  assert.equal(config.processingTimeoutMs, 60_000);
  assert.equal(config.allowUntradeableSpotDustEntry, false);
  assert.equal(config.gitCommit, "development");
});

test("personal trading accepts explicit live limits and git version", () => {
  const config = loadBinanceTradingConfig({
    LIVE_TRADING_ENABLED: "true",
    BINANCE_KILL_SWITCH: "false",
    MAX_ORDER_USD: "20",
    MAX_POSITION_USD: "60",
    BINANCE_ALLOW_UNTRADEABLE_SPOT_DUST_ENTRY: "true",
    GIT_COMMIT: "774c500",
  });
  assert.equal(config.liveTradingEnabled, true);
  assert.equal(config.killSwitchActive, false);
  assert.equal(config.maxOrderUsd, 20);
  assert.equal(config.maxPositionUsd, 60);
  assert.equal(config.allowUntradeableSpotDustEntry, true);
  assert.equal(config.gitCommit, "774c500");
});

test("order limit cannot exceed position limit", () => {
  assert.throws(() => loadBinanceTradingConfig({ MAX_ORDER_USD: "101", MAX_POSITION_USD: "100" }));
});
