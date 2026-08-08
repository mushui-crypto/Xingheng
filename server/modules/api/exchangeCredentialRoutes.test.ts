import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { registerExchangeCredentialRoutes } from "./exchangeCredentialRoutes";

test("credential API binds input to the authenticated user and never echoes Secret", async () => {
  const captured: Array<{ userId: string; venue: string; input: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerExchangeCredentialRoutes(app, {
    list: () => [],
    put: async (userId: string, venue: string, input: unknown) => {
      captured.push({ userId, venue, input });
      return {
        venue,
        configured: true,
        implemented: true,
        accountId: "binance:account-1",
        accountFingerprint: "fingerprint-1",
        maskedApiKey: "api-...-001",
        permissions: { read: true, trade: true, withdraw: false },
        lastVerifiedAt: 1,
        message: null,
      };
    },
    delete: async () => ({ venue: "binance", configured: false }),
  } as never);

  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials/binance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "api-key", apiSecret: "never-echo-this" }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body.includes("never-echo-this"), false);
    assert.equal(captured[0]?.userId, "session-user");
    assert.equal(captured[0]?.venue, "binance");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("credential API rejects a request without an authenticated user", async () => {
  const app = express();
  registerExchangeCredentialRoutes(app, {
    list: () => [],
  } as never);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials`);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { category: string }).category, "authentication_required");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
