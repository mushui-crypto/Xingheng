import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { basename, dirname, resolve } from "node:path";
import {
  RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
  RWA_CREDENTIAL_AAD_SCHEMA,
  RWA_CREDENTIAL_ENVELOPE_VERSION,
  STEP_UP_SECURITY_AAD_SCHEMA,
  canonicalCredentialAad,
  credentialEnvironment,
  type AutomationBackupKeyContext,
  type CredentialEnvironment,
  type CredentialKeyProvider,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";
import {
  RWA_AUTOMATION_CURRENT_POINTER,
  RWA_AUTOMATION_ROLLBACK_POINTER,
  assertContained,
  assertSecureDirectory,
  assertSecureFile,
  createGenerationName,
  ensureSecureDirectory,
  expectedRwaAutomationOwner,
  readGenerationPointer,
  readGenerationState,
  validateRwaAutomationDataLayout,
  writeGenerationState,
  type RwaAutomationDataLayoutOptions,
} from "./RwaAutomationDataLayout";

export const RWA_AUTOMATION_BACKUP_ROOT = "/app/rwa-automation-backups";
export const RWA_AUTOMATION_BACKUP_SCHEMA_VERSION = 1 as const;
export const RWA_AUTOMATION_BACKUP_DOMAIN = "rwa-automation-disaster-recovery" as const;

const backupFilePattern = /^rwa-automation-([0-9]{8}T[0-9]{6}Z)\.rwa\.enc\.json$/;
const rootStatePattern = /^[a-f0-9]{16}-(bybit|bitget|binance|okx)-(credentials\.enc|state)\.json$/;
const stepUpStatePattern = /^[A-Za-z0-9_-]{24}\.enc\.json$/;
const maxManifestFiles = 100_000;

type BackupManifestFile = {
  path: string;
  size: number;
  sha256: string;
  mode: 384;
};

type BackupManifest = {
  schemaVersion: typeof RWA_AUTOMATION_BACKUP_SCHEMA_VERSION;
  backupId: string;
  createdAt: number;
  environment: CredentialEnvironment;
  files: BackupManifestFile[];
  totalBytes: number;
};

type BackupPlaintext = {
  manifest: BackupManifest;
  files: Array<{ path: string; data: string }>;
};

type BackupEnvelope = WrappedCredentialDataKey & {
  version: typeof RWA_AUTOMATION_BACKUP_SCHEMA_VERSION;
  algorithm: "AES-256-GCM";
  purpose: "automation-backup";
  backupDomain: typeof RWA_AUTOMATION_BACKUP_DOMAIN;
  aadSchema: typeof RWA_AUTOMATION_BACKUP_AAD_SCHEMA;
  backupId: string;
  environment: CredentialEnvironment;
  createdAt: number;
  wrapBindingTag: string;
  ciphertext: string;
  nonce: string;
  tag: string;
};

export type RwaAutomationBackupLimits = {
  retentionDays: number;
  maxTotalBytes: number;
  maxSnapshotBytes: number;
};

export type RwaAutomationBackupServiceOptions = RwaAutomationDataLayoutOptions & {
  dataRoot?: string;
  backupRoot?: string;
  limits?: Partial<RwaAutomationBackupLimits>;
  now?: () => Date;
  faultHook?: (point: "after_snapshot" | "before_backup_publish" | "before_pointer_swap" | "after_pointer_swap") => void;
};

export class RwaAutomationBackupError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class RwaAutomationBackupService {
  private readonly dataRoot: string;
  private readonly backupRoot: string;
  private readonly layoutOptions: RwaAutomationDataLayoutOptions;
  private readonly limits: RwaAutomationBackupLimits;
  private readonly now: () => Date;
  private readonly faultHook?: RwaAutomationBackupServiceOptions["faultHook"];

  constructor(
    private readonly keyProvider: CredentialKeyProvider,
    options: RwaAutomationBackupServiceOptions = {},
  ) {
    this.dataRoot = resolve(options.dataRoot ?? process.env.RWA_AUTOMATION_DATA_DIR ?? "server/data/rwa-automation");
    this.backupRoot = resolve(options.backupRoot ?? process.env.RWA_AUTOMATION_BACKUP_DIR ?? "server/data/rwa-automation-backups");
    this.layoutOptions = {
      root: this.dataRoot,
      expectedUid: options.expectedUid,
      expectedGid: options.expectedGid,
      production: options.production,
    };
    this.limits = {
      ...loadRwaAutomationBackupLimits(),
      ...options.limits,
    };
    assertValidLimits(this.limits);
    this.now = options.now ?? (() => new Date());
    this.faultHook = options.faultHook;
  }

  async createBackup() {
    try {
      return await this.createBackupUnsafe();
    } catch (error) {
      throw asBackupError(error);
    }
  }

  private async createBackupUnsafe() {
    const { active } = validateRwaAutomationDataLayout(this.layoutOptions);
    await this.assertBackupRoot();
    const createdAt = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
    const backupId = backupIdFromDate(createdAt);
    const fileName = backupFileName(backupId);
    const destination = resolve(this.backupRoot, fileName);
    assertContained(this.backupRoot, destination);
    if (await fileExists(destination)) {
      throw new RwaAutomationBackupError("backup_already_exists", "同一 UTC 秒的自动套利备份已存在。");
    }
    const plaintextSnapshot = await this.captureSnapshot(active, backupId, createdAt.getTime());
    this.faultHook?.("after_snapshot");
    const plaintext = Buffer.from(JSON.stringify(plaintextSnapshot), "utf8");
    if (plaintext.length > this.limits.maxSnapshotBytes) {
      plaintext.fill(0);
      throw new RwaAutomationBackupError("backup_capacity_exceeded", "自动套利备份超过单快照容量上限。");
    }
    const context = backupContext(backupId);
    await this.assertKeyProviderHealthy(context);
    const dataKey = await this.keyProvider.createDataKey(context).catch(throwBackupError);
    const nonce = randomBytes(12);
    let ciphertext: Buffer | null = null;
    let published = false;
    try {
      const cipher = createCipheriv("aes-256-gcm", dataKey.plaintextDek, nonce);
      cipher.setAAD(canonicalCredentialAad(context));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: BackupEnvelope = {
        version: RWA_AUTOMATION_BACKUP_SCHEMA_VERSION,
        algorithm: "AES-256-GCM",
        purpose: "automation-backup",
        backupDomain: RWA_AUTOMATION_BACKUP_DOMAIN,
        aadSchema: RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
        backupId,
        environment: credentialEnvironment(),
        createdAt: createdAt.getTime(),
        provider: dataKey.provider,
        keyName: dataKey.keyName,
        wrapReference: dataKey.wrapReference,
        wrappedDek: dataKey.wrappedDek,
        wrapBindingTag: "",
        ciphertext: ciphertext.toString("base64url"),
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      };
      envelope.wrapBindingTag = backupWrapBindingTag(dataKey.plaintextDek, envelope);
      this.faultHook?.("before_backup_publish");
      await atomicWriteFile(destination, Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"), this.layoutOptions);
      published = true;
      await this.pruneBackups(fileName);
      return {
        fileName,
        backupId,
        createdAt: createdAt.getTime(),
        fileCount: plaintextSnapshot.manifest.files.length,
        plaintextBytes: plaintextSnapshot.manifest.totalBytes,
      };
    } catch (error) {
      if (published) {
        await unlink(destination).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
      }
      throw asBackupError(error);
    } finally {
      plaintext.fill(0);
      ciphertext?.fill(0);
      dataKey.plaintextDek.fill(0);
    }
  }

  async restoreBackup(fileName: string) {
    try {
      return await this.restoreBackupUnsafe(fileName);
    } catch (error) {
      throw safeRestoreError(error);
    }
  }

  private async restoreBackupUnsafe(fileName: string) {
    const match = assertBackupFileName(fileName);
    const { active } = validateRwaAutomationDataLayout(this.layoutOptions);
    const backupStorageBytes = await this.assertBackupRoot();
    if (backupStorageBytes > this.limits.maxTotalBytes) throw capacityExceeded();
    const source = resolve(this.backupRoot, fileName);
    assertContained(this.backupRoot, source);
    const encoded = await readBoundedSecureFile(
      source,
      maxEncryptedBackupBytes(this.limits.maxSnapshotBytes),
      this.layoutOptions,
    );
    let envelope: BackupEnvelope;
    try {
      envelope = validateEnvelope(JSON.parse(encoded.toString("utf8")), match[1]!);
    } finally {
      encoded.fill(0);
    }
    const context = backupContext(envelope.backupId);
    await this.assertKeyProviderHealthy(context);
    const dataKey = await this.keyProvider.unwrapDataKey(envelope, context).catch(throwBackupError);
    let plaintext: Buffer | null = null;
    let generationPath: string | null = null;
    let pointerSwapped = false;
    const previousGeneration = basename(active);
    const previousRollbackGeneration = readGenerationState(this.dataRoot, this.layoutOptions).rollbackGeneration;
    try {
      assertBackupWrapBinding(dataKey, envelope);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(canonicalCredentialAad(context));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      if (plaintext.length > this.limits.maxSnapshotBytes) {
        throw new RwaAutomationBackupError("backup_capacity_exceeded", "自动套利备份超过单快照容量上限。");
      }
      const snapshot = validatePlaintext(JSON.parse(plaintext.toString("utf8")), envelope);
      const generation = createGenerationName(this.now());
      generationPath = resolve(this.dataRoot, generation);
      assertContained(this.dataRoot, generationPath);
      ensureSecureDirectory(generationPath, this.layoutOptions);
      await this.writeSnapshot(generationPath, snapshot);
      await this.validateSnapshotTree(generationPath, snapshot.manifest);
      this.faultHook?.("before_pointer_swap");
      writeGenerationState(
        this.dataRoot,
        generation,
        previousGeneration,
        this.layoutOptions,
      );
      pointerSwapped = true;
      this.faultHook?.("after_pointer_swap");
      return {
        fileName,
        backupId: envelope.backupId,
        restoredGeneration: generation,
        rollbackGeneration: previousGeneration,
        fileCount: snapshot.manifest.files.length,
      };
    } catch (error) {
      if (pointerSwapped) {
        writeGenerationState(
          this.dataRoot,
          previousGeneration,
          previousRollbackGeneration,
          this.layoutOptions,
        );
      }
      if (generationPath) await rm(generationPath, { recursive: true, force: true });
      throw safeRestoreError(error);
    } finally {
      plaintext?.fill(0);
      dataKey.fill(0);
    }
  }

  rollbackRestore() {
    try {
      const { active } = validateRwaAutomationDataLayout(this.layoutOptions);
      let rollback: string;
      try {
        rollback = readGenerationPointer(this.dataRoot, RWA_AUTOMATION_ROLLBACK_POINTER, this.layoutOptions);
      } catch {
        throw new RwaAutomationBackupError("rollback_unavailable", "没有可用的自动套利恢复回滚点。");
      }
      const activeGeneration = basename(active);
      const rollbackGeneration = basename(rollback);
      writeGenerationState(
        this.dataRoot,
        rollbackGeneration,
        activeGeneration,
        this.layoutOptions,
      );
      return { activeGeneration: rollbackGeneration, rollbackGeneration: activeGeneration };
    } catch (error) {
      throw safeRestoreError(error);
    }
  }

  private async captureSnapshot(active: string, backupId: string, createdAt: number): Promise<BackupPlaintext> {
    const files = await this.readAllowedFiles(active);
    const manifestFiles: BackupManifestFile[] = files.map((file) => ({
      path: file.path,
      size: file.data.length,
      sha256: sha256(file.data),
      mode: 0o600,
    }));
    return {
      manifest: {
        schemaVersion: RWA_AUTOMATION_BACKUP_SCHEMA_VERSION,
        backupId,
        createdAt,
        environment: credentialEnvironment(),
        files: manifestFiles,
        totalBytes: manifestFiles.reduce((sum, file) => sum + file.size, 0),
      },
      files: files.map((file) => ({ path: file.path, data: file.data.toString("base64url") })),
    };
  }

  private async readAllowedFiles(active: string) {
    assertSecureDirectory(active, this.layoutOptions);
    const result: Array<{ path: string; data: Buffer }> = [];
    const rootEntries = await readdir(active, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name === "step-up-security") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalidSnapshot();
        const directory = resolve(active, entry.name);
        assertSecureDirectory(directory, this.layoutOptions);
        const securityEntries = await readdir(directory, { withFileTypes: true });
        for (const securityEntry of securityEntries) {
          if (!securityEntry.isFile() || securityEntry.isSymbolicLink() || !stepUpStatePattern.test(securityEntry.name)) {
            throw invalidSnapshot();
          }
          const path = resolve(directory, securityEntry.name);
          await assertSecureRegularFile(path, this.layoutOptions);
          const data = await readFile(path);
          validateStepUpEnvelope(data);
          result.push({ path: `step-up-security/${securityEntry.name}`, data });
        }
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !rootStatePattern.test(entry.name)) throw invalidSnapshot();
      const path = resolve(active, entry.name);
      await assertSecureRegularFile(path, this.layoutOptions);
      const source = await readFile(path);
      const rootMatch = rootStatePattern.exec(entry.name);
      if (!rootMatch) throw invalidSnapshot();
      if (entry.name.endsWith("-credentials.enc.json")) {
        validateCredentialEnvelope(source, rootMatch[1] as "bybit" | "bitget" | "binance" | "okx");
      }
      result.push({
        path: entry.name,
        data: entry.name.endsWith("-state.json") ? sanitizeAutomationState(source) : source,
      });
    }
    result.sort((left, right) => left.path.localeCompare(right.path));
    if (result.length > maxManifestFiles) throw new RwaAutomationBackupError("backup_manifest_invalid", "自动套利备份文件数量超出上限。");
    return result;
  }

  private async writeSnapshot(root: string, snapshot: BackupPlaintext) {
    for (const file of snapshot.files) {
      const destination = resolve(root, file.path);
      assertContained(root, destination);
      ensureSecureDirectory(dirname(destination), this.layoutOptions);
      const data = Buffer.from(file.data, "base64url");
      try {
        await atomicWriteFile(destination, data, this.layoutOptions);
      } finally {
        data.fill(0);
      }
    }
  }

  private async validateSnapshotTree(root: string, manifest: BackupManifest) {
    const readBack = await this.readAllowedFiles(root);
    if (readBack.length !== manifest.files.length) throw invalidSnapshot();
    for (let index = 0; index < readBack.length; index += 1) {
      const actual = readBack[index]!;
      const expected = manifest.files[index]!;
      if (actual.path !== expected.path || actual.data.length !== expected.size || sha256(actual.data) !== expected.sha256) {
        throw new RwaAutomationBackupError("backup_integrity_failed", "自动套利备份文件完整性校验失败。");
      }
    }
  }

  private async assertBackupRoot() {
    ensureSecureDirectory(this.backupRoot, this.layoutOptions);
    const entries = await readdir(this.backupRoot, { withFileTypes: true });
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !backupFilePattern.test(entry.name)) {
        throw new RwaAutomationBackupError("backup_storage_invalid", "自动套利备份目录包含不受信任的条目。");
      }
      const metadata = await assertSecureRegularFile(resolve(this.backupRoot, entry.name), this.layoutOptions);
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.limits.maxTotalBytes) throw capacityExceeded();
    }
    return totalBytes;
  }

  private async pruneBackups(newestFileName: string) {
    const now = this.now().getTime();
    const entries = await readdir(this.backupRoot, { withFileTypes: true });
    const backups: Array<{ name: string; size: number; createdAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !backupFilePattern.test(entry.name)) continue;
      const path = resolve(this.backupRoot, entry.name);
      const metadata = await stat(path);
      backups.push({ name: entry.name, size: metadata.size, createdAt: backupTimeFromFileName(entry.name) });
    }
    backups.sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
    const retentionCutoff = now - this.limits.retentionDays * 86_400_000;
    for (const backup of [...backups]) {
      if (backup.name === newestFileName || backup.createdAt >= retentionCutoff) continue;
      await unlink(resolve(this.backupRoot, backup.name));
      backups.splice(backups.indexOf(backup), 1);
    }
    let total = backups.reduce((sum, item) => sum + item.size, 0);
    for (const backup of backups) {
      if (total <= this.limits.maxTotalBytes) break;
      if (backup.name === newestFileName) continue;
      await unlink(resolve(this.backupRoot, backup.name));
      total -= backup.size;
    }
    if (total > this.limits.maxTotalBytes) {
      await unlink(resolve(this.backupRoot, newestFileName)).catch(() => {});
      throw new RwaAutomationBackupError("backup_capacity_exceeded", "自动套利备份目录超过容量上限。");
    }
  }

  private async assertKeyProviderHealthy(context: AutomationBackupKeyContext) {
    if (!this.keyProvider.configured) {
      throw new RwaAutomationBackupError("backup_key_unavailable", "自动套利备份密钥服务不可用。");
    }
    const health = await this.keyProvider.healthCheck(context).catch(throwBackupError);
    if (!health.ok) throw new RwaAutomationBackupError("backup_key_unavailable", "自动套利备份密钥服务不可用。");
  }
}

