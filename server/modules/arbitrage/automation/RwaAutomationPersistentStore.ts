import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  RwaBybitCredentials,
  RwaBybitPermissions,
  RwaCredentialLifecycle,
  RwaExecutionConfig,
  RwaExecutionRecord,
  RwaPreflightReport,
  RwaStrategyPnlSnapshot,
  RwaVenueCredentials,
  RwaVenueAccountIdentity,
  RwaVenuePermissions,
} from "./RwaNeutralExecutionTypes";
import { defaultRwaExecutionConfig } from "./RwaNeutralExecutionTypes";

type CredentialEnvelope<TPermissions extends RwaVenuePermissions> = {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
  maskedApiKey: string;
  accountId: string;
  accountFingerprint: string;
  accountMode: RwaVenueAccountIdentity["accountMode"];
  permissions: TPermissions;
  lastVerifiedAt: number;
  updatedAt: number;
};

type StoredChallenge = {
  id: string;
  tokenHash: string;
  report: RwaPreflightReport;
  expiresAt: number;
  consumedAt: number | null;
};

type AutomationState = {
  version: 1;
  config: RwaExecutionConfig;
  challenges: StoredChallenge[];
  executions: RwaExecutionRecord[];
  pnlSeries: RwaStrategyPnlSnapshot[];
  credentialLifecycle: RwaCredentialLifecycle;
  credentialAlert: string | null;
  credentialAudit: Array<{
    userId: string;
    action: "activated" | "rotated" | "invalidated" | "deleted";
    accountId: string;
    accountFingerprint: string;
    maskedApiKey: string | null;
    occurredAt: number;
  }>;
};

const emptyState = (): AutomationState => ({
  version: 1,
  config: { ...defaultRwaExecutionConfig },
  challenges: [],
  executions: [],
  pnlSeries: [],
  credentialLifecycle: "unconfigured",
  credentialAlert: null,
  credentialAudit: [],
});

export class RwaAutomationPersistentStore<
  TCredentials extends RwaVenueCredentials = RwaBybitCredentials,
  TPermissions extends RwaVenuePermissions = RwaBybitPermissions,
