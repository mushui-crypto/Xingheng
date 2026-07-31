import { createHash } from "node:crypto";
import { loadRuntimeConfig } from "../config/runtimeConfig";
import { GcpKmsCredentialKeyProvider } from "../modules/arbitrage/automation/GcpKmsCredentialKeyProvider";
import { RwaAutomationPersistentStore } from "../modules/arbitrage/automation/RwaAutomationPersistentStore";
import type {
  RwaBinanceCredentials,
  RwaBinancePermissions,
} from "../modules/arbitrage/automation/RwaBinanceAutomationTypes";
import { RwaBinanceMainnetClient } from "../modules/arbitrage/automation/RwaBinanceMainnetClient";

export type ProviderIdentityReceipt = {
  schemaVersion: 1;
  provider: "binance";
  deploymentEnvironment: "production";
  composeProject: "xingheng";
  revision: string;
  accountIdentitySha256: string;
  credentialBindingSha256: string;
  verifiedAt: string;
  readOnly: true;
};

type Metadata = {
  accountId: string;
  accountFingerprint: string;
};

type Store = {
  readCredentialMetadata(): Promise<Metadata | null>;
  loadCredentials(): Promise<RwaBinanceCredentials>;
};

type Client = {
  validateAccess(): Promise<{
    accountId: string;
    accountFingerprint: string;
  }>;
};

type Dependencies = {
  loadConfig?: () => {
    deploymentEnvironment: "production";
    composeProject: "xingheng";
  };
  serverKillSwitch?: () => string | undefined;
  expectedRevision?: () => string | undefined;
  userId?: () => string | undefined;
  createStore?: (userId: string) => Store;
  createClient?: (credentials: RwaBinanceCredentials) => Client;
  now?: () => Date;
};

export async function runRwaProviderIdentityPreflight(
  dependencies: Dependencies = {},
): Promise<ProviderIdentityReceipt> {
  const config = (dependencies.loadConfig ?? loadRuntimeConfig)();
  const deploymentEnvironment = config.deploymentEnvironment;
  const composeProject = config.composeProject;
  if (deploymentEnvironment !== "production" || composeProject !== "xingheng") {
    throw new ProviderIdentityPreflightError("deployment_identity_invalid");
  }
  const serverKillSwitch = (dependencies.serverKillSwitch
    ?? (() => process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH))();
  if (serverKillSwitch !== "true") {
    throw new ProviderIdentityPreflightError("server_kill_switch_required");
  }
  const revision = (dependencies.expectedRevision
    ?? (() => process.env.XINGHENG_EXPECTED_REVISION))();
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) {
    throw new ProviderIdentityPreflightError("deployment_revision_invalid");
  }
  const userId = (dependencies.userId
    ?? (() => process.env.RWA_PROVIDER_PREFLIGHT_USER_ID))()?.trim();
  if (!userId || userId.length > 256 || /[\u0000-\u001f\u007f]/u.test(userId)) {
    throw new ProviderIdentityPreflightError("provider_owner_unconfigured");
  }
  const createStore = dependencies.createStore ?? ((ownerUserId: string) =>
    new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
      userId: ownerUserId,
      venue: "binance",
      keyProvider: new GcpKmsCredentialKeyProvider(),
    }));
  const createClient = dependencies.createClient
    ?? ((credentials: RwaBinanceCredentials) => new RwaBinanceMainnetClient(credentials));
  const store = createStore(userId);
  const metadata = await store.readCredentialMetadata();
  if (!metadata) {
    throw new ProviderIdentityPreflightError("provider_credential_unconfigured");
  }
  const client = createClient(await store.loadCredentials());
  const authoritative = await client.validateAccess();
  if (
    authoritative.accountId !== metadata.accountId
    || authoritative.accountFingerprint !== metadata.accountFingerprint
  ) {
    throw new ProviderIdentityPreflightError("provider_identity_mismatch");
  }
  const binding = `${deploymentEnvironment}:${composeProject}`
    + `:${authoritative.accountId}:${authoritative.accountFingerprint}`;
  return {
    schemaVersion: 1,
    provider: "binance",
    deploymentEnvironment,
    composeProject,
    revision: revision!,
    accountIdentitySha256: digest(`binance-authoritative:${authoritative.accountId}`),
    credentialBindingSha256: digest(binding),
    verifiedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    readOnly: true,
  };
}

export function providerIdentityPreflightErrorCategory(error: unknown) {
  return error instanceof ProviderIdentityPreflightError
    ? error.category
    : "provider_identity_preflight_failed";
}

class ProviderIdentityPreflightError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