export function loadRwaAutomationBackupLimits(environment: NodeJS.ProcessEnv = process.env): RwaAutomationBackupLimits {
  return {
    retentionDays: parseInteger(environment.RWA_AUTOMATION_BACKUP_RETENTION_DAYS ?? "30", 1, 365, "retention"),
    maxTotalBytes: parseInteger(
      environment.RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES ?? String(1024 * 1024 * 1024),
      1024 * 1024,
      10 * 1024 * 1024 * 1024,
      "capacity",
    ),
    maxSnapshotBytes: parseInteger(
      environment.RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES ?? String(100 * 1024 * 1024),
      1024,
      500 * 1024 * 1024,
      "snapshot capacity",
    ),
  };
}

export function assertBackupFileName(fileName: string) {
  const match = backupFilePattern.exec(fileName);
  if (!match) throw new RwaAutomationBackupError("backup_name_invalid", "自动套利恢复文件名无效。");
  return match;
}

function backupIdFromDate(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function backupFileName(backupId: string) {
  return `rwa-automation-${backupId}.rwa.enc.json`;
}

function backupTimeFromFileName(fileName: string) {
  const backupId = assertBackupFileName(fileName)[1]!;
  const timestamp = Date.parse(
    `${backupId.slice(0, 4)}-${backupId.slice(4, 6)}-${backupId.slice(6, 8)}T`
    + `${backupId.slice(9, 11)}:${backupId.slice(11, 13)}:${backupId.slice(13, 15)}Z`,
  );
  if (!Number.isFinite(timestamp)) throw new RwaAutomationBackupError("backup_name_invalid", "自动套利备份时间无效。");
  return timestamp;
}

function backupContext(backupId: string): AutomationBackupKeyContext {
  return {
    purpose: "automation-backup",
    backupId,
    backupDomain: RWA_AUTOMATION_BACKUP_DOMAIN,
    environment: credentialEnvironment(),
    schemaVersion: RWA_CREDENTIAL_ENVELOPE_VERSION,
  };
}

function sanitizeAutomationState(source: Buffer) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw invalidSnapshot();
  }
  if (
    parsed.version !== 1
    || !hasExactKeys(parsed, [
      "challenges",
      "config",
      "credentialAlert",
      "credentialAudit",
      "credentialLifecycle",
      "executions",
      "pnlSeries",
      "version",
    ])
    || !Array.isArray(parsed.executions)
    || !Array.isArray(parsed.pnlSeries)
    || !Array.isArray(parsed.credentialAudit)
  ) throw invalidSnapshot();
  validateExecutionConfig(parsed.config);
  if (!Array.isArray(parsed.challenges)) throw invalidSnapshot();
  parsed.challenges.forEach(validateStoredChallenge);
  parsed.executions.forEach(validateExecutionRecord);
  parsed.pnlSeries.forEach(validatePnlSnapshot);
  parsed.credentialAudit.forEach(validateCredentialAudit);
  if (![
    "unconfigured", "validating", "active", "invalid", "expired", "revoked", "rotation_required",
  ].includes(String(parsed.credentialLifecycle))) throw invalidSnapshot();
  if (!(parsed.credentialAlert === null || typeof parsed.credentialAlert === "string")) throw invalidSnapshot();
  const value = {
    ...parsed,
    config: {
      ...(parsed.config as Record<string, unknown>),
      globalExecutionEnabled: false,
      strategyEnabled: false,
      killSwitchActive: true,
    },
    challenges: [],
  };
  if (containsForbiddenPersistentKey(value)) throw invalidSnapshot();
  return Buffer.from(JSON.stringify(value), "utf8");
}

