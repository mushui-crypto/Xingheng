import assert from "node:assert/strict";
import test from "node:test";
import {
  providerIdentityPreflightErrorCategory,
  runRwaProviderIdentityPreflight,
} from "./RwaProviderIdentityPreflight";

const REVISION = "a".repeat(40);
const IDENTITY = {
  accountId: "binance:authoritative",
  accountFingerprint: "authoritative",
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

test("provider identity preflight binds authoritative access to stored metadata without writes", async () => {
  let loadCount = 0;
  let validateCount = 0;
  const receipt = await runRwaProviderIdentityPreflight({
    loadConfig: () => ({
      deploymentEnvironment: "production",
      composeProject: "xingheng",
    }),
    serverKillSwitch: () => "true",
    expectedRevision: () => REVISION,
    userId: () => "USR-FIXTURE",
    createStore: () => ({
      readCredentialMetadata: async () => IDENTITY,
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
  assert.equal(receipt.deploymentEnvironment, "production");
  assert.equal(receipt.accountMode, "single_asset_one_way");
  assert.deepEqual(receipt.streamProbe, STREAM_PROBE);
  assert.equal(receipt.account.spotXautExposure, false);
  assert.match(receipt.accountIdentitySha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-user|fixture-key|fixture-secret|authoritative/u);
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
      readCredentialMetadata: async () => IDENTITY,
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
        readCredentialMetadata: async () => null,
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
          accountId: "binance:different",
          accountFingerprint: "different",
          accountMode: IDENTITY.accountMode,
          permissions: IDENTITY.permissions,
        }),
        readPreflightSnapshot: async () => SNAPSHOT,
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
