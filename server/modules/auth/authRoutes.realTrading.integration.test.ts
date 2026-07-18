import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { EmailService } from "../email/EmailService";
import { UserService } from "../../auth/UserService";
import { TradingStore } from "../../storage/TradingStore";
import { registerUserAuthMiddleware } from "./authRoutes";

test("real-trading middleware returns 401, allows active users, and returns 403 after disable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-real-auth-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(store, {} as EmailService, "http://127.0.0.1:5173");
  const login = users.login("demo@example.com", "demo123");
  const app = express();
  registerUserAuthMiddleware(app, users);
  app.post("/api/real-trading/exchange", (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/real-trading/exchange`;
  try {
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${login.token}` } })).status, 200);
    users.setUserStatus(login.user.id, "disabled");
    assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${login.token}` } })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
