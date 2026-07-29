export const RWA_GCP_KMS_AUTH_MODE_X509_WIF = "x509_wif";
export const RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT =
  "gce_attached_service_account";
export const RWA_REAL_TEST_GCE_PROJECT_ID = "xingheng-real-test";

export type RwaGcpKmsAuthMode =
  | typeof RWA_GCP_KMS_AUTH_MODE_X509_WIF
  | typeof RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT;

export function isRwaGcpKmsAuthMode(value: string): value is RwaGcpKmsAuthMode {
  return value === RWA_GCP_KMS_AUTH_MODE_X509_WIF
    || value === RWA_GCP_KMS_AUTH_MODE_GCE_ATTACHED_SERVICE_ACCOUNT;
}

export function isValidRealTestGceServiceAccountEmail(value: string) {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]@xingheng-real-test\.iam\.gserviceaccount\.com$/.test(value)
    && !value.includes("replace");
}

export const RWA_GCE_FORBIDDEN_CREDENTIAL_ENVIRONMENT = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "CLOUDSDK_CONFIG",
  "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT",
  "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
  "GCE_METADATA_HOST",
  "GCE_METADATA_IP",
  "NO_GCE_CHECK",
] as const;