function validateCredentialEnvelope(
  source: Buffer,
  venue: "bybit" | "bitget" | "binance" | "okx",
) {
  const envelope = parseObject(source);
  if (
    !hasExactKeys(envelope, [
      "aadSchema", "accountFingerprint", "accountId", "accountMode", "algorithm", "ciphertext", "createdAt",
      "keyName", "lastVerifiedAt", "maskedApiKey", "nonce", "permissions", "provider", "tag", "updatedAt",
      "version", "wrapBindingTag", "wrapReference", "wrappedDek",
    ])
    || envelope.version !== RWA_CREDENTIAL_ENVELOPE_VERSION
    || envelope.algorithm !== "AES-256-GCM"
    || envelope.aadSchema !== RWA_CREDENTIAL_AAD_SCHEMA
    || !["gcp-kms", "fake"].includes(String(envelope.provider))
    || !isNonEmptyString(envelope.keyName) || !isNonEmptyString(envelope.wrapReference)
    || !isNonEmptyString(envelope.accountId) || !isNonEmptyString(envelope.accountFingerprint)
    || typeof envelope.maskedApiKey !== "string"
    || !isAccountMode(envelope.accountMode)
    || !isTimestamp(envelope.createdAt) || !isTimestamp(envelope.updatedAt) || !isTimestamp(envelope.lastVerifiedAt)
    || !validBase64url(envelope.wrappedDek) || !validBase64url(envelope.wrapBindingTag)
    || !validBase64url(envelope.ciphertext) || !validBase64url(envelope.nonce, 12)
    || !validBase64url(envelope.tag, 16)
  ) throw invalidSnapshot();
  validateVenuePermissions(envelope.permissions, venue);
}

