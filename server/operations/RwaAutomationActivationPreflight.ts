import { randomUUID } from "node:crypto";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtimeConfig";
import {
  RWA_CREDENTIAL_ENVELOPE_VERSION,
  type CredentialKeyContext,
} from "../modules/arbitrage/automation/CredentialKeyProvider";
import { GcpKmsCredentialKeyProvider } from "../modules/arbitrage/automation/GcpKmsCredentialKeyProvider";

type HealthResult = {
  ok: boolean;
  category?: string;
};

type HealthProvider = {
  healthCheck(context: CredentialKeyContext): Promise<HealthResult>;
};

type ActivationPreflightDependencies = {
  loadConfig?: () => Pick<RuntimeConfig, "deploymentEnvironment">;
  serverKillSwitch?: () => string | undefined;
  createProvider?: () => HealthProvider;
  createProbeId?: () => string;
};

export async function runRwaAutomationActivationPreflight(
  dependencies: ActivationPreflightDependencies = {},
) {
  const loadConfig = dependencies.loadConfig ?? loadRuntimeConfig;
  const serverKillSwitch = dependencies.serverKillSwitch
    ?? (() => process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH);
  const createProvider = dependencies.createProvider
    ?? (() => new GcpKmsCredentialKeyProvider());
  const createProbeId = dependencies.createProbeId ?? randomUUID;

  const config = loadConfig();
  if (
    config.deploymentEnvironment !== "production"
    && config.deploymentEnvironment !== "real-test"
  ) {
    throw new ActivationPreflightError("activation_preflight_deployment_invalid");
  }
  if (serverKillSwitch() !== "true") {
    throw new ActivationPreflightError("server_kill_switch_required");
  }

  const provider = createProvider();
  const health = await provider.healthCheck({
    purpose: "automation-backup",
    backupId: `activation-health-${createProbeId()}`,
    backupDomain: "rwa-automation-disaster-recovery",
    environment: config.deploymentEnvironment,
    schemaVersion: RWA_CREDENTIAL_ENVELOPE_VERSION,
  });
  if (!health.ok) {
    throw new ActivationPreflightError(stableCategory(health.category));
  }
}

export const ACTIVATION_KMS_HEALTH_RECEIPT = "activation KMS health verified";

export function activationPreflightErrorCategory(error: unknown) {
  if (error instanceof ActivationPreflightError) return error.category;
  return "activation_preflight_failed";
}

class ActivationPreflightError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

function stableCategory(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/u.test(value)
    ? value
    : "credential_key_provider_unavailable";
}
