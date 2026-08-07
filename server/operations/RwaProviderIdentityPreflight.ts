import { createHash } from "node:crypto";
import { loadRuntimeConfig } from "../config/runtimeConfig";
import { GcpKmsCredentialKeyProvider } from "../modules/arbitrage/automation/GcpKmsCredentialKeyProvider";
import { RwaAutomationPersistentStore } from "../modules/arbitrage/automation/RwaAutomationPersistentStore";
import type {
  RwaBinanceCredentials,
  RwaBinancePermissions,
} from "../modules/arbitrage/automation/RwaBinanceAutomationTypes";
import {
  RwaBinanceMainnetClient,
  RwaBinanceProviderError,
} from "../modules/arbitrage/automation/RwaBinanceMainnetClient";
import {
  binanceCredentialBindingSha256,
  RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN,
  type RwaBinanceProductionSelfTestBinding,
} from "../modules/arbitrage/automation/RwaBinanceProductionSelfTestPermit";
import { BinanceCredentialBindingReadStore } from "../storage/BinanceCredentialBindingReadStore";

export type ProviderIdentityReceipt = {
  schemaVersion: 2;
  provider: "binance";
  deploymentEnvironment: "production";
  composeProject: "xingheng";
  revision: string;
  releaseManifestRevision: string;
  runtimeIdentityMatchesManifest: true;
  userIdSha256: string;
  venue: "binance";
  bindingDomain: typeof RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN;
  bindingVersion: number;
  uidSnapshotSha256: string;
  accountBindingSha256: string;
  providerUidMatchesBinding: true;
  snapshotUidMatchesBinding: true;
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

type Store = {
  readCredentialBinding(): Promise<RwaBinanceProductionSelfTestBinding | null>;
  loadCredentials(): Promise<RwaBinanceCredentials>;
};

type Client = {
  validateAccess(): Promise<{
    accountId: string;
    accountFingerprint: string;
    uidSnapshot: string;
    accountMode: string;
    permissions: ProviderIdentityReceipt["permissions"];
  }>;
  readPreflightSnapshot(): Promise<{
    uidSnapshot?: string;
    productAvailability: {
      available: boolean;
    };
    spot: {
      status: string;
      qtyStep: number;
      minOrderQty: number;
      minNotionalUsd: number;
      priceTick: number;
    };
    perpetual: {
      status: string;
      qtyStep: number;
      minOrderQty: number;
      minNotionalUsd: number;
      priceTick: number;
    };
    existingSpotQuantityXaut: number;
    existingPerpetualQuantityXaut: number;
    openSpotOrderCount: number;
    openPerpetualOrderCount: number;
  }>;
};

type Dependencies = {
  loadConfig?: () => {
    deploymentEnvironment: "production";
    composeProject: "xingheng";
  };
  serverKillSwitch?: () => string | undefined;
  expectedRevision?: () => string | undefined;
  releaseManifestRevision?: () => string | undefined;
  userId?: () => string | undefined;
  createStore?: (userId: string) => Store;
  createClient?: (credentials: RwaBinanceCredentials) => Client;
  probeStreams?: (credentials: RwaBinanceCredentials) => Promise<ProviderIdentityReceipt["streamProbe"]>;
  now?: () => Date;
};

export async function runRwaProviderIdentityPreflight(
  dependencies: Dependencies = {},
): Promise<ProviderIdentityReceipt> {
  let config;
  try {
    config = (dependencies.loadConfig ?? loadRuntimeConfig)();
  } catch {
    throw new ProviderIdentityPreflightError("deployment_identity_invalid");
  }
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
  const releaseManifestRevision = (dependencies.releaseManifestRevision
    ?? (() => process.env.XINGHENG_RELEASE_MANIFEST_REVISION))();
  if (
    !/^[a-f0-9]{40}$/u.test(revision ?? "")
    || !/^[a-f0-9]{40}$/u.test(releaseManifestRevision ?? "")
  ) {
    throw new ProviderIdentityPreflightError("deployment_revision_invalid");
  }
  if (revision !== releaseManifestRevision) {
    throw new ProviderIdentityPreflightError("runtime_release_identity_mismatch");
  }
  const userId = (dependencies.userId
    ?? (() => process.env.RWA_PROVIDER_PREFLIGHT_USER_ID))()?.trim();
  if (!/^USR-[A-Z0-9]+$/u.test(userId ?? "")) {
    throw new ProviderIdentityPreflightError("provider_owner_unconfigured");
  }
  const createStore = dependencies.createStore ?? ((ownerUserId: string) => ({
      readCredentialBinding: async () => {
        const readStore = new BinanceCredentialBindingReadStore();
        try {
          return readStore.findActiveBinanceCredentialBinding(ownerUserId);
        } finally {
          readStore.close();
        }
      },
      loadCredentials: async () => new RwaAutomationPersistentStore<RwaBinanceCredentials, RwaBinancePermissions>({
        userId: ownerUserId,
        venue: "binance",
        keyProvider: new GcpKmsCredentialKeyProvider(),
      }).loadCredentials(),
    }));
  const createClient = dependencies.createClient
    ?? ((credentials: RwaBinanceCredentials) => new RwaBinanceMainnetClient(credentials));
  const store = await diagnosticStage("kms_credential", async () => createStore(userId!));
  const binding = await diagnosticStage("uid_binding", () => store.readCredentialBinding());
  if (!binding || binding.status !== "active") {
    throw new ProviderIdentityPreflightError("uid_binding");
  }
  const credentials = await diagnosticStage("kms_credential", () => store.loadCredentials());
  const client = await diagnosticStage("binance_permission_api", async () => createClient(credentials));
  const authoritative = await diagnosticStageForProviderIdentity(() => client.validateAccess());
  if (authoritative.uidSnapshot !== binding.uidSnapshot) {
    throw new ProviderIdentityPreflightError("uid_binding");
  }
  const snapshot = await diagnosticStageForSnapshot(() => client.readPreflightSnapshot());
  if (snapshot.uidSnapshot !== binding.uidSnapshot) {
    throw new ProviderIdentityPreflightError("uid_binding");
  }
  const streamProbe = await diagnosticStage("stream_probe", () => (
    dependencies.probeStreams ?? probeBinanceGate1UserStreams
  )(credentials));
  const confirmedBinding = await diagnosticStage("uid_binding", () => store.readCredentialBinding());
  if (
    !confirmedBinding
    || confirmedBinding.status !== "active"
    || !sameBindingIdentity(binding, confirmedBinding)
  ) {
    throw new ProviderIdentityPreflightError("uid_binding");
  }
  return {
    schemaVersion: 2,
    provider: "binance",
    deploymentEnvironment,
    composeProject,
    revision: revision!,
    releaseManifestRevision: releaseManifestRevision!,
    runtimeIdentityMatchesManifest: true,
    userIdSha256: digest(userId!),
    venue: binding.venue,
    bindingDomain: RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN,
    bindingVersion: binding.bindingVersion,
    uidSnapshotSha256: digest(binding.uidSnapshot),
    accountBindingSha256: binanceCredentialBindingSha256(binding),
    providerUidMatchesBinding: true,
    snapshotUidMatchesBinding: true,
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

function sameBindingIdentity(
  left: Pick<RwaBinanceProductionSelfTestBinding,
    "status" | "userId" | "venue" | "bindingVersion" | "uidSnapshot">,
  right: Pick<RwaBinanceProductionSelfTestBinding,
    "status" | "userId" | "venue" | "bindingVersion" | "uidSnapshot">,
) {
  return left.status === right.status
    && left.userId === right.userId
    && left.venue === right.venue
    && left.bindingVersion === right.bindingVersion
    && left.uidSnapshot === right.uidSnapshot;
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
    : "binance_permission_api";
}

export function providerIdentityPreflightFailureReceipt(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const runtimeRevision = safeRevision(environment.XINGHENG_EXPECTED_REVISION);
  const releaseManifestRevision = safeRevision(environment.XINGHENG_RELEASE_MANIFEST_REVISION);
  return {
    schemaVersion: 1,
    receiptType: "provider_identity_preflight_diagnostic" as const,
    status: "failed" as const,
    provider: "binance" as const,
    deploymentEnvironment: "production" as const,
    composeProject: "xingheng" as const,
    runtimeRevision,
    releaseManifestRevision,
    runtimeIdentityMatchesManifest: runtimeRevision !== null
      && runtimeRevision === releaseManifestRevision,
    category: providerIdentityPreflightErrorCategory(error),
    readOnly: true as const,
  };
}

class ProviderIdentityPreflightError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

type DiagnosticCategory =
  | "kms_credential"
  | "uid_binding"
  | "binance_permission_api"
  | "product_rule"
  | "stream_probe";

async function diagnosticStage<T>(category: DiagnosticCategory, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProviderIdentityPreflightError) throw error;
    throw new ProviderIdentityPreflightError(category);
  }
}

function diagnosticStageForProviderIdentity<T>(operation: () => Promise<T>) {
  return diagnosticStageWithProviderMapping(operation, new Set(["provider_identity_unavailable"]), "uid_binding");
}

function diagnosticStageForSnapshot<T>(operation: () => Promise<T>) {
  return diagnosticStageWithProviderMapping(
    operation,
    new Set(["provider_product_unavailable", "provider_snapshot_invalid"]),
    "product_rule",
  );
}

async function diagnosticStageWithProviderMapping<T>(
  operation: () => Promise<T>,
  mappedProviderCategories: ReadonlySet<string>,
  mappedCategory: DiagnosticCategory,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ProviderIdentityPreflightError(
      error instanceof RwaBinanceProviderError && mappedProviderCategories.has(error.category)
        ? mappedCategory
        : "binance_permission_api",
    );
  }
}

function safeRevision(value: string | undefined) {
  return /^[a-f0-9]{40}$/u.test(value ?? "") ? value! : null;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
