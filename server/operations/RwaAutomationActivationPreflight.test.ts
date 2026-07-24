import assert from "node:assert/strict";
import test from "node:test";
import {
  activationPreflightErrorCategory,
  runRwaAutomationActivationPreflight,
} from "./RwaAutomationActivationPreflight";

test("runtime validation failure and disabled server kill switch perform zero KMS probes", async () => {
  let providerCreations = 0;
  const createProvider = () => {
    providerCreations += 1;
    return { healthCheck: async () => ({ ok: true }) };
  };

  await assert.rejects(
    runRwaAutomationActivationPreflight({
      loadConfig: () => {
        throw new Error("test-only WIF boundary failure with /private/path");
      },
      serverKillSwitch: () => "true",
      createProvider,
    }),
    /test-only/u,
  );
  await assert.rejects(
    runRwaAutomationActivationPreflight({
      loadConfig: () => undefined,
      serverKillSwitch: () => "false",
      createProvider,
    }),
    (error) => activationPreflightErrorCategory(error) === "server_kill_switch_required",
  );
  assert.equal(providerCreations, 0);
});

test("successful activation preflight performs one non-sensitive KMS health probe", async () => {
  const contexts: unknown[] = [];
  await runRwaAutomationActivationPreflight({
    loadConfig: () => undefined,
    serverKillSwitch: () => "true",
    createProbeId: () => "public-test-probe",
    createProvider: () => ({
      healthCheck: async (context) => {
        contexts.push(context);
        return { ok: true };
      },
    }),
  });
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0], {
    purpose: "automation-backup",
    backupId: "activation-health-public-test-probe",
    backupDomain: "rwa-automation-disaster-recovery",
    environment: "production",
    schemaVersion: 2,
  });
  assert.doesNotMatch(JSON.stringify(contexts), /ciphertext|audience|private|secret|token|path/iu);
});

test("provider failure exposes only a stable category", async () => {
  for (const [providerCategory, expected] of [
    ["credential_key_provider_unavailable", "credential_key_provider_unavailable"],
    ["/run/secrets/gcp-wif/private-key.pem", "credential_key_provider_unavailable"],
  ]) {
    await assert.rejects(
      runRwaAutomationActivationPreflight({
        loadConfig: () => undefined,
        serverKillSwitch: () => "true",
        createProbeId: () => "public-test-probe",
        createProvider: () => ({
          healthCheck: async () => ({ ok: false, category: providerCategory }),
        }),
      }),
      (error) => activationPreflightErrorCategory(error) === expected,
    );
  }
});
