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

test("raw order routes cannot select the internal MARKET execution method", () => {
  const source = readFileSync(new URL("./binancePersonalTradingRoutes.ts", import.meta.url), "utf8");
  assert.match(source, /\/api\/binance\/orders[^\n]+service\.placeOrder\(request\.body\)/u);
  assert.match(source, /\/api\/binance\/test-orders[^\n]+service\.placeTestOrder\(request\.body\)/u);
  assert.doesNotMatch(source, /\/api\/binance\/(?:orders|test-orders)[^\n]+placeExecutionOrder/u);
});
