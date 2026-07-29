import { randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { Compute, type ComputeOptions } from "google-auth-library";
import {
  RWA_GCE_FORBIDDEN_CREDENTIAL_ENVIRONMENT,
  RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT,
  RWA_GCP_KMS_AUTH_MODE_X509_WIF,
  RWA_REAL_TEST_GCE_PROJECT_ID,
  isRwaGcpKmsAuthMode,
  isValidRealTestGceServiceAccountEmail,
  type RwaGcpKmsAuthMode,
} from "./GcpKmsAuthConfig";
import {
  CredentialKeyProviderError,
  RWA_GCP_KMS_KEY_NAME,
  RWA_REAL_TEST_GCP_KMS_KEY_NAME,
  cloudCredentialAad,
  type CreatedCredentialDataKey,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type CredentialKeyProviderHealth,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";
import { loadDeploymentIdentity } from "../../../config/deploymentEnvironment";
import {
  GcpWifConfigurationError,
  RWA_AUTOMATION_RUNTIME_GID,
  RWA_AUTOMATION_RUNTIME_UID,
  RWA_GCP_WIF_SECRET_ROOT,
  isCanonicalGcpWifAudience,
  validateGcpWifCredentialFiles,
  validateGcpWifRuntimeBoundary,
  type GcpWifDeploymentEnvironment,
} from "./GcpWifCredentialConfig";

type KmsClient = Pick<KeyManagementServiceClient, "encrypt" | "decrypt">;
type GceMetadataIdentity = {
  projectId: string;
  serviceAccountEmail: string;
  serviceAccounts: string[];
};
type GceMetadataIdentityLoader = () => Promise<GceMetadataIdentity>;
type ComputeAuthClientFactory = (options: ComputeOptions) => Compute;
type KmsClientFactory = (authClient?: Compute) => KmsClient;
const crc32cTable = createCrc32cTable();
const GCE_METADATA_ORIGIN = "http://metadata.google.internal";
const GCE_METADATA_TIMEOUT_MS = 1_000;
const GCE_METADATA_MAX_RESPONSE_BYTES = 1_024;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export class GcpKmsCredentialKeyProvider implements CredentialKeyProvider {
  readonly name = "gcp-kms" as const;
  readonly configured: boolean;
  readonly configurationError: string | null;
  private readonly keyName: string;
  private readonly adcPath: string;
  private readonly wifAudience: string;
  private readonly secretRoot: string;
  private readonly expectedOwnerUid: number;
  private readonly expectedOwnerGid: number;
  private readonly deploymentEnvironment: GcpWifDeploymentEnvironment | null;
  private readonly authMode: RwaGcpKmsAuthMode | null;
  private readonly expectedGceServiceAccountEmail: string;
  private readonly metadataIdentityLoader: GceMetadataIdentityLoader;
  private readonly computeAuthClient: Compute | null;
  private readonly kmsClientFactory: KmsClientFactory;
  private readonly validateRuntimeBoundary: boolean;
  private client: KmsClient | null = null;

  constructor(options: {
    keyName?: string;
    adcPath?: string;
    wifAudience?: string;
    secretRoot?: string;
    expectedOwnerUid?: number;
    expectedOwnerGid?: number;
    deploymentEnvironment?: GcpWifDeploymentEnvironment;
    authMode?: string;
    expectedGceServiceAccountEmail?: string;
    metadataIdentityLoader?: GceMetadataIdentityLoader;
    metadataFetch?: typeof fetch;
    computeAuthClientFactory?: ComputeAuthClientFactory;
    kmsClientFactory?: KmsClientFactory;
    client?: KmsClient;
  } = {}) {
    const testMode = process.env.NODE_ENV === "test";
    this.validateRuntimeBoundary = !testMode;
    this.secretRoot = testMode && options.secretRoot ? options.secretRoot : RWA_GCP_WIF_SECRET_ROOT;
    this.expectedOwnerUid = testMode && options.expectedOwnerUid !== undefined
      ? options.expectedOwnerUid
      : RWA_AUTOMATION_RUNTIME_UID;
    this.expectedOwnerGid = testMode && options.expectedOwnerGid !== undefined
      ? options.expectedOwnerGid
      : RWA_AUTOMATION_RUNTIME_GID;
    this.keyName = options.keyName?.trim() ?? process.env.RWA_GCP_KMS_KEY_NAME?.trim() ?? "";
    this.adcPath = options.adcPath?.trim() ?? process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "";
    this.wifAudience = options.wifAudience?.trim() ?? process.env.RWA_GCP_WIF_AUDIENCE?.trim() ?? "";
    const configuredAuthMode = options.authMode?.trim()
      ?? process.env.RWA_GCP_KMS_AUTH_MODE?.trim()
      ?? "";
    this.authMode = isRwaGcpKmsAuthMode(configuredAuthMode) ? configuredAuthMode : null;
    this.expectedGceServiceAccountEmail = options.expectedGceServiceAccountEmail?.trim()
      ?? process.env.RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL?.trim()
      ?? "";
    this.metadataIdentityLoader = testMode && options.metadataIdentityLoader
      ? options.metadataIdentityLoader
      : () => loadGceMetadataIdentity(testMode ? options.metadataFetch : undefined);
    const computeAuthClientFactory = testMode && options.computeAuthClientFactory
      ? options.computeAuthClientFactory
      : (computeOptions: ComputeOptions) => new Compute(computeOptions);
    this.kmsClientFactory = testMode && options.kmsClientFactory
      ? options.kmsClientFactory
      : (authClient?: Compute) => new KeyManagementServiceClient(authClient ? { authClient } : {});
    this.client = options.client ?? null;
    const configuration = validateConfiguration(
      this.keyName,
      this.adcPath,
      this.wifAudience,
      this.secretRoot,
      configuredAuthMode,
      this.expectedGceServiceAccountEmail,
      testMode ? options.deploymentEnvironment : undefined,
    );
    this.configurationError = configuration.error;
    this.deploymentEnvironment = configuration.deploymentEnvironment;
    this.configured = this.configurationError === null;
    this.computeAuthClient = this.configured
      && this.deploymentEnvironment === "real-test"
      && this.authMode === RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT
      ? computeAuthClientFactory({
        serviceAccountEmail: this.expectedGceServiceAccountEmail,
        scopes: [CLOUD_PLATFORM_SCOPE],
      })
      : null;
  }

  async createDataKey(context: CredentialKeyContext): Promise<CreatedCredentialDataKey> {
    this.requireConfigured();
    const plaintextDek = randomBytes(32);
    try {
      const wrapped = await this.wrapDataKey(plaintextDek, context);
      return { ...wrapped, plaintextDek };
    } catch (error) {
      plaintextDek.fill(0);
      throw safeKmsError(error);
    }
  }

  async unwrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext) {
    this.requireConfigured();
    if (input.provider !== this.name || input.keyName !== this.keyName || !input.wrappedDek) {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "凭证密钥身份不匹配；已拒绝解密。");
    }
    await this.validateAdcConfiguration();
    if (!validCryptoKeyVersionReference(input.wrapReference, this.keyName)) {
      throw new CredentialKeyProviderError(
        "credential_key_identity_mismatch",
        "凭证数据密钥版本身份不匹配；已拒绝解密。",
      );
    }
    try {
      const ciphertext = Buffer.from(input.wrappedDek, "base64url");
      const aad = cloudCredentialAad(context);
      const [response] = await this.getClient().decrypt({
        name: this.keyName,
        ciphertext,
        additionalAuthenticatedData: aad,
        ciphertextCrc32c: int64Value(crc32c(ciphertext)),
        additionalAuthenticatedDataCrc32c: int64Value(crc32c(aad)),
      });
      const plaintext = bufferFromUnknown(response.plaintext);
      const plaintextChecksum = parseCrc32c(response.plaintextCrc32c);
      if (plaintext.length !== 32 || plaintextChecksum === null || plaintextChecksum !== crc32c(plaintext)) {
        plaintext.fill(0);
        throw new CredentialKeyProviderError(
          "credential_key_integrity_failed",
          "KMS 解密完整性校验失败；已拒绝使用数据密钥。",
        );
      }
      return plaintext;
    } catch (error) {
      throw safeKmsError(error);
    }
  }

  async rewrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext) {
    const plaintextDek = await this.unwrapDataKey(input, context);
    try {
      return await this.wrapDataKey(plaintextDek, context);
    } finally {
      plaintextDek.fill(0);
    }
  }

  async healthCheck(context: CredentialKeyContext): Promise<CredentialKeyProviderHealth> {
    const probe = randomBytes(32);
    try {
      const wrapped = await this.wrapDataKey(probe, context);
      const recovered = await this.unwrapDataKey(wrapped, context);
      const ok = recovered.equals(probe);
      recovered.fill(0);
      return ok
        ? { ok: true, category: null, message: null }
        : { ok: false, category: "credential_key_provider_integrity", message: "KMS 健康检查完整性校验失败。" };
    } catch (error) {
      const safe = safeKmsError(error);
      return { ok: false, category: safe.category, message: safe.message };
    } finally {
      probe.fill(0);
    }
  }

  private async wrapDataKey(plaintextDek: Buffer, context: CredentialKeyContext): Promise<WrappedCredentialDataKey> {
    await this.validateAdcConfiguration();
    try {
      const aad = cloudCredentialAad(context);
      const [response] = await this.getClient().encrypt({
        name: this.keyName,
        plaintext: plaintextDek,
        additionalAuthenticatedData: aad,
        plaintextCrc32c: int64Value(crc32c(plaintextDek)),
        additionalAuthenticatedDataCrc32c: int64Value(crc32c(aad)),
      });
      const ciphertext = bufferFromUnknown(response.ciphertext);
      const ciphertextChecksum = parseCrc32c(response.ciphertextCrc32c);
      if (
        !ciphertext.length
        || response.verifiedPlaintextCrc32c !== true
        || response.verifiedAdditionalAuthenticatedDataCrc32c !== true
        || ciphertextChecksum === null
        || ciphertextChecksum !== crc32c(ciphertext)
      ) {
        throw new CredentialKeyProviderError(
          "credential_key_integrity_failed",
          "KMS 加密完整性校验失败；已拒绝保存凭证。",
        );
      }
      if (!validCryptoKeyVersionReference(response.name, this.keyName)) {
        throw new CredentialKeyProviderError(
          "credential_key_identity_mismatch",
          "KMS 返回的数据密钥版本身份不受信任；已拒绝保存凭证。",
        );
      }
      return {
        provider: this.name,
        keyName: this.keyName,
        wrapReference: response.name!,
        wrappedDek: ciphertext.toString("base64url"),
      };
    } catch (error) {
      throw safeKmsError(error);
    }
  }

  private requireConfigured() {
    if (!this.configured) {
      throw new CredentialKeyProviderError(
        "credential_key_provider_unconfigured",
        this.configurationError ?? "GCP KMS 凭证密钥 provider 未配置；已拒绝凭证操作。",
      );
    }
  }

  private async validateAdcConfiguration() {
    this.requireConfigured();
    if (this.authMode === RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT) {
      await this.validateGceMetadataIdentity();
      return;
    }
    try {
      if (this.validateRuntimeBoundary) validateGcpWifRuntimeBoundary();
      validateGcpWifCredentialFiles({
        adcPath: this.adcPath,
        expectedAudience: this.wifAudience,
        secretRoot: this.secretRoot,
        expectedOwnerUid: this.expectedOwnerUid,
        expectedOwnerGid: this.expectedOwnerGid,
        deploymentEnvironment: this.deploymentEnvironment!,
      });
    } catch (error) {
      if (error instanceof GcpWifConfigurationError) {
        throw new CredentialKeyProviderError(error.category, error.message);
      }
      throw new CredentialKeyProviderError(
        "credential_key_provider_auth_unavailable",
        "GCP ADC/WIF 配置不可用；已拒绝凭证操作。",
      );
    }
  }

  private async validateGceMetadataIdentity() {
    try {
      const identity = await this.metadataIdentityLoader();
      const expectedEntries = new Set([
        "default/",
        `${this.expectedGceServiceAccountEmail}/`,
      ]);
      const actualEntries = new Set(identity.serviceAccounts);
      if (
        identity.projectId !== RWA_REAL_TEST_GCE_PROJECT_ID
        || identity.serviceAccountEmail !== this.expectedGceServiceAccountEmail
        || identity.serviceAccounts.length !== expectedEntries.size
        || actualEntries.size !== expectedEntries.size
        || [...actualEntries].some((entry) => !expectedEntries.has(entry))
      ) {
        throw new CredentialKeyProviderError(
          "credential_key_provider_auth_rejected",
          "GCE metadata 项目或附加服务账号身份不匹配；已拒绝 KMS 操作。",
        );
      }
    } catch (error) {
      if (error instanceof CredentialKeyProviderError) throw error;
      throw new CredentialKeyProviderError(
        "credential_key_provider_auth_unavailable",
        "GCE metadata 身份不可用或响应无效；已拒绝 KMS 操作。",
      );
    }
  }

  private getClient() {
    this.client ??= this.kmsClientFactory(this.computeAuthClient ?? undefined);
    return this.client;
  }
}

