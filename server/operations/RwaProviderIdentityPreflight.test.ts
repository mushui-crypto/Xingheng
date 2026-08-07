import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { RwaBinanceProductionSelfTestBinding } from "../modules/arbitrage/automation/RwaBinanceProductionSelfTestPermit";
import { RwaBinanceProviderError } from "../modules/arbitrage/automation/RwaBinanceMainnetClient";
import {
  providerIdentityPreflightErrorCategory,
  providerIdentityPreflightFailureReceipt,
  runRwaProviderIdentityPreflight,
} from "./RwaProviderIdentityPreflight";
import { runRwaProviderUserStreamProbe } from "./RwaProviderUserStreamProbe";

const REVISION = "a".repeat(40);
const IDENTITY = {
  accountId: "binance:authoritative",
  accountFingerprint: "authoritative",
  uidSnapshot: "f".repeat(64),
  accountMode: "single_asset_one_way",
  permissions: {
    read: true, spotTrade: true, contractTrade: true, withdraw: false,
    ipRestricted: true, positionModeSupported: true,
  },
};
const SNAPSHOT = {
  ...IDENTITY,
  productAvailability: { available: true },
  spot: { status: "Trading", qtyStep: 0.0001, minOrderQty: 0.0001, minNotionalUsd: 5, priceTick: 0.01 },
  perpetual: { status: "Trading", qtyStep: 0.001, minOrderQty: 0.001, minNotionalUsd: 5, priceTick: 0.01 },
  existingSpotQuantityXaut: 0,
  existingPerpetualQuantityXaut: 0,
  openSpotOrderCount: 0,
  openPerpetualOrderCount: 0,
};
const STREAM_PROBE = {
  spotSignedSubscribe: true as const,
  futuresListenKeyCreate: true as const,
  futuresListenKeyKeepalive: true as const,
  futuresListenKeyClose: true as const,
};

class LifecycleSocket extends EventEmitter {
  constructor(readonly url: string, event: "error" | "close") {
    super();
    queueMicrotask(() => {
      this.emit("open");
      if (!url.includes("fstream")) return;
      if (event === "error") {
        this.emit("error", Object.assign(
          new TypeError("listen-key fixture-key fixture-secret provider response"),
          { code: "ECONNRESET" },
        ));
      } else {
        this.emit("close", 1006, Buffer.from(
          "listen-key fixture-key fixture-secret provider response",
        ));
      }
    });
  }

  send(value: string) {
    const request = JSON.parse(value);
    queueMicrotask(() => this.emit("message", JSON.stringify({ id: request.id, status: 200 })));
  }

  close() {}
}