function validateStepUpEnvelope(source: Buffer) {
  const envelope = parseObject(source);
  if (
    !hasExactKeys(envelope, [
      "aadSchema", "algorithm", "ciphertext", "createdAt", "keyName", "nonce", "provider", "purpose",
      "securityDomain", "tag", "updatedAt", "version", "wrapBindingTag", "wrapReference", "wrappedDek",
    ])
    || envelope.version !== RWA_CREDENTIAL_ENVELOPE_VERSION
    || envelope.algorithm !== "AES-256-GCM"
    || envelope.purpose !== "step-up-security"
    || envelope.securityDomain !== "rwa-sensitive-operations"
    || envelope.aadSchema !== STEP_UP_SECURITY_AAD_SCHEMA
    || !["gcp-kms", "fake"].includes(String(envelope.provider))
    || !isNonEmptyString(envelope.keyName) || !isNonEmptyString(envelope.wrapReference)
    || !isTimestamp(envelope.createdAt) || !isTimestamp(envelope.updatedAt)
    || !validBase64url(envelope.wrappedDek) || !validBase64url(envelope.wrapBindingTag)
    || !validBase64url(envelope.ciphertext) || !validBase64url(envelope.nonce, 12)
    || !validBase64url(envelope.tag, 16)
  ) throw invalidSnapshot();
}