function validateConfiguration(
  keyName: string,
  adcPath: string,
  wifAudience: string,
  secretRoot: string,
  authMode: string,
  expectedGceServiceAccountEmail: string,
  testDeploymentEnvironment?: GcpWifDeploymentEnvironment,
) {
  if (process.env.RWA_AUTOMATION_MASTER_KEY?.trim()) {
    return invalidConfiguration("RWA_AUTOMATION_MASTER_KEY 已停用；生产环境禁止回退本地主密钥。");
  }
  if (process.env.RWA_CREDENTIAL_KEY_PROVIDER !== "gcp-kms") {
    return invalidConfiguration("RWA_CREDENTIAL_KEY_PROVIDER 必须固定为 gcp-kms。");
  }
  let deploymentEnvironment;
  try {
    deploymentEnvironment = testDeploymentEnvironment ?? loadDeploymentIdentity().environment;
  } catch (error) {
    return invalidConfiguration(error instanceof Error
      ? error.message
      : "部署环境身份无效；已拒绝 GCP KMS 配置。");
  }
  if (deploymentEnvironment !== "production" && deploymentEnvironment !== "real-test") {
    return invalidConfiguration("WIF 部署环境必须精确为 production 或 real-test。");
  }
  if (!isRwaGcpKmsAuthMode(authMode)) {
    return invalidConfiguration("RWA_GCP_KMS_AUTH_MODE 必须是受支持的显式认证模式。");
  }
  if (
    deploymentEnvironment === "production"
    && authMode !== RWA_GCP_KMS_AUTH_MODE_X509_WIF
  ) {
    return invalidConfiguration("正式环境只允许 x509_wif KMS 认证模式。");
  }
  if (
    deploymentEnvironment === "real-test"
    && authMode !== RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT
  ) {
    return invalidConfiguration("真实测试环境只允许 gce_attached_service_account KMS 认证模式。");
  }
  const expectedKeyName = deploymentEnvironment === "real-test"
    ? RWA_REAL_TEST_GCP_KMS_KEY_NAME
    : RWA_GCP_KMS_KEY_NAME;
  if (keyName !== expectedKeyName) {
    return invalidConfiguration(deploymentEnvironment === "real-test"
      ? "真实测试环境 RWA_GCP_KMS_KEY_NAME 必须是已冻结的独立 CryptoKey 完整资源名。"
      : "正式环境 RWA_GCP_KMS_KEY_NAME 必须是已冻结的生产 CryptoKey 完整资源名。");
  }
  if (authMode === RWA_GCP_KMS_AUTH_MODE_X509_WIF) {
    if (
      expectedGceServiceAccountEmail
      || process.env.RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL !== undefined
    ) {
      return invalidConfiguration("正式环境禁止配置 real-test GCE 附加服务账号身份。");
    }
    if (adcPath !== `${secretRoot}/adc.json`) {
      return invalidConfiguration("GOOGLE_APPLICATION_CREDENTIALS 必须指向冻结的 X.509 WIF ADC secret 路径。");
    }
    if (!isCanonicalGcpWifAudience(wifAudience)) {
      return invalidConfiguration("RWA_GCP_WIF_AUDIENCE 必须是受信 WIF provider 的完整 audience。");
    }
  } else {
    if (
      adcPath
      || wifAudience
      || process.env.RWA_GCP_WIF_AUDIENCE !== undefined
      || process.env.GOOGLE_APPLICATION_CREDENTIALS !== undefined
      || process.env.XINGHENG_WIF_HOST_PATH !== undefined
      || process.env.RWA_AUTOMATION_MASTER_KEY !== undefined
    ) {
      return invalidConfiguration("真实测试 GCE metadata 模式禁止配置 WIF audience、ADC 或 WIF host path。");
    }
    const forbiddenEnvironment = RWA_GCE_FORBIDDEN_CREDENTIAL_ENVIRONMENT.find(
      (name) => process.env[name] !== undefined,
    );
    if (forbiddenEnvironment) {
      return invalidConfiguration("真实测试 GCE metadata 模式禁止文件凭证、Cloud SDK 覆盖或服务账号模拟。");
    }
    if (!isValidRealTestGceServiceAccountEmail(expectedGceServiceAccountEmail)) {
      return invalidConfiguration("RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL 必须是冻结的 real-test VM 服务账号邮箱。");
    }
  }
  return { error: null, deploymentEnvironment };
}

