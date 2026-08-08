import assert from "node:assert/strict";
import test from "node:test";
import { loadDeploymentIdentity } from "./deploymentEnvironment";

test("production derives from NODE_ENV without legacy deployment identity variables", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    domain: process.env.DOMAIN,
    environment: process.env.XINGHENG_DEPLOYMENT_ENVIRONMENT,
    composeProject: process.env.XINGHENG_COMPOSE_PROJECT,
  };
  try {
    process.env.NODE_ENV = "production";
    process.env.DOMAIN = "app.stellaxtrade.com";
    delete process.env.XINGHENG_DEPLOYMENT_ENVIRONMENT;
    delete process.env.XINGHENG_COMPOSE_PROJECT;

    assert.deepEqual(loadDeploymentIdentity(), {
      environment: "production",
      composeProject: "xingheng",
      publicDomain: "app.stellaxtrade.com",
      credentialDomain: "production",
      userCookieName: "xh_user_session",
      adminCookieName: "xh_admin_session",
    });
  } finally {
    restore("NODE_ENV", previous.nodeEnv);
    restore("DOMAIN", previous.domain);
    restore("XINGHENG_DEPLOYMENT_ENVIRONMENT", previous.environment);
    restore("XINGHENG_COMPOSE_PROJECT", previous.composeProject);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