async function captureFuturesLifecycleFailure(event: "error" | "close") {
  try {
    await runRwaProviderUserStreamProbe(
      { apiKey: "fixture-key", apiSecret: "fixture-secret" },
      (async (_url: string, init?: RequestInit) => new Response(
        init?.method === "POST" ? JSON.stringify({ listenKey: "listen-key" }) : "{}",
        { status: 200 },
      )) as typeof fetch,
      ((url: string) => new LifecycleSocket(url, event) as any),
      Date.now,
      { timeoutMs: 50, observationMs: 5 },
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected Futures lifecycle failure");
}

function activeBinding(bindingVersion = 1, uidSnapshot = IDENTITY.uidSnapshot): RwaBinanceProductionSelfTestBinding {
  return {
    userId: "USR-FIXTURE",
    venue: "binance",
    uidSnapshot,
    bindingVersion,
    status: "active",
  };
}

test("provider identity preflight binds authoritative access to stored metadata without writes", async () => {
  let loadCount = 0;
  let validateCount = 0;
  let readBindingCount = 0;
  const receipt = await runRwaProviderIdentityPreflight({
    loadConfig: () => ({
      deploymentEnvironment: "production",
      composeProject: "xingheng",
    }),
    serverKillSwitch: () => "true",
    expectedRevision: () => REVISION,
    releaseManifestRevision: () => REVISION,
    userId: () => "USR-FIXTURE",
    createStore: () => ({
      readCredentialBinding: async () => {
        readBindingCount += 1;
        return activeBinding(3);
      },
      loadCredentials: async () => {
        loadCount += 1;
        return { apiKey: "fixture-key", apiSecret: "fixture-secret" };
      },
    }),
    createClient: () => ({
      validateAccess: async () => {
        validateCount += 1;
        return IDENTITY;
      },
      readPreflightSnapshot: async () => SNAPSHOT,
    }),
    probeStreams: async () => STREAM_PROBE,
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  });
  assert.equal(loadCount, 1);
  assert.equal(validateCount, 1);
  assert.equal(readBindingCount, 2);
  assert.equal(receipt.deploymentEnvironment, "production");
  assert.equal(receipt.releaseManifestRevision, REVISION);
  assert.equal(receipt.runtimeIdentityMatchesManifest, true);
  assert.equal(receipt.accountMode, "single_asset_one_way");
  assert.equal(receipt.bindingVersion, 3);
  assert.equal(receipt.venue, "binance");
  assert.deepEqual(receipt.streamProbe, STREAM_PROBE);
  assert.equal(receipt.account.spotXautExposure, false);
  assert.match(receipt.userIdSha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.uidSnapshotSha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.accountBindingSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-user|fixture-key|fixture-secret|authoritative/u);
});

test("binding must remain unchanged across preflight receipt generation", async () => {
  const raceCases = [
    {
      label: "unbind",
      bindings: [
        activeBinding(1, IDENTITY.uidSnapshot),
        { ...activeBinding(1, IDENTITY.uidSnapshot), status: "verified_unbound" } satisfies RwaBinanceProductionSelfTestBinding,
      ],
    },
    {
      label: "rebind",
      bindings: [
        activeBinding(1, IDENTITY.uidSnapshot),
        {
          userId: "USR-FIXTURE",
          venue: "binance",
          uidSnapshot: "e".repeat(64),
          bindingVersion: 2,
          status: "active",
        } satisfies RwaBinanceProductionSelfTestBinding,
      ],
    },
    {
      label: "bindingVersion changed",
      bindings: [
        activeBinding(1, IDENTITY.uidSnapshot),
        {
          ...activeBinding(2, IDENTITY.uidSnapshot),
        } satisfies RwaBinanceProductionSelfTestBinding,
      ],
    },
    {
      label: "uidSnapshot changed",
      bindings: [
        activeBinding(1, IDENTITY.uidSnapshot),
        {
          ...activeBinding(1, "e".repeat(64)),
        } satisfies RwaBinanceProductionSelfTestBinding,
      ],
    },
  ] as const;

  for (const raceCase of raceCases) {
    let readIndex = 0;
    await assert.rejects(
      runRwaProviderIdentityPreflight({
        loadConfig: () => ({
          deploymentEnvironment: "production",
          composeProject: "xingheng",
        }),
        serverKillSwitch: () => "true",
        expectedRevision: () => REVISION,
        releaseManifestRevision: () => REVISION,
        userId: () => "USR-FIXTURE",
        createStore: () => ({
          readCredentialBinding: async () => raceCase.bindings[Math.min(readIndex++, raceCase.bindings.length - 1)] ?? null,
          loadCredentials: async () => ({ apiKey: "fixture-key", apiSecret: "fixture-secret" }),
        }),
        createClient: () => ({
          validateAccess: async () => IDENTITY,
          readPreflightSnapshot: async () => SNAPSHOT,
        }),
        probeStreams: async () => STREAM_PROBE,
      }),
      /uid_binding/u,
      raceCase.label,
    );
    assert.equal(readIndex, 2, raceCase.label);
  }
});

test("missing kill switch, metadata, read failure and binding mismatch all fail closed", async () => {
  const base = {
    loadConfig: () => ({
      deploymentEnvironment: "production" as const,
      composeProject: "xingheng" as const,
    }),
    serverKillSwitch: () => "true",
    expectedRevision: () => REVISION,
    releaseManifestRevision: () => REVISION,
    userId: () => "USR-FIXTURE",
    createStore: () => ({
      readCredentialBinding: async () => activeBinding(),
      loadCredentials: async () => ({ apiKey: "key", apiSecret: "secret" }),
    }),
    createClient: () => ({
      validateAccess: async () => IDENTITY,
      readPreflightSnapshot: async () => SNAPSHOT,
    }),
    probeStreams: async () => STREAM_PROBE,
  };
  for (const dependencies of [
    { ...base, serverKillSwitch: () => "false" },
    {
      ...base,
      createStore: () => ({
        readCredentialBinding: async () => ({
          ...activeBinding(),
          status: "verified_unbound",
        } satisfies RwaBinanceProductionSelfTestBinding),
        loadCredentials: async () => ({ apiKey: "key", apiSecret: "secret" }),
      }),
    },
    {
      ...base,
      createStore: () => ({
        readCredentialBinding: async () => null,
        loadCredentials: async () => ({ apiKey: "key", apiSecret: "secret" }),
      }),
    },
    {
      ...base,
      createClient: () => ({
        validateAccess: async () => {
          throw new Error("provider unavailable");
        },
        readPreflightSnapshot: async () => SNAPSHOT,
      }),
    },
    {
      ...base,
      createClient: () => ({
        validateAccess: async () => ({
          ...IDENTITY,
          uidSnapshot: "e".repeat(64),
        }),
        readPreflightSnapshot: async () => SNAPSHOT,
      }),
    },
    {
      ...base,
      createClient: () => ({
        validateAccess: async () => IDENTITY,
        readPreflightSnapshot: async () => ({
          ...SNAPSHOT,
          uidSnapshot: "e".repeat(64),
        }),
      }),
    },
    { ...base, probeStreams: async () => { throw new Error("stream failed"); } },
  ]) {
    await assert.rejects(
      runRwaProviderIdentityPreflight(dependencies),
    );
  }
});

test("invalid runtime identity is rejected before credential metadata is opened", async () => {
  for (const loadConfig of [
    () => ({
      deploymentEnvironment: "development",
      composeProject: "xingheng",
    }),
    () => ({
      deploymentEnvironment: "production",
      composeProject: "other-project",
    }),
  ]) {
    let storeCreateCount = 0;
    await assert.rejects(
      runRwaProviderIdentityPreflight({
        loadConfig: loadConfig as never,
        serverKillSwitch: () => "true",
        expectedRevision: () => REVISION,
        releaseManifestRevision: () => REVISION,
        userId: () => "USR-FIXTURE",
        createStore: () => {
          storeCreateCount += 1;
          throw new Error("credential metadata must not be opened");
        },
      }),
      /deployment_identity_invalid/u,
    );
    assert.equal(storeCreateCount, 0);
  }
});

test("provider owner accepts only one canonical USR uppercase identity", async () => {
  for (const owner of [undefined, "", "fixture-user", "USR-lower", "USR-A/B", "USR-A B", "USR-A\nB"]) {
    let storeCreateCount = 0;
    await assert.rejects(runRwaProviderIdentityPreflight({
      loadConfig: () => ({ deploymentEnvironment: "production", composeProject: "xingheng" }),
      serverKillSwitch: () => "true",
      expectedRevision: () => REVISION,
      releaseManifestRevision: () => REVISION,
      userId: () => owner,
      createStore: () => {
        storeCreateCount += 1;
        throw new Error("must not open store");
      },
    }));
    assert.equal(storeCreateCount, 0);
  }
});

test("unexpected failures expose only a stable diagnostic category and non-empty safe receipt", () => {
  const secret = new Error("secret provider payload API-KEY-123");
  assert.equal(
    providerIdentityPreflightErrorCategory(secret),
    "binance_permission_api",
  );
  const receipt = providerIdentityPreflightFailureReceipt(secret, {
    XINGHENG_EXPECTED_REVISION: REVISION,
    XINGHENG_RELEASE_MANIFEST_REVISION: REVISION,
  });
  const serialized = JSON.stringify(receipt);
  assert.ok(serialized.length > 0);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "category", "composeProject", "connectivity_failed_detail", "deploymentEnvironment", "mutation", "provider", "readOnly",
    "receiptType", "releaseManifestRevision", "runtimeIdentityMatchesManifest",
    "runtimeRevision", "schemaVersion", "status", "streamProbeLifecycle", "streamProbeStage",
  ].sort());
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.runtimeIdentityMatchesManifest, true);
  assert.equal(receipt.mutation, false);
  assert.equal(receipt.streamProbeStage, null);
  assert.equal(receipt.connectivity_failed_detail, null);
  assert.equal(receipt.streamProbeLifecycle, null);
  assert.doesNotMatch(serialized, /secret|API-KEY-123/u);
});