function validateExecutionConfig(value: unknown) {
  const config = assertObject(value);
  if (!hasExactKeys(config, [
    "globalExecutionEnabled", "killSwitchActive", "maxCombinedSlippageBps", "maxEntryBasisBps",
    "maxStrategyCapitalUsd", "maxUnhedgedMs", "minLiquidationDistancePercent", "minNetAprPercent",
    "strategyEnabled",
  ])) throw invalidSnapshot();
  for (const key of ["globalExecutionEnabled", "strategyEnabled", "killSwitchActive"]) {
    if (typeof config[key] !== "boolean") throw invalidSnapshot();
  }
  for (const key of [
    "maxStrategyCapitalUsd", "maxEntryBasisBps", "maxCombinedSlippageBps", "minNetAprPercent",
    "minLiquidationDistancePercent", "maxUnhedgedMs",
  ]) {
    if (!isFiniteNumber(config[key])) throw invalidSnapshot();
  }
}

function validateStoredChallenge(value: unknown) {
  const challenge = assertObject(value);
  if (!hasExactKeys(challenge, ["consumedAt", "expiresAt", "id", "report", "tokenHash"])
    || !isNonEmptyString(challenge.id) || !isNonEmptyString(challenge.tokenHash)
    || !isTimestamp(challenge.expiresAt) || !isNullableTimestamp(challenge.consumedAt)) throw invalidSnapshot();
  validatePreflightReport(challenge.report);
}

function validatePreflightReport(value: unknown) {
  const report = assertObject(value);
  if (!hasExactKeys(report, [
    "accountFingerprint", "accountId", "action", "checks", "entryBasisBps", "estimatedCapitalRequiredUsd",
    "estimatedNetAprPercent", "estimatedPerpetualNotionalUsd", "estimatedSpotNotionalUsd", "expiresAt",
    "fundingRate", "generatedAt", "mode", "network", "opportunityId", "passed", "quantityXaut",
    "referencePerpetualBid", "referenceSpotAsk", "strategyId", "totalBudgetUsd", "userId", "venue", "warnings",
  ])) throw invalidSnapshot();
  for (const key of ["userId", "accountId", "accountFingerprint", "strategyId", "opportunityId"]) {
    if (!isNonEmptyString(report[key])) throw invalidSnapshot();
  }
  if (!["bybit_mainnet", "binance_mainnet"].includes(String(report.network))
    || !["arbitrage_entry", "manual_entry"].includes(String(report.action))
    || !["arbitrage_entry", "manual_entry"].includes(String(report.mode))
    || !["bybit", "binance"].includes(String(report.venue))
    || typeof report.passed !== "boolean"
    || !isTimestamp(report.generatedAt) || !isTimestamp(report.expiresAt)) throw invalidSnapshot();
  for (const key of [
    "quantityXaut", "totalBudgetUsd", "estimatedSpotNotionalUsd", "estimatedPerpetualNotionalUsd",
    "estimatedCapitalRequiredUsd", "referenceSpotAsk", "referencePerpetualBid", "entryBasisBps", "fundingRate",
    "estimatedNetAprPercent",
  ]) {
    if (!isFiniteNumber(report[key])) throw invalidSnapshot();
  }
  if (!Array.isArray(report.checks) || !Array.isArray(report.warnings)
    || !report.warnings.every((item) => typeof item === "string")) throw invalidSnapshot();
  report.checks.forEach((item) => {
    const check = assertObject(item);
    if (!hasExactKeys(check, ["limit", "message", "name", "passed", "value"])
      || !isNonEmptyString(check.name) || typeof check.message !== "string" || typeof check.passed !== "boolean"
      || !isCheckValue(check.value) || !isCheckValue(check.limit)) throw invalidSnapshot();
  });
}

function validateExecutionRecord(value: unknown) {
  const execution = assertObject(value);
  const legacyKeys = [
    "accountId", "challengeId", "compensationOrders", "createdAt", "errorCategory", "executionId",
    "hedgedQuantityXaut", "idempotencyKey", "message", "orderLinkPrefix", "perpetualOrders", "spotOrder", "state",
    "unhedgedDurationMs", "updatedAt", "userId",
  ];
  const currentKeys = [
    "accountId", "challengeId", "compensationOrders", "createdAt", "errorCategory", "executionId",
    "finalizeIdempotency", "hedgedQuantityXaut", "idempotencyKey", "message", "orderLinkPrefix", "perpetualOrders", "reconciliation", "spotOrder", "state",
    "unhedgedDurationMs", "updatedAt", "userId",
  ];
  const strategyPositionKeys = [...currentKeys, "strategyPosition"];
  if (!hasExactKeys(execution, strategyPositionKeys)
    && !hasExactKeys(execution, currentKeys)
    && !hasExactKeys(execution, legacyKeys)) throw invalidSnapshot();
  for (const key of ["userId", "accountId", "executionId", "idempotencyKey", "challengeId", "orderLinkPrefix"]) {
    if (!isNonEmptyString(execution[key])) throw invalidSnapshot();
  }
  if (![
    "accepted", "opening_spot", "opening_perpetual", "partial_closed", "hedged", "compensating", "reconciled", "closed", "failed", "manual_intervention",
  ].includes(String(execution.state))
    || !(execution.errorCategory === null || typeof execution.errorCategory === "string")
    || typeof execution.message !== "string"
    || !(execution.reconciliation === undefined || execution.reconciliation === null || typeof execution.reconciliation === "object")
    || !(execution.finalizeIdempotency === undefined || execution.finalizeIdempotency === null || typeof execution.finalizeIdempotency === "object")
    || !isFiniteNumber(execution.hedgedQuantityXaut)
    || !isNullableFiniteNumber(execution.unhedgedDurationMs)
    || !isTimestamp(execution.createdAt) || !isTimestamp(execution.updatedAt)
    || !Array.isArray(execution.perpetualOrders) || !Array.isArray(execution.compensationOrders)) throw invalidSnapshot();
  if (execution.reconciliation !== undefined && execution.reconciliation !== null) validateReconciliationPreview(execution.reconciliation);
  if (execution.finalizeIdempotency !== undefined && execution.finalizeIdempotency !== null) validateFinalizeIdempotency(execution.finalizeIdempotency);
  if (execution.strategyPosition !== undefined) validateStrategyPosition(execution.strategyPosition);
  if (execution.spotOrder !== null) validateProviderOrder(execution.spotOrder);
  execution.perpetualOrders.forEach(validateProviderOrder);
  execution.compensationOrders.forEach(validateProviderOrder);
}

