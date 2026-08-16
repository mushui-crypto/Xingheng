import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import {
  CredentialKeyProviderError,
  canonicalCredentialAad,
  equalCredentialAad,
  type CreatedCredentialDataKey,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type WrappedCredentialDataKey,
} from "../credentials/CredentialKeyProvider";
import { UserExchangeCredentialService } from "../credentials/UserExchangeCredentialService";
import { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
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

test("credential API accepts OKX passphrase without echoing secrets", async () => {
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
        accountId: "okx:credential-only:account",
        accountFingerprint: "OKX-FINGERPRINT",
        maskedApiKey: "okx-...-001",
        permissions: { read: false, executionEnabled: false, providerVerified: false },
        lastVerifiedAt: 1,
        message: "OKX API credential is encrypted and saved. Private provider validation and execution are not enabled for this venue.",
      };
    },
  } as never);

  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials/okx`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "okx-api-key",
        apiSecret: "never-echo-this",
        passphrase: "never-echo-passphrase",
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body.includes("never-echo-this"), false);
    assert.equal(body.includes("never-echo-passphrase"), false);
    assert.equal(captured[0]?.userId, "session-user");
    assert.equal(captured[0]?.venue, "okx");
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

test("credential API exposes an authenticated OKX controlled rebind operation", async () => {
  const users: string[] = [];
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerExchangeCredentialRoutes(app, {
    rebindOkx: async (userId: string) => {
      users.push(userId);
      return {
        venue: "okx",
        configured: true,
        accountId: "okx:0123456789abcdef",
        permissions: { providerVerified: true, executionEnabled: false },
      };
    },
  } as never);
  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials/okx/rebind`, {
      method: "POST",
    });
    const payload = await response.json() as {
      accountId: string;
      permissions: Record<string, boolean>;
    };
    assert.equal(response.status, 200);
    assert.deepEqual(users, ["session-user"]);
    assert.equal(payload.accountId, "okx:0123456789abcdef");
    assert.equal(payload.permissions.executionEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("credential API returns a stable KMS category without echoing credential input", async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerExchangeCredentialRoutes(app, {
    list: () => [],
    put: async () => {
      throw new CredentialKeyProviderError(
        "credential_key_provider_unavailable",
        "GCP KMS is unavailable, unauthorized, or the key version is disabled.",
      );
    },
  } as never);

  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials/bitget`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "bitget-api-key",
        apiSecret: "never-echo-this",
        passphrase: "never-echo-passphrase",
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(body.includes("credential_key_provider_unavailable"), true);
    assert.equal(body.includes("never-echo-this"), false);
    assert.equal(body.includes("never-echo-passphrase"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("credential API persists Bybit, Bitget and OKX credentials through service, store and KMS envelope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "exchange-credential-route-"));
  const dbPath = join(directory, "credentials.sqlite");
  const keyProvider = new FakeCredentialKeyProvider();
  const store = new UserExchangeCredentialStore({ dbPath, environment: "test", keyProvider });
  const service = new UserExchangeCredentialService(store, {
    okxClientFactory: () => ({
      validateAccess: async () => ({
        accountId: "okx:0123456789abcdef",
        accountFingerprint: "0123456789abcdef",
        uidHash: `0123456789abcdef${"0".repeat(48)}`,
        accountLevel: "3",
        permissions: {
          read: true,
          spotTrade: true,
          contractTrade: true,
          withdraw: false,
          ipRestricted: true,
          accountLevelSupported: true,
          positionModeSupported: true,
          providerVerified: true,
          executionEnabled: true,
        },
      }),
    }),
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerExchangeCredentialRoutes(app, service);
  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    for (const venue of ["bybit", "bitget", "okx"] as const) {
      const secret = `${venue}-secret-route-001`;
      const passphrase = `${venue}-passphrase-route-001`;
      const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials/${venue}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: `${venue}-api-key-route-001`,
          apiSecret: secret,
          ...(venue === "bybit" ? {} : { passphrase }),
        }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body.includes(secret), false);
      assert.equal(body.includes(passphrase), false);
      const payload = JSON.parse(body) as {
        venue: string;
        configured: boolean;
        accountId: string;
        permissions: Record<string, boolean>;
        message: string;
      };
      assert.equal(payload.venue, venue);
      assert.equal(payload.configured, true);
      if (venue === "okx") {
        assert.equal(payload.accountId, "okx:0123456789abcdef");
        assert.equal(payload.permissions.executionEnabled, true);
        assert.match(payload.message, /Provider-verified/u);
      } else {
        assert.match(payload.accountId, new RegExp(`^${venue}:credential-only:`));
        assert.equal(payload.permissions.executionEnabled, false);
        assert.match(payload.message, /Private provider validation and execution are not enabled/u);
      }

      const databaseBytes = readFileSync(dbPath).toString("utf8");
      assert.equal(databaseBytes.includes(secret), false);
      assert.equal(databaseBytes.includes(passphrase), false);
      assert.deepEqual(await store.loadForExecution("session-user", venue), {
        apiKey: `${venue}-api-key-route-001`,
        apiSecret: secret,
        ...(venue === "bybit" ? {} : { passphrase }),
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("OKX rebind decrypts a legacy envelope and atomically saves Provider-derived identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "okx-credential-rebind-route-"));
  const dbPath = join(directory, "credentials.sqlite");
  const keyProvider = new FakeCredentialKeyProvider();
  const store = new UserExchangeCredentialStore({ dbPath, environment: "test", keyProvider });
  await store.save({
    userId: "session-user",
    venue: "okx",
    accountId: "okx:credential-only:0123456789abcdef0123",
    accountFingerprint: "OKX-LEGACY",
    apiKey: "okx-api-key-rebind-001",
    apiSecret: "okx-secret-rebind-001",
    passphrase: "okx-passphrase-rebind-001",
    permissions: { providerVerified: false, executionEnabled: false },
  });
  let providerReads = 0;
  const service = new UserExchangeCredentialService(store, {
    okxClientFactory: () => ({
      validateAccess: async () => {
        providerReads += 1;
        return {
          accountId: "okx:0123456789abcdef",
          accountFingerprint: "0123456789abcdef",
          uidHash: `0123456789abcdef${"0".repeat(48)}`,
          accountLevel: "3",
          permissions: {
            read: true,
            spotTrade: true,
            contractTrade: true,
            withdraw: false,
            ipRestricted: true,
            accountLevelSupported: true,
            positionModeSupported: true,
            providerVerified: true,
            executionEnabled: true,
          },
        };
      },
    }),
  });
  const app = express();
  app.use((request, _response, next) => {
    request.user = { id: "session-user" } as never;
    next();
  });
  registerExchangeCredentialRoutes(app, service);
  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/exchange-credentials/okx/rebind`, {
      method: "POST",
    });
    const payload = await response.json() as {
      accountId: string;
      permissions: Record<string, boolean>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.accountId, "okx:0123456789abcdef");
    assert.equal(payload.permissions.providerVerified, true);
    assert.equal(payload.permissions.executionEnabled, false);
    assert.equal(providerReads, 1);
    assert.deepEqual(await store.loadForExecution("session-user", "okx"), {
      apiKey: "okx-api-key-rebind-001",
      apiSecret: "okx-secret-rebind-001",
      passphrase: "okx-passphrase-rebind-001",
    });
    const databaseBytes = readFileSync(dbPath).toString("utf8");
    assert.equal(databaseBytes.includes("okx-secret-rebind-001"), false);
    assert.equal(databaseBytes.includes("okx-passphrase-rebind-001"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

class FakeCredentialKeyProvider implements CredentialKeyProvider {
  readonly name = "fake-kms";
  readonly keyName = "fake-key";
  readonly configured = true;
  readonly configurationError = null;
  readonly entries = new Map<string, { aad: Buffer; dek: Buffer }>();

  async createDataKey(context: CredentialKeyContext): Promise<CreatedCredentialDataKey> {
    const plaintextDek = randomBytes(32);
    const wrappedDek = randomBytes(24).toString("base64url");
    this.entries.set(wrappedDek, { aad: canonicalCredentialAad(context), dek: Buffer.from(plaintextDek) });
    return { provider: this.name, keyName: this.keyName, wrapReference: "fake-key/versions/1", wrappedDek, plaintextDek };
  }

  async unwrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext) {
    if (input.provider !== this.name || input.keyName !== this.keyName) {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "Credential key identity does not match.");
    }
    const entry = this.entries.get(input.wrappedDek);
    if (!entry || !equalCredentialAad(entry.aad, canonicalCredentialAad(context))) {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "Credential key identity does not match.");
    }
    return Buffer.from(entry.dek);
  }
}