> {
  readonly credentialPath: string;
  readonly statePath: string;
  readonly userDomain: string;
  readonly venue: "bybit" | "bitget" | "binance" | "okx";
  readonly ownerUserId: string;
  private readonly key: Buffer | null;
  private readonly keyError: string | null;

  constructor(options: {
    userId: string;
    venue?: "bybit" | "bitget" | "binance" | "okx";
    masterKey?: string;
    credentialPath?: string;
    statePath?: string;
  }) {
    if (!options.userId.trim()) throw new Error("RWA automation store requires authenticated user ownership.");
    this.ownerUserId = options.userId;
    this.venue = options.venue ?? "bybit";
    this.userDomain = createHash("sha256").update(`rwa-user:${this.ownerUserId}`).digest("hex").slice(0, 16);
    const dataDir = resolve(process.env.RWA_AUTOMATION_DATA_DIR ?? "server/data/rwa-automation");
    this.credentialPath = options.credentialPath
      ? resolve(options.credentialPath)
      : resolve(dataDir, `${this.userDomain}-${this.venue}-credentials.enc.json`);
    this.statePath = options.statePath
      ? resolve(options.statePath)
      : resolve(dataDir, `${this.userDomain}-${this.venue}-state.json`);
    const parsed = parseMasterKey(options.masterKey ?? process.env.RWA_AUTOMATION_MASTER_KEY ?? "");
    this.key = parsed.key;
    this.keyError = parsed.error;
  }

  get masterKeyConfigured() {
    return this.key !== null;
  }

  get masterKeyError() {
    return this.keyError;
  }

  async hasCredentials() {
    return access(this.credentialPath).then(() => true).catch(() => false);
  }

  async readCredentialMetadata(): Promise<Omit<CredentialEnvelope<TPermissions>, "ciphertext" | "nonce" | "tag"> | null> {
    const envelope = await this.readCredentialEnvelope();
    if (!envelope) return null;
    return {
      version: envelope.version,
      maskedApiKey: envelope.maskedApiKey,
      accountId: envelope.accountId,
      accountFingerprint: envelope.accountFingerprint,
      accountMode: envelope.accountMode,
      permissions: envelope.permissions,
      lastVerifiedAt: envelope.lastVerifiedAt,
      updatedAt: envelope.updatedAt,
    };
  }

  async saveCredentials(
    credentials: TCredentials,
    permissions: TPermissions,
    identity: RwaVenueAccountIdentity,
    verifiedAt: number,
  ) {
    const key = this.requireKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    cipher.setAAD(this.credentialAad(identity.accountId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: CredentialEnvelope<TPermissions> = {
      version: 1,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      maskedApiKey: maskApiKey(credentials.apiKey),
      accountId: identity.accountId,
      accountFingerprint: identity.accountFingerprint,
      accountMode: identity.accountMode,
      permissions,
      lastVerifiedAt: verifiedAt,
      updatedAt: verifiedAt,
    };
    await atomicWriteJson(this.credentialPath, envelope);
  }

  async loadCredentials(): Promise<TCredentials> {
    const key = this.requireKey();
    const envelope = await this.readCredentialEnvelope();
    if (!envelope) throw new Error("交易所 API 凭证尚未配置。");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(this.credentialAad(envelope.accountId));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const value = JSON.parse(plaintext.toString("utf8")) as Partial<TCredentials>;
      if (!value.apiKey || !value.apiSecret) throw new Error("invalid credential payload");
      return value as TCredentials;
    } catch {
      throw new Error("交易所 API 凭证无法解密；已拒绝继续使用。");
    }
  }

  async deleteCredentials() {
    await unlink(this.credentialPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async readState() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<AutomationState>;
      if (parsed.version !== 1) return emptyState();
      return {
        ...emptyState(),
        ...parsed,
        config: { ...defaultRwaExecutionConfig, ...(parsed.config ?? {}) },
        challenges: Array.isArray(parsed.challenges) ? parsed.challenges : [],
        executions: Array.isArray(parsed.executions) ? parsed.executions : [],
        pnlSeries: Array.isArray(parsed.pnlSeries) ? parsed.pnlSeries : [],
        credentialLifecycle: validCredentialLifecycle(parsed.credentialLifecycle) ? parsed.credentialLifecycle : "unconfigured",
        credentialAlert: typeof parsed.credentialAlert === "string" ? parsed.credentialAlert : null,
        credentialAudit: Array.isArray(parsed.credentialAudit) ? parsed.credentialAudit : [],
      } as AutomationState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new Error("RWA 自动执行状态文件不可读；已 fail-closed。");
    }
  }

  async writeState(state: AutomationState) {
    await atomicWriteJson(this.statePath, state);
  }

  private requireKey() {
    if (!this.key) throw new Error(this.keyError ?? "RWA_AUTOMATION_MASTER_KEY 未配置；已拒绝凭证操作。");
    return this.key;
  }

  private credentialAad(accountId: string) {
    return Buffer.from(`rwa-automation:v1:${this.ownerUserId}:${this.venue}:${accountId}`, "utf8");
  }

  private async readCredentialEnvelope(): Promise<CredentialEnvelope<TPermissions> | null> {
    try {
      const parsed = JSON.parse(await readFile(this.credentialPath, "utf8")) as CredentialEnvelope<TPermissions>;
      if (
        parsed.version !== 1 || !parsed.nonce || !parsed.tag || !parsed.ciphertext ||
        !parsed.maskedApiKey || !parsed.accountId || !parsed.accountFingerprint || !parsed.accountMode ||
        !parsed.permissions || !Number.isFinite(parsed.updatedAt)
      ) {
        throw new Error("invalid envelope");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("交易所 API 凭证文件格式无效；已拒绝继续使用。");
    }
  }
}

export type RwaAutomationStateData = AutomationState;
export type RwaStoredChallenge = StoredChallenge;

async function atomicWriteJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseMasterKey(raw: string): { key: Buffer | null; error: string | null } {
  if (!raw) return { key: null, error: "RWA_AUTOMATION_MASTER_KEY 未配置；已拒绝凭证操作。" };
  let key: Buffer;
  try {
    if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, "hex");
    else if (/^[A-Za-z0-9+/_=-]+$/.test(raw)) key = Buffer.from(raw, "base64url");
    else return { key: null, error: "RWA_AUTOMATION_MASTER_KEY 格式无效；必须是 32 字节 hex/base64。" };
  } catch {
    return { key: null, error: "RWA_AUTOMATION_MASTER_KEY 格式无效；必须是 32 字节 hex/base64。" };
  }
  return key.length === 32
    ? { key, error: null }
    : { key: null, error: "RWA_AUTOMATION_MASTER_KEY 长度无效；必须是 32 字节。" };
}

function maskApiKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function validCredentialLifecycle(value: unknown): value is RwaCredentialLifecycle {
  return ["unconfigured", "validating", "active", "invalid", "expired", "revoked", "rotation_required"].includes(String(value));
}
