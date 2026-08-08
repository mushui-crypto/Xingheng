import { randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import {
  CredentialKeyProviderError,
  canonicalCredentialAad,
  type CreatedCredentialDataKey,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";

type KmsClient = Pick<KeyManagementServiceClient, "encrypt" | "decrypt">;
const crc32cTable = createCrc32cTable();

export class GcpKmsCredentialKeyProvider implements CredentialKeyProvider {
  readonly name = "gcp-kms" as const;
  readonly keyName: string;
  readonly configured: boolean;
  readonly configurationError: string | null;
  private client: KmsClient | null;

  constructor(options: { keyName?: string; client?: KmsClient } = {}) {
    this.keyName = options.keyName?.trim() ?? process.env.GCP_KMS_CREDENTIAL_KEY_NAME?.trim() ?? "";
    this.configurationError = validateKeyName(this.keyName);
    this.configured = this.configurationError === null;
    this.client = options.client ?? null;
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
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "Credential key identity does not match.");
    }
    if (!validCryptoKeyVersionReference(input.wrapReference, this.keyName)) {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "Credential key version does not match.");
    }
    try {
      const ciphertext = Buffer.from(input.wrappedDek, "base64url");
      const aad = canonicalCredentialAad(context);
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
        throw new CredentialKeyProviderError("credential_key_integrity_failed", "KMS decrypt integrity verification failed.");
      }
      return plaintext;
    } catch (error) {
      throw safeKmsError(error);
    }
  }

  private async wrapDataKey(plaintextDek: Buffer, context: CredentialKeyContext): Promise<WrappedCredentialDataKey> {
    const aad = canonicalCredentialAad(context);
    try {
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
        throw new CredentialKeyProviderError("credential_key_integrity_failed", "KMS encrypt integrity verification failed.");
      }
      if (!validCryptoKeyVersionReference(response.name, this.keyName)) {
        throw new CredentialKeyProviderError("credential_key_identity_mismatch", "KMS returned an unexpected key version.");
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
        this.configurationError ?? "GCP KMS credential key is not configured.",
      );
    }
  }

  private getClient() {
    this.client ??= new KeyManagementServiceClient();
    return this.client;
  }
}

function validateKeyName(value: string) {
  if (!value) return "GCP_KMS_CREDENTIAL_KEY_NAME is required.";
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/u.test(value)) {
    return "GCP_KMS_CREDENTIAL_KEY_NAME must be a full CryptoKey resource name.";
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
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
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
  return value.startsWith(prefix) && /^[1-9]\d*$/u.test(value.slice(prefix.length));
}

function safeKmsError(error: unknown) {
  if (error instanceof CredentialKeyProviderError) return error;
  return new CredentialKeyProviderError(
    "credential_key_provider_unavailable",
    "GCP KMS is unavailable, unauthorized, or the key version is disabled.",
  );
}
