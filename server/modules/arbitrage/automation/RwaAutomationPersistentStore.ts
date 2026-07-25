import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  RwaBybitCredentials,
  RwaBybitPermissions,
  RwaCredentialLifecycle,
  RwaExecutionConfig,
  RwaExecutionRecord,
  RwaExecutionFinalizeIdempotency,
  RwaExecutionReconciliationPreview,
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
import { normalizeActivityContinuity } from "./RwaProviderActivityContinuity";
import {
  getRwaAutomationAssetProfile,
  requireRwaAutomationExecutionProfile,
  rwaAutomationProfileId,
  type RwaAutomationCapitalExposure,
} from "./RwaAutomationAssetProfile";
import {
  RWA_MAX_ASSET_AUTHORIZATIONS_PER_STATE,
  validateAccountAssetAuthorization,
  type RwaAccountAssetAuthorization,
} from "./RwaAccountAssetAuthorization";
import {
  RWA_MAX_ASSET_TAKEOVERS_PER_STATE,
  validateRwaAssetTakeoverRecord,
  type RwaAssetTakeoverRecord,
} from "./RwaAssetTakeover";

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

export type RwaCredentialMutationSnapshot = {
  credentialFile: string | null;
  stateFile: string | null;
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
  assetAuthorizations: RwaAccountAssetAuthorization[];
  assetTakeovers: RwaAssetTakeoverRecord[];
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
  assetAuthorizations: [],
  assetTakeovers: [],
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
    this.userDomain = rwaAutomationUserDomain(this.ownerUserId);
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

  async captureCredentialMutationSnapshot(): Promise<RwaCredentialMutationSnapshot> {
    const [credentialFile, stateFile] = await Promise.all([
      readOptionalUtf8(this.credentialPath),
      readOptionalUtf8(this.statePath),
    ]);
    return { credentialFile, stateFile };
  }

  async restoreCredentialMutationSnapshot(snapshot: RwaCredentialMutationSnapshot) {
    await Promise.all([
      restoreOptionalUtf8(this.credentialPath, snapshot.credentialFile),
      restoreOptionalUtf8(this.statePath, snapshot.stateFile),
    ]);
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
        assetAuthorizations: Array.isArray(parsed.assetAuthorizations)
          ? parsed.assetAuthorizations.map((authorization) =>
            validateAccountAssetAuthorizationForStore(authorization, this.userDomain, this.venue))
          : parsed.assetAuthorizations === undefined
            ? []
            : (() => { throw invalidRiskState(); })(),
        assetTakeovers: Array.isArray(parsed.assetTakeovers)
          ? parsed.assetTakeovers.map((takeover) =>
            validateAssetTakeoverForStore(takeover, this.ownerUserId, this.userDomain, this.venue))
          : parsed.assetTakeovers === undefined
            ? []
            : (() => { throw invalidRiskState(); })(),
        challenges: Array.isArray(parsed.challenges) ? parsed.challenges : [],
        executions: Array.isArray(parsed.executions)
          ? parsed.executions.map((execution) => normalizeExecutionRecord(execution, this.venue))
          : [],
        pnlSeries: Array.isArray(parsed.pnlSeries) ? parsed.pnlSeries : [],
        credentialLifecycle: validCredentialLifecycle(parsed.credentialLifecycle) ? parsed.credentialLifecycle : "unconfigured",
        credentialAlert: typeof parsed.credentialAlert === "string" ? parsed.credentialAlert : null,
        credentialAudit: Array.isArray(parsed.credentialAudit) ? parsed.credentialAudit : [],
      } as AutomationState;
      assertTakeoverCollection(normalized.assetTakeovers, normalized.assetAuthorizations);
      const compacted = compactState(normalized, this.governanceConfig, this.clock());
      const rawComparable = JSON.stringify(parsed);
      const normalizedComparable = JSON.stringify(normalized);
      const compactedComparable = JSON.stringify(compacted);
      if (compactedComparable !== normalizedComparable || normalizedComparable !== rawComparable) {
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
    if (state.assetAuthorizations.length > RWA_MAX_ASSET_AUTHORIZATIONS_PER_STATE) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "账户资产授权状态超过安全容量上限；已拒绝继续。",
      );
    }
    if (state.assetTakeovers.length > RWA_MAX_ASSET_TAKEOVERS_PER_STATE) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_capacity_exceeded",
        "资产接管状态超过安全容量上限；已拒绝继续。",
      );
    }
    for (const authorization of state.assetAuthorizations) {
      validateAccountAssetAuthorizationForStore(authorization, this.userDomain, this.venue);
    }
    for (const takeover of state.assetTakeovers) {
      validateAssetTakeoverForStore(takeover, this.ownerUserId, this.userDomain, this.venue);
    }
    assertTakeoverCollection(state.assetTakeovers, state.assetAuthorizations);
    for (const execution of state.executions) {
      assertProfiledExecutionFields(execution, this.venue);
    }
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

