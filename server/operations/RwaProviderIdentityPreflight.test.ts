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
};

test("provider identity preflight binds authoritative access to stored metadata without writes", async () => {
  let loadCount = 0;
  let validateCount = 0;
  const receipt = await runRwaProviderIdentityPreflight({
    loadConfig: () => ({
      deploymentEnvironment: "real-test",
      composeProject: "xingheng-real-test",
    }),
    serverKillSwitch: () => "true",
    expectedRevision: () => REVISION,
    userId: () => "fixture-user",
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
    }),
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  });
  assert.equal(loadCount, 1);
  assert.equal(validateCount, 1);
  assert.equal(receipt.deploymentEnvironment, "real-test");
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
    userId: () => "fixture-user",
    createStore: () => ({
      readCredentialMetadata: async () => IDENTITY,
      loadCredentials: async () => ({ apiKey: "key", apiSecret: "secret" }),
    }),
    createClient: () => ({
      validateAccess: async () => IDENTITY,
    }),
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
      }),
    },
    {
      ...base,
      createClient: () => ({
        validateAccess: async () => ({
          accountId: "binance:different",
          accountFingerprint: "different",
        }),
      }),
    },
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
      composeProject: "xingheng-real-test",
    }),
  ]) {
    let storeCreateCount = 0;
    await assert.rejects(
      runRwaProviderIdentityPreflight({
        loadConfig: loadConfig as never,
        serverKillSwitch: () => "true",
        expectedRevision: () => REVISION,
        userId: () => "fixture-user",
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

test("unexpected failures expose only a stable category", () => {
  assert.equal(
    providerIdentityPreflightErrorCategory(new Error("secret provider payload")),
    "provider_identity_preflight_failed",
  );
});
