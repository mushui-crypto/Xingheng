import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, chown, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CredentialKeyProviderError,
  RWA_GCP_KMS_KEY_NAME,
  type CredentialKeyContext,
} from "./CredentialKeyProvider";
import { GcpKmsCredentialKeyProvider, crc32c } from "./GcpKmsCredentialKeyProvider";
import {
  RWA_AUTOMATION_RUNTIME_GID,
  RWA_AUTOMATION_RUNTIME_UID,
  validateGcpWifRuntimeBoundary,
} from "./GcpWifCredentialConfig";

const context: CredentialKeyContext = {
  userId: "user-a",
  venue: "binance",
  accountId: "binance:test-account",
  environment: "test",
  schemaVersion: 2,
};
const testWifAudience =
  "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/xingheng-rwa-prod/providers/vultr-x509";

test("GCP KMS adapter accepts X.509 external-account ADC and wraps isolated data keys", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.provider.createDataKey(context);
    assert.equal(created.provider, "gcp-kms");
    assert.equal(created.keyName, RWA_GCP_KMS_KEY_NAME);
    assert.match(created.wrapReference, /cryptoKeyVersions\/1$/);
    assert.equal(created.plaintextDek.length, 32);
    const unwrapped = await fixture.provider.unwrapDataKey(created, context);
    assert.ok(unwrapped.equals(created.plaintextDek));
    const rewrapped = await fixture.provider.rewrapDataKey(created, context);
    assert.notEqual(rewrapped.wrappedDek, created.wrappedDek);
    const health = await fixture.provider.healthCheck(context);
    assert.equal(health.ok, true);
    created.plaintextDek.fill(0);
    unwrapped.fill(0);
    assert.ok(fixture.client.encryptCalls >= 3);
    assert.ok(fixture.client.decryptCalls >= 3);
  } finally {
    await fixture.cleanup();
  }
});

test("GCP KMS adapter rejects AAD and account replacement with a stable safe error", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.provider.createDataKey(context);
    await assert.rejects(
      fixture.provider.unwrapDataKey(created, { ...context, accountId: "binance:other-account" }),
      (error: unknown) => error instanceof CredentialKeyProviderError
        && error.category === "credential_key_provider_unavailable"
        && !JSON.stringify(error).includes("raw-upstream-secret"),
    );
    created.plaintextDek.fill(0);
  } finally {
    await fixture.cleanup();
  }
});

test("GCP KMS adapter rejects service-account JSON and local master-key fallback", async () => {
  const serviceAccount = await createFixture({
    type: "service_account",
    client_email: "forbidden@example.invalid",
    private_key: "-----BEGIN PRIVATE KEY-----forbidden-----END PRIVATE KEY-----",
  });
  try {
    await assert.rejects(
      serviceAccount.provider.createDataKey(context),
      (error: unknown) => error instanceof CredentialKeyProviderError
        && error.category === "credential_key_provider_auth_rejected"
        && !JSON.stringify(error).includes("forbidden@example.invalid"),
    );
    assert.equal(serviceAccount.client.encryptCalls, 0);
  } finally {
    await serviceAccount.cleanup();
  }

  const previous = process.env.RWA_AUTOMATION_MASTER_KEY;
  process.env.RWA_AUTOMATION_MASTER_KEY = "11".repeat(32);
  try {
    const provider = new GcpKmsCredentialKeyProvider({
      keyName: RWA_GCP_KMS_KEY_NAME,
      adcPath: "/not-read",
      wifAudience: testWifAudience,
      secretRoot: "/not-read-root",
      expectedOwnerUid: process.getuid?.() ?? 0,
      expectedOwnerGid: process.getgid?.() ?? 0,
      client: new FakeKmsClient() as never,
    });
    assert.equal(provider.configured, false);
    assert.match(provider.configurationError ?? "", /停用|禁止回退/);
  } finally {
    if (previous === undefined) delete process.env.RWA_AUTOMATION_MASTER_KEY;
    else process.env.RWA_AUTOMATION_MASTER_KEY = previous;
  }
});

