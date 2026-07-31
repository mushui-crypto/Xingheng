import { createHash } from "node:crypto";

export const RWA_CREDENTIAL_ENVELOPE_VERSION = 2 as const;
export const RWA_CREDENTIAL_AAD_SCHEMA = "rwa-credential:v2:userId:venue:accountId:environment" as const;
export const STEP_UP_SECURITY_AAD_SCHEMA = "step-up-security:v1:userId:purpose:environment" as const;
export const RWA_AUTOMATION_BACKUP_AAD_SCHEMA = "rwa-automation-backup:v1:backupId:environment" as const;
export const RWA_GCP_KMS_KEY_NAME =
  "projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials" as const;

export type CredentialKeyProviderName = "gcp-kms" | "fake";

export type CredentialEnvironment = "production" | "development" | "test";

export type ExchangeCredentialKeyContext = {
  purpose?: "exchange-credential";
  userId: string;
  venue: "bybit" | "bitget" | "binance" | "okx";
  accountId: string;
  environment: CredentialEnvironment;
  schemaVersion: typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
};

export type StepUpSecurityKeyContext = {
  purpose: "step-up-security";
  userId: string;
  securityDomain: "rwa-sensitive-operations";
  environment: CredentialEnvironment;
  schemaVersion: typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
};

export type AutomationBackupKeyContext = {
  purpose: "automation-backup";
  backupId: string;
  backupDomain: "rwa-automation-disaster-recovery";
  environment: CredentialEnvironment;
  schemaVersion: typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
};

export type CredentialKeyContext =
  | ExchangeCredentialKeyContext
  | StepUpSecurityKeyContext
  | AutomationBackupKeyContext;

export type WrappedCredentialDataKey = {
  provider: CredentialKeyProviderName;
  keyName: string;
  wrapReference: string;
  wrappedDek: string;
};

export type CreatedCredentialDataKey = WrappedCredentialDataKey & {
  plaintextDek: Buffer;
};

export type CredentialKeyProviderHealth = {
  ok: boolean;
  category: string | null;
  message: string | null;
};

export interface CredentialKeyProvider {
  readonly name: CredentialKeyProviderName;
  readonly configured: boolean;
  readonly configurationError: string | null;
  createDataKey(context: CredentialKeyContext): Promise<CreatedCredentialDataKey>;
  unwrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext): Promise<Buffer>;
  rewrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext): Promise<WrappedCredentialDataKey>;
  healthCheck(context: CredentialKeyContext): Promise<CredentialKeyProviderHealth>;
}

export class CredentialKeyProviderError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export function credentialEnvironment(): CredentialEnvironment {
  if (process.env.NODE_ENV === "production") {
    const environment = process.env.XINGHENG_DEPLOYMENT_ENVIRONMENT;
    if (environment === "production") return environment;
    throw new CredentialKeyProviderError(
      "credential_environment_unconfigured",
      "生产安全模式缺少精确部署环境身份；已拒绝凭证操作。",
    );
  }
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

export function canonicalCredentialAad(context: CredentialKeyContext) {
  if (context.purpose === "automation-backup") {
    return Buffer.from(JSON.stringify({
      schema: RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
      purpose: context.purpose,
      backupId: context.backupId,
      backupDomain: context.backupDomain,
      environment: context.environment,
      schemaVersion: context.schemaVersion,
    }), "utf8");
  }
  if (context.purpose === "step-up-security") {
    return Buffer.from(JSON.stringify({
      schema: STEP_UP_SECURITY_AAD_SCHEMA,
      purpose: context.purpose,
      userId: context.userId,
      securityDomain: context.securityDomain,
      environment: context.environment,
      schemaVersion: context.schemaVersion,
    }), "utf8");
  }
  return Buffer.from(JSON.stringify({
    schema: RWA_CREDENTIAL_AAD_SCHEMA,
    userId: context.userId,
    venue: context.venue,
    accountId: context.accountId,
    environment: context.environment,
    schemaVersion: context.schemaVersion,
  }), "utf8");
}

export function cloudCredentialAad(context: CredentialKeyContext) {
  if (context.purpose === "automation-backup") {
    return Buffer.from(JSON.stringify({
      schema: RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
      purpose: context.purpose,
      backupDomain: domainHash("backup-purpose", context.backupDomain),
      backupId: domainHash("backup-id", context.backupId),
      environment: context.environment,
      schemaVersion: context.schemaVersion,
    }), "utf8");
  }
  if (context.purpose === "step-up-security") {
    return Buffer.from(JSON.stringify({
      schema: STEP_UP_SECURITY_AAD_SCHEMA,
      purpose: context.purpose,
      userDomain: domainHash("step-up-user", context.userId),
      securityDomain: domainHash("step-up-purpose", context.securityDomain),
      environment: context.environment,
      schemaVersion: context.schemaVersion,
    }), "utf8");
  }
  return Buffer.from(JSON.stringify({
    schema: RWA_CREDENTIAL_AAD_SCHEMA,
    userDomain: domainHash("user", context.userId),
    venue: context.venue,
    accountDomain: domainHash("account", context.accountId),
    environment: context.environment,
    schemaVersion: context.schemaVersion,
  }), "utf8");
}

function domainHash(domain: string, value: string) {
  return createHash("sha256").update(`rwa:${domain}:${value}`, "utf8").digest("base64url");
}
