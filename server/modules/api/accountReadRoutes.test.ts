import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { AccountReadRegistry, AccountReadRegistryError } from "../account-read/AccountReadRegistry";
import { registerAccountReadRoutes } from "./accountReadRoutes";

test("account read API binds the venue read to the authenticated user", async () => {
  const reads: Array<{ userId: string; venue: string }> = [];
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerAccountReadRoutes(app, {
    read: async (userId: string, venue: string) => {
      reads.push({ userId, venue });
      return { venue };
    },
  } as never);

  const { response, close } = await request(app, "/api/account-read/binance");
  try {
    assert.equal(response.status, 200);
    assert.deepEqual(reads, [{ userId: "session-user", venue: "binance" }]);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await close();
  }
});

test("account read API distinguishes invalid and unimplemented venues", async (t) => {
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  const registry = new AccountReadRegistry({
    loadForAccountRead: async () => ({ apiKey: "unused", apiSecret: "unused" }),
  } as never, []);
  registerAccountReadRoutes(app, registry);

  for (const [path, expectedStatus, category] of [
    ["/api/account-read/unknown", 400, "account_read_venue_invalid"],
    ["/api/account-read/okx", 501, "account_read_provider_not_implemented"],
  ] as const) {
    await t.test(category, async () => {
      const { response, close } = await request(app, path);
      try {
        assert.equal(response.status, expectedStatus);
        assert.equal((await response.json() as { category: string }).category, category);
      } finally {
        await close();
      }
    });
  }
});

test("account read API rejects a missing authenticated user", async () => {
  const app = express();
  registerAccountReadRoutes(app, {
    read: async () => { throw new AccountReadRegistryError("unexpected", "must not run"); },
  } as never);

  const { response, close } = await request(app, "/api/account-read/binance");
  try {
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { category: string }).category, "authentication_required");
  } finally {
    await close();
  }
});

async function request(app: express.Express, path: string) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    response: await fetch(`http://127.0.0.1:${port}${path}`),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
