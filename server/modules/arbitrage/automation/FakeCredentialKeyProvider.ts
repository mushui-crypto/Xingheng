import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  CredentialKeyProviderError,
  cloudCredentialAad,
  type CreatedCredentialDataKey,
  type CredentialKeyContext,
  type CredentialKeyProvider,
  type WrappedCredentialDataKey,
} from "./CredentialKeyProvider";

export class FakeCredentialKeyProvider implements CredentialKeyProvider {
  readonly name = "fake" as const;
  readonly configured = true;
  readonly configurationError = null;
  readonly createdDekFingerprints: string[] = [];
  failCategory: string | null = null;
  authenticationFailCategory: string | null = null;
  private readonly wrappingKey = randomBytes(32);

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new CredentialKeyProviderError("fake_key_provider_forbidden", "生产环境禁止使用测试凭证密钥 provider。");
    }
  }

  async createDataKey(context: CredentialKeyContext): Promise<CreatedCredentialDataKey> {
    this.assertAvailable();
    const plaintextDek = randomBytes(32);
    this.createdDekFingerprints.push(createHash("sha256").update(plaintextDek).digest("hex"));
    return { ...this.wrap(plaintextDek, context), plaintextDek };
  }

  async unwrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext) {
    this.assertAvailable();
    if (input.provider !== this.name || input.keyName !== "fake:test-key") {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "凭证密钥身份不匹配；已拒绝解密。");
    }
    try {
      const payload = Buffer.from(input.wrappedDek, "base64url");
      const nonce = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const ciphertext = payload.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.wrappingKey, nonce);
      decipher.setAAD(cloudCredentialAad(context));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length !== 32) throw new Error("invalid data key");
      return plaintext;
    } catch {
      throw new CredentialKeyProviderError("credential_key_identity_mismatch", "凭证密钥身份或 AAD 不匹配；已拒绝解密。");
    }
  }

  async rewrapDataKey(input: WrappedCredentialDataKey, context: CredentialKeyContext) {
    const plaintext = await this.unwrapDataKey(input, context);
    try {
      return this.wrap(plaintext, context);
    } finally {
      plaintext.fill(0);
    }
  }

  async healthCheck() {
    if (this.failCategory) {
      return { ok: false, category: this.failCategory, message: "测试凭证密钥 provider 不可用。" };
    }
    return { ok: true, category: null, message: null };
  }

  async authenticationHealthCheck() {
    if (this.authenticationFailCategory) {
      return {
        ok: false,
        category: this.authenticationFailCategory,
        message: "测试凭证认证不可用。",
      };
    }
    return { ok: true, category: null, message: null };
  }

  private wrap(plaintext: Buffer, context: CredentialKeyContext): WrappedCredentialDataKey {
    this.assertAvailable();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.wrappingKey, nonce);
    cipher.setAAD(cloudCredentialAad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      provider: this.name,
      keyName: "fake:test-key",
      wrapReference: "fake:test-key/versions/1",
      wrappedDek: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"),
    };
  }

  private assertAvailable() {
    if (this.failCategory) throw new CredentialKeyProviderError(this.failCategory, "测试凭证密钥 provider 不可用。");
  }
}
