import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  USER_EXCHANGE_CREDENTIAL_AAD_SCHEMA,
  USER_EXCHANGE_CREDENTIAL_ENVELOPE_VERSION,
  canonicalCredentialAad,
  credentialEnvironment,
  type CredentialEnvironment,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type ExchangeVenue,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";

export type UserExchangeCredentialSecret = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

export type UserExchangeCredentialSummary = {
  userId: string;
  venue: ExchangeVenue;
  accountId: string;
  accountFingerprint: string;
  maskedApiKey: string;
  environment: CredentialEnvironment;
  permissions: Record<string, boolean>;
  lastVerifiedAt: number;
  createdAt: number;
  updatedAt: number;
};

export type SaveUserExchangeCredentialInput = UserExchangeCredentialSecret & {
  userId: string;
  venue: ExchangeVenue;
  accountId: string;
  accountFingerprint: string;
  permissions: Record<string, boolean>;
  verifiedAt?: number;
};

type CredentialRow = UserExchangeCredentialSummary & Omit<WrappedCredentialDataKey, "provider"> & {
  keyProvider: string;
  envelopeVersion: number;
  algorithm: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
  aadSchema: string;
  permissionsJson: string;
};

export class UserExchangeCredentialStoreError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class UserExchangeCredentialStore {
  private readonly db: DatabaseSync;
  private readonly environment: CredentialEnvironment;
  private readonly now: () => number;

