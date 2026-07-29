import assert from "node:assert/strict";
import test from "node:test";
import { credentialEnvironment } from "../modules/arbitrage/automation/CredentialKeyProvider";
import { adminCookieName, userCookieName } from "../modules/auth/session";
import { loadDeploymentIdentity } from "./deploymentEnvironment";

test("production identity preserves the established project and cookie namespace", () => {
  withEnvironment({
    NODE_ENV: "production",
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
    XINGHENG_COMPOSE_PROJECT: "xingheng",
    XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
    RWA_GCP_KMS_AUTH_MODE: "x509_wif",
    DOMAIN: "app.example.com",
    REAL_TEST_DOMAIN: "test.example.com",
  }, () => {
    const identity = loadDeploymentIdentity();
    assert.equal(identity.environment, "production");
    assert.equal(identity.composeProject, "xingheng");
    assert.equal(identity.publicDomain, "app.example.com");
    assert.equal(userCookieName(), "xh_user_session");
    assert.equal(adminCookieName(), "xh_admin_session");
    assert.equal(credentialEnvironment(), "production");
  });
});

test("real-test identity uses a distinct project, domain, cookie namespace, and AAD domain", () => {
  withEnvironment({
    NODE_ENV: "production",
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
    XINGHENG_COMPOSE_PROJECT: "xingheng-real-test",
    XINGHENG_WIF_HOST_PATH: undefined,
    RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
    DOMAIN: "test.example.com",
    REAL_TEST_DOMAIN: "test.example.com",
  }, () => {
    const identity = loadDeploymentIdentity();
    assert.equal(identity.environment, "real-test");
    assert.equal(identity.composeProject, "xingheng-real-test");
    assert.equal(identity.publicDomain, "test.example.com");
    assert.equal(userCookieName(), "xh_real_test_user_session");
    assert.equal(adminCookieName(), "xh_real_test_admin_session");
    assert.equal(credentialEnvironment(), "real-test");
  });
});

test("production safety mode rejects missing or crossed deployment identity fields", () => {
  const cases = [
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: undefined,
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
      RWA_GCP_KMS_AUTH_MODE: "x509_wif",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng-real-test/gcp-wif",
      RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
      XINGHENG_COMPOSE_PROJECT: "xingheng-real-test",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
      RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
      XINGHENG_COMPOSE_PROJECT: "xingheng-real-test",
      XINGHENG_WIF_HOST_PATH: "",
      RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
      XINGHENG_COMPOSE_PROJECT: "xingheng-real-test",
      XINGHENG_WIF_HOST_PATH: undefined,
      RWA_GCP_KMS_AUTH_MODE: "gce_attached_service_account",
      DOMAIN: "app.example.com",
    },
  ];
  for (const values of cases) {
    withEnvironment({
      NODE_ENV: "production",
      DOMAIN: "test.example.com",
      REAL_TEST_DOMAIN: "test.example.com",
      ...values,
    }, () => assert.throws(() => loadDeploymentIdentity()));
  }
});

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
