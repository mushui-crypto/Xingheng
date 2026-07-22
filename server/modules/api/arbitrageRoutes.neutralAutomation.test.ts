import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { EmailService } from "../email/EmailService";
import { UserService } from "../../auth/UserService";
import { TradingStore } from "../../storage/TradingStore";
import { registerAuthRoutes, registerUserAuthMiddleware } from "../auth/authRoutes";
import { ArbitrageDashboardService } from "../arbitrage/ArbitrageDashboardService";
import { RwaBybitReadOnlyConnector } from "../arbitrage/automation/RwaBybitReadOnlyConnector";
import { RwaNeutralAutomationService } from "../arbitrage/automation/RwaNeutralAutomationService";
import { registerArbitrageRoutes } from "./arbitrageRoutes";
import type { ArbitrageDashboardSnapshot } from "../arbitrage/arbitrageTypes";

test("admin neutral automation status is owner/admin-only, no-store, and redacted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-rwa-neutral-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const email = { sendVerificationMail: async () => {}, isConfigured: false } as unknown as EmailService;
  const users = new UserService(store, email, "http://127.0.0.1:5173");
  const registerCode = await users.requestRegisterCode("user@example.com") as { devCode?: string };
  const code = registerCode.devCode;
  assert.ok(code);
  users.register({ email: "user@example.com", password: "Password123!", code });
  const userLogin = users.login("user@example.com", "Password123!");
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
  registerUserAuthMiddleware(app, users);
  registerArbitrageRoutes(
    app,
    new ArbitrageDashboardService({ snapshotLoader: async () => emptyDashboard() }),
    new RwaNeutralAutomationService(new RwaBybitReadOnlyConnector(), { now: () => 1_800_000_000_000 }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/admin/arbitrage/neutral-automation`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/arbitrage/neutral-automation`, {
      headers: { authorization: `Bearer ${userLogin.token}` },
    })).status, 401);
    const publicDashboard = await fetch(`${base}/api/arbitrage/dashboard`);
    assert.equal(publicDashboard.status, 200);
    const login = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "adminpassword123" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    const response = await fetch(`${base}/api/admin/arbitrage/neutral-automation`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as any;
    assert.equal(payload.phase, "phase_a_shadow");
    assert.equal(payload.ownerOnly, true);
    assert.equal(payload.execution.automaticOrdersEnabled, false);
    assert.equal(payload.execution.providerWriteCallCount, 0);
    assert.equal(payload.connector.permissions.trade, false);
    assert.equal(payload.connector.permissions.withdraw, false);
    assert.doesNotMatch(JSON.stringify(payload), /adminpassword123|Password123|api.?key|secret|signature|private.?key|rawPayload|raw_response/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function emptyDashboard(): ArbitrageDashboardSnapshot {
  return {
    horizonDays: 90 as const,
    generatedAt: Date.now(),
    markets: [],
    opportunities: [],
    summary: {
      bestScore: null,
      bestNetApr: null,
      eligibleOpportunityCount: 0,
      connectedVenueCount: 0,
      totalVenueCount: 5,
      trackedMarketCount: 0,
      usdcUsdtPrice: null,
      stablecoinBasisBps: null,
    },
    warnings: [],
  };
}
