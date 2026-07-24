import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { UserService } from "../../auth/UserService";
import { TradingStore } from "../../storage/TradingStore";
import { registerAuthRoutes, registerUserAuthMiddleware } from "../auth/authRoutes";
import { RwaAutomationControlError } from "../arbitrage/automation/RwaAutomationControlService";
import { RwaAutomationGovernanceError } from "../arbitrage/automation/RwaAutomationGovernance";
import type { EmailService } from "../email/EmailService";
import { FakeCredentialKeyProvider } from "../arbitrage/automation/FakeCredentialKeyProvider";
import { StepUpSecurityService } from "./StepUpSecurityService";
import { StepUpSecurityStore } from "./StepUpSecurityStore";
import { registerStepUpSecurityRoutes } from "./stepUpSecurityRoutes";

test("step-up routes are user-only, no-store, disabled-aware, and reject client user scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-step-up-routes-"));
  const tradingStore = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(
    tradingStore,
    { sendVerificationMail: async () => {}, isConfigured: false } as unknown as EmailService,
    "http://127.0.0.1:5173",
  );
  const registerCode = await users.requestRegisterCode("step-up@example.com") as { devCode?: string };
  assert.ok(registerCode.devCode);
  const user = users.register({ email: "step-up@example.com", password: "Password123!", code: registerCode.devCode });
  const login = users.login("step-up@example.com", "Password123!");
  const provider = new FakeCredentialKeyProvider();
  const security = new StepUpSecurityService({
    storeFactory: (userId) => new StepUpSecurityStore(userId, provider, { statePath: join(directory, `${userId}.enc.json`) }),
    verifyPassword: (userId, password) => users.verifyCurrentPassword(userId, password),
    getEnrollmentInvalidatedAt: (userId) => users.getStepUpEnrollmentInvalidatedAt(userId),
  });
  const app = express();
  app.use(express.json());
  registerAuthRoutes({
    app,
    users,
    wallet: {} as any,
    tradingStore,
    stepUpSecurity: security,
    config: {
      adminAuthConfigured: true,
      adminEmail: "admin@example.com",
      adminPassword: "adminpassword123",
      isProduction: false,
    } as any,
  });
  registerUserAuthMiddleware(app, users);
  registerStepUpSecurityRoutes(app, security, {
    resolveStepUpIntent: async (userId: string, input: unknown, sourceIp: string) => {
      assert.equal(userId, user.id);
      assert.match(sourceIp, /127\.0\.0\.1/);
      if ((input as { rateLimited?: unknown })?.rateLimited === true) {
        throw new RwaAutomationGovernanceError(
          429,
          "automation_rate_limited",
          "自动套利请求过于频繁，请稍后再试。",
          17,
        );
      }
      throw new RwaAutomationControlError(409, "account_mismatch", "二次验证账户意图不属于当前用户。");
    },
  } as any);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { authorization: `Bearer ${login.token}` };

  try {
    const anonymous = await fetch(`${base}/api/auth/security/step-up/status`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");

    const active = await fetch(`${base}/api/auth/security/step-up/status`, { headers: auth });
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("cache-control"), "no-store");
    assert.equal((await active.json() as { enrolled: boolean }).enrolled, false);

    const injectedScope = await fetch(`${base}/api/auth/security/step-up/enrollment/begin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "Password123!", userId: "another-user" }),
    });
    assert.equal(injectedScope.status, 400);
    assert.equal(injectedScope.headers.get("cache-control"), "no-store");
    assert.equal((await injectedScope.json() as { category: string }).category, "step_up_invalid");

    const ownershipMismatch = await fetch(`${base}/api/auth/security/step-up/authorize`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456", intent: {} }),
    });
    assert.equal(ownershipMismatch.status, 409);
    assert.equal((await ownershipMismatch.json() as { category: string }).category, "account_mismatch");

    const rateLimitedIntent = await fetch(`${base}/api/auth/security/step-up/authorize`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456", intent: { rateLimited: true } }),
    });
    assert.equal(rateLimitedIntent.status, 429);
    assert.equal(rateLimitedIntent.headers.get("cache-control"), "no-store");
    assert.equal(rateLimitedIntent.headers.get("retry-after"), "17");
    assert.deepEqual(await rateLimitedIntent.json(), {
      category: "automation_rate_limited",
      message: "自动套利请求过于频繁，请稍后再试。",
    });

    const adminLogin = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "adminpassword123" }),
    });
    const adminOnly = await fetch(`${base}/api/auth/security/step-up/status`, {
      headers: { cookie: adminLogin.headers.get("set-cookie") ?? "" },
    });
    assert.equal(adminOnly.status, 401);
    assert.equal(adminOnly.headers.get("cache-control"), "no-store");

    users.setUserStatus(user.id, "disabled");
    const disabled = await fetch(`${base}/api/auth/security/step-up/status`, { headers: auth });
    assert.equal(disabled.status, 403);
    assert.equal(disabled.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    tradingStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