export async function discoverAutomationUsersWithExposure() {
  const dataDir = resolveRwaAutomationActiveDataDir();
  const entries = await readdir(dataDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const users = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{16}-(?:bybit|binance)-state\.json$/.test(entry.name)) continue;
    const path = resolve(dataDir, entry.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 10 * 1024 * 1024) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const executions = (parsed as { executions?: unknown }).executions;
    const assetTakeovers = (parsed as { assetTakeovers?: unknown }).assetTakeovers;
    if (!Array.isArray(executions)) continue;
    for (const value of executions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const execution = value as Record<string, any>;
      const position = execution.strategyPosition as Record<string, any> | undefined;
      const hasExposure = Number(position?.spotRemainingXaut) > 1e-12
        || Number(position?.perpetualRemainingXaut) > 1e-12;
      if (hasExposure && typeof execution.userId === "string" && execution.userId.trim()) {
        const expectedDomain = createHash("sha256")
          .update(`rwa-user:${execution.userId}`)
          .digest("hex")
          .slice(0, 16);
        if (!entry.name.startsWith(`${expectedDomain}-`)) continue;
        users.add(execution.userId);
      }
    }
    if (assetTakeovers !== undefined && !Array.isArray(assetTakeovers)) continue;
    for (const value of assetTakeovers ?? []) {
      try {
        const takeover = validateRwaAssetTakeoverRecord(value);
        const hasExposure = takeover.state !== "failed"
          && (takeover.finalSpotQuantity > 1e-12 || takeover.finalPerpetualQuantity > 1e-12);
        if (hasExposure && takeover.userDomain === entry.name.slice(0, 16)) users.add(takeover.userId);
      } catch {
        continue;
      }
    }
  }
  return [...users].sort();
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
    assetTakeovers: state.assetTakeovers
      .filter((takeover) =>
        takeover.state !== "failed"
        || takeover.updatedAt + config.stateCompletedExecutionRetentionMs > now)
      .sort((left, right) =>
        left.createdAt - right.createdAt || left.takeoverId.localeCompare(right.takeoverId)),
    pnlSeries: state.pnlSeries
      .sort((left, right) => left.capturedAt - right.capturedAt)
      .slice(-config.stateMaxPnlPoints),
    credentialAudit: state.credentialAudit
      .sort((left, right) => left.occurredAt - right.occurredAt)
      .slice(-config.stateMaxCredentialAuditEntries),
  };
}

