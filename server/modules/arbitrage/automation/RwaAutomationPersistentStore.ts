import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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
import {
  CredentialKeyProviderError,
  RWA_CREDENTIAL_AAD_SCHEMA,
  RWA_CREDENTIAL_ENVELOPE_VERSION,
  canonicalCredentialAad,
  credentialEnvironment,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";
import { resolveRwaAutomationActiveDataDir } from "./RwaAutomationDataLayout";
import {
  RwaAutomationGovernanceError,
  loadRwaAutomationGovernanceConfig,
  type RwaAutomationGovernanceConfig,
} from "./RwaAutomationGovernance";

type LegacyCredentialEnvelope<TPermissions extends RwaVenuePermissions> = {
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

type CredentialEnvelope<TPermissions extends RwaVenuePermissions> = {
  version: typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
  algorithm: "AES-256-GCM";
  provider: WrappedCredentialDataKey["provider"];
  keyName: string;
  wrapReference: string;
  wrappedDek: string;
  wrapBindingTag: string;
  ciphertext: string;
  nonce: string;
  tag: string;
  aadSchema: typeof RWA_CREDENTIAL_AAD_SCHEMA;
  createdAt: number;
  updatedAt: number;
  maskedApiKey: string;
  accountId: string;
  accountFingerprint: string;
  accountMode: RwaVenueAccountIdentity["accountMode"];
  permissions: TPermissions;
  lastVerifiedAt: number;
};

export type RwaCredentialMetadata<TPermissions extends RwaVenuePermissions = RwaBybitPermissions> = {
  version: 1 | typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
  requiresRotation: boolean;
  maskedApiKey: string;
  accountId: string;
  accountFingerprint: string;
  accountMode: RwaVenueAccountIdentity["accountMode"];
  permissions: TPermissions;
  lastVerifiedAt: number;
  updatedAt: number;
};

export class CredentialStoreError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

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
  private readonly keyProvider: CredentialKeyProvider;
  private readonly governanceConfig: RwaAutomationGovernanceConfig;
  private clock: () => number;

  constructor(options: {
    userId: string;
    venue?: "bybit" | "bitget" | "binance" | "okx";
    keyProvider: CredentialKeyProvider;
    credentialPath?: string;
    statePath?: string;
    governanceConfig?: RwaAutomationGovernanceConfig;
    now?: () => number;
  }) {
    if (!options.userId.trim()) throw new Error("RWA automation store requires authenticated user ownership.");
    this.ownerUserId = options.userId;
    this.venue = options.venue ?? "bybit";
    this.userDomain = createHash("sha256").update(`rwa-user:${this.ownerUserId}`).digest("hex").slice(0, 16);
    const dataDir = resolveRwaAutomationActiveDataDir();
    this.credentialPath = options.credentialPath
      ? resolve(options.credentialPath)
      : resolve(dataDir, `${this.userDomain}-${this.venue}-credentials.enc.json`);
    this.statePath = options.statePath
      ? resolve(options.statePath)
      : resolve(dataDir, `${this.userDomain}-${this.venue}-state.json`);
    this.keyProvider = options.keyProvider;
    this.governanceConfig = options.governanceConfig ?? loadRwaAutomationGovernanceConfig();
    this.clock = options.now ?? Date.now;
  }

  get masterKeyConfigured() {
    return this.keyProvider.configured;
  }

  get masterKeyError() {
    return this.keyProvider.configurationError;
  }

  get maxInMemoryChallenges() {
    return this.governanceConfig.maxChallengesPerUser;
  }

  setClock(now: () => number) {
    this.clock = now;
  }

  async hasCredentials() {
    return access(this.credentialPath).then(() => true).catch(() => false);
  }

  async readCredentialMetadata(): Promise<RwaCredentialMetadata<TPermissions> | null> {
    const envelope = await this.readRawCredentialEnvelope();
    if (!envelope) return null;
    return {
      version: envelope.version,
      requiresRotation: envelope.version === 1,
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
    await this.assertKeyProviderHealthy(identity.accountId);
    const previous = await this.readRawCredentialEnvelope();
    if (previous?.version === 1) {
      throw new CredentialStoreError(
        "credential_rotation_required",
        "检测到旧版凭证格式；必须先删除旧凭证并重新授权，在线服务不会自动迁移。",
      );
    }
    const context = this.credentialContext(identity.accountId);
    const dataKey = await this.keyProvider.createDataKey(context).catch(asCredentialStoreError);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey.plaintextDek, nonce);
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    try {
      cipher.setAAD(canonicalCredentialAad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: CredentialEnvelope<TPermissions> = {
        version: RWA_CREDENTIAL_ENVELOPE_VERSION,
        algorithm: "AES-256-GCM",
        provider: dataKey.provider,
        keyName: dataKey.keyName,
        wrapReference: dataKey.wrapReference,
        wrappedDek: dataKey.wrappedDek,
        wrapBindingTag: "",
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        aadSchema: RWA_CREDENTIAL_AAD_SCHEMA,
        createdAt: previous?.createdAt ?? verifiedAt,
        updatedAt: verifiedAt,
        maskedApiKey: maskApiKey(credentials.apiKey),
        accountId: identity.accountId,
        accountFingerprint: identity.accountFingerprint,
        accountMode: identity.accountMode,
        permissions,
        lastVerifiedAt: verifiedAt,
      };
      envelope.wrapBindingTag = createWrapBindingTag(dataKey.plaintextDek, envelope);
      await atomicWriteJson(this.credentialPath, envelope);
      ciphertext.fill(0);
    } finally {
      plaintext.fill(0);
      dataKey.plaintextDek.fill(0);
    }
  }

  async loadCredentials(): Promise<TCredentials> {
    const envelope = await this.readRawCredentialEnvelope();
    if (!envelope) throw new Error("交易所 API 凭证尚未配置。");
    if (envelope.version === 1) {
      throw new CredentialStoreError(
        "credential_rotation_required",
        "检测到旧版凭证格式；必须删除旧凭证并重新授权。",
      );
    }
    const context = this.credentialContext(envelope.accountId);
    const dataKey = await this.keyProvider.unwrapDataKey(wrappedDataKey(envelope), context).catch(asCredentialStoreError);
    let plaintext: Buffer | null = null;
    try {
      assertWrapBinding(dataKey, envelope);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(canonicalCredentialAad(context));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const value = JSON.parse(plaintext.toString("utf8")) as Partial<TCredentials>;
      if (!value.apiKey || !value.apiSecret) throw new Error("invalid credential payload");
      return value as TCredentials;
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError("credential_decryption_failed", "交易所 API 凭证无法解密；已拒绝继续使用。");
    } finally {
      plaintext?.fill(0);
      dataKey.fill(0);
    }
  }

  async rewrapCredentials() {
    const envelope = await this.readRawCredentialEnvelope();
    if (!envelope) throw new CredentialStoreError("credentials_unconfigured", "交易所 API 凭证尚未配置。");
    if (envelope.version === 1) {
      throw new CredentialStoreError("credential_rotation_required", "旧版凭证不允许在线重包裹。");
    }
    await this.assertKeyProviderHealthy(envelope.accountId);
    const context = this.credentialContext(envelope.accountId);
    const dataKey = await this.keyProvider.unwrapDataKey(wrappedDataKey(envelope), context).catch(asCredentialStoreError);
    try {
      assertWrapBinding(dataKey, envelope);
      const rewrapped = await this.keyProvider.rewrapDataKey(wrappedDataKey(envelope), context).catch(asCredentialStoreError);
      const nextEnvelope: CredentialEnvelope<TPermissions> = {
        ...envelope,
        provider: rewrapped.provider,
        keyName: rewrapped.keyName,
        wrapReference: rewrapped.wrapReference,
        wrappedDek: rewrapped.wrappedDek,
        wrapBindingTag: "",
        updatedAt: Date.now(),
      };
      nextEnvelope.wrapBindingTag = createWrapBindingTag(dataKey, nextEnvelope);
      await atomicWriteJson(this.credentialPath, nextEnvelope);
    } finally {
      dataKey.fill(0);
    }
  }

  async assertKeyProviderHealthy(accountId: string) {
    if (!this.keyProvider.configured) {
      throw new CredentialStoreError(
        "credential_key_provider_unavailable",
        this.keyProvider.configurationError ?? "凭证密钥 provider 未配置；已拒绝凭证操作。",
      );
    }
    const health = await this.keyProvider.healthCheck(this.credentialContext(accountId));
    if (!health.ok) {
      throw new CredentialStoreError(
        health.category ?? "credential_key_provider_unavailable",
        health.message ?? "凭证密钥 provider 不可用；已拒绝凭证操作。",
      );
    }
  }

  async deleteCredentials() {
    await unlink(this.credentialPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async assertRiskCapacity() {
    const state = await this.readState();
    const completed = state.executions.filter(isCompletedExecution).length;
    const active = state.executions.length - completed;
    const encodedBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    if (
      completed >= this.governanceConfig.stateMaxCompletedExecutions
      || active >= this.governanceConfig.stateMaxActiveExecutions
      || encodedBytes >= this.governanceConfig.stateMaxBytes
    ) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "自动套利持久状态容量已满；已拒绝新增风险操作，急停与受控退出仍可用。",
      );
    }
  }

  async readState() {
    try {
      const metadata = await stat(this.statePath);
      if (metadata.size > this.governanceConfig.stateMaxBytesHard) {
        throw new RwaAutomationGovernanceError(
          503,
          "automation_capacity_exceeded",
          "自动套利持久状态超过安全硬上限；已保持 fail-closed。",
        );
      }
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<AutomationState>;
      if (parsed.version !== 1) return emptyState();
      const normalized = {
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
      const compacted = compactState(normalized, this.governanceConfig, this.clock());
      if (JSON.stringify(compacted) !== JSON.stringify(normalized)) {
        await this.writeState(compacted);
      }
      return compacted;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      if (error instanceof RwaAutomationGovernanceError) throw error;
      throw new Error("RWA 自动执行状态文件不可读；已 fail-closed。");
    }
  }

  async writeState(state: AutomationState) {
    const compacted = compactState(state, this.governanceConfig, this.clock());
    const completed = compacted.executions.filter(isCompletedExecution).length;
    const active = compacted.executions.length - completed;
    const encodedBytes = Buffer.byteLength(JSON.stringify(compacted), "utf8");
    if (
      completed > this.governanceConfig.stateMaxCompletedExecutionsHard
      || active > this.governanceConfig.stateMaxActiveExecutions
      || encodedBytes > this.governanceConfig.stateMaxBytesHard
    ) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "自动套利持久状态超过安全硬上限；已保持 fail-closed。",
      );
    }
    await atomicWriteJson(this.statePath, compacted);
  }

  private credentialContext(accountId: string): CredentialKeyContext {
    return {
      userId: this.ownerUserId,
      venue: this.venue,
      accountId,
      environment: credentialEnvironment(),
      schemaVersion: RWA_CREDENTIAL_ENVELOPE_VERSION,
    };
  }

  private async readRawCredentialEnvelope(): Promise<CredentialEnvelope<TPermissions> | LegacyCredentialEnvelope<TPermissions> | null> {
    try {
      const parsed = JSON.parse(await readFile(this.credentialPath, "utf8")) as CredentialEnvelope<TPermissions> | LegacyCredentialEnvelope<TPermissions>;
      if (parsed.version === 1 && validLegacyEnvelope(parsed)) return parsed;
      if (
        parsed.version !== RWA_CREDENTIAL_ENVELOPE_VERSION || parsed.algorithm !== "AES-256-GCM" ||
        !parsed.provider || !parsed.keyName || !parsed.wrapReference || !parsed.wrappedDek ||
        !parsed.wrapBindingTag || !parsed.nonce || !parsed.tag || !parsed.ciphertext ||
        parsed.aadSchema !== RWA_CREDENTIAL_AAD_SCHEMA ||
        !parsed.maskedApiKey || !parsed.accountId || !parsed.accountFingerprint || !parsed.accountMode ||
        !parsed.permissions || !Number.isFinite(parsed.createdAt) || !Number.isFinite(parsed.updatedAt)
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

function compactState(
  state: AutomationState,
  config: RwaAutomationGovernanceConfig,
  now: number,
): AutomationState {
  const retainedExecutions = state.executions.filter((execution) =>
    !isCompletedExecution(execution)
    || execution.updatedAt + config.stateCompletedExecutionRetentionMs > now);
  return {
    ...state,
    challenges: state.challenges
      .filter((challenge) => challenge.consumedAt === null && challenge.expiresAt > now)
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .slice(-config.maxChallengesPerUser),
    executions: retainedExecutions.sort((left, right) =>
      left.createdAt - right.createdAt || left.executionId.localeCompare(right.executionId)),
    pnlSeries: state.pnlSeries
      .sort((left, right) => left.capturedAt - right.capturedAt)
      .slice(-config.stateMaxPnlPoints),
    credentialAudit: state.credentialAudit
      .sort((left, right) => left.occurredAt - right.occurredAt)
      .slice(-config.stateMaxCredentialAuditEntries),
  };
}

function isCompletedExecution(execution: RwaExecutionRecord) {
  return execution.state === "closed" || execution.state === "failed";
}

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

function validLegacyEnvelope<TPermissions extends RwaVenuePermissions>(
  value: LegacyCredentialEnvelope<TPermissions>,
) {
  return Boolean(
    value.nonce && value.tag && value.ciphertext && value.maskedApiKey && value.accountId &&
    value.accountFingerprint && value.accountMode && value.permissions && Number.isFinite(value.updatedAt),
  );
}

function wrappedDataKey<TPermissions extends RwaVenuePermissions>(envelope: CredentialEnvelope<TPermissions>) {
  return {
    provider: envelope.provider,
    keyName: envelope.keyName,
    wrapReference: envelope.wrapReference,
    wrappedDek: envelope.wrappedDek,
  } satisfies WrappedCredentialDataKey;
}

function createWrapBindingTag<TPermissions extends RwaVenuePermissions>(
  dataKey: Buffer,
  envelope: CredentialEnvelope<TPermissions>,
) {
  return createHmac("sha256", dataKey).update(wrapBindingPayload(envelope)).digest("base64url");
}

function assertWrapBinding<TPermissions extends RwaVenuePermissions>(
  dataKey: Buffer,
  envelope: CredentialEnvelope<TPermissions>,
) {
  const expected = Buffer.from(createWrapBindingTag(dataKey, envelope), "base64url");
  const actual = Buffer.from(envelope.wrapBindingTag, "base64url");
  try {
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new CredentialStoreError(
        "credential_key_identity_mismatch",
        "凭证数据密钥版本绑定无效；已拒绝解密。",
      );
    }
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}

function wrapBindingPayload<TPermissions extends RwaVenuePermissions>(
  envelope: CredentialEnvelope<TPermissions>,
) {
  return Buffer.from(JSON.stringify({
    version: envelope.version,
    algorithm: envelope.algorithm,
    provider: envelope.provider,
    keyName: envelope.keyName,
    wrapReference: envelope.wrapReference,
    wrappedDek: envelope.wrappedDek,
    aadSchema: envelope.aadSchema,
    accountId: envelope.accountId,
  }), "utf8");
}

function asCredentialStoreError(error: unknown): never {
  if (error instanceof CredentialStoreError) throw error;
  if (error instanceof CredentialKeyProviderError) throw new CredentialStoreError(error.category, error.message);
  throw new CredentialStoreError("credential_key_provider_unavailable", "凭证密钥 provider 不可用；已拒绝凭证操作。");
}

function maskApiKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function validCredentialLifecycle(value: unknown): value is RwaCredentialLifecycle {
  return ["unconfigured", "validating", "active", "invalid", "expired", "revoked", "rotation_required"].includes(String(value));
}
