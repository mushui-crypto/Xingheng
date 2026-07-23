import { createHash } from "node:crypto";

export const RWA_CREDENTIAL_ENVELOPE_VERSION = 2 as const;
export const RWA_CREDENTIAL_AAD_SCHEMA = "rwa-credential:v2:userId:venue:accountId:environment" as const;
export const RWA_GCP_KMS_KEY_NAME =
  "projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials" as const;

export type CredentialKeyProviderName = "gcp-kms" | "fake";

export type CredentialKeyContext = {
  userId: string;
  venue: "bybit" | "bitget" | "binance" | "okx";
  accountId: string;
  environment: "production" | "development" | "test";
  schemaVersion: typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
};

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

export function credentialEnvironment(): CredentialKeyContext["environment"] {
  if (process.env.NODE_ENV === "production") return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

export function canonicalCredentialAad(context: CredentialKeyContext) {
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
