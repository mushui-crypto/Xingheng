import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { AccountReadRegistry, AccountReadRegistryError } from "../account-read/AccountReadRegistry";
import { BitgetAccountReadProviderFactory } from "../account-read/BitgetAccountReadProvider";
import { BybitAccountReadProviderFactory } from "../account-read/BybitAccountReadProvider";
import { OkxAccountReadProviderFactory } from "../account-read/OkxAccountReadProvider";
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

test("account read API rejects an invalid venue", async (t) => {
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

test("account read API serves Bitget through the common registry route", async () => {
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => {
      assert.equal(userId, "session-user");
      assert.equal(venue, "bitget");
      return { apiKey: "key", apiSecret: "secret", passphrase: "passphrase" };
    },
  } as never, [new BitgetAccountReadProviderFactory(() => ({
    readAccountSnapshot: async () => ({
      uid: "8123456789",
      accountMode: "hybrid",
      assetMode: "multi_assets",
      accountLevel: "advanced",
      permType: "read-only",
      permissions: ["uta_mgt"],
      boundIps: "",
      balances: [{ asset: "USDT", total: 120, available: 100, locked: 20 }],
      fetchedAt: 1_800_000_000_000,
    }),
  }))]);
  registerAccountReadRoutes(app, registry);

  const { response, close } = await request(app, "/api/account-read/bitget");
  try {
    const body = await response.json() as { venue: string; accountTypes: string[]; valuationCoverage: string };
    assert.equal(response.status, 200);
    assert.equal(body.venue, "bitget");
    assert.deepEqual(body.accountTypes, ["unified"]);
    assert.equal(body.valuationCoverage, "UNAVAILABLE");
  } finally {
    await close();
  }
});

test("account read API serves Bybit through the common registry route", async () => {
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => {
      assert.equal(userId, "session-user");
      assert.equal(venue, "bybit");
      return { apiKey: "key", apiSecret: "secret" };
    },
  } as never, [new BybitAccountReadProviderFactory(() => ({
    readAccountSnapshot: async () => ({
      uid: "91234567",
      unifiedMarginStatus: 5,
      marginMode: "REGULAR_MARGIN",
      readOnly: 1,
      permissions: null,
      boundIps: null,
      balances: [{ asset: "USDT", accountType: "unified", total: 120, available: null, locked: 20 }],
      fetchedAt: 1_800_000_000_000,
    }),
  }))]);
  registerAccountReadRoutes(app, registry);

  const { response, close } = await request(app, "/api/account-read/bybit");
  try {
    const body = await response.json() as { venue: string; accountTypes: string[]; valuationCoverage: string };
    assert.equal(response.status, 200);
    assert.equal(body.venue, "bybit");
    assert.deepEqual(body.accountTypes, ["unified"]);
    assert.equal(body.valuationCoverage, "UNAVAILABLE");
  } finally {
    await close();
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

test("account read API serves OKX through the common registry route", async () => {
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  const registry = new AccountReadRegistry({
    loadForAccountRead: async (userId: string, venue: string) => {
      assert.equal(userId, "session-user");
      assert.equal(venue, "okx");
      return { apiKey: "key", apiSecret: "secret", passphrase: "passphrase" };
    },
  } as never, [new OkxAccountReadProviderFactory(() => ({
    readAccountSnapshot: async () => ({
      uid: "44705892343619584",
      accountLevel: "3",
      permissions: "read_only",
      boundIps: "",
      balances: [{ asset: "USDT", total: 120, available: 100, locked: 20 }],
      fetchedAt: 1_800_000_000_000,
    }),
  }))]);
  registerAccountReadRoutes(app, registry);

  const { response, close } = await request(app, "/api/account-read/okx");
  try {
    const body = await response.json() as { venue: string; accountTypes: string[]; valuationCoverage: string };
    assert.equal(response.status, 200);
    assert.equal(body.venue, "okx");
    assert.deepEqual(body.accountTypes, ["unified"]);
    assert.equal(body.valuationCoverage, "UNAVAILABLE");
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
