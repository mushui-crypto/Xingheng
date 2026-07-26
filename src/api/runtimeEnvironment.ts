import { requestJson } from "./httpClient";

export type RuntimeEnvironmentIdentity =
  | {
      deploymentEnvironment: "production";
      composeProject: "xingheng";
    }
  | {
      deploymentEnvironment: "real-test";
      composeProject: "xingheng-real-test";
    };

export class RuntimeEnvironmentValidationError extends Error {
  constructor() {
    super("环境信息校验失败，请重新获取后继续操作。");
    this.name = "RuntimeEnvironmentValidationError";
  }
}

export async function fetchRuntimeEnvironmentIdentity(signal?: AbortSignal) {
  const payload = await requestJson<unknown>(
    "/api/health",
    "环境信息获取失败，请稍后重试。",
    {
      init: {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      },
      networkErrorMessage: "环境信息获取失败，请检查网络后重试。",
    },
  );

  return parseRuntimeEnvironmentIdentity(payload);
}

export function parseRuntimeEnvironmentIdentity(payload: unknown): RuntimeEnvironmentIdentity {
  if (!payload || typeof payload !== "object") {
    throw new RuntimeEnvironmentValidationError();
  }

  const deploymentEnvironment = Reflect.get(payload, "deploymentEnvironment");
  const composeProject = Reflect.get(payload, "composeProject");

  if (deploymentEnvironment === "production" && composeProject === "xingheng") {
    return { deploymentEnvironment, composeProject };
  }
  if (deploymentEnvironment === "real-test" && composeProject === "xingheng-real-test") {
    return { deploymentEnvironment, composeProject };
  }

  throw new RuntimeEnvironmentValidationError();
}