function isCompletedExecution(execution: RwaExecutionRecord) {
  return execution.state === "closed" || execution.state === "reconciled" || execution.state === "failed";
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

async function readOptionalUtf8(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function restoreOptionalUtf8(path: string, value: string | null) {
  if (value === null) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
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

function normalizeExecutionRecord(
  value: unknown,
  venue: "bybit" | "bitget" | "binance" | "okx",
): RwaExecutionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRiskState();
  const execution = { ...(value as Record<string, unknown>) };
  const rawSpotOrder = execution.spotOrder;
  const strategyPosition = normalizeStrategyPosition(execution.strategyPosition, execution.state, execution.updatedAt);
  const profileFieldCount = ["asset", "profileId", "reservedCapitalUsd"]
    .filter((field) => Object.prototype.hasOwnProperty.call(execution, field)).length;
  if (profileFieldCount !== 0 && profileFieldCount !== 3) throw invalidRiskState();
  const profiled = profileFieldCount === 0
    ? legacyExecutionProfile(venue)
    : assertProfiledExecutionFields(execution, venue);
  return {
    userId: String(execution.userId ?? ""),
    accountId: String(execution.accountId ?? ""),
    asset: profiled.asset,
    profileId: profiled.profileId,
    reservedCapitalUsd: profiled.reservedCapitalUsd,
    executionId: String(execution.executionId ?? ""),
    idempotencyKey: String(execution.idempotencyKey ?? ""),
    challengeId: String(execution.challengeId ?? ""),
    state: String(execution.state ?? "failed") as RwaExecutionRecord["state"],
    orderLinkPrefix: String(execution.orderLinkPrefix ?? ""),
    spotOrder: rawSpotOrder && typeof rawSpotOrder === "object" && !Array.isArray(rawSpotOrder)
      ? rawSpotOrder as RwaExecutionRecord["spotOrder"]
      : null,
    perpetualOrders: Array.isArray(execution.perpetualOrders) ? execution.perpetualOrders as RwaExecutionRecord["perpetualOrders"] : [],
    compensationOrders: Array.isArray(execution.compensationOrders) ? execution.compensationOrders as RwaExecutionRecord["compensationOrders"] : [],
    hedgedQuantityXaut: typeof execution.hedgedQuantityXaut === "number" ? execution.hedgedQuantityXaut : Number(execution.hedgedQuantityXaut ?? 0),
    unhedgedDurationMs: execution.unhedgedDurationMs === null || execution.unhedgedDurationMs === undefined
      ? null
      : Number(execution.unhedgedDurationMs),
    errorCategory: typeof execution.errorCategory === "string" ? execution.errorCategory : null,
    message: typeof execution.message === "string" ? execution.message : "",
    reconciliation: normalizeReconciliationPreview(execution.reconciliation),
    finalizeIdempotency: normalizeFinalizeIdempotency(execution.finalizeIdempotency),
    strategyPosition,
    activityContinuity: normalizeActivityContinuity(execution.activityContinuity, Number(execution.createdAt ?? 0)),
    createdAt: typeof execution.createdAt === "number" ? execution.createdAt : Number(execution.createdAt ?? 0),
    updatedAt: typeof execution.updatedAt === "number" ? execution.updatedAt : Number(execution.updatedAt ?? 0),
  };
}

export function automationCapitalExposuresFromExecutions(
  executions: readonly RwaExecutionRecord[],
): RwaAutomationCapitalExposure[] {
  return executions.flatMap((execution) => {
    assertProfiledExecutionFields(execution);
    const positionCapital = executionPositionCapitalUsd(execution);
    const hasLiveState = !["closed", "reconciled", "failed"].includes(execution.state)
      || positionCapital > 0;
    const capitalUsd = Math.max(positionCapital, hasLiveState ? execution.reservedCapitalUsd : 0);
    if (!(capitalUsd > 0)) return [];
    const assetId = execution.asset.toLowerCase();
    const asset = getRwaAutomationAssetProfile(assetId);
    const validProfileIds = asset?.venues.map((venue) =>
      rwaAutomationProfileId({ asset, venue })) ?? [];
    if (!asset || !validProfileIds.includes(execution.profileId)) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_risk_state_invalid",
        "自动套利持久状态包含未知或错配的资产 profile；已拒绝新增风险。",
      );
    }
    return [{
      executionId: execution.executionId,
      userId: execution.userId,
      accountId: execution.accountId,
      assetId: assetId as RwaAutomationCapitalExposure["assetId"],
      profileId: execution.profileId,
      capitalUsd,
    }];
  });
}

export function automationCapitalExposuresFromTakeovers(
  takeovers: readonly RwaAssetTakeoverRecord[],
): RwaAutomationCapitalExposure[] {
  return takeovers.flatMap((value) => {
    const takeover = validateRwaAssetTakeoverRecord(value);
    if (takeover.state === "failed" || !(takeover.reservedCapitalUsd > 0)) return [];
    return [{
      executionId: `takeover:${takeover.takeoverId}`,
      userId: takeover.userId,
      accountId: takeover.accountId,
      assetId: takeover.assetId,
      profileId: takeover.profileId,
      capitalUsd: takeover.reservedCapitalUsd,
    }];
  });
}

function legacyExecutionProfile(
  venue: "bybit" | "bitget" | "binance" | "okx",
): Pick<RwaExecutionRecord, "asset" | "profileId" | "reservedCapitalUsd"> {
  const profileId = venue === "bybit" || venue === "binance"
    ? rwaAutomationProfileId(requireRwaAutomationExecutionProfile("xaut", venue))
    : "legacy:XAUT";
  return { asset: "XAUT", profileId, reservedCapitalUsd: 0 };
}

