import { createHash } from "node:crypto";

export const RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE =
  Object.freeze(["READ", "TRADE"] as const);

export const RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE =
  "single_connectivity_smoke" as const;

export type RwaBinanceProductionSelfTestActionScope =
  readonly ["READ", "TRADE"];

export const RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN =
  "xingheng:capital-test:binance-credential-binding:v1" as const;

export type RwaBinanceProductionSelfTestBinding = {
  userId: string;
  venue: "binance";
  bindingVersion: number;
  uidSnapshot: string;
  status: "active" | "verified_unbound" | "unverified_unbound" | "recovery_inconsistent";
};

export type RwaBinanceProductionSelfTestPermit = {
  permitId: string;
  ownerUserId: string;
  accountBindingSha256: string;
  actionScope: RwaBinanceProductionSelfTestActionScope;
  executionMode: typeof RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE;
  authorizationDigest: string;
  approvedCapitalUsd: number;
  expiresAt: number;
  revision: string;
  digest: string;
};

export type RwaBinanceProductionSelfTestPermitConfirmation = {
  permitId: string;
  ownerUserId: string;
  accountBindingSha256: string;
  actionScope: RwaBinanceProductionSelfTestActionScope;
  executionMode: typeof RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE;
  authorizationDigest: string;
  approvedCapitalUsd: number;
  expiresAt: number;
  revision: string;
  digest: string;
  confirmedAt: number;
};

export type RwaBinanceProductionSelfTestPermitConsumption = {
  permitId: string;
  digest: string;
  consumedAt: number;
};

export function loadRwaBinanceProductionSelfTestPermit(
  environment: NodeJS.ProcessEnv = process.env,
): RwaBinanceProductionSelfTestPermit | null {
  if (environment.RWA_BINANCE_PRODUCTION_SELF_TEST_ENABLED !== "true") return null;
  const permitId = environment.RWA_BINANCE_PRODUCTION_SELF_TEST_PERMIT_ID ?? "";
  const ownerUserId = environment.RWA_BINANCE_PRODUCTION_SELF_TEST_OWNER_USER_ID ?? "";
  const accountBindingSha256 =
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_ACCOUNT_BINDING_SHA256 ?? "";
  const actionScopeSource =
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE ?? "";
  const authorizationDigest =
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_AUTHORIZATION_DIGEST ?? "";
  const expectedDigest =
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_DIGEST ?? "";
  const executionMode =
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE ?? "";
  const expiresAtSource = environment.RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT ?? "";
  const approvedCapitalUsd = Number(
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD,
  );
  const revision = environment.XINGHENG_EXPECTED_REVISION ?? "";
  if (
    !/^[a-f0-9]{32}$/u.test(permitId)
    || !/^USR-[A-Z0-9]+$/u.test(ownerUserId)
    || !/^[a-f0-9]{64}$/u.test(accountBindingSha256)
    || actionScopeSource !== '["READ","TRADE"]'
    || !/^[a-f0-9]{64}$/u.test(authorizationDigest)
    || !/^[a-f0-9]{64}$/u.test(expectedDigest)
    || executionMode !== RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE
    || !/^[a-f0-9]{40}$/u.test(revision)
    || !Number.isFinite(approvedCapitalUsd) || approvedCapitalUsd <= 0
    || approvedCapitalUsd > 40
    || !isStrictUtcTimestamp(expiresAtSource)
  ) return null;
  const expiresAt = Date.parse(expiresAtSource);
  const actionScope = RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE;
  const digest = productionSelfTestPermitDigest({
    permitId,
    ownerUserId,
    accountBindingSha256,
    actionScope,
    executionMode,
    authorizationDigest,
    approvedCapitalUsd,
    expiresAt,
    revision,
  });
  if (digest !== expectedDigest) return null;
  return {
    permitId, ownerUserId, accountBindingSha256, actionScope, authorizationDigest, approvedCapitalUsd,
    executionMode,
    expiresAt, revision, digest,
  };
}

export function binanceCredentialBindingSha256(
  binding: Pick<RwaBinanceProductionSelfTestBinding,
    "userId" | "venue" | "bindingVersion" | "uidSnapshot">,
) {
  if (
    typeof binding.userId !== "string"
    || binding.userId.length === 0
    || binding.venue !== "binance"
    || !Number.isSafeInteger(binding.bindingVersion)
    || binding.bindingVersion <= 0
    || !/^[a-f0-9]{64}$/u.test(binding.uidSnapshot)
  ) throw new Error("Binance Credential Binding identity is invalid.");
  return sha256([
    RWA_BINANCE_PRODUCTION_SELF_TEST_BINDING_DOMAIN,
    binding.userId,
    binding.venue,
    String(binding.bindingVersion),
    binding.uidSnapshot,
  ].join("\0"));
}

export function productionSelfTestPermitDigest(input: {
  permitId: string;
  ownerUserId: string;
  accountBindingSha256: string;
  actionScope: RwaBinanceProductionSelfTestActionScope;
  executionMode: typeof RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE;
  authorizationDigest: string;
  approvedCapitalUsd: number;
  expiresAt: number;
  revision: string;
}) {
  return sha256([
    "production",
    "binance",
    "xaut",
    input.permitId,
    input.ownerUserId,
    input.accountBindingSha256,
    input.actionScope[0],
    input.actionScope[1],
    input.executionMode,
    input.authorizationDigest,
    String(input.approvedCapitalUsd),
    input.revision,
    new Date(input.expiresAt).toISOString(),
  ].join(":"));
}

export function validProductionSelfTestPermitConfirmation(
  value: unknown,
): value is RwaBinanceProductionSelfTestPermitConfirmation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === [
    "accountBindingSha256", "actionScope", "approvedCapitalUsd", "authorizationDigest",
    "confirmedAt", "digest", "executionMode", "expiresAt", "ownerUserId", "permitId", "revision",
  ].sort().join(",")
    && typeof record.permitId === "string" && /^[a-f0-9]{32}$/u.test(record.permitId)
    && typeof record.ownerUserId === "string" && /^USR-[A-Z0-9]+$/u.test(record.ownerUserId)
    && typeof record.accountBindingSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(record.accountBindingSha256)
    && validProductionSelfTestActionScope(record.actionScope)
    && typeof record.authorizationDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.authorizationDigest)
    && record.executionMode === RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_MODE
    && typeof record.revision === "string" && /^[a-f0-9]{40}$/u.test(record.revision)
    && typeof record.approvedCapitalUsd === "number"
    && Number.isFinite(record.approvedCapitalUsd) && record.approvedCapitalUsd > 0
    && record.approvedCapitalUsd <= 40
    && typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest)
    && typeof record.expiresAt === "number" && Number.isSafeInteger(record.expiresAt)
    && typeof record.confirmedAt === "number" && Number.isSafeInteger(record.confirmedAt);
}

export function validProductionSelfTestPermitConsumption(
  value: unknown,
): value is RwaBinanceProductionSelfTestPermitConsumption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === ["consumedAt", "digest", "permitId"].sort().join(",")
    && typeof record.permitId === "string" && /^[a-f0-9]{32}$/u.test(record.permitId)
    && typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest)
    && typeof record.consumedAt === "number" && Number.isSafeInteger(record.consumedAt)
    && record.consumedAt > 0;
}

export function validProductionSelfTestActionScope(
  value: unknown,
): value is RwaBinanceProductionSelfTestActionScope {
  return Array.isArray(value)
    && value.length === 2
    && value[0] === "READ"
    && value[1] === "TRADE";
}

function isStrictUtcTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString() === value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
