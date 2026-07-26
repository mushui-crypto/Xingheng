export type DeploymentEnvironment = "production" | "real-test" | "test" | "development";

export type DeploymentIdentity = {
  environment: DeploymentEnvironment;
  composeProject: string;
  publicDomain: string;
  credentialDomain: DeploymentEnvironment;
  userCookieName: string;
  adminCookieName: string;
};

const PRODUCTION_PROJECT = "xingheng";
const REAL_TEST_PROJECT = "xingheng-real-test";

export function loadDeploymentIdentity(): DeploymentIdentity {
  if (process.env.NODE_ENV !== "production") {
    const environment = process.env.NODE_ENV === "test" ? "test" : "development";
    return {
      environment,
      composeProject: environment,
      publicDomain: "",
      credentialDomain: environment,
      userCookieName: "xh_user_session",
      adminCookieName: "xh_admin_session",
    };
  }

  const environment = process.env.XINGHENG_DEPLOYMENT_ENVIRONMENT?.trim();
  if (environment !== "production" && environment !== "real-test") {
    throw new Error("XINGHENG_DEPLOYMENT_ENVIRONMENT 必须精确为 production 或 real-test。");
  }
  const composeProject = process.env.XINGHENG_COMPOSE_PROJECT?.trim() ?? "";
  const expectedProject = environment === "production" ? PRODUCTION_PROJECT : REAL_TEST_PROJECT;
  if (composeProject !== expectedProject) {
    throw new Error("部署环境身份与固定 Compose 项目不一致。");
  }

  const domain = process.env.DOMAIN?.trim() ?? "";
  const realTestDomain = process.env.REAL_TEST_DOMAIN?.trim() ?? "";
  const publicDomain = environment === "production" ? domain : realTestDomain;
  if (!isDomain(publicDomain)) {
    throw new Error("部署环境必须绑定有效的纯域名。");
  }
  if (environment === "real-test" && domain !== realTestDomain) {
    throw new Error("真实测试 API 的 DOMAIN 必须精确绑定 REAL_TEST_DOMAIN。");
  }

  const expectedWifHostPath = environment === "production"
    ? "/run/xingheng/gcp-wif"
    : "/run/xingheng-real-test/gcp-wif";
  if (process.env.XINGHENG_WIF_HOST_PATH !== expectedWifHostPath) {
    throw new Error("部署环境 WIF 挂载身份不一致。");
  }

  return {
    environment,
    composeProject,
    publicDomain,
    credentialDomain: environment,
    userCookieName: environment === "production"
      ? "xh_user_session"
      : "xh_real_test_user_session",
    adminCookieName: environment === "production"
      ? "xh_admin_session"
      : "xh_real_test_admin_session",
  };
}

function isDomain(value: string) {
  return !value.includes("://")
    && !value.includes("/")
    && !value.includes(":")
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(value);
}
