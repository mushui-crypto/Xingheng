export type DeploymentEnvironment = "production" | "test" | "development";

export type DeploymentIdentity = {
  environment: DeploymentEnvironment;
  composeProject: string;
  publicDomain: string;
  credentialDomain: DeploymentEnvironment;
  userCookieName: string;
  adminCookieName: string;
};

const PRODUCTION_PROJECT = "xingheng";

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
  if (environment !== "production") {
    throw new Error("XINGHENG_DEPLOYMENT_ENVIRONMENT 必须精确为 production。");
  }
  const composeProject = process.env.XINGHENG_COMPOSE_PROJECT?.trim() ?? "";
  if (composeProject !== PRODUCTION_PROJECT) {
    throw new Error("部署环境身份与固定 Compose 项目不一致。");
  }

  const publicDomain = process.env.DOMAIN?.trim() ?? "";
  if (!isDomain(publicDomain)) {
    throw new Error("部署环境必须绑定有效的纯域名。");
  }

  if (process.env.XINGHENG_WIF_HOST_PATH !== "/run/xingheng/gcp-wif") {
    throw new Error("部署环境 WIF 挂载身份不一致。");
  }

  return {
    environment,
    composeProject,
    publicDomain,
    credentialDomain: environment,
    userCookieName: "xh_user_session",
    adminCookieName: "xh_admin_session",
  };
}

function isDomain(value: string) {
  return !value.includes("://")
    && !value.includes("/")
    && !value.includes(":")
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(value);
}
