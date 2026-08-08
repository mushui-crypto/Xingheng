import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { UserService } from "../../auth/UserService";
import { TradingStore } from "../../storage/TradingStore";
import type { EmailService } from "../email/EmailService";
import { registerUserAuthMiddleware } from "./authRoutes";

test("personal trading authentication failures are not cacheable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stellax-personal-auth-"));
  const store = new TradingStore(join(directory, "test.sqlite"));
  const users = new UserService(store, {} as EmailService, "http://127.0.0.1:5173");
  const app = express();
  registerUserAuthMiddleware(app, users);
  app.get("/api/exchange-credentials", (_request, response) => response.json([]));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/exchange-credentials`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