function assertProfiledExecutionFields(
  execution: Record<string, unknown> | RwaExecutionRecord,
  venue?: "bybit" | "bitget" | "binance" | "okx",
): Pick<RwaExecutionRecord, "asset" | "profileId" | "reservedCapitalUsd"> {
  const asset = typeof execution.asset === "string"
    ? getRwaAutomationAssetProfile(execution.asset.toLowerCase())
    : null;
  const venueProfiles = asset?.executionStatus === "enabled"
    ? asset.venues.filter((profile) => venue === undefined || profile.venue === venue)
    : [];
  const validProfileIds = venueProfiles.map((profile) => rwaAutomationProfileId({ asset: asset!, venue: profile }));
  if (
    !asset
    || execution.asset !== asset.baseAsset
    || validProfileIds.length === 0
    || typeof execution.profileId !== "string"
    || !validProfileIds.includes(execution.profileId)
    || typeof execution.reservedCapitalUsd !== "number"
    || !Number.isFinite(execution.reservedCapitalUsd)
    || execution.reservedCapitalUsd < 0
  ) throw invalidRiskState();
  return {
    asset: asset.baseAsset,
    profileId: execution.profileId,
    reservedCapitalUsd: execution.reservedCapitalUsd,
  };
}

function invalidRiskState() {
  return new RwaAutomationGovernanceError(
    503,
    "automation_risk_state_invalid",
    "自动套利持久风险状态的资产 profile 字段无效；已拒绝新增风险。",
  );
}

export function rwaAutomationUserDomain(userId: string) {
  return createHash("sha256").update(`rwa-user:${userId}`).digest("hex").slice(0, 16);
}

function validateAccountAssetAuthorizationForStore(
  value: unknown,
  userDomain: string,
  venue: "bybit" | "bitget" | "binance" | "okx",
) {
  const authorization = validateAccountAssetAuthorization(value);
  if (authorization.userDomain !== userDomain || authorization.venue !== venue) throw invalidRiskState();
  return authorization;
}

function validateAssetTakeoverForStore(
  value: unknown,
  userId: string,
  userDomain: string,
  venue: "bybit" | "bitget" | "binance" | "okx",
) {
  const takeover = validateRwaAssetTakeoverRecord(value);
  if (
    takeover.userId !== userId
    || takeover.userDomain !== userDomain
    || takeover.venue !== venue
  ) throw invalidRiskState();
  return takeover;
}

function assertTakeoverCollection(
  takeovers: readonly RwaAssetTakeoverRecord[],
  authorizations: readonly RwaAccountAssetAuthorization[],
) {
  for (const key of ["takeoverId", "idempotencyKey", "orderLinkPrefix"] as const) {
    if (new Set(takeovers.map((item) => item[key])).size !== takeovers.length) {
      throw invalidRiskState();
    }
  }
  for (const takeover of takeovers) {
    const matches = authorizations.filter((authorization) =>
      authorization.authorizationId === takeover.authorizationId
      && authorization.createdAt === takeover.authorizationCreatedAt
      && authorization.accountId === takeover.accountId
      && authorization.accountFingerprint === takeover.accountFingerprint
      && authorization.assetId === takeover.assetId
      && authorization.profileId === takeover.profileId
      && authorization.policyVersion === takeover.policyVersion
      && authorization.policyDigest === takeover.policyDigest);
    if (matches.length !== 1) throw invalidRiskState();
  }
  const capitalHoldingAuthorizations = takeovers
    .filter((takeover) => takeover.state !== "failed")
    .map((takeover) => `${takeover.authorizationId}\0${takeover.authorizationCreatedAt}`);
  if (new Set(capitalHoldingAuthorizations).size !== capitalHoldingAuthorizations.length) {
    throw invalidRiskState();
  }
}

