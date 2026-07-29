import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVATION_KMS_HEALTH_RECEIPT,
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
      loadConfig: () => ({ deploymentEnvironment: "production" }),
      serverKillSwitch: () => "false",
      createProvider,
    }),
    (error) => activationPreflightErrorCategory(error) === "server_kill_switch_required",
  );
  assert.equal(providerCreations, 0);
});

test("successful activation preflight binds the exact verified deployment to one health probe", async () => {
  for (const deploymentEnvironment of ["production", "real-test"] as const) {
    const contexts: unknown[] = [];
    let providerCreations = 0;
    await runRwaAutomationActivationPreflight({
      loadConfig: () => ({ deploymentEnvironment }),
      serverKillSwitch: () => "true",
      createProbeId: () => "public-test-probe",
      createProvider: () => {
        providerCreations += 1;
        return {
          healthCheck: async (context) => {
            contexts.push(context);
            return { ok: true };
          },
        };
      },
    });
    assert.equal(providerCreations, 1);
    assert.deepEqual(contexts, [{
      purpose: "automation-backup",
      backupId: "activation-health-public-test-probe",
      backupDomain: "rwa-automation-disaster-recovery",
      environment: deploymentEnvironment,
      schemaVersion: 2,
    }]);
    assert.doesNotMatch(JSON.stringify(contexts), /ciphertext|audience|private|secret|token|path/iu);
  }
});

test("provider failure exposes only a stable category", async () => {
  for (const [providerCategory, expected] of [
    ["credential_key_provider_unavailable", "credential_key_provider_unavailable"],
    ["/run/secrets/gcp-wif/private-key.pem", "credential_key_provider_unavailable"],
  ]) {
    await assert.rejects(
      runRwaAutomationActivationPreflight({
        loadConfig: () => ({ deploymentEnvironment: "production" }),
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

test("missing or invalid deployment identity and every non-true kill switch perform zero provider work", async () => {
  for (const loadConfig of [
    () => {
      throw new Error("runtime identity unavailable");
    },
    () => ({ deploymentEnvironment: undefined as never }),
    () => ({ deploymentEnvironment: "test" as never }),
  ]) {
    let providerCreations = 0;
    await assert.rejects(runRwaAutomationActivationPreflight({
      loadConfig,
      serverKillSwitch: () => "true",
      createProvider: () => {
        providerCreations += 1;
        return { healthCheck: async () => ({ ok: true }) };
      },
    }));
    assert.equal(providerCreations, 0);
  }
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    let providerCreations = 0;
    await assert.rejects(runRwaAutomationActivationPreflight({
      loadConfig: () => ({ deploymentEnvironment: "real-test" }),
      serverKillSwitch: () => value,
      createProvider: () => {
        providerCreations += 1;
        return { healthCheck: async () => ({ ok: true }) };
      },
    }), (error) => activationPreflightErrorCategory(error) === "server_kill_switch_required");
    assert.equal(providerCreations, 0);
  }
});

test("activation CLI success receipt is authentication-neutral and non-sensitive", () => {
  assert.equal(ACTIVATION_KMS_HEALTH_RECEIPT, "activation KMS health verified");
  assert.doesNotMatch(
    ACTIVATION_KMS_HEALTH_RECEIPT,
    /wif|metadata|token|payload|ciphertext|service.?account|private|secret/iu,
  );
});
