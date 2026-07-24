import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CredentialKeyProviderError,
  RWA_CREDENTIAL_ENVELOPE_VERSION,
  STEP_UP_SECURITY_AAD_SCHEMA,
  canonicalCredentialAad,
  credentialEnvironment,
  type CredentialKeyProvider,
  type StepUpSecurityKeyContext,
  type WrappedCredentialDataKey,
} from "../arbitrage/automation/CredentialKeyProvider";
import { RWA_AUTOMATION_RUNTIME_GID, RWA_AUTOMATION_RUNTIME_UID } from "../arbitrage/automation/GcpWifCredentialConfig";
import { resolveRwaAutomationActiveDataDir } from "../arbitrage/automation/RwaAutomationDataLayout";

export type RecoveryCodeRecord = { salt: string; hash: string; usedAt: number | null };

export type StepUpSecurityState = {
  version: 1;
  pending: null | {
    enrollmentIdHash: string;
    secret: string;
    createdAt: number;
    expiresAt: number;
  };
  active: null | {
    secret: string;
    enabledAt: number;
    lastAcceptedCounter: number | null;
    recoveryCodes: RecoveryCodeRecord[];
  };
  audit: Array<{
    userDomain: string;
    accountDomain: string | null;
    operation: string;
    result: "success" | "rejected" | "revoked";
    category: string;
    occurredAt: number;
  }>;
};

type SecurityEnvelope = WrappedCredentialDataKey & {
  version: typeof RWA_CREDENTIAL_ENVELOPE_VERSION;
  algorithm: "AES-256-GCM";
  purpose: "step-up-security";
  securityDomain: "rwa-sensitive-operations";
  aadSchema: typeof STEP_UP_SECURITY_AAD_SCHEMA;
  wrapBindingTag: string;
  ciphertext: string;
  nonce: string;
  tag: string;
  createdAt: number;
  updatedAt: number;
};

export class StepUpSecurityStoreError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class StepUpSecurityStore {
  readonly statePath: string;
  private readonly expectedUid: number;
  private readonly expectedGid: number;

  constructor(
    readonly userId: string,
    private readonly keyProvider: CredentialKeyProvider,
    options: { statePath?: string; expectedUid?: number; expectedGid?: number } = {},
  ) {
    if (!userId.trim()) throw new Error("step-up security store requires user ownership");
    const userDomain = domain("file-user", userId).slice(0, 24);
    const root = resolve(resolveRwaAutomationActiveDataDir(), "step-up-security");
    const production = process.env.NODE_ENV === "production";
    this.statePath = production
      ? resolve(root, `${userDomain}.enc.json`)
      : resolve(options.statePath ?? resolve(root, `${userDomain}.enc.json`));
    this.expectedUid = production ? RWA_AUTOMATION_RUNTIME_UID : options.expectedUid ?? process.getuid?.() ?? -1;
    this.expectedGid = production ? RWA_AUTOMATION_RUNTIME_GID : options.expectedGid ?? process.getgid?.() ?? -1;
  }

  async read(): Promise<StepUpSecurityState> {
    const envelope = await this.readEnvelope();
    if (!envelope) return emptyState();
    const context = this.context();
    const dataKey = await this.keyProvider.unwrapDataKey(envelope, context).catch(asStoreError);
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
      return validateState(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      if (error instanceof StepUpSecurityStoreError) throw error;
      throw new StepUpSecurityStoreError("step_up_storage_corrupt", "二次验证安全状态不可读；已拒绝敏感操作。");
    } finally {
      plaintext?.fill(0);
      dataKey.fill(0);
    }
  }

  async write(state: StepUpSecurityState) {
    if (!this.keyProvider.configured) {
      throw new StepUpSecurityStoreError("step_up_key_unavailable", "二次验证密钥服务不可用；已拒绝敏感操作。");
    }
    const context = this.context();
    const health = await this.keyProvider.healthCheck(context).catch(asStoreError);
    if (!health.ok) throw new StepUpSecurityStoreError("step_up_key_unavailable", "二次验证密钥服务不可用；已拒绝敏感操作。");
    const dataKey = await this.keyProvider.createDataKey(context).catch(asStoreError);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify({ ...state, audit: state.audit.slice(-200) }), "utf8");
    try {
      const cipher = createCipheriv("aes-256-gcm", dataKey.plaintextDek, nonce);
      cipher.setAAD(canonicalCredentialAad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const previous = await this.readEnvelope();
      const now = Date.now();
      const envelope: SecurityEnvelope = {
        version: RWA_CREDENTIAL_ENVELOPE_VERSION,
        algorithm: "AES-256-GCM",
        purpose: "step-up-security",
        securityDomain: "rwa-sensitive-operations",
        provider: dataKey.provider,
        keyName: dataKey.keyName,
        wrapReference: dataKey.wrapReference,
        wrappedDek: dataKey.wrappedDek,
        wrapBindingTag: "",
        ciphertext: ciphertext.toString("base64url"),
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        aadSchema: STEP_UP_SECURITY_AAD_SCHEMA,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      envelope.wrapBindingTag = wrapBindingTag(dataKey.plaintextDek, envelope);
      await atomicWrite(this.statePath, envelope, this.expectedUid, this.expectedGid);
      ciphertext.fill(0);
    } finally {
      plaintext.fill(0);
      dataKey.plaintextDek.fill(0);
    }
  }

  async clearPending() {
    const state = await this.read();
    if (!state.pending) return;
    state.pending = null;
    await this.write(state);
  }

  private context(): StepUpSecurityKeyContext {
    return {
      purpose: "step-up-security",
      userId: this.userId,
      securityDomain: "rwa-sensitive-operations",
      environment: credentialEnvironment(),
      schemaVersion: RWA_CREDENTIAL_ENVELOPE_VERSION,
    };
  }

  private async readEnvelope(): Promise<SecurityEnvelope | null> {
    try {
      await assertSecurePath(this.statePath, this.expectedUid, this.expectedGid);
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<SecurityEnvelope>;
      if (
        parsed.version !== RWA_CREDENTIAL_ENVELOPE_VERSION
        || parsed.algorithm !== "AES-256-GCM"
        || parsed.purpose !== "step-up-security"
        || parsed.securityDomain !== "rwa-sensitive-operations"
        || parsed.aadSchema !== STEP_UP_SECURITY_AAD_SCHEMA
        || !parsed.provider || !parsed.keyName || !parsed.wrapReference || !parsed.wrappedDek
        || !parsed.wrapBindingTag || !parsed.ciphertext || !parsed.nonce || !parsed.tag
        || !Number.isFinite(parsed.createdAt) || !Number.isFinite(parsed.updatedAt)
      ) throw new Error("invalid envelope");
      return parsed as SecurityEnvelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof StepUpSecurityStoreError) throw error;
      throw new StepUpSecurityStoreError("step_up_storage_corrupt", "二次验证安全状态不可读；已拒绝敏感操作。");
    }
  }
}