function invalidConfiguration(error: string) {
  return { error, deploymentEnvironment: null };
}

function bufferFromUnknown(value: Uint8Array | Buffer | string | null | undefined) {
  if (!value) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.from(value);
}

export function crc32c(value: Uint8Array) {
  let checksum = 0xffffffff;
  for (const byte of value) checksum = crc32cTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function createCrc32cTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function int64Value(value: number) {
  return { value };
}

function parseCrc32c(value: { value?: unknown } | null | undefined) {
  if (!value || value.value === null || value.value === undefined) return null;
  const raw = typeof value.value === "object" && value.value !== null && "toString" in value.value
    ? String(value.value)
    : value.value;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed : null;
}

function validCryptoKeyVersionReference(value: string | null | undefined, keyName: string) {
  if (typeof value !== "string") return false;
  const prefix = `${keyName}/cryptoKeyVersions/`;
  if (!value.startsWith(prefix)) return false;
  return /^[1-9]\d*$/.test(value.slice(prefix.length));
}

async function loadGceMetadataIdentity(metadataFetch: typeof fetch = fetch): Promise<GceMetadataIdentity> {
  const [projectId, serviceAccountEmail, serviceAccountsRaw] = await Promise.all([
    readGceMetadata("computeMetadata/v1/project/project-id", metadataFetch),
    readGceMetadata("computeMetadata/v1/instance/service-accounts/default/email", metadataFetch),
    readGceMetadata("computeMetadata/v1/instance/service-accounts/", metadataFetch),
  ]);
  const serviceAccounts = serviceAccountsRaw.endsWith("\n")
    ? serviceAccountsRaw.slice(0, -1).split("\n")
    : serviceAccountsRaw.split("\n");
  if (
    projectId !== projectId.trim()
    || serviceAccountEmail !== serviceAccountEmail.trim()
    || !projectId
    || !serviceAccountEmail
    || serviceAccounts.length !== 2
    || serviceAccounts.some((entry) =>
      entry !== entry.trim()
      || !/^(?:default|[a-z][a-z0-9-]{4,28}[a-z0-9]@xingheng-real-test\.iam\.gserviceaccount\.com)\/$/.test(entry))
  ) {
    throw new Error("invalid metadata identity");
  }
  return { projectId, serviceAccountEmail, serviceAccounts };
}

async function readGceMetadata(path: string, metadataFetch: typeof fetch) {
  const response = await metadataFetch(`${GCE_METADATA_ORIGIN}/${path}`, {
    headers: { "Metadata-Flavor": "Google" },
    redirect: "error",
    signal: AbortSignal.timeout(GCE_METADATA_TIMEOUT_MS),
  });
  const rawContentLength = response.headers.get("content-length");
  const contentLength = rawContentLength === null ? null : Number(rawContentLength);
  if (
    !response.ok
    || response.headers.get("metadata-flavor") !== "Google"
    || (contentLength !== null && (
      !Number.isSafeInteger(contentLength)
      || contentLength < 0
      || contentLength > GCE_METADATA_MAX_RESPONSE_BYTES
    ))
    || !response.body
  ) {
    throw new Error("invalid metadata response");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > GCE_METADATA_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("metadata response too large");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (contentLength !== null && contentLength !== totalBytes) {
    throw new Error("metadata content length mismatch");
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function safeKmsError(error: unknown) {
  if (error instanceof CredentialKeyProviderError) return error;
  return new CredentialKeyProviderError(
    "credential_key_provider_unavailable",
    "GCP KMS 暂不可用、权限不足或密钥状态异常；已拒绝凭证操作。",
  );
}
