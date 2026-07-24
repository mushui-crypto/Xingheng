import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "../config/runtimeConfig";
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
  loadConfig?: () => unknown;
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

  loadConfig();
  if (serverKillSwitch() !== "true") {
    throw new ActivationPreflightError("server_kill_switch_required");
  }

  const provider = createProvider();
  const health = await provider.healthCheck({
    purpose: "automation-backup",
    backupId: `activation-health-${createProbeId()}`,
    backupDomain: "rwa-automation-disaster-recovery",
    environment: "production",
    schemaVersion: RWA_CREDENTIAL_ENVELOPE_VERSION,
  });
  if (!health.ok) {
    throw new ActivationPreflightError(stableCategory(health.category));
  }
}

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