test("stream probe failure emits a non-empty redacted zero-mutation diagnostic receipt", async () => {
  let captured: unknown;
  const providerMutations: string[] = [];
  try {
    await runRwaProviderIdentityPreflight({
      loadConfig: () => ({ deploymentEnvironment: "production", composeProject: "xingheng" }),
      serverKillSwitch: () => "true",
      expectedRevision: () => REVISION,
      releaseManifestRevision: () => REVISION,
      userId: () => "USR-FIXTURE",
      createStore: () => ({
        readCredentialBinding: async () => activeBinding(),
        loadCredentials: async () => ({ apiKey: "fixture-key", apiSecret: "fixture-secret" }),
      }),
      createClient: () => ({
        validateAccess: async () => IDENTITY,
        readPreflightSnapshot: async () => SNAPSHOT,
        placeOrder: async () => { providerMutations.push("placeOrder"); },
        cancelOrder: async () => { providerMutations.push("cancelOrder"); },
        transfer: async () => { providerMutations.push("transfer"); },
        withdraw: async () => { providerMutations.push("withdraw"); },
        setLeverage: async () => { providerMutations.push("setLeverage"); },
      }),
      probeStreams: async () => {
        throw new Error("provider raw response fixture-key fixture-secret private UID");
      },
    });
  } catch (error) {
    captured = error;
  }
  const receipt = providerIdentityPreflightFailureReceipt(captured, {
    XINGHENG_EXPECTED_REVISION: REVISION,
    XINGHENG_RELEASE_MANIFEST_REVISION: REVISION,
  });
  const serialized = JSON.stringify(receipt);
  assert.ok(serialized.length > 0);
  assert.equal(receipt.category, "stream_probe");
  assert.equal(receipt.streamProbeStage, "connectivity_failed");
  assert.equal(receipt.connectivity_failed_detail, null);
  assert.equal(receipt.streamProbeLifecycle, null);
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.provider, "binance");
  assert.equal(receipt.runtimeRevision, REVISION);
  assert.equal(receipt.mutation, false);
  assert.deepEqual(providerMutations, []);
  assert.doesNotMatch(serialized, /raw|fixture-key|fixture-secret|private|UID/u);
});