export function emptyState(): StepUpSecurityState {
  return { version: 1, pending: null, active: null, audit: [] };
}

function validateState(value: unknown): StepUpSecurityState {
  if (!value || typeof value !== "object" || (value as StepUpSecurityState).version !== 1) {
    throw new StepUpSecurityStoreError("step_up_storage_corrupt", "二次验证安全状态不可读；已拒绝敏感操作。");
  }
  const state = value as StepUpSecurityState;
  if (!Array.isArray(state.audit) || !(state.pending === null || typeof state.pending === "object") || !(state.active === null || typeof state.active === "object")) {
    throw new StepUpSecurityStoreError("step_up_storage_corrupt", "二次验证安全状态不可读；已拒绝敏感操作。");
  }
  if (state.active && (!state.active.secret || !Array.isArray(state.active.recoveryCodes))) {
    throw new StepUpSecurityStoreError("step_up_storage_corrupt", "二次验证安全状态不可读；已拒绝敏感操作。");
  }
  return state;
}

async function assertSecurePath(path: string, uid: number, gid: number) {
  const directory = dirname(path);
  const directoryLink = await lstat(directory);
  const directoryStat = await stat(directory);
  if (directoryLink.isSymbolicLink() || !directoryStat.isDirectory() || directoryStat.uid !== uid || directoryStat.gid !== gid || (directoryStat.mode & 0o777) !== 0o700) {
    throw new StepUpSecurityStoreError("step_up_storage_permissions", "二次验证安全存储权限无效；已拒绝敏感操作。");
  }
  const fileLink = await lstat(path);
  const fileStat = await stat(path);
  if (fileLink.isSymbolicLink() || !fileStat.isFile() || fileStat.uid !== uid || fileStat.gid !== gid || (fileStat.mode & 0o777) !== 0o600) {
    throw new StepUpSecurityStoreError("step_up_storage_permissions", "二次验证安全存储权限无效；已拒绝敏感操作。");
  }
}

async function atomicWrite(path: string, value: unknown, uid: number, gid: number) {
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new StepUpSecurityStoreError("step_up_storage_permissions", "二次验证安全存储权限无效；已拒绝敏感操作。");
  }
  const directoryLink = await lstat(directory);
  const directoryStat = await stat(directory);
  if (
    directoryLink.isSymbolicLink()
    || !directoryStat.isDirectory()
    || directoryStat.uid !== uid
    || directoryStat.gid !== gid
    || (directoryStat.mode & 0o777) !== 0o700
  ) {
    throw new StepUpSecurityStoreError("step_up_storage_permissions", "二次验证安全存储权限无效；已拒绝敏感操作。");
  }
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function assertWrapBinding(dataKey: Buffer, envelope: SecurityEnvelope) {
  const expected = Buffer.from(wrapBindingTag(dataKey, envelope), "base64url");
  const actual = Buffer.from(envelope.wrapBindingTag, "base64url");
  try {
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new StepUpSecurityStoreError("step_up_key_identity_mismatch", "二次验证密钥绑定无效；已拒绝敏感操作。");
    }
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}

function wrapBindingTag(dataKey: Buffer, envelope: SecurityEnvelope) {
  return createHmac("sha256", dataKey).update(JSON.stringify({
    version: envelope.version,
    algorithm: envelope.algorithm,
    purpose: envelope.purpose,
    securityDomain: envelope.securityDomain,
    provider: envelope.provider,
    keyName: envelope.keyName,
    wrapReference: envelope.wrapReference,
    wrappedDek: envelope.wrappedDek,
    aadSchema: envelope.aadSchema,
  })).digest("base64url");
}

function domain(purpose: string, value: string) {
  return createHash("sha256").update(`step-up:${purpose}:${value}`).digest("base64url");
}

function asStoreError(error: unknown): never {
  if (error instanceof StepUpSecurityStoreError) throw error;
  if (error instanceof CredentialKeyProviderError) {
    throw new StepUpSecurityStoreError("step_up_key_unavailable", "二次验证密钥服务不可用；已拒绝敏感操作。");
  }
  throw new StepUpSecurityStoreError("step_up_key_unavailable", "二次验证密钥服务不可用；已拒绝敏感操作。");
}
