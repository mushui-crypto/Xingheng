export type DeploymentEnvironment = "production" | "test" | "development";

export type DeploymentIdentity = {
  environment: DeploymentEnvironment;
  composeProject: string;
  publicDomain: string;
  credentialDomain: DeploymentEnvironment;
  userCookieName: string;
  adminCookieName: string;
};

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

  const publicDomain = process.env.DOMAIN?.trim() ?? "";
  if (!isDomain(publicDomain)) {
    throw new Error("部署环境必须绑定有效的纯域名。");
  }

  return {
    environment: "production",
    composeProject: "xingheng",
    publicDomain,
    credentialDomain: "production",
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