test("GCP KMS adapter binds production to the frozen CryptoKey", () => {
  const productionEnvironment = {
    NODE_ENV: "production",
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
    XINGHENG_COMPOSE_PROJECT: "xingheng",
    XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
    DOMAIN: "app.example.com",
    RWA_CREDENTIAL_KEY_PROVIDER: "gcp-kms",
    RWA_AUTOMATION_MASTER_KEY: undefined,
  };
  withEnvironment(productionEnvironment, () => {
    assert.equal(createConfigurationProbe(RWA_GCP_KMS_KEY_NAME).configured, true);
    const crossed = createConfigurationProbe(
      "projects/other/locations/asia/keyRings/other/cryptoKeys/other",
    );
    assert.equal(crossed.configured, false);
    assert.match(crossed.configurationError ?? "", /CryptoKey/);

    const missing = createConfigurationProbe("");
    assert.equal(missing.configured, false);
    assert.match(missing.configurationError ?? "", /CryptoKey/);
  });
});

test("GCP KMS adapter rejects missing or unknown production deployment identity", () => {
  for (const deploymentEnvironment of [undefined, "staging"] as const) {
    withEnvironment({
      NODE_ENV: "production",
      XINGHENG_DEPLOYMENT_ENVIRONMENT: deploymentEnvironment,
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
      DOMAIN: "app.example.com",
      RWA_CREDENTIAL_KEY_PROVIDER: "gcp-kms",
      RWA_AUTOMATION_MASTER_KEY: undefined,
    }, () => {
      const provider = createConfigurationProbe(RWA_GCP_KMS_KEY_NAME);
      assert.equal(provider.configured, false);
      assert.match(provider.configurationError ?? "", /production/);
    });
  }
});

test("GCP KMS adapter fails closed for missing ADC and upstream KMS failures", async () => {
  const previousProvider = process.env.RWA_CREDENTIAL_KEY_PROVIDER;
  const previousMasterKey = process.env.RWA_AUTOMATION_MASTER_KEY;
  process.env.RWA_CREDENTIAL_KEY_PROVIDER = "gcp-kms";
  delete process.env.RWA_AUTOMATION_MASTER_KEY;
  try {
    const missingFixture = await createFixture();
    try {
      await rm(missingFixture.adcPath);
      await assert.rejects(
        missingFixture.provider.createDataKey(context),
        (error: unknown) => error instanceof CredentialKeyProviderError
          && error.category === "credential_key_provider_auth_unavailable",
      );
    } finally {
      await missingFixture.cleanup();
    }

    const fixture = await createFixture(undefined, new FailingKmsClient());
    try {
      const health = await fixture.provider.healthCheck(context);
      assert.equal(health.ok, false);
      assert.equal(health.category, "credential_key_provider_unavailable");
      assert.doesNotMatch(JSON.stringify(health), /upstream-certificate-or-key-material/);
      await assert.rejects(
        fixture.provider.createDataKey(context),
        (error: unknown) => error instanceof CredentialKeyProviderError
          && error.category === "credential_key_provider_unavailable"
          && !JSON.stringify(error).includes("upstream-certificate-or-key-material"),
      );
    } finally {
      await fixture.cleanup();
    }
  } finally {
    if (previousProvider === undefined) delete process.env.RWA_CREDENTIAL_KEY_PROVIDER;
    else process.env.RWA_CREDENTIAL_KEY_PROVIDER = previousProvider;
    if (previousMasterKey === undefined) delete process.env.RWA_AUTOMATION_MASTER_KEY;
    else process.env.RWA_AUTOMATION_MASTER_KEY = previousMasterKey;
  }
});

