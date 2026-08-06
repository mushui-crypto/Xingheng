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
  accountMode: string;
  permissions: {
    read: boolean;
    spotTrade: boolean;
    contractTrade: boolean;
    withdraw: boolean;
    ipRestricted: boolean;
    positionModeSupported: boolean;
  };
  product: {
    available: boolean;
    spotStatus: string;
    perpetualStatus: string;
    spotQtyStep: number;
    spotMinOrderQty: number;
    spotMinNotionalUsd: number;
    spotPriceTick: number;
    perpetualQtyStep: number;
    perpetualMinOrderQty: number;
    perpetualMinNotionalUsd: number;
    perpetualPriceTick: number;
  };
  account: {
    spotXautExposure: boolean;
    perpetualXautExposure: boolean;
    activeSpotOrders: boolean;
    activePerpetualOrders: boolean;
  };
  streamProbe: {
    spotSignedSubscribe: true;
    futuresListenKeyCreate: true;
    futuresListenKeyKeepalive: true;
    futuresListenKeyClose: true;
  };
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
    accountMode: string;
    permissions: ProviderIdentityReceipt["permissions"];
  }>;
  readPreflightSnapshot(): Promise<any>;
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
  probeStreams?: (credentials: RwaBinanceCredentials) => Promise<ProviderIdentityReceipt["streamProbe"]>;
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
  if (!/^USR-[A-Z0-9]+$/u.test(userId ?? "")) {
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
  const store = createStore(userId!);
  const metadata = await store.readCredentialMetadata();
  if (!metadata) {
    throw new ProviderIdentityPreflightError("provider_credential_unconfigured");
  }
  const credentials = await store.loadCredentials();
  const client = createClient(credentials);
  const authoritative = await client.validateAccess();
  if (
    authoritative.accountId !== metadata.accountId
    || authoritative.accountFingerprint !== metadata.accountFingerprint
  ) {
    throw new ProviderIdentityPreflightError("provider_identity_mismatch");
  }
  const snapshot = await client.readPreflightSnapshot();
  if (snapshot.accountId !== authoritative.accountId
    || snapshot.accountFingerprint !== authoritative.accountFingerprint) {
    throw new ProviderIdentityPreflightError("provider_identity_mismatch");
  }
  const streamProbe = await (dependencies.probeStreams ?? probeBinanceGate1UserStreams)(
    credentials,
  );
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
    accountMode: authoritative.accountMode,
    permissions: {
      read: authoritative.permissions.read,
      spotTrade: authoritative.permissions.spotTrade,
      contractTrade: authoritative.permissions.contractTrade,
      withdraw: authoritative.permissions.withdraw,
      ipRestricted: authoritative.permissions.ipRestricted,
      positionModeSupported: authoritative.permissions.positionModeSupported,
    },
    product: {
      available: snapshot.productAvailability.available,
      spotStatus: snapshot.spot.status,
      perpetualStatus: snapshot.perpetual.status,
      spotQtyStep: snapshot.spot.qtyStep,
      spotMinOrderQty: snapshot.spot.minOrderQty,
      spotMinNotionalUsd: snapshot.spot.minNotionalUsd,
      spotPriceTick: snapshot.spot.priceTick,
      perpetualQtyStep: snapshot.perpetual.qtyStep,
      perpetualMinOrderQty: snapshot.perpetual.minOrderQty,
      perpetualMinNotionalUsd: snapshot.perpetual.minNotionalUsd,
      perpetualPriceTick: snapshot.perpetual.priceTick,
    },
    account: {
      spotXautExposure: snapshot.existingSpotQuantityXaut > 0,
      perpetualXautExposure: snapshot.existingPerpetualQuantityXaut > 0,
      activeSpotOrders: snapshot.openSpotOrderCount > 0,
      activePerpetualOrders: snapshot.openPerpetualOrderCount > 0,
    },
    streamProbe,
    verifiedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    readOnly: true,
  };
}

export async function probeBinanceGate1UserStreams(
  credentials: RwaBinanceCredentials,
): Promise<ProviderIdentityReceipt["streamProbe"]> {
  const module = await import("./RwaProviderUserStreamProbe");
  return module.runRwaProviderUserStreamProbe(credentials);
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
