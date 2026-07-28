import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export const WIF_LOGICAL_ROOT = "/run/secrets/gcp-wif";
export const WIF_RUNTIME_UID = 20001;
export const WIF_RUNTIME_GID = 20001;
const ADC_NAME = "adc.json";
const CERTIFICATE_CONFIG_NAME = "certificate_config.json";
const TRUST_CHAIN_NAME = "trust-chain.pem";
const SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:mtls";
const STS_URL = "https://sts.mtls.googleapis.com/v1/token";
const AUDIENCE_PATTERN = /^\/\/iam\.googleapis\.com\/projects\/[1-9]\d{5,19}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/u;
const WIF_PROFILES = new Set(["production", "real-test"]);

export function readExpectedAudience(path, expectedUid = process.getuid?.(), expectedGid = process.getgid?.()) {
  const value = readStrictFile(path, expectedUid, expectedGid, 0o400, 4096).trim();
  if (!AUDIENCE_PATTERN.test(value)) throw new Error("WIF expected audience is invalid");
  return value;
}

export function validateWifBundle(
  root,
  expectedAudience,
  profile,
  {
    expectedUid = process.getuid?.(),
    expectedGid = process.getgid?.(),
    logicalRoot = WIF_LOGICAL_ROOT,
  } = {},
) {
  assertWifProfile(profile);
  if (!AUDIENCE_PATTERN.test(expectedAudience)) throw new Error("WIF expected audience is invalid");
  const absoluteRoot = resolve(root);
  const rootMetadata = lstatSync(absoluteRoot);
  if (
    !rootMetadata.isDirectory()
    || rootMetadata.isSymbolicLink()
    || rootMetadata.uid !== expectedUid
    || rootMetadata.gid !== expectedGid
    || (rootMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("WIF bundle root boundary is invalid");
  }

  const adc = jsonObject(
    readStrictFile(join(absoluteRoot, ADC_NAME), expectedUid, expectedGid, 0o400, 64 * 1024),
    "WIF ADC",
  );
  exactKeys(adc, ["audience", "credential_source", "subject_token_type", "token_url", "type"], "WIF ADC");
  if (
    adc.type !== "external_account"
    || adc.audience !== expectedAudience
    || adc.subject_token_type !== SUBJECT_TOKEN_TYPE
    || adc.token_url !== STS_URL
    || containsForbiddenIdentityMaterial(adc)
  ) {
    throw new Error("WIF ADC identity boundary is invalid");
  }
  const source = record(adc.credential_source, "WIF credential source");
  exactKeys(source, ["certificate"], "WIF credential source");
  const certificate = record(source.certificate, "WIF certificate source");
  const certificateKeys = profile === "production"
    ? ["certificate_config_location", "trust_chain_path"]
    : ["certificate_config_location"];
  exactKeys(certificate, certificateKeys, "WIF certificate source");
  if (certificate.certificate_config_location !== `${logicalRoot}/${CERTIFICATE_CONFIG_NAME}`) {
    throw new Error("WIF certificate source boundary is invalid");
  }
  if (
    profile === "production"
    && certificate.trust_chain_path !== `${logicalRoot}/${TRUST_CHAIN_NAME}`
  ) throw new Error("WIF certificate source boundary is invalid");

  const certificateConfig = jsonObject(
    readStrictFile(
      join(absoluteRoot, CERTIFICATE_CONFIG_NAME),
      expectedUid,
      expectedGid,
      0o400,
      64 * 1024,
    ),
    "WIF certificate config",
  );
  exactKeys(certificateConfig, ["cert_configs"], "WIF certificate config");
  const certConfigs = record(certificateConfig.cert_configs, "WIF cert configs");
  exactKeys(certConfigs, ["workload"], "WIF cert configs");
  const workload = record(certConfigs.workload, "WIF workload config");
  exactKeys(workload, ["cert_path", "key_path"], "WIF workload config");
  const certificateName = logicalFileName(workload.cert_path, logicalRoot, "WIF certificate");
  const keyName = logicalFileName(workload.key_path, logicalRoot, "WIF private key");
  const fileNames = [
    ADC_NAME,
    CERTIFICATE_CONFIG_NAME,
    ...(profile === "production" ? [TRUST_CHAIN_NAME] : []),
    certificateName,
    keyName,
  ];
  if (new Set(fileNames).size !== fileNames.length) throw new Error("WIF bundle file mapping is invalid");
  for (const name of fileNames) {
    readStrictFile(join(absoluteRoot, name), expectedUid, expectedGid, 0o400, 1024 * 1024);
  }
  const actual = readdirSync(absoluteRoot).sort();
  const expected = [...fileNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("WIF bundle contains unknown or missing files");
  }
  return Object.freeze({ fileNames: Object.freeze(fileNames) });
}

export function copyWifBundle(sourceRoot, destinationRoot, expectedAudience, profile) {
  const sourceUid = process.getuid?.();
  const sourceGid = process.getgid?.();
  const bundle = validateWifBundle(sourceRoot, expectedAudience, profile, {
    expectedUid: sourceUid,
    expectedGid: sourceGid,
  });
  for (const name of bundle.fileNames) {
    const source = join(resolve(sourceRoot), name);
    const destination = join(resolve(destinationRoot), name);
    const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content;
    try {
      const opened = fstatSync(sourceFd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== sourceUid || opened.gid !== sourceGid) {
        throw new Error("WIF source file changed during installation");
      }
      content = readFileSync(sourceFd);
    } finally {
      closeSync(sourceFd);
    }
    const destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    try {
      writeFileSync(destinationFd, content);
      fchownSync(destinationFd, WIF_RUNTIME_UID, WIF_RUNTIME_GID);
      fchmodSync(destinationFd, 0o400);
    } finally {
      closeSync(destinationFd);
      content.fill(0);
    }
  }
  return validateWifBundle(destinationRoot, expectedAudience, profile, {
    expectedUid: WIF_RUNTIME_UID,
    expectedGid: WIF_RUNTIME_GID,
  });
}

function assertWifProfile(profile) {
  if (!WIF_PROFILES.has(profile)) {
    throw new Error("WIF profile must be production or real-test");
  }
}

function readStrictFile(path, expectedUid, expectedGid, expectedMode, maxBytes) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new Error("WIF bundle file boundary is invalid");
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.uid !== expectedUid
    || before.gid !== expectedGid
    || (before.mode & 0o777) !== expectedMode
    || before.size < 1
    || before.size > maxBytes
  ) {
    throw new Error("WIF bundle file boundary is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.uid !== expectedUid
      || opened.gid !== expectedGid
      || (opened.mode & 0o777) !== expectedMode
    ) {
      throw new Error("WIF bundle file changed during validation");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function logicalFileName(value, logicalRoot, label) {
  if (typeof value !== "string" || !value.startsWith(`${logicalRoot}/`)) {
    throw new Error(`${label} path is invalid`);
  }
  const name = value.slice(logicalRoot.length + 1);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)
    || basename(name) !== name
    || [ADC_NAME, CERTIFICATE_CONFIG_NAME, TRUST_CHAIN_NAME].includes(name)
  ) {
    throw new Error(`${label} path is invalid`);
  }
  return name;
}

function jsonObject(value, label) {
  try {
    return record(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} format is invalid`);
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} structure is invalid`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} schema is invalid`);
  }
}

function containsForbiddenIdentityMaterial(value) {
  if (typeof value === "string") return /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenIdentityMaterial);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) =>
    ["private_key", "private_key_id", "client_email"].includes(key)
    || containsForbiddenIdentityMaterial(entry));
}
