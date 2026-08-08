import assert from "node:assert/strict";
import test from "node:test";
import { CredentialKeyProviderError, canonicalCredentialAad, type CredentialKeyContext } from "./CredentialKeyProvider";
import { GcpKmsCredentialKeyProvider, crc32c } from "./GcpKmsCredentialKeyProvider";

const keyName = "projects/test-project/locations/global/keyRings/test-ring/cryptoKeys/credential-key";
const context: CredentialKeyContext = {
  userId: "user-1",
  venue: "binance",
  accountId: "binance:account-1",
  environment: "test",
};

test("uses KMS CRC32C integrity fields for wrap and unwrap", async () => {
  const client = new FakeKmsClient();
  const provider = new GcpKmsCredentialKeyProvider({ keyName, client: client as never });
  const created = await provider.createDataKey(context);
  assert.equal(created.plaintextDek.length, 32);
  assert.equal(client.encryptRequest?.plaintextCrc32c.value, crc32c(created.plaintextDek));
  assert.equal(
    client.encryptRequest?.additionalAuthenticatedDataCrc32c.value,
    crc32c(canonicalCredentialAad(context)),
  );

  const recovered = await provider.unwrapDataKey(created, context);
  assert.deepEqual(recovered, created.plaintextDek);
  assert.equal(client.decryptRequest?.ciphertextCrc32c.value, crc32c(Buffer.from(created.wrappedDek, "base64url")));
  recovered.fill(0);
  created.plaintextDek.fill(0);
});

test("rejects a KMS response with invalid integrity metadata", async () => {
  const client = new FakeKmsClient();
  client.validEncryptIntegrity = false;
  const provider = new GcpKmsCredentialKeyProvider({ keyName, client: client as never });
  await assert.rejects(
    provider.createDataKey(context),
    (error: unknown) => error instanceof CredentialKeyProviderError && error.category === "credential_key_integrity_failed",
  );
});

test("requires a full CryptoKey resource name without deployment identity gates", () => {
  const provider = new GcpKmsCredentialKeyProvider({ keyName: "credential-key" });
  assert.equal(provider.configured, false);
  assert.match(provider.configurationError ?? "", /full CryptoKey resource name/u);
});

test("CRC32C matches the standard test vector", () => {
  assert.equal(crc32c(Buffer.from("123456789")), 0xe3069283);
});

class FakeKmsClient {
  encryptRequest: any = null;
  decryptRequest: any = null;
  plaintext: Buffer | null = null;
  validEncryptIntegrity = true;

  async encrypt(request: any) {
    this.encryptRequest = request;
    this.plaintext = Buffer.from(request.plaintext);
    const ciphertext = Buffer.from(`wrapped:${Buffer.from(request.plaintext).toString("base64url")}`);
    return [{
      name: `${keyName}/cryptoKeyVersions/1`,
      ciphertext,
      ciphertextCrc32c: { value: crc32c(ciphertext) },
      verifiedPlaintextCrc32c: this.validEncryptIntegrity,
      verifiedAdditionalAuthenticatedDataCrc32c: this.validEncryptIntegrity,
    }];
  }

  async decrypt(request: any) {
    this.decryptRequest = request;
    const plaintext = Buffer.from(this.plaintext!);
    return [{ plaintext, plaintextCrc32c: { value: crc32c(plaintext) } }];
  }
}
