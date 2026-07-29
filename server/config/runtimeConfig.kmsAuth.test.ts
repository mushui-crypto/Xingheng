import assert from "node:assert/strict";
import test from "node:test";
import { validateRwaKmsAuthenticationRuntime } from "./runtimeConfig";

const expectedServiceAccount =
  "rwa-real-test-vm@xingheng-real-test.iam.gserviceaccount.com";

test("real-test runtime accepts only the attached GCE service account metadata mode", () => {
  withEnvironment(metadataEnvironment(), () => {
    assert.doesNotThrow(() => validateRwaKmsAuthenticationRuntime("real-test"));
  });
});

test("real-test runtime rejects WIF, file credentials, overrides, impersonation, and invalid service account", () => {
  const cases: Array<Record<string, string | undefined>> = [
    { RWA_GCP_KMS_AUTH_MODE: "x509_wif" },
    { RWA_GCP_WIF_AUDIENCE: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v" },
    { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/service-account.json" },
    { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/adc.json" },
    { CLOUDSDK_CONFIG: "/tmp/gcloud" },
    { GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: "other@example.invalid" },
    { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "other@example.invalid" },
    { GCE_METADATA_HOST: "example.invalid" },
    { GCE_METADATA_IP: "127.0.0.1" },
    { NO_GCE_CHECK: "true" },
    { XINGHENG_WIF_HOST_PATH: "/run/xingheng-real-test/gcp-wif" },
    { RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL: "replace@example.invalid" },
  ];
  for (const override of cases) {
    withEnvironment({ ...metadataEnvironment(), ...override }, () => {
      assert.throws(() => validateRwaKmsAuthenticationRuntime("real-test"));
    });
  }
  for (const name of [
    "RWA_GCP_WIF_AUDIENCE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "CLOUDSDK_CONFIG",
    "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT",
    "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
    "GCE_METADATA_HOST",
    "GCE_METADATA_IP",
    "NO_GCE_CHECK",
    "XINGHENG_WIF_HOST_PATH",
    "RWA_AUTOMATION_MASTER_KEY",
  ]) {
    withEnvironment({ ...metadataEnvironment(), [name]: "" }, () => {
      assert.throws(
        () => validateRwaKmsAuthenticationRuntime("real-test"),
        /禁止 WIF、文件凭证、Cloud SDK 覆盖或服务账号模拟/,
      );
    });
  }
});

test("production runtime and non-deployment environments reject metadata mode", () => {
  withEnvironment(metadataEnvironment(), () => {
    assert.throws(
      () => validateRwaKmsAuthenticationRuntime("production"),
      /正式环境只允许 x509_wif/,
    );
    assert.throws(
      () => validateRwaKmsAuthenticationRuntime("development"),
      /只允许 production 或 real-test/,
    );
  });
  withEnvironment({
    RWA_GCP_KMS_AUTH_MODE: "x509_wif",
    RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL: "",
  }, () => {
    assert.throws(
      () => validateRwaKmsAuthenticationRuntime("production"),
      /禁止配置 real-test GCE/,
    );
  });
});

function metadataEnvironment() {
  return {
    RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
    RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL: expectedServiceAccount,
    RWA_GCP_WIF_AUDIENCE: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: undefined,
    CLOUDSDK_CONFIG: undefined,
    GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: undefined,
    CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: undefined,
    GCE_METADATA_HOST: undefined,
    GCE_METADATA_IP: undefined,
    NO_GCE_CHECK: undefined,
    XINGHENG_WIF_HOST_PATH: undefined,
    RWA_AUTOMATION_MASTER_KEY: undefined,
  };
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
