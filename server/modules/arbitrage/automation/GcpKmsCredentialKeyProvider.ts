import { randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import {
  CredentialKeyProviderError,
  RWA_GCP_KMS_KEY_NAME,
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
} from "./GcpWifCredentialConfig";

type KmsClient = Pick<KeyManagementServiceClient, "encrypt" | "decrypt">;
const crc32cTable = createCrc32cTable();

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
  private client: KmsClient | null = null;

  constructor(options: {
    keyName?: string;
    adcPath?: string;
    wifAudience?: string;
    secretRoot?: string;
    expectedOwnerUid?: number;
    expectedOwnerGid?: number;
    client?: KmsClient;
  } = {}) {
    const testMode = process.env.NODE_ENV === "test";
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
    this.client = options.client ?? null;
    this.configurationError = validateConfiguration(
      this.keyName,
      this.adcPath,
      this.wifAudience,
      this.secretRoot,
    );
    this.configured = this.configurationError === null;
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
    try {
      if (process.env.NODE_ENV !== "test") validateGcpWifRuntimeBoundary();
      validateGcpWifCredentialFiles({
        adcPath: this.adcPath,
        expectedAudience: this.wifAudience,
        secretRoot: this.secretRoot,
        expectedOwnerUid: this.expectedOwnerUid,
        expectedOwnerGid: this.expectedOwnerGid,
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

  private getClient() {
    this.client ??= new KeyManagementServiceClient();
    return this.client;
  }
}

function validateConfiguration(keyName: string, adcPath: string, wifAudience: string, secretRoot: string) {
  if (process.env.RWA_AUTOMATION_MASTER_KEY?.trim()) {
    return "RWA_AUTOMATION_MASTER_KEY 已停用；生产环境禁止回退本地主密钥。";
  }
  if (process.env.RWA_CREDENTIAL_KEY_PROVIDER !== "gcp-kms") {
    return "RWA_CREDENTIAL_KEY_PROVIDER 必须固定为 gcp-kms。";
  }
  let deploymentEnvironment;
  try {
    deploymentEnvironment = loadDeploymentIdentity().environment;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "部署环境身份无效；已拒绝 GCP KMS 配置。";
  }
  if (keyName !== RWA_GCP_KMS_KEY_NAME) {
    return "正式环境 RWA_GCP_KMS_KEY_NAME 必须是已冻结的生产 CryptoKey 完整资源名。";
  }
  if (adcPath !== `${secretRoot}/adc.json`) {
    return "GOOGLE_APPLICATION_CREDENTIALS 必须指向冻结的 X.509 WIF ADC secret 路径。";
  }
  if (!isCanonicalGcpWifAudience(wifAudience)) {
    return "RWA_GCP_WIF_AUDIENCE 必须是受信 WIF provider 的完整 audience。";
  }
  return null;
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

function safeKmsError(error: unknown) {
  if (error instanceof CredentialKeyProviderError) return error;
  return new CredentialKeyProviderError(
    "credential_key_provider_unavailable",
    "GCP KMS 暂不可用、权限不足或密钥状态异常；已拒绝凭证操作。",
  );
}