function validateStrategyPosition(value: unknown) {
  const position = assertObject(value);
  if (!hasExactKeys(position, ["coverage", "perpetualRemainingXaut", "spotRemainingXaut", "updatedAt"])
    || !["complete", "ambiguous"].includes(String(position.coverage))
    || !isFiniteNumber(position.spotRemainingXaut) || Number(position.spotRemainingXaut) < 0
    || !isFiniteNumber(position.perpetualRemainingXaut) || Number(position.perpetualRemainingXaut) < 0
    || !isTimestamp(position.updatedAt)) {
    throw invalidSnapshot();
  }
}

function validateReconciliationPreview(value: unknown) {
  const preview = assertObject(value);
  if (!hasExactKeys(preview, [
    "authoritativeState", "blockingReasons", "canFinalize", "dustResidual", "legDiffs",
    "reconciliationId", "recommendedAction", "recordedState", "strategyId", "tradableResidual",
  ])) throw invalidSnapshot();
}

function validateFinalizeIdempotency(value: unknown) {
  const item = assertObject(value);
  if (!hasExactKeys(item, ["completedAt", "requestFingerprint", "resultState", "scopedKey"])) throw invalidSnapshot();
  if (!isNonEmptyString(item.scopedKey) || !isNonEmptyString(item.requestFingerprint) || !isTimestamp(item.completedAt)) {
    throw invalidSnapshot();
  }
  if (!["reconciled", "closed"].includes(String(item.resultState))) throw invalidSnapshot();
}

function validateProviderOrder(value: unknown) {
  const order = assertObject(value);
  const legacyKeys = [
    "averagePrice", "feeUsd", "filledQuantityXaut", "orderId", "orderLinkId", "requestedQuantityXaut", "status", "updatedAt",
  ];
  const currentKeys = [...legacyKeys, "positionQuantityXaut"];
  if ((!hasExactKeys(order, legacyKeys) && !hasExactKeys(order, currentKeys))
    || !isNonEmptyString(order.orderId) || !isNonEmptyString(order.orderLinkId)
    || !["New", "PartiallyFilled", "Filled", "Cancelled", "Rejected", "Unknown"].includes(String(order.status))
    || !isFiniteNumber(order.requestedQuantityXaut) || !isFiniteNumber(order.filledQuantityXaut)
    || !(order.positionQuantityXaut === undefined
      || (isFiniteNumber(order.positionQuantityXaut) && Number(order.positionQuantityXaut) >= 0))
    || !isNullableFiniteNumber(order.averagePrice) || !isFiniteNumber(order.feeUsd) || !isTimestamp(order.updatedAt)) {
    throw invalidSnapshot();
  }
}

function validatePnlSnapshot(value: unknown) {
  const snapshot = assertObject(value);
  if (!hasExactKeys(snapshot, [
    "accountFingerprint", "accountId", "capturedAt", "currentBasisBps", "entryBasisBps", "feesUsd", "fundingPnlUsd",
    "legs", "netDeltaUsd", "netDeltaXaut", "netPnlUsd", "openOrders", "realizedPnlUsd", "slippageUsd", "strategyId",
    "unrealizedPnlUsd",
  ])) throw invalidSnapshot();
  for (const key of ["accountId", "accountFingerprint", "strategyId"]) {
    if (!isNonEmptyString(snapshot[key])) throw invalidSnapshot();
  }
  if (!isTimestamp(snapshot.capturedAt) || !isNullableFiniteNumber(snapshot.entryBasisBps)
    || !isNullableFiniteNumber(snapshot.currentBasisBps) || !Array.isArray(snapshot.openOrders)) throw invalidSnapshot();
  for (const key of [
    "netDeltaXaut", "netDeltaUsd", "realizedPnlUsd", "unrealizedPnlUsd", "fundingPnlUsd", "feesUsd", "slippageUsd", "netPnlUsd",
  ]) {
    if (!isFiniteNumber(snapshot[key])) throw invalidSnapshot();
  }
  const legs = assertObject(snapshot.legs);
  if (!hasExactKeys(legs, ["perpetual", "spot"])) throw invalidSnapshot();
  validatePnlSide(legs.spot, "spot_long");
  validatePnlSide(legs.perpetual, "perpetual_short");
  snapshot.openOrders.forEach(validateProviderOrder);
}

function validatePnlSide(value: unknown, expectedKind: "spot_long" | "perpetual_short") {
  const side = assertObject(value);
  if (!hasExactKeys(side, [
    "averageEntryPrice", "kind", "markPrice", "notionalUsd", "quantityXaut", "realizedPnlUsd", "unrealizedPnlUsd",
  ]) || side.kind !== expectedKind || !isFiniteNumber(side.quantityXaut)
    || !isNullableFiniteNumber(side.averageEntryPrice) || !isNullableFiniteNumber(side.markPrice)
    || !isFiniteNumber(side.notionalUsd) || !isFiniteNumber(side.realizedPnlUsd) || !isFiniteNumber(side.unrealizedPnlUsd)) {
    throw invalidSnapshot();
  }
}

