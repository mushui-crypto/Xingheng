import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const RWA_GCP_WIF_SECRET_ROOT = "/run/secrets/gcp-wif";
export const RWA_GCP_WIF_ADC_PATH = `${RWA_GCP_WIF_SECRET_ROOT}/adc.json`;
export const RWA_GCP_WIF_CERTIFICATE_CONFIG_PATH = `${RWA_GCP_WIF_SECRET_ROOT}/certificate_config.json`;
export const RWA_GCP_WIF_TRUST_CHAIN_PATH = `${RWA_GCP_WIF_SECRET_ROOT}/trust-chain.pem`;
export const RWA_GCP_WIF_MTLS_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:mtls";
export const RWA_GCP_STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";

type WifValidationOptions = {
  adcPath: string;
  expectedAudience: string;
  secretRoot?: string;
  expectedOwnerUid?: number;
};

export class GcpWifConfigurationError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export function isCanonicalGcpWifAudience(value: string) {
  return /^\/\/iam\.googleapis\.com\/projects\/[1-9]\d{5,19}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/.test(value);
}

export function validateGcpWifCredentialFiles(options: WifValidationOptions) {
  const secretRoot = resolve(options.secretRoot ?? RWA_GCP_WIF_SECRET_ROOT);
  const expectedOwnerUid = options.expectedOwnerUid ?? 0;
  if (!isCanonicalGcpWifAudience(options.expectedAudience)) {
    throw rejected("受信 WIF audience/provider 配置无效。");
  }

  const adcPath = secureFile(options.adcPath, secretRoot, expectedOwnerUid, "ADC");
  const adc = jsonObject(adcPath, "ADC");
  assertExactKeys(adc, ["audience", "credential_source", "subject_token_type", "token_url", "type"], "ADC");
  if (
    adc.type !== "external_account"
    || adc.audience !== options.expectedAudience
    || adc.subject_token_type !== RWA_GCP_WIF_MTLS_SUBJECT_TOKEN_TYPE
    || adc.token_url !== RWA_GCP_STS_TOKEN_URL
  ) {
    throw rejected("X.509 WIF ADC 身份域不受信任。");
  }
  if (containsSensitiveCredentialMaterial(adc)) {
    throw rejected("X.509 WIF ADC 包含不允许的长期身份材料。");
  }

  const source = object(adc.credential_source, "ADC credential_source");
  assertExactKeys(source, ["certificate"], "ADC credential_source");
  const certificate = object(source.certificate, "ADC certificate source");
  assertExactKeys(
    certificate,
    ["certificate_config_location", "trust_chain_path"],
    "ADC certificate source",
  );

  const expectedCertificateConfigPath = resolve(secretRoot, "certificate_config.json");
  const expectedTrustChainPath = resolve(secretRoot, "trust-chain.pem");
  if (
    certificate.certificate_config_location !== expectedCertificateConfigPath
    || certificate.trust_chain_path !== expectedTrustChainPath
  ) {
    throw rejected("X.509 WIF certificate source 路径不符合冻结配置。");
  }

  const certificateConfigPath = secureFile(
    certificate.certificate_config_location,
    secretRoot,
    expectedOwnerUid,
    "certificate config",
  );
  secureFile(certificate.trust_chain_path, secretRoot, expectedOwnerUid, "trust chain");

  const certificateConfig = jsonObject(certificateConfigPath, "certificate config");
  assertExactKeys(certificateConfig, ["cert_configs"], "certificate config");
  const certConfigs = object(certificateConfig.cert_configs, "certificate config cert_configs");
  assertExactKeys(certConfigs, ["workload"], "certificate config cert_configs");
  const workload = object(certConfigs.workload, "certificate config workload");
  assertExactKeys(workload, ["cert_path", "key_path"], "certificate config workload");
  if (typeof workload.cert_path !== "string" || typeof workload.key_path !== "string") {
    throw rejected("X.509 WIF certificate config 字段无效。");
  }
  secureFile(workload.cert_path, secretRoot, expectedOwnerUid, "certificate");
  secureFile(workload.key_path, secretRoot, expectedOwnerUid, "private key");
}

function secureFile(path: unknown, secretRoot: string, expectedOwnerUid: number, label: string) {
  if (typeof path !== "string" || !path) throw unavailable(`${label} 文件不可用。`);
  const absolutePath = resolve(path);
  const rootPath = resolve(secretRoot);
  let rootRealPath: string;
  try {
    const rootMetadata = lstatSync(rootPath);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw rejected("WIF secret 根目录不安全。");
    }
    rootRealPath = realpathSync(rootPath);
  } catch (error) {
    if (error instanceof GcpWifConfigurationError) throw error;
    throw unavailable("WIF secret 根目录不可用。");
  }
  if (!within(rootRealPath, absolutePath)) throw rejected(`${label} 文件超出受信 secret 目录。`);

  try {
    const linkMetadata = lstatSync(absolutePath);
    if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
      throw rejected(`${label} 文件类型不安全。`);
    }
    const realPath = realpathSync(absolutePath);
    const metadata = statSync(realPath);
    if (realPath !== absolutePath || !within(rootRealPath, realPath)) {
      throw rejected(`${label} 文件路径不安全。`);
    }
    if (!metadata.isFile() || metadata.uid !== expectedOwnerUid || (metadata.mode & 0o777) !== 0o400) {
      throw rejected(`${label} 文件权限不安全。`);
    }
    return realPath;
  } catch (error) {
    if (error instanceof GcpWifConfigurationError) throw error;
    throw unavailable(`${label} 文件不可用。`);
  }
}

function within(root: string, path: string) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !child.includes(`${sep}..${sep}`);
}

function jsonObject(path: string, label: string) {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")), label);
  } catch (error) {
    if (error instanceof GcpWifConfigurationError) throw error;
    throw rejected(`${label} 文件格式无效。`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected(`${label} 结构无效。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw rejected(`${label} 包含不受支持的字段。`);
  }
}

function containsSensitiveCredentialMaterial(value: unknown): boolean {
  if (typeof value === "string") return /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(value);
  if (Array.isArray(value)) return value.some(containsSensitiveCredentialMaterial);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    ["private_key", "private_key_id", "client_email"].includes(key) || containsSensitiveCredentialMaterial(entry));
}

function rejected(message: string) {
  return new GcpWifConfigurationError("credential_key_provider_auth_rejected", message);
}

function unavailable(message: string) {
  return new GcpWifConfigurationError("credential_key_provider_auth_unavailable", message);
}
