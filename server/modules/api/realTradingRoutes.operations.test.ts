import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { EmailService } from "../email/EmailService";
import { UserService } from "../../auth/UserService";
import { TradingStore } from "../../storage/TradingStore";
import { registerAuthRoutes } from "../auth/authRoutes";
import { registerRealTradingRoutes } from "./realTradingRoutes";

test("admin real-trading operations health is admin-only and returns a testnet, redacted contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-real-ops-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(store, {} as EmailService, "http://127.0.0.1:5173");
  store.saveRealTradingAudit({
    requestId: "request-cancel",
    userId: "USR-demo",
    network: "hyperliquid-testnet",
    masterAddress: "0x1111111111111111111111111111111111111111",
    actionType: "cancel",
    clientOrderIds: [],
    outcome: "pending_reconciliation",
    errorCategory: "provider_transport_unknown",
    providerStatus: "unknown",
    httpStatus: 504,
    message: "Hyperliquid Testnet 请求结果未知。",
    submittedAt: Date.now(),
    completedAt: Date.now(),
  });
  const app = express();
  app.use(express.json());
  registerAuthRoutes({
    app,
    users,
    wallet: {} as any,
    tradingStore: store,
    config: {
      adminAuthConfigured: true,
      adminEmail: "admin@example.com",
      adminPassword: "adminpassword123",
      isProduction: false,
    } as any,
  });
  registerRealTradingRoutes({
    app,
    info: {} as any,
    exchange: {} as any,
    orderState: {} as any,
    realtimeTokens: {} as any,
    auditStore: store,
    risk: {
      getHealth: () => ({
        limits: { maxLeverage: 20 },
        inFlightByAddress: [{ masterAddress: "0x1111...1111", count: 1, notional: 100 }],
      }),
    } as any,
    userStreams: {
      getHealth: () => ({ activeStreamCount: 1, streams: [{ address: "0x2222...2222", status: "connected" }] }),
    } as any,
    reconciliation: {
      getHealth: () => ({ enabled: true, running: false, lastError: null }),
    } as any,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/admin/real-trading/operations`)).status, 401);
    const login = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "adminpassword123" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    const response = await fetch(`${base}/api/admin/real-trading/operations`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.network, "hyperliquid-testnet");
    assert.equal(payload.status, "degraded");
    assert.equal(payload.reconciliation.enabled, true);
    assert.equal(payload.operations.manualReviewPendingCount, 1);
    assert.equal(payload.operations.auditCleanup.retentionDays, 180);
    assert.doesNotMatch(JSON.stringify(payload), /adminpassword123|signature|private.?key|mnemonic|raw.?payload/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admin real-trading operations health is degraded when reconciliation worker has provider failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-real-ops-worker-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(store, {} as EmailService, "http://127.0.0.1:5173");
  const app = express();
  app.use(express.json());
  registerAuthRoutes({
    app,
    users,
    wallet: {} as any,
    tradingStore: store,
    config: {
      adminAuthConfigured: true,
      adminEmail: "admin@example.com",
      adminPassword: "adminpassword123",
      isProduction: false,
    } as any,
  });
  registerRealTradingRoutes({
    app,
    info: {} as any,
    exchange: {} as any,
    orderState: {} as any,
    realtimeTokens: {} as any,
    auditStore: store,
    risk: {
      getHealth: () => ({ limits: { maxLeverage: 20 }, inFlightByAddress: [] }),
    } as any,
    userStreams: {
      getHealth: () => ({ activeStreamCount: 0, streams: [] }),
    } as any,
    reconciliation: {
      getHealth: () => ({
        enabled: true,
        running: false,
        network: "hyperliquid-testnet",
        lastAttemptAt: Date.now(),
        lastSuccessAt: null,
        lastCompletedAt: null,
        consecutiveFailures: 1,
        lastError: "ECONNRESET [path] signature=[secret]",
        lastScannedPending: 1,
        lastRecoveredRequests: 0,
        stale: false,
      }),
    } as any,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "adminpassword123" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    const response = await fetch(`${base}/api/admin/real-trading/operations`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.status, "degraded");
    assert.equal(payload.operations.pendingCount, 0);
    assert.equal(payload.reconciliation.consecutiveFailures, 1);
    assert.match(payload.reconciliation.lastError, /ECONNRESET/);
    assert.doesNotMatch(JSON.stringify(payload), /signature=0x|private.?key|mnemonic|raw.?payload|\/tmp|\/dev\/null/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