function validateCredentialAudit(value: unknown) {
  const audit = assertObject(value);
  if (!hasExactKeys(audit, ["accountFingerprint", "accountId", "action", "maskedApiKey", "occurredAt", "userId"])
    || !isNonEmptyString(audit.userId) || !isNonEmptyString(audit.accountId)
    || !isNonEmptyString(audit.accountFingerprint)
    || !["activated", "rotated", "invalidated", "deleted"].includes(String(audit.action))
    || !(audit.maskedApiKey === null || typeof audit.maskedApiKey === "string") || !isTimestamp(audit.occurredAt)) {
    throw invalidSnapshot();
  }
}

function validateVenuePermissions(value: unknown, venue: "bybit" | "bitget" | "binance" | "okx") {
  const permissions = assertObject(value);
  const common = ["contractTrade", "ipRestricted", "read", "spotTrade", "withdraw"];
  const extra = venue === "bybit"
    ? ["ownerSubaccount", "uta"]
    : venue === "binance"
      ? ["futuresAccount", "positionModeSupported", "spotAccount"]
      : [];
  if (!hasExactKeys(permissions, [...common, ...extra])) throw invalidSnapshot();
  for (const key of [...common, ...extra]) {
    if (typeof permissions[key] !== "boolean") throw invalidSnapshot();
  }
}

function parseObject(source: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(source.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw invalidSnapshot();
  }
}

function validateEnvelope(value: unknown, expectedBackupId: string): BackupEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidEnvelope();
  const envelope = value as Partial<BackupEnvelope>;
  const exactKeys = [
    "aadSchema", "algorithm", "backupDomain", "backupId", "ciphertext", "createdAt", "environment",
    "keyName", "nonce", "provider", "purpose", "tag", "version", "wrapBindingTag", "wrapReference", "wrappedDek",
  ];
  if (
    Object.keys(value).sort().join(",") !== exactKeys.sort().join(",")
    || envelope.version !== RWA_AUTOMATION_BACKUP_SCHEMA_VERSION
    || envelope.algorithm !== "AES-256-GCM"
    || envelope.purpose !== "automation-backup"
    || envelope.backupDomain !== RWA_AUTOMATION_BACKUP_DOMAIN
    || envelope.aadSchema !== RWA_AUTOMATION_BACKUP_AAD_SCHEMA
    || envelope.backupId !== expectedBackupId
    || envelope.environment !== credentialEnvironment()
    || envelope.createdAt !== backupTimeFromFileName(backupFileName(expectedBackupId))
    || !envelope.provider || !envelope.keyName || !envelope.wrapReference || !envelope.wrappedDek
    || !envelope.wrapBindingTag || !envelope.ciphertext || !envelope.nonce || !envelope.tag
    || !validBase64url(envelope.wrappedDek) || !validBase64url(envelope.wrapBindingTag, 32)
    || !validBase64url(envelope.ciphertext) || !validBase64url(envelope.nonce, 12)
    || !validBase64url(envelope.tag, 16)
  ) throw invalidEnvelope();
  return envelope as BackupEnvelope;
}

function validatePlaintext(value: unknown, envelope: BackupEnvelope): BackupPlaintext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSnapshot();
  const snapshot = value as Partial<BackupPlaintext>;
  if (Object.keys(value).sort().join(",") !== "files,manifest" || !snapshot.manifest || !Array.isArray(snapshot.files)) {
    throw invalidSnapshot();
  }
  const manifest = snapshot.manifest;
  if (
    Object.keys(manifest).sort().join(",") !== "backupId,createdAt,environment,files,schemaVersion,totalBytes"
    || manifest.schemaVersion !== RWA_AUTOMATION_BACKUP_SCHEMA_VERSION
    || manifest.backupId !== envelope.backupId
    || manifest.createdAt !== envelope.createdAt
    || manifest.environment !== envelope.environment
    || !Array.isArray(manifest.files) || manifest.files.length > maxManifestFiles
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0
    || manifest.files.length !== snapshot.files.length
  ) throw invalidSnapshot();
  const seen = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const metadata = manifest.files[index]!;
    const payload = snapshot.files[index]!;
    if (
      !metadata || typeof metadata !== "object"
      || Object.keys(metadata).sort().join(",") !== "mode,path,sha256,size"
      || metadata.mode !== 0o600
      || !Number.isSafeInteger(metadata.size) || metadata.size < 0
      || !/^[a-f0-9]{64}$/.test(metadata.sha256)
      || !validSnapshotPath(metadata.path) || seen.has(metadata.path)
      || !payload || typeof payload !== "object"
      || Object.keys(payload).sort().join(",") !== "data,path"
      || payload.path !== metadata.path || typeof payload.data !== "string"
      || !validBase64url(payload.data, metadata.size)
    ) throw invalidSnapshot();
    const data = Buffer.from(payload.data, "base64url");
    if (data.length !== metadata.size || sha256(data) !== metadata.sha256) {
      data.fill(0);
      throw new RwaAutomationBackupError("backup_integrity_failed", "自动套利备份文件完整性校验失败。");
    }
    data.fill(0);
    seen.add(metadata.path);
    totalBytes += metadata.size;
  }
  if (totalBytes !== manifest.totalBytes) throw invalidSnapshot();
  return snapshot as BackupPlaintext;
}

function validSnapshotPath(path: string) {
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  if (segments.length === 1) return rootStatePattern.test(segments[0]!);
  return segments.length === 2 && segments[0] === "step-up-security" && stepUpStatePattern.test(segments[1]!);
}