test("GCP KMS adapter freezes the trusted WIF audience, STS, token type, and certificate source", async () => {
  const variants = [
    { audience: `${testWifAudience}-other` },
    { subject_token_type: "urn:ietf:params:oauth:token-type:jwt" },
    { token_url: "https://example.invalid/token" },
    { credential_source: { certificate: {}, file: "/tmp/untrusted" } },
  ];
  for (const override of variants) {
    const fixture = await createFixture((secretRoot: string) => ({ ...x509Adc(secretRoot), ...override }));
    try {
      await assert.rejects(
        fixture.provider.createDataKey(context),
        (error: unknown) => error instanceof CredentialKeyProviderError
          && error.category === "credential_key_provider_auth_rejected",
      );
      assert.equal(fixture.client.encryptCalls, 0);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("GCP KMS adapter rejects symlinked or over-permissive WIF identity files", async () => {
  const identityPaths = [
    "adcPath",
    "certificateConfigPath",
    "certPath",
    "keyPath",
    "trustChainPath",
  ] as const;
  for (const pathName of identityPaths) {
    const permissionsFixture = await createFixture();
    try {
      await chmod(permissionsFixture[pathName], 0o600);
      await assert.rejects(
        permissionsFixture.provider.createDataKey(context),
        hasCategory("credential_key_provider_auth_rejected"),
      );
      assert.equal(permissionsFixture.client.encryptCalls, 0);
    } finally {
      await permissionsFixture.cleanup();
    }
  }

  for (const pathName of identityPaths) {
    const symlinkFixture = await createFixture();
    try {
      const originalPath = symlinkFixture[pathName];
      const target = join(symlinkFixture.directory, `outside-${pathName}`);
      await writeFile(target, await readFile(originalPath), { mode: 0o666 });
      await rm(originalPath);
      await symlink(target, originalPath);
      await assert.rejects(
        symlinkFixture.provider.createDataKey(context),
        hasCategory("credential_key_provider_auth_rejected"),
      );
      assert.equal(symlinkFixture.client.encryptCalls, 0);
    } finally {
      await symlinkFixture.cleanup();
    }
  }
});

test("GCP KMS adapter requires a private 0700 secret root", async () => {
  const fixture = await createFixture();
  try {
    await chmod(fixture.secretRoot, 0o755);
    await assert.rejects(
      fixture.provider.createDataKey(context),
      hasCategory("credential_key_provider_auth_rejected"),
    );
    assert.equal(fixture.client.encryptCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("GCP KMS adapter rejects a mismatched group owner for the secret root and every identity file", async () => {
  const wrongGid = alternateGroupId();
  for (const pathName of [
    "secretRoot",
    "adcPath",
    "certificateConfigPath",
    "certPath",
    "keyPath",
    "trustChainPath",
  ] as const) {
    const fixture = await createFixture();
    try {
      await chown(fixture[pathName], process.getuid?.() ?? 0, wrongGid);
      await assert.rejects(
        fixture.provider.createDataKey(context),
        (error: unknown) => error instanceof CredentialKeyProviderError
          && error.category === "credential_key_provider_auth_rejected"
          && !JSON.stringify(error).includes(String(wrongGid))
          && !JSON.stringify(error).includes(fixture.secretRoot),
      );
      assert.equal(fixture.client.encryptCalls, 0);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("runtime boundary pins a non-root UID/GID, rejects remapping, and requires a read-only tmpfs mount", () => {
  const uidMap = "0 0 4294967295\n";
  const readOnlyTmpfs =
    "36 25 0:32 / /run/secrets/gcp-wif ro,nosuid,nodev,noexec - tmpfs tmpfs rw\n";
  assert.doesNotThrow(() => validateGcpWifRuntimeBoundary({
    runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
    runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
    uidMap,
    mountInfo: readOnlyTmpfs,
  }));

  for (const options of [
    {
      runtimeUid: 0,
      runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
      uidMap,
      mountInfo: readOnlyTmpfs,
    },
    {
      runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
      runtimeGid: 0,
      uidMap,
      mountInfo: readOnlyTmpfs,
    },
    {
      runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
      runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
      uidMap: "0 100000 65536\n",
      mountInfo: readOnlyTmpfs,
    },
    {
      runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
      runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
      uidMap: `${RWA_AUTOMATION_RUNTIME_UID} ${RWA_AUTOMATION_RUNTIME_UID} 1\n`,
      mountInfo: readOnlyTmpfs,
    },
    {
      runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
      runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
      uidMap,
      mountInfo: "36 25 0:32 / /run/secrets/gcp-wif rw,nosuid,nodev - tmpfs tmpfs rw\n",
    },
    {
      runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
      runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
      uidMap,
      mountInfo: "36 25 8:1 / /run/secrets/gcp-wif ro,nosuid,nodev - ext4 /dev/vda1 rw\n",
    },
    {
      runtimeUid: RWA_AUTOMATION_RUNTIME_UID,
      runtimeGid: RWA_AUTOMATION_RUNTIME_GID,
      uidMap,
      mountInfo: `${readOnlyTmpfs}37 36 0:33 / /run/secrets/gcp-wif/override rw - tmpfs tmpfs rw\n`,
    },
  ]) {
    assert.throws(
      () => validateGcpWifRuntimeBoundary(options),
      (error: unknown) => error instanceof Error && /身份|namespace|tmpfs|可写/.test(error.message),
    );
  }
});

test("versioned certificate files become active through an atomic certificate-config replacement", async () => {
  const fixture = await createFixture();
  try {
    const nextCertPath = join(fixture.secretRoot, "client-cert-generation-2.pem");
    const nextKeyPath = join(fixture.secretRoot, "client-key-generation-2.pem");
    const stagedConfigPath = join(fixture.secretRoot, "certificate_config.next.json");
    await Promise.all([
      writeFile(nextCertPath, "test-only-certificate-generation-2", { mode: 0o400 }),
      writeFile(nextKeyPath, "test-only-key-generation-2", { mode: 0o400 }),
    ]);
    await writeFile(stagedConfigPath, JSON.stringify({
      cert_configs: {
        workload: {
          cert_path: nextCertPath,
          key_path: nextKeyPath,
        },
      },
    }), { mode: 0o400 });
    await rename(stagedConfigPath, fixture.certificateConfigPath);

    const created = await fixture.provider.createDataKey(context);
    assert.equal(created.plaintextDek.length, 32);
    assert.equal(fixture.client.encryptCalls > 0, true);
    created.plaintextDek.fill(0);
  } finally {
    await fixture.cleanup();
  }
});

test("GCP KMS adapter requires CRC32C request and response integrity", async () => {
  assert.equal(crc32c(Buffer.from("123456789")), 0xe3069283);
  for (const mode of ["missing_encrypt_flags", "bad_ciphertext_crc", "bad_plaintext_crc"] as const) {
    const fixture = await createFixture(undefined, new FakeKmsClient({ integrityMode: mode }));
    try {
      if (mode === "bad_plaintext_crc") {
        const created = await fixture.provider.createDataKey(context);
        await assert.rejects(
          fixture.provider.unwrapDataKey(created, context),
          hasCategory("credential_key_integrity_failed"),
        );
        created.plaintextDek.fill(0);
      } else {
        await assert.rejects(
          fixture.provider.createDataKey(context),
          hasCategory("credential_key_integrity_failed"),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("GCP KMS adapter validates CryptoKeyVersion responses and wrap references", async () => {
  const invalidResponse = await createFixture(
    undefined,
    new FakeKmsClient({ versionName: "projects/other/locations/asia/keyRings/other/cryptoKeys/other/cryptoKeyVersions/1" }),
  );
  try {
    await assert.rejects(
      invalidResponse.provider.createDataKey(context),
      hasCategory("credential_key_identity_mismatch"),
    );
  } finally {
    await invalidResponse.cleanup();
  }

  const fixture = await createFixture();
  try {
    const created = await fixture.provider.createDataKey(context);
    await assert.rejects(
      fixture.provider.unwrapDataKey({
        ...created,
        wrapReference: "projects/other/locations/asia/keyRings/other/cryptoKeys/other/cryptoKeyVersions/1",
      }, context),
      hasCategory("credential_key_identity_mismatch"),
    );
    created.plaintextDek.fill(0);
  } finally {
    await fixture.cleanup();
  }
});

function createConfigurationProbe(keyName: string) {
  return new GcpKmsCredentialKeyProvider({
    keyName,
    adcPath: "/run/secrets/gcp-wif/adc.json",
    wifAudience: testWifAudience,
    client: new FakeKmsClient({ versionName: `${keyName}/cryptoKeyVersions/1` }) as never,
  });
}

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createFixture(
  adc: unknown | ((secretRoot: string) => unknown) = x509Adc,
  client = new FakeKmsClient(),
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "xingheng-gcp-kms-")));
  const secretRoot = join(directory, "gcp-wif");
  const adcPath = join(secretRoot, "adc.json");
  const certificateConfigPath = join(secretRoot, "certificate_config.json");
  const certPath = join(secretRoot, "client-cert.pem");
  const keyPath = join(secretRoot, "client-key.pem");
  const trustChainPath = join(secretRoot, "trust-chain.pem");
  await mkdir(secretRoot, { mode: 0o700 });
  await Promise.all([
    writeFile(
      certificateConfigPath,
      JSON.stringify({
        cert_configs: {
          workload: {
            cert_path: certPath,
            key_path: keyPath,
          },
        },
      }),
      { mode: 0o400 },
    ),
    writeFile(certPath, "test-only-certificate", { mode: 0o400 }),
    writeFile(keyPath, "test-only-private-key-reference", { mode: 0o400 }),
    writeFile(trustChainPath, "test-only-trust-chain", { mode: 0o400 }),
  ]);
  const adcValue = typeof adc === "function" ? adc(secretRoot) : adc;
  await writeFile(adcPath, JSON.stringify(adcValue), { mode: 0o400 });
  const previousProvider = process.env.RWA_CREDENTIAL_KEY_PROVIDER;
  const previousMasterKey = process.env.RWA_AUTOMATION_MASTER_KEY;
  process.env.RWA_CREDENTIAL_KEY_PROVIDER = "gcp-kms";
  delete process.env.RWA_AUTOMATION_MASTER_KEY;
  const provider = new GcpKmsCredentialKeyProvider({
    keyName: RWA_GCP_KMS_KEY_NAME,
    adcPath,
    wifAudience: testWifAudience,
    secretRoot,
    expectedOwnerUid: process.getuid?.() ?? 0,
    expectedOwnerGid: process.getgid?.() ?? 0,
    client: client as never,
  });
  return {
    provider,
    client,
    directory,
    secretRoot,
    adcPath,
    certificateConfigPath,
    certPath,
    keyPath,
    trustChainPath,
    cleanup: async () => {
      if (previousProvider === undefined) delete process.env.RWA_CREDENTIAL_KEY_PROVIDER;
      else process.env.RWA_CREDENTIAL_KEY_PROVIDER = previousProvider;
      if (previousMasterKey === undefined) delete process.env.RWA_AUTOMATION_MASTER_KEY;
      else process.env.RWA_AUTOMATION_MASTER_KEY = previousMasterKey;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function alternateGroupId() {
  const current = process.getgid?.() ?? 0;
  const alternate = process.getgroups?.().find((gid) => gid !== current);
  if (alternate !== undefined) return alternate;
  if ((process.getuid?.() ?? 1) === 0) return current === 1 ? 2 : 1;
  throw new Error("GID ownership test requires a secondary local group.");
}

function x509Adc(secretRoot: string) {
  return {
    type: "external_account",
    audience: testWifAudience,
    subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
    token_url: "https://sts.mtls.googleapis.com/v1/token",
    credential_source: {
      certificate: {
        certificate_config_location: join(secretRoot, "certificate_config.json"),
        trust_chain_path: join(secretRoot, "trust-chain.pem"),
      },
    },
  };
}

type FakeIntegrityMode =
  | "valid"
  | "missing_encrypt_flags"
  | "bad_ciphertext_crc"
  | "bad_plaintext_crc";

type FakeEncryptRequest = {
  name?: string;
  plaintext?: Uint8Array | string | null;
  additionalAuthenticatedData?: Uint8Array | string | null;
  plaintextCrc32c?: { value?: unknown } | null;
  additionalAuthenticatedDataCrc32c?: { value?: unknown } | null;
};

type FakeDecryptRequest = {
  ciphertext?: Uint8Array | string | null;
  additionalAuthenticatedData?: Uint8Array | string | null;
  ciphertextCrc32c?: { value?: unknown } | null;
  additionalAuthenticatedDataCrc32c?: { value?: unknown } | null;
};

class FakeKmsClient {
  encryptCalls = 0;
  decryptCalls = 0;
  private readonly key = randomBytes(32);
  private readonly integrityMode: FakeIntegrityMode;
  private readonly versionName: string;

  constructor(options: { integrityMode?: FakeIntegrityMode; versionName?: string } = {}) {
    this.integrityMode = options.integrityMode ?? "valid";
    this.versionName = options.versionName ?? `${RWA_GCP_KMS_KEY_NAME}/cryptoKeyVersions/1`;
  }

  async encrypt(request: FakeEncryptRequest) {
    this.encryptCalls += 1;
    const plaintext = toBuffer(request.plaintext);
    const aad = toBuffer(request.additionalAuthenticatedData);
    assert.equal(crcValue(request.plaintextCrc32c), crc32c(plaintext));
    assert.equal(crcValue(request.additionalAuthenticatedDataCrc32c), crc32c(aad));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    const response: {
      name: string;
      ciphertext: Buffer;
      ciphertextCrc32c: { value: number };
      verifiedPlaintextCrc32c?: boolean;
      verifiedAdditionalAuthenticatedDataCrc32c?: boolean;
    } = {
      name: this.versionName,
      ciphertext,
      ciphertextCrc32c: {
        value: this.integrityMode === "bad_ciphertext_crc"
          ? (crc32c(ciphertext) + 1) >>> 0
          : crc32c(ciphertext),
      },
      verifiedPlaintextCrc32c: true,
      verifiedAdditionalAuthenticatedDataCrc32c: true,
    };
    if (this.integrityMode === "missing_encrypt_flags") {
      delete response.verifiedPlaintextCrc32c;
    }
    return [{
      ...response,
    }];
  }

  async decrypt(request: FakeDecryptRequest) {
    this.decryptCalls += 1;
    try {
      const payload = toBuffer(request.ciphertext);
      const aad = toBuffer(request.additionalAuthenticatedData);
      assert.equal(crcValue(request.ciphertextCrc32c), crc32c(payload));
      assert.equal(crcValue(request.additionalAuthenticatedDataCrc32c), crc32c(aad));
      const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(payload.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
      return [{
        plaintext,
        plaintextCrc32c: {
          value: this.integrityMode === "bad_plaintext_crc"
            ? (crc32c(plaintext) + 1) >>> 0
            : crc32c(plaintext),
        },
      }];
    } catch {
      throw new Error("raw-upstream-secret=must-not-leak");
    }
  }
}

class FailingKmsClient extends FakeKmsClient {
  override async encrypt(_request: FakeEncryptRequest): Promise<never> {
    throw new Error("upstream-certificate-or-key-material=must-not-leak");
  }

  override async decrypt(_request: FakeDecryptRequest): Promise<never> {
    throw new Error("upstream-certificate-or-key-material=must-not-leak");
  }
}

function toBuffer(value: Uint8Array | string | null | undefined) {
  if (!value) return Buffer.alloc(0);
  return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
}

function crcValue(value: { value?: unknown } | null | undefined) {
  if (!value || value.value === null || value.value === undefined) return null;
  return Number(String(value.value));
}

function hasCategory(category: string) {
  return (error: unknown) =>
    error instanceof CredentialKeyProviderError && error.category === category;
}
