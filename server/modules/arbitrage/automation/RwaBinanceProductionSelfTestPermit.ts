import { createHash } from "node:crypto";

export const RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE =
  Object.freeze(["READ", "TRADE"] as const);

export type RwaBinanceProductionSelfTestActionScope =
  readonly ["READ", "TRADE"];

export type RwaBinanceProductionSelfTestPermit = {
  permitId: string;
  ownerUserId: string;
  accountBindingSha256: string;
  actionScope: RwaBinanceProductionSelfTestActionScope;
  authorizationDigest: string;
  approvedCapitalUsd: number;
  leverage: number;
  maxPositionUsd: number;
  maxOrderSizeUsd: number;
  maxOrderCount: number;
  maxSlippageBps: number;
  maxFeeBps: number;
  lossLimitUsd: number;
  executionId: string;
  expiresAt: number;
  revision: string;
  digest: string;
};

export type RwaBinanceProductionSelfTestPermitConfirmation = {
  permitId: string;
  ownerUserId: string;
  accountBindingSha256: string;
  actionScope: RwaBinanceProductionSelfTestActionScope;
  authorizationDigest: string;
  approvedCapitalUsd: number;
  leverage: number;
  maxPositionUsd: number;
  maxOrderSizeUsd: number;
  maxOrderCount: number;
  maxSlippageBps: number;
  maxFeeBps: number;
  lossLimitUsd: number;
  executionId: string;
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
  const expiresAtSource = environment.RWA_BINANCE_PRODUCTION_SELF_TEST_EXPIRES_AT ?? "";
  const approvedCapitalUsd = Number(
    environment.RWA_BINANCE_PRODUCTION_SELF_TEST_APPROVED_CAPITAL_USD,
  );
  const revision = environment.XINGHENG_EXPECTED_REVISION ?? "";
  const leverage = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_LEVERAGE);
  const maxPositionUsd = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_MAX_POSITION_USD);
  const maxOrderSizeUsd = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_MAX_ORDER_SIZE_USD);
  const maxOrderCount = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_MAX_ORDER_COUNT);
  const maxSlippageBps = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_MAX_SLIPPAGE_BPS);
  const maxFeeBps = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_MAX_FEE_BPS);
  const lossLimitUsd = Number(environment.RWA_BINANCE_PRODUCTION_SELF_TEST_LOSS_LIMIT_USD);
  const executionId = environment.RWA_BINANCE_PRODUCTION_SELF_TEST_EXECUTION_ID ?? "";
  if (
    !/^[a-f0-9]{32}$/u.test(permitId)
    || !/^USR-[A-Z0-9]+$/u.test(ownerUserId)
    || !/^[a-f0-9]{64}$/u.test(accountBindingSha256)
    || actionScopeSource !== '["READ","TRADE"]'
    || !/^[a-f0-9]{64}$/u.test(authorizationDigest)
    || !/^[a-f0-9]{40}$/u.test(revision)
    || !Number.isFinite(approvedCapitalUsd) || approvedCapitalUsd <= 0
    || approvedCapitalUsd > 40 || leverage !== 1 || maxPositionUsd !== 40
    || !Number.isFinite(maxOrderSizeUsd) || maxOrderSizeUsd <= 0 || maxOrderSizeUsd > 40
    || maxOrderCount !== 4 || !Number.isSafeInteger(maxSlippageBps)
    || maxSlippageBps < 1 || maxSlippageBps > 20
    || !Number.isFinite(maxFeeBps) || maxFeeBps <= 0 || maxFeeBps > 100
    || !Number.isFinite(lossLimitUsd) || lossLimitUsd <= 0 || lossLimitUsd > 40
    || !/^[a-f0-9]{32}$/u.test(executionId)
    || !isStrictUtcTimestamp(expiresAtSource)
  ) return null;
  const expiresAt = Date.parse(expiresAtSource);
  const actionScope = RWA_BINANCE_PRODUCTION_SELF_TEST_ACTION_SCOPE;
  const digest = productionSelfTestPermitDigest({
    permitId,
    ownerUserId,
    accountBindingSha256,
    actionScope,
    authorizationDigest,
    approvedCapitalUsd,
    leverage, maxPositionUsd, maxOrderSizeUsd, maxOrderCount, maxSlippageBps,
    maxFeeBps, lossLimitUsd, executionId,
    expiresAt,
    revision,
  });
  return {
    permitId, ownerUserId, accountBindingSha256, actionScope, authorizationDigest, approvedCapitalUsd,
    leverage, maxPositionUsd, maxOrderSizeUsd, maxOrderCount, maxSlippageBps,
    maxFeeBps, lossLimitUsd, executionId,
    expiresAt, revision, digest,
  };
}