function backupWrapBindingTag(dataKey: Buffer, envelope: BackupEnvelope) {
  return createHmac("sha256", dataKey).update(JSON.stringify({
    version: envelope.version,
    purpose: envelope.purpose,
    backupDomain: envelope.backupDomain,
    backupId: envelope.backupId,
    environment: envelope.environment,
    provider: envelope.provider,
    keyName: envelope.keyName,
    wrapReference: envelope.wrapReference,
    wrappedDek: envelope.wrappedDek,
    createdAt: envelope.createdAt,
  })).digest("base64url");
}

function assertBackupWrapBinding(dataKey: Buffer, envelope: BackupEnvelope) {
  const expected = Buffer.from(backupWrapBindingTag(dataKey, envelope), "utf8");
  const actual = Buffer.from(envelope.wrapBindingTag, "utf8");
  const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
  expected.fill(0);
  actual.fill(0);
  if (!valid) throw new RwaAutomationBackupError("backup_key_identity_mismatch", "自动套利备份密钥身份不匹配。");
}

async function atomicWriteFile(
  path: string,
  data: Buffer,
  options: RwaAutomationDataLayoutOptions,
) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await assertSecureRegularFile(path, options);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function assertSecureRegularFile(path: string, options: RwaAutomationDataLayoutOptions) {
  assertSecureFile(path, options);
  const link = await lstat(path);
  const metadata = await stat(path);
  if (link.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new RwaAutomationBackupError("backup_storage_invalid", "自动套利备份或快照文件不安全。");
  }
  return metadata;
}

async function readBoundedSecureFile(
  path: string,
  maximumBytes: number,
  options: RwaAutomationDataLayoutOptions,
) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const chunks: Buffer[] = [];
  try {
    handle = await open(path, O_RDONLY | O_NOFOLLOW);
    const metadata = await handle.stat();
    const owner = expectedRwaAutomationOwner(options);
    if (!metadata.isFile() || metadata.nlink !== 1
      || metadata.uid !== owner.uid || metadata.gid !== owner.gid
      || (metadata.mode & 0o777) !== 0o600) {
      throw new RwaAutomationBackupError("backup_storage_invalid", "自动套利备份或快照文件不安全。");
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > maximumBytes) {
      throw capacityExceeded();
    }
    let totalBytes = 0;
    while (true) {
      const remaining = maximumBytes - totalBytes;
      if (remaining < 1) {
        const probe = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(probe, 0, 1, null);
        probe.fill(0);
        if (bytesRead > 0) throw capacityExceeded();
        break;
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof RwaAutomationBackupError) throw error;
    throw new RwaAutomationBackupError("backup_storage_invalid", "自动套利备份或快照文件不安全。");
  } finally {
    await handle?.close().catch(() => {});
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function fileExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validBase64url(value: unknown, expectedBytes?: number) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  const valid = decoded.toString("base64url") === value
    && (expectedBytes === undefined || decoded.length === expectedBytes);
  decoded.fill(0);
  return valid;
}

function maxEncryptedBackupBytes(maxSnapshotBytes: number) {
  return Math.ceil(maxSnapshotBytes * 4 / 3) + 2048;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSnapshot();
  return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown) {
  return value === null || isFiniteNumber(value);
}

function isTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableTimestamp(value: unknown) {
  return value === null || isTimestamp(value);
}

function isCheckValue(value: unknown) {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}

function isAccountMode(value: unknown) {
  return [
    "uta", "classic", "single_asset_one_way", "single_asset_hedge", "multi_assets_one_way",
    "multi_assets_hedge", "portfolio_margin", "unknown",
  ].includes(String(value));
}

function containsForbiddenPersistentKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenPersistentKey);
  for (const [key, child] of Object.entries(value)) {
    if ([
      "apiSecret", "privateKey", "providerRawResponse", "rawResponse", "challengeToken", "tokenHash",
      "authorizationToken", "stepUpToken", "armed", "cache", "caches",
    ].includes(key)) {
      return true;
    }
    if (containsForbiddenPersistentKey(child)) return true;
  }
  return false;
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function parseInteger(value: string, minimum: number, maximum: number, label: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RwaAutomationBackupError("backup_config_invalid", `自动套利备份 ${label} 配置无效。`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RwaAutomationBackupError("backup_config_invalid", `自动套利备份 ${label} 配置超出允许范围。`);
  }
  return number;
}

function assertValidLimits(value: RwaAutomationBackupLimits) {
  if (
    !Number.isSafeInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 365
    || !Number.isSafeInteger(value.maxTotalBytes) || value.maxTotalBytes < 1024 * 1024 || value.maxTotalBytes > 10 * 1024 * 1024 * 1024
    || !Number.isSafeInteger(value.maxSnapshotBytes) || value.maxSnapshotBytes < 1024 || value.maxSnapshotBytes > 500 * 1024 * 1024
    || value.maxSnapshotBytes > value.maxTotalBytes
  ) throw new RwaAutomationBackupError("backup_config_invalid", "自动套利备份保留或容量配置无效。");
}

function invalidSnapshot() {
  return new RwaAutomationBackupError("backup_manifest_invalid", "自动套利快照清单或文件结构无效。");
}

function invalidEnvelope() {
  return new RwaAutomationBackupError("backup_envelope_invalid", "自动套利备份 envelope 无效。");
}

function capacityExceeded() {
  return new RwaAutomationBackupError("backup_capacity_exceeded", "自动套利备份超过容量上限。");
}

function asBackupError(error: unknown): RwaAutomationBackupError {
  if (error instanceof RwaAutomationBackupError) return error;
  return new RwaAutomationBackupError("backup_failed", "自动套利备份操作失败；未更改现有数据。");
}

function throwBackupError(error: unknown): never {
  throw asBackupError(error);
}

function safeRestoreError(error: unknown): RwaAutomationBackupError {
  if (error instanceof RwaAutomationBackupError) return error;
  return new RwaAutomationBackupError("restore_failed", "自动套利恢复失败；原数据保持不变。");
}
