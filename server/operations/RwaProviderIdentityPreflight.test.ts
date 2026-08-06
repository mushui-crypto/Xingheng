import assert from "node:assert/strict";
import test from "node:test";
import type { RwaBinanceProductionSelfTestBinding } from "../modules/arbitrage/automation/RwaBinanceProductionSelfTestPermit";
import {
  providerIdentityPreflightErrorCategory,
  runRwaProviderIdentityPreflight,
} from "./RwaProviderIdentityPreflight";

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
      /provider_identity_mismatch/u,
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
      userId: () => owner,
      createStore: () => {
        storeCreateCount += 1;
        throw new Error("must not open store");
      },
    }));
    assert.equal(storeCreateCount, 0);
  }
});

test("unexpected failures expose only a stable category", () => {
  assert.equal(
    providerIdentityPreflightErrorCategory(new Error("secret provider payload")),
    "provider_identity_preflight_failed",
  );
});
