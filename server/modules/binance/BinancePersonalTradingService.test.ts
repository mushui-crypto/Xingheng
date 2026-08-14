import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BinanceCredential } from "./BinanceCredential";
import { BinanceOrderStore } from "./BinanceOrderStore";
import { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { BinanceRiskError } from "./BinanceRiskGuard";

test("personal trading service exposes no legacy mutation facade", () => {
  const source = readFileSync(new URL("./BinancePersonalTradingService.ts", import.meta.url), "utf8");
  const connectionCheck = source.slice(source.indexOf("  async start()"), source.indexOf("  getStatus()"));
  assert.doesNotMatch(source, /async (?:placeOrder|placeTestOrder)\(|\breconciliation\(\)/u);
  assert.doesNotMatch(source, /\.reconcile\(\)/u);
  assert.match(connectionCheck, /client\.validateAccess\(\)/u);
  assert.doesNotMatch(connectionCheck, /syncPositions|reconcile|cancel|place/u);
  assert.match(source, /async placeExecutionOrder\(/u);
  assert.match(source, /async cancelOrder\(/u);
  const cancelOrder = source.slice(source.indexOf("  async cancelOrder("), source.indexOf("  ordersState()"));
  assert.match(cancelOrder, /this\.risk\.assertCancellationAllowed\(\)/u);
  assert.ok(
    cancelOrder.indexOf("this.risk.assertCancellationAllowed()") < cancelOrder.indexOf("this.requireOrders().cancel"),
    "cancel mutation must pass RiskGuard before reaching OrderManager",
  );
});

test("closed risk-increasing gates allow only a known-order cancel to continue past RiskGuard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "binance-cancel-risk-"));
  const previous = {
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED,
    killSwitch: process.env.BINANCE_KILL_SWITCH,
  };
  try {
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.BINANCE_KILL_SWITCH = "true";
    const killSwitchActive = new BinancePersonalTradingService({
      credential: null,
      orderDbPath: join(directory, "kill-switch.sqlite"),
    });
    await assert.rejects(
      () => killSwitchActive.cancelOrder({ idempotencyKey: "cancel-kill-switch" }),
      (error: unknown) => !(error instanceof BinanceRiskError) && /not configured/u.test(String(error)),
    );
    killSwitchActive.close();

    process.env.LIVE_TRADING_ENABLED = "false";
    process.env.BINANCE_KILL_SWITCH = "false";
    const liveDisabled = new BinancePersonalTradingService({
      credential: null,
      orderDbPath: join(directory, "live-disabled.sqlite"),
    });
    await assert.rejects(
      () => liveDisabled.cancelOrder({ idempotencyKey: "cancel-live-disabled" }),
      (error: unknown) => !(error instanceof BinanceRiskError) && /not configured/u.test(String(error)),
    );
    liveDisabled.close();
  } finally {
    restore("LIVE_TRADING_ENABLED", previous.liveTradingEnabled);
    restore("BINANCE_KILL_SWITCH", previous.killSwitch);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordersState and exact execution lookup propagate isolated persistence without provider access", () => {
  const directory = mkdtempSync(join(tmpdir(), "binance-orders-state-isolation-"));
  const dbPath = join(directory, "orders.sqlite");
  try {
    const store = new BinanceOrderStore(dbPath);
    for (const id of ["normal", "malformed"]) {
      store.reserve({
        idempotencyKey: id, requestFingerprint: `${id}-fingerprint`, clientOrderId: `${id}-client`,
        category: "spot", symbol: "BTCUSDT", executionMode: "production_ioc",
      });
    }
    store.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE binance_personal_orders SET providerOrderId = ?, orderJson = ? WHERE idempotencyKey = ?")
      .run(
        "9223372036854775807",
        '{"symbol":"BTCUSDT","orderId":9223372036854775807,"orderLinkId":"malformed-client","status":"New","requestedQuantity":0.001,"filledQuantity":0,"requestedBaseQuantity":"0.001","filledBaseQuantity":"0","averagePrice":null,"feeUsd":0,"updatedAt":3000}',
        "malformed",
      );
    db.close();

    const service = new BinancePersonalTradingService({
      credential: BinanceCredential.fromValues("test-key", "test-secret"),
      orderDbPath: dbPath,
    });
    const state = service.ordersState();
    assert.deepEqual(state.orders.map((order) => order.idempotencyKey), ["normal"]);
    assert.deepEqual(state.isolatedOrders.map((order) => order.idempotencyKey), ["malformed"]);
    assert.equal(service.executionOrderState("normal").kind, "found");
    assert.equal(service.executionOrderState("malformed").kind, "isolated");
    assert.equal(service.executionOrderState("missing").kind, "missing");
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