  constructor(options: {
    keyProvider: CredentialKeyProvider;
    dbPath?: string;
    environment?: CredentialEnvironment;
    now?: () => number;
  }) {
    const dbPath = options.dbPath
      ?? process.env.USER_EXCHANGE_CREDENTIAL_DB_PATH
      ?? process.env.TRADING_DB_PATH
      ?? resolve(process.cwd(), "server/data/trading.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.keyProvider = options.keyProvider;
    this.environment = options.environment ?? credentialEnvironment();
    this.now = options.now ?? Date.now;
    this.migrate();
  }

  private readonly keyProvider: CredentialKeyProvider;

  async save(input: SaveUserExchangeCredentialInput): Promise<UserExchangeCredentialSummary> {
    const normalized = normalizeSaveInput(input);
    const context = this.context(normalized.userId, normalized.venue, normalized.accountId);
    const dataKey = await this.keyProvider.createDataKey(context);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify(secretPayload(normalized)), "utf8");
    let ciphertext = Buffer.alloc(0);
    try {
      const cipher = createCipheriv("aes-256-gcm", dataKey.plaintextDek, nonce);
      cipher.setAAD(canonicalCredentialAad(context));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const now = this.now();
      const summary: UserExchangeCredentialSummary = {
        userId: normalized.userId,
        venue: normalized.venue,
        accountId: normalized.accountId,
        accountFingerprint: normalized.accountFingerprint,
        maskedApiKey: maskApiKey(normalized.apiKey),
        environment: this.environment,
        permissions: normalized.permissions,
        lastVerifiedAt: normalized.verifiedAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      try {
        this.db.prepare(`INSERT INTO user_exchange_credentials (
          userId, venue, accountId, accountFingerprint, maskedApiKey, environment, permissionsJson,
          envelopeVersion, algorithm, keyProvider, keyName, wrapReference, wrappedDek,
          nonce, authTag, ciphertext, aadSchema, lastVerifiedAt, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AES-256-GCM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            summary.userId, summary.venue, summary.accountId, summary.accountFingerprint,
            summary.maskedApiKey, summary.environment, JSON.stringify(summary.permissions),
            USER_EXCHANGE_CREDENTIAL_ENVELOPE_VERSION, dataKey.provider, dataKey.keyName,
            dataKey.wrapReference, dataKey.wrappedDek, nonce.toString("base64url"),
            cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url"),
            USER_EXCHANGE_CREDENTIAL_AAD_SCHEMA, summary.lastVerifiedAt, summary.createdAt, summary.updatedAt,
          );
      } catch (error) {
        if (isUserVenueConflict(error)) {
          throw new UserExchangeCredentialStoreError(
            "credential_already_configured",
            "This user already has a credential for the exchange.",
          );
        }
        if (isAccountBindingConflict(error)) {
          throw new UserExchangeCredentialStoreError(
            "credential_account_already_bound",
            "This exchange account is already bound to another user.",
          );
        }
        throw new UserExchangeCredentialStoreError("credential_storage_unavailable", "Credential storage is unavailable.");
      }
      return summary;
    } finally {
      plaintext.fill(0);
      dataKey.plaintextDek.fill(0);
      ciphertext.fill(0);
      nonce.fill(0);
    }
  }

  listForUser(userId: string): UserExchangeCredentialSummary[] {
    const normalizedUserId = requiredIdentifier(userId, "userId");
    return (this.db.prepare("SELECT * FROM user_exchange_credentials WHERE userId = ? ORDER BY venue").all(normalizedUserId) as unknown as CredentialRow[])
      .map(summaryFromRow);
  }

  findSummary(userId: string, venue: ExchangeVenue): UserExchangeCredentialSummary | null {
    const row = this.findRow(requiredIdentifier(userId, "userId"), validVenue(venue));
    return row ? summaryFromRow(row) : null;
  }

  async loadForExecution(userId: string, venue: ExchangeVenue): Promise<UserExchangeCredentialSecret> {
    const normalizedUserId = requiredIdentifier(userId, "userId");
    const normalizedVenue = validVenue(venue);
    const row = this.findRow(normalizedUserId, normalizedVenue);
    if (!row) throw new UserExchangeCredentialStoreError("credential_not_configured", "Exchange credential is not configured.");
    if (row.environment !== this.environment) {
      throw new UserExchangeCredentialStoreError("credential_environment_mismatch", "Credential belongs to a different environment.");
    }
    if (
      row.envelopeVersion !== USER_EXCHANGE_CREDENTIAL_ENVELOPE_VERSION
      || row.algorithm !== "AES-256-GCM"
      || row.aadSchema !== USER_EXCHANGE_CREDENTIAL_AAD_SCHEMA
    ) {
      throw new UserExchangeCredentialStoreError("credential_envelope_invalid", "Credential envelope is invalid.");
    }
    const context = this.context(normalizedUserId, normalizedVenue, row.accountId);
    const dataKey = await this.keyProvider.unwrapDataKey({
      provider: row.keyProvider,
      keyName: row.keyName,
      wrapReference: row.wrapReference,
      wrappedDek: row.wrappedDek,
    }, context);
    let plaintext: Buffer | null = null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(row.nonce, "base64url"));
      decipher.setAAD(canonicalCredentialAad(context));
      decipher.setAuthTag(Buffer.from(row.authTag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64url")),
        decipher.final(),
      ]);
      return parseSecret(plaintext);
    } catch (error) {
      if (error instanceof UserExchangeCredentialStoreError) throw error;
      throw new UserExchangeCredentialStoreError("credential_decryption_failed", "Credential could not be decrypted.");
    } finally {
      plaintext?.fill(0);
      dataKey.fill(0);
    }
  }

  delete(userId: string, venue: ExchangeVenue) {
    this.db.prepare("DELETE FROM user_exchange_credentials WHERE userId = ? AND venue = ?")
      .run(requiredIdentifier(userId, "userId"), validVenue(venue));
  }

  close() {
    this.db.close();
  }

  private context(userId: string, venue: ExchangeVenue, accountId: string): CredentialKeyContext {
    return { userId, venue, accountId, environment: this.environment };
  }

  private findRow(userId: string, venue: ExchangeVenue) {
    return this.db.prepare("SELECT * FROM user_exchange_credentials WHERE userId = ? AND venue = ?")
      .get(userId, venue) as unknown as CredentialRow | undefined;
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS user_exchange_credentials (
      userId TEXT NOT NULL,
      venue TEXT NOT NULL CHECK(venue IN ('binance', 'bybit', 'bitget', 'okx')),
      accountId TEXT NOT NULL,
      accountFingerprint TEXT NOT NULL,
      maskedApiKey TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('development', 'test', 'production')),
      permissionsJson TEXT NOT NULL,
      envelopeVersion INTEGER NOT NULL,
      algorithm TEXT NOT NULL CHECK(algorithm = 'AES-256-GCM'),
      keyProvider TEXT NOT NULL,
      keyName TEXT NOT NULL,
      wrapReference TEXT NOT NULL,
      wrappedDek TEXT NOT NULL,
      nonce TEXT NOT NULL,
      authTag TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      aadSchema TEXT NOT NULL,
      lastVerifiedAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY(userId, venue),
      UNIQUE(venue, accountId)
    );`);
  }
}

function normalizeSaveInput(input: SaveUserExchangeCredentialInput) {
  const apiKey = requiredSecret(input.apiKey, "apiKey");
  const apiSecret = requiredSecret(input.apiSecret, "apiSecret");
  const passphrase = input.passphrase === undefined ? undefined : requiredSecret(input.passphrase, "passphrase");
  return {
    ...input,
    userId: requiredIdentifier(input.userId, "userId"),
    venue: validVenue(input.venue),
    accountId: requiredIdentifier(input.accountId, "accountId"),
    accountFingerprint: requiredIdentifier(input.accountFingerprint, "accountFingerprint"),
    apiKey,
    apiSecret,
    ...(passphrase ? { passphrase } : {}),
    permissions: validPermissions(input.permissions),
  };
}

function secretPayload(input: SaveUserExchangeCredentialInput): UserExchangeCredentialSecret {
  return { apiKey: input.apiKey, apiSecret: input.apiSecret, ...(input.passphrase ? { passphrase: input.passphrase } : {}) };
}

function parseSecret(value: Buffer): UserExchangeCredentialSecret {
  try {
    const parsed = JSON.parse(value.toString("utf8")) as Partial<UserExchangeCredentialSecret>;
    const apiKey = requiredSecret(parsed.apiKey, "apiKey");
    const apiSecret = requiredSecret(parsed.apiSecret, "apiSecret");
    const passphrase = parsed.passphrase === undefined ? undefined : requiredSecret(parsed.passphrase, "passphrase");
    return { apiKey, apiSecret, ...(passphrase ? { passphrase } : {}) };
  } catch (error) {
    if (error instanceof UserExchangeCredentialStoreError) throw error;
    throw new UserExchangeCredentialStoreError("credential_payload_invalid", "Credential payload is invalid.");
  }
}

function summaryFromRow(row: CredentialRow): UserExchangeCredentialSummary {
  return {
    userId: String(row.userId),
    venue: validVenue(row.venue),
    accountId: String(row.accountId),
    accountFingerprint: String(row.accountFingerprint),
    maskedApiKey: String(row.maskedApiKey),
    environment: row.environment,
    permissions: JSON.parse(String(row.permissionsJson)) as Record<string, boolean>,
    lastVerifiedAt: Number(row.lastVerifiedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function requiredIdentifier(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw new UserExchangeCredentialStoreError("credential_input_invalid", `${name} is invalid.`);
  return text;
}

function requiredSecret(value: unknown, name: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512) throw new UserExchangeCredentialStoreError("credential_input_invalid", `${name} is invalid.`);
  return text;
}

function validVenue(value: unknown): ExchangeVenue {
  if (value === "binance" || value === "bybit" || value === "bitget" || value === "okx") return value;
  throw new UserExchangeCredentialStoreError("credential_input_invalid", "venue is invalid.");
}

function validPermissions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserExchangeCredentialStoreError("credential_input_invalid", "permissions are invalid.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32 || entries.some(([key, enabled]) => !key || key.length > 80 || typeof enabled !== "boolean")) {
    throw new UserExchangeCredentialStoreError("credential_input_invalid", "permissions are invalid.");
  }
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function maskApiKey(value: string) {
  return value.length < 8 ? "configured" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isAccountBindingConflict(error: unknown) {
  return error instanceof Error
    && /UNIQUE constraint failed: user_exchange_credentials\.venue, user_exchange_credentials\.accountId/u.test(error.message);
}

function isUserVenueConflict(error: unknown) {
  return error instanceof Error
    && /UNIQUE constraint failed: user_exchange_credentials\.userId, user_exchange_credentials\.venue/u.test(error.message);
}
