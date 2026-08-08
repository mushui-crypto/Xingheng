import { timingSafeEqual } from "node:crypto";

export const USER_EXCHANGE_CREDENTIAL_ENVELOPE_VERSION = 1 as const;
export const USER_EXCHANGE_CREDENTIAL_AAD_SCHEMA = "user-exchange-credential:v1" as const;

export type ExchangeVenue = "binance" | "bybit" | "bitget" | "okx";
export type CredentialEnvironment = "development" | "test" | "production";

export type CredentialKeyContext = {
  userId: string;
  venue: ExchangeVenue;
  accountId: string;
  environment: CredentialEnvironment;
};

export type WrappedCredentialDataKey = {
  provider: string;
  keyName: string;
  wrapReference: string;
  wrappedDek: string;
};

export type CreatedCredentialDataKey = WrappedCredentialDataKey & {
  plaintextDek: Buffer;
};

export interface CredentialKeyProvider {
  readonly name: string;
  readonly keyName: string;
  readonly configured: boolean;
  readonly configurationError: string | null;
  createDataKey(context: CredentialKeyContext): Promise<CreatedCredentialDataKey>;
  unwrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext): Promise<Buffer>;
}

export class CredentialKeyProviderError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export function canonicalCredentialAad(context: CredentialKeyContext) {
  return Buffer.from(JSON.stringify({
    userId: context.userId,
    venue: context.venue,
    accountId: context.accountId,
    environment: context.environment,
  }), "utf8");
}

export function credentialEnvironment(source: NodeJS.ProcessEnv = process.env): CredentialEnvironment {
  const configured = source.USER_CREDENTIAL_ENVIRONMENT?.trim();
  if (configured) {
    if (configured === "development" || configured === "test" || configured === "production") return configured;
    throw new Error("USER_CREDENTIAL_ENVIRONMENT must be development, test, or production.");
  }
  if (source.NODE_ENV === "production") return "production";
  if (source.NODE_ENV === "test") return "test";
  return "development";
}

export function equalCredentialAad(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}