export function binanceAccountBindingSha256(accountId: string, accountFingerprint: string) {
  return sha256(`binance:xaut:${accountId}:${accountFingerprint}`);
}

export function productionSelfTestPermitDigest(input: {
  permitId: string;
  ownerUserId: string;
  accountBindingSha256: string;
  actionScope: RwaBinanceProductionSelfTestActionScope;
  authorizationDigest: string;
  approvedCapitalUsd: number;
  leverage: number;
  maxPositionUsd: number;
  maxOrderSizeUsd: number;
  maxOrderCount: number;
  maxSlippageBps: number;
  maxFeeBps: number;
  lossLimitUsd: number;
  executionId: string;
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
    input.authorizationDigest,
    String(input.approvedCapitalUsd),
    String(input.leverage),
    String(input.maxPositionUsd),
    String(input.maxOrderSizeUsd),
    String(input.maxOrderCount),
    String(input.maxSlippageBps),
    String(input.maxFeeBps),
    String(input.lossLimitUsd),
    input.executionId,
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
    "confirmedAt", "digest", "executionId", "expiresAt", "leverage", "lossLimitUsd",
    "maxFeeBps", "maxOrderCount", "maxOrderSizeUsd", "maxPositionUsd", "maxSlippageBps",
    "ownerUserId", "permitId", "revision",
  ].sort().join(",")
    && typeof record.permitId === "string" && /^[a-f0-9]{32}$/u.test(record.permitId)
    && typeof record.ownerUserId === "string" && /^USR-[A-Z0-9]+$/u.test(record.ownerUserId)
    && typeof record.accountBindingSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(record.accountBindingSha256)
    && validProductionSelfTestActionScope(record.actionScope)
    && typeof record.authorizationDigest === "string"
    && /^[a-f0-9]{64}$/u.test(record.authorizationDigest)
    && typeof record.revision === "string" && /^[a-f0-9]{40}$/u.test(record.revision)
    && typeof record.approvedCapitalUsd === "number"
    && Number.isFinite(record.approvedCapitalUsd) && record.approvedCapitalUsd > 0
    && record.approvedCapitalUsd <= 40
    && record.leverage === 1 && record.maxPositionUsd === 40
    && typeof record.maxOrderSizeUsd === "number" && Number.isFinite(record.maxOrderSizeUsd)
    && record.maxOrderSizeUsd > 0 && record.maxOrderSizeUsd <= 40
    && record.maxOrderCount === 4
    && typeof record.maxSlippageBps === "number" && Number.isSafeInteger(record.maxSlippageBps)
    && record.maxSlippageBps >= 1 && record.maxSlippageBps <= 20
    && typeof record.maxFeeBps === "number" && Number.isFinite(record.maxFeeBps)
    && record.maxFeeBps > 0 && record.maxFeeBps <= 100
    && typeof record.lossLimitUsd === "number" && Number.isFinite(record.lossLimitUsd)
    && record.lossLimitUsd > 0 && record.lossLimitUsd <= 40
    && typeof record.executionId === "string" && /^[a-f0-9]{32}$/u.test(record.executionId)
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