test("connectivity diagnostics expose only a stable redacted detail", async () => {
  const cases = [
    ["ENOTFOUND", "dns_resolution_failed"],
    ["ECONNREFUSED", "tcp_connection_failed"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_handshake_failed"],
    ["ERR_INVALID_URL", "endpoint_configuration_missing"],
  ] as const;
  for (const [code, expected] of cases) {
    let captured: unknown;
    try {
      await runRwaProviderIdentityPreflight({
        loadConfig: () => ({ deploymentEnvironment: "production", composeProject: "xingheng" }),
        serverKillSwitch: () => "true",
        expectedRevision: () => REVISION,
        releaseManifestRevision: () => REVISION,
        userId: () => "USR-FIXTURE",
        createStore: () => ({
          readCredentialBinding: async () => activeBinding(),
          loadCredentials: async () => ({ apiKey: "fixture-key", apiSecret: "fixture-secret" }),
        }),
        createClient: () => ({
          validateAccess: async () => IDENTITY,
          readPreflightSnapshot: async () => SNAPSHOT,
        }),
        probeStreams: async () => {
          throw Object.assign(new Error("raw endpoint fixture-key fixture-secret"), { code });
        },
      });
    } catch (error) {
      captured = error;
    }
    const receipt = providerIdentityPreflightFailureReceipt(captured, {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_RELEASE_MANIFEST_REVISION: REVISION,
    });
    assert.equal(receipt.category, "stream_probe");
    assert.equal(receipt.streamProbeStage, "connectivity_failed");
    assert.equal(receipt.connectivity_failed_detail, expected);
    assert.equal(receipt.streamProbeLifecycle, null);
    assert.equal(receipt.mutation, false);
    assert.doesNotMatch(JSON.stringify(receipt), /raw|fixture-key|fixture-secret/u);
  }
});

test("Futures lifecycle diagnostic propagates into the exact Gate 1 schema v2 receipt", async () => {
  const cases = [
    {
      event: "error" as const,
      expected: { error: { name: "TypeError", code: "ECONNRESET" }, close: null },
    },
    {
      event: "close" as const,
      expected: { error: null, close: { code: 1006 } },
    },
  ];
  for (const item of cases) {
    const probeError = await captureFuturesLifecycleFailure(item.event);
    let captured: unknown;
    const providerMutations: string[] = [];
    try {
      await runRwaProviderIdentityPreflight({
        loadConfig: () => ({ deploymentEnvironment: "production", composeProject: "xingheng" }),
        serverKillSwitch: () => "true",
        expectedRevision: () => REVISION,
        releaseManifestRevision: () => REVISION,
        userId: () => "USR-FIXTURE",
        createStore: () => ({
          readCredentialBinding: async () => activeBinding(),
          loadCredentials: async () => ({ apiKey: "fixture-key", apiSecret: "fixture-secret" }),
        }),
        createClient: () => ({
          validateAccess: async () => IDENTITY,
          readPreflightSnapshot: async () => SNAPSHOT,
          placeOrder: async () => { providerMutations.push("placeOrder"); },
          cancelOrder: async () => { providerMutations.push("cancelOrder"); },
          transfer: async () => { providerMutations.push("transfer"); },
          withdraw: async () => { providerMutations.push("withdraw"); },
          setLeverage: async () => { providerMutations.push("setLeverage"); },
        }),
        probeStreams: async () => { throw probeError; },
      });
    } catch (error) {
      captured = error;
    }
    const receipt = providerIdentityPreflightFailureReceipt(captured, {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_RELEASE_MANIFEST_REVISION: REVISION,
    });
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.category, "stream_probe");
    assert.equal(receipt.readOnly, true);
    assert.equal(receipt.mutation, false);
    assert.deepEqual(receipt.streamProbeLifecycle, item.expected);
    assert.deepEqual(Object.keys(receipt.streamProbeLifecycle!).sort(), ["close", "error"]);
    assert.deepEqual(
      Object.keys(receipt.streamProbeLifecycle!.error ?? receipt.streamProbeLifecycle!.close!).sort(),
      item.event === "error" ? ["code", "name"] : ["code"],
    );
    assert.deepEqual(providerMutations, []);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /message|reason|listen-key|fixture-key|fixture-secret|provider response|apiKey|secret/u,
    );
  }
});

