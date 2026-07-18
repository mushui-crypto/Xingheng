import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { EmailService } from "../email/EmailService";
import { UserService } from "../../auth/UserService";
import { TradingStore } from "../../storage/TradingStore";
import { registerUserAuthMiddleware } from "../auth/authRoutes";
import { registerRealTradingRoutes } from "./realTradingRoutes";

test("user reconciliation records are authenticated, no-store, redacted, and disabled users receive 403", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-real-reconciliation-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(store, {} as EmailService, "http://127.0.0.1:5173");
  const login = users.login("demo@example.com", "demo123");
  const now = Date.now();
  store.reserveRealTradingOrderRequest({
    requestId: "request-order",
    userId: login.user.id,
    network: "hyperliquid-testnet",
    masterAddress: "0x1111111111111111111111111111111111111111",
    clientOrderIds: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    actionType: "order",
    requestFingerprint: "fingerprint-order",
    submittedAt: now,
  });
  store.completeRealTradingOrderRequest("request-order", "pending_reconciliation", JSON.stringify({ requestId: "request-order" }), now);
  store.saveRealTradingAudit(record("request-order", login.user.id, "order", ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], now));
  store.saveRealTradingAudit(record("request-cancel", login.user.id, "cancel", [], now + 1));

  const app = express();
  app.use(express.json());
  registerUserAuthMiddleware(app, users);
  registerRealTradingRoutes({
    app,
    info: {} as any,
    exchange: {} as any,
    orderState: {} as any,
    realtimeTokens: {} as any,
    auditStore: store,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/real-trading/orders/reconciliation`;
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    const active = await fetch(endpoint, { headers: { authorization: `Bearer ${login.token}` } });
    assert.equal(active.status, 200);
    assert.match(active.headers.get("cache-control") ?? "", /no-store/);
    const payload = await active.json() as any;
    assert.equal(payload.network, "hyperliquid-testnet");
    assert.equal(payload.records.length, 2);
    assert.equal(payload.records.find((item: any) => item.requestId === "request-order")?.autoRecoverable, true);
    assert.equal(payload.records.find((item: any) => item.requestId === "request-cancel")?.manualReview, true);
    assert.doesNotMatch(JSON.stringify(payload), /0x1111111111111111111111111111111111111111|signature|private.?key|raw.?payload|mnemonic/i);
    users.setUserStatus(login.user.id, "disabled");
    assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${login.token}` } })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function record(requestId: string, userId: string, actionType: string, clientOrderIds: string[], submittedAt: number) {
  return {
    requestId,
    userId,
    network: "hyperliquid-testnet" as const,
    masterAddress: "0x1111111111111111111111111111111111111111",
    actionType,
    clientOrderIds,
    outcome: "pending_reconciliation" as const,
    errorCategory: "provider_transport_unknown",
    providerStatus: "unknown",
    httpStatus: 504,
    message: "Hyperliquid Testnet 请求结果未知。",
    submittedAt,
    completedAt: submittedAt,
  };
}
