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
    DOMAIN: "app.example.com",
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

test("production safety mode rejects missing, unknown or crossed deployment identity fields", () => {
  const cases = [
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: undefined,
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "staging",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
      XINGHENG_COMPOSE_PROJECT: "other-project",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/other/gcp-wif",
    },
    {
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
      DOMAIN: "invalid",
    },
  ];
  for (const values of cases) {
    withEnvironment({
      NODE_ENV: "production",
      DOMAIN: "app.example.com",
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