test("runtime and release manifest identity mismatch fails before credential or Provider access", async () => {
  let storeCreateCount = 0;
  await assert.rejects(
    runRwaProviderIdentityPreflight({
      loadConfig: () => ({ deploymentEnvironment: "production", composeProject: "xingheng" }),
      serverKillSwitch: () => "true",
      expectedRevision: () => REVISION,
      releaseManifestRevision: () => "b".repeat(40),
      userId: () => "USR-FIXTURE",
      createStore: () => {
        storeCreateCount += 1;
        throw new Error("must not open credentials");
      },
    }),
    /runtime_release_identity_mismatch/u,
  );
  assert.equal(storeCreateCount, 0);
});

test("provider failures map to the five diagnostic categories without raw error text", async () => {
  const base = {
    loadConfig: () => ({ deploymentEnvironment: "production" as const, composeProject: "xingheng" as const }),
    serverKillSwitch: () => "true",
    expectedRevision: () => REVISION,
    releaseManifestRevision: () => REVISION,
    userId: () => "USR-FIXTURE",
    createStore: () => ({
      readCredentialBinding: async () => activeBinding(),
      loadCredentials: async () => ({ apiKey: "fixture-key", apiSecret: "fixture-secret" }),
    }),
    createClient: () => ({
      validateAccess: async () => IDENTITY,
      readPreflightSnapshot: async () => SNAPSHOT,
    }),
    probeStreams: async () => STREAM_PROBE,
  };
  const cases = [
    {
      category: "kms_credential",
      dependencies: {
        ...base,
        createStore: () => ({
          readCredentialBinding: async () => activeBinding(),
          loadCredentials: async () => { throw new Error("raw kms secret"); },
        }),
      },
    },
    {
      category: "uid_binding",
      dependencies: {
        ...base,
        createStore: () => ({
          readCredentialBinding: async () => null,
          loadCredentials: async () => ({ apiKey: "fixture-key", apiSecret: "fixture-secret" }),
        }),
      },
    },
    {
      category: "binance_permission_api",
      dependencies: {
        ...base,
        createClient: () => ({
          validateAccess: async () => { throw new Error("raw Binance response"); },
          readPreflightSnapshot: async () => SNAPSHOT,
        }),
      },
    },
    {
      category: "product_rule",
      dependencies: {
        ...base,
        createClient: () => ({
          validateAccess: async () => IDENTITY,
          readPreflightSnapshot: async () => {
            throw new RwaBinanceProviderError("provider_product_unavailable", "raw product payload");
          },
        }),
      },
    },
    {
      category: "stream_probe",
      dependencies: { ...base, probeStreams: async () => { throw new Error("raw stream payload"); } },
    },
  ];
  for (const item of cases) {
    let captured: unknown;
    try {
      await runRwaProviderIdentityPreflight(item.dependencies as never);
    } catch (error) {
      captured = error;
    }
    assert.equal(providerIdentityPreflightErrorCategory(captured), item.category);
    assert.doesNotMatch(String(captured), /raw|secret|payload/u);
  }
});