export async function readRwaAutomationCapitalExposures() {
  const dataDir = resolveRwaAutomationActiveDataDir();
  const entries = await readdir(dataDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const exposures: RwaAutomationCapitalExposure[] = [];
  for (const entry of entries) {
    const match = /^([a-f0-9]{16})-(bybit|binance)-state\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const path = resolve(dataDir, entry.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size > 10 * 1024 * 1024) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_risk_state_invalid",
        "自动套利风险状态文件边界无效；已拒绝新增风险。",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_risk_state_invalid",
        "自动套利风险状态不可读；已拒绝新增风险。",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !Array.isArray((parsed as { executions?: unknown }).executions)
      || !(
        (parsed as { assetTakeovers?: unknown }).assetTakeovers === undefined
        || Array.isArray((parsed as { assetTakeovers?: unknown }).assetTakeovers)
      )) {
      throw new RwaAutomationGovernanceError(
        503,
        "automation_risk_state_invalid",
        "自动套利风险状态结构无效；已拒绝新增风险。",
      );
    }
    const venue = match[2] as "bybit" | "binance";
    const normalized = (parsed as { executions: unknown[] }).executions
      .map((execution) => normalizeExecutionRecord(execution, venue));
    const takeovers = ((parsed as { assetTakeovers?: unknown[] }).assetTakeovers ?? [])
      .map((takeover) => validateRwaAssetTakeoverRecord(takeover));
    const expectedProfileId = rwaAutomationProfileId(requireRwaAutomationExecutionProfile("xaut", venue));
    for (const execution of normalized) {
      const expectedDomain = createHash("sha256")
        .update(`rwa-user:${execution.userId}`)
        .digest("hex")
        .slice(0, 16);
      if (
        expectedDomain !== match[1]
        || execution.asset !== "XAUT"
        || execution.profileId !== expectedProfileId
      ) {
        throw new RwaAutomationGovernanceError(
          503,
          "automation_risk_state_invalid",
          "自动套利风险状态的用户、venue 或资产 profile 绑定无效；已拒绝新增风险。",
        );
      }
    }
    for (const takeover of takeovers) {
      if (
        takeover.userDomain !== match[1]
        || takeover.venue !== venue
        || takeover.assetId !== "xaut"
        || takeover.profileId !== expectedProfileId
      ) {
        throw new RwaAutomationGovernanceError(
          503,
          "automation_risk_state_invalid",
          "自动套利接管状态的用户、venue 或资产 profile 绑定无效；已拒绝新增风险。",
        );
      }
    }
    exposures.push(...automationCapitalExposuresFromExecutions(normalized));
    exposures.push(...automationCapitalExposuresFromTakeovers(takeovers));
  }
  return exposures;
}

function executionPositionCapitalUsd(execution: RwaExecutionRecord) {
  const spotQuantity = execution.strategyPosition.spotRemainingXaut;
  const perpetualQuantity = execution.strategyPosition.perpetualRemainingXaut;
  if (!(spotQuantity > 0 || perpetualQuantity > 0)) return 0;
  const spotPrice = execution.spotOrder?.averagePrice ?? 0;
  const perpetualPrice = Number([...execution.perpetualOrders].reverse()
    .find((order) => Number(order.averagePrice) > 0)?.averagePrice ?? 0);
  if ((spotQuantity > 0 && !(spotPrice > 0)) || (perpetualQuantity > 0 && !(perpetualPrice > 0))) {
    throw new RwaAutomationGovernanceError(
      503,
      "automation_risk_state_invalid",
      "自动套利持仓缺少可验证价格；已拒绝新增风险。",
    );
  }
  return spotQuantity * spotPrice + perpetualQuantity * perpetualPrice;
}

function normalizeStrategyPosition(
  value: unknown,
  executionState: unknown,
  fallbackUpdatedAt: unknown,
): RwaExecutionRecord["strategyPosition"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const position = value as Record<string, unknown>;
    const coverage = position.coverage === "complete" ? "complete" : "ambiguous";
    const spotRemainingXaut = Number(position.spotRemainingXaut);
    const perpetualRemainingXaut = Number(position.perpetualRemainingXaut);
    const updatedAt = Number(position.updatedAt);
    if (
      Number.isFinite(spotRemainingXaut) && spotRemainingXaut >= 0
      && Number.isFinite(perpetualRemainingXaut) && perpetualRemainingXaut >= 0
      && Number.isFinite(updatedAt) && updatedAt >= 0
    ) {
      return { coverage, spotRemainingXaut, perpetualRemainingXaut, updatedAt };
    }
  }
  const completed = executionState === "closed" || executionState === "reconciled";
  return {
    coverage: completed ? "complete" : "ambiguous",
    spotRemainingXaut: 0,
    perpetualRemainingXaut: 0,
    updatedAt: Number.isFinite(Number(fallbackUpdatedAt)) ? Number(fallbackUpdatedAt) : 0,
  };
}

function normalizeReconciliationPreview(value: unknown): RwaExecutionReconciliationPreview | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RwaExecutionReconciliationPreview
    : null;
}

function normalizeFinalizeIdempotency(value: unknown): RwaExecutionFinalizeIdempotency | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RwaExecutionFinalizeIdempotency
    : null;
}
