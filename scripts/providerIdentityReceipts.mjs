import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const MAX_AGE_MS = 10 * 60 * 1000;

export function validateProviderIdentityReceipt(value, expectedEnvironment, now = new Date()) {
  const expectedProject = expectedEnvironment === "production"
    ? "xingheng"
    : expectedEnvironment === "real-test"
      ? "xingheng-real-test"
      : null;
  if (
    expectedProject === null
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "accountIdentitySha256", "composeProject", "credentialBindingSha256",
      "deploymentEnvironment", "provider", "readOnly", "revision", "schemaVersion",
      "verifiedAt",
    ].sort().join(",")
    || value.schemaVersion !== 1
    || value.provider !== "binance"
    || value.deploymentEnvironment !== expectedEnvironment
    || value.composeProject !== expectedProject
    || value.readOnly !== true
    || !REVISION.test(value.revision ?? "")
    || !SHA256.test(value.accountIdentitySha256 ?? "")
    || !SHA256.test(value.credentialBindingSha256 ?? "")
  ) throw new Error("provider identity receipt schema is invalid");
  const verifiedAt = Date.parse(value.verifiedAt);
  if (
    !Number.isFinite(verifiedAt)
    || verifiedAt > now.getTime() + 30_000
    || now.getTime() - verifiedAt > MAX_AGE_MS
  ) throw new Error("provider identity receipt is stale");
  return value;
}

export function compareProviderIdentityReceipts(production, realTest, now = new Date()) {
  const prod = validateProviderIdentityReceipt(production, "production", now);
  const test = validateProviderIdentityReceipt(realTest, "real-test", now);
  if (prod.revision !== test.revision) {
    throw new Error("provider identity receipt revision mismatch");
  }
  if (prod.accountIdentitySha256 === test.accountIdentitySha256) {
    throw new Error("production and real-test resolve to the same authoritative provider account");
  }
  return {
    schemaVersion: 1,
    provider: "binance",
    revision: prod.revision,
    productionBound: true,
    realTestBound: true,
    authoritativeAccountsDistinct: true,
    comparedAt: now.toISOString(),
  };
}

function readSecureReceipt(path, testMode) {
  const before = lstatSync(path);
  const expectedUid = testMode ? (process.getuid?.() ?? -1) : 0;
  const expectedGid = testMode ? (process.getgid?.() ?? -1) : 0;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || before.gid !== expectedGid
    || ![0o400, 0o600].includes(before.mode & 0o777)
    || before.size < 2
    || before.size > 16 * 1024
  ) throw new Error("provider identity receipt file boundary is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs
    ) throw new Error("provider identity receipt changed while opening");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) throw new Error("provider identity receipt changed while reading");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

async function main() {
  if (process.argv.length !== 4) {
    throw new Error("usage: providerIdentityReceipts.mjs PRODUCTION_RECEIPT REAL_TEST_RECEIPT");
  }
  const testMode = process.env.NODE_ENV === "test"
    && process.env.NODE_TEST_CONTEXT === "child-v8";
  if (!testMode && (process.platform !== "linux" || process.getuid?.() !== 0)) {
    throw new Error("provider identity receipt comparison requires controlled root on Linux");
  }
  const result = compareProviderIdentityReceipts(
    readSecureReceipt(process.argv[2], testMode),
    readSecureReceipt(process.argv[3], testMode),
  );
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "provider identity receipt comparison failed");
    process.exit(1);
  });
}
