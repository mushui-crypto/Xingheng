import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { registerBinancePersonalTradingRoutes } from "./binancePersonalTradingRoutes";

test("Binance routes resolve status from the authenticated user", async () => {
  const users: string[] = [];
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerBinancePersonalTradingRoutes(app, {
    status: (userId: string) => {
      users.push(userId);
      return { credential: { configured: true, maskedApiKey: "api-...-001" } };
    },
  } as never);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/binance/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(users, ["session-user"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("legacy Binance mutation routes are absent", () => {
  const source = readFileSync(new URL("./binancePersonalTradingRoutes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /app\.post\("\/api\/binance\/(?:orders|test-orders|orders\/cancel|reconciliation)"/u,
  );
  assert.doesNotMatch(source, /service\.(?:placeOrder|placeTestOrder|cancelOrder|reconciliation)\(/u);
  assert.match(source, /app\.get\("\/api\/binance\/orders"[^\n]+service\.ordersState\(\)/u);
});

test("legacy Binance mutation endpoints return not found", async () => {
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerBinancePersonalTradingRoutes(app, {} as never);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    for (const path of ["orders", "test-orders", "orders/cancel", "reconciliation"]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/binance/${path}`, { method: "POST" });
      assert.equal(response.status, 404, path);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("legacy Binance strategy execution routes are absent", () => {
  const source = readFileSync(new URL("./binancePersonalTradingRoutes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/api\/binance\/strategy|service\.(?:strategyStatus|enter|exit)\(/u);
});
