import type { RuntimeEnvironmentIdentity } from "../../api/runtimeEnvironment";

export type RuntimeEnvironmentStatus = "checking" | "verified" | "error";

export type RuntimeEnvironmentState = {
  status: RuntimeEnvironmentStatus;
  identity: RuntimeEnvironmentIdentity | null;
  message: string | null;
};

export type RuntimeEnvironmentRequestToken = {
  generation: number;
  scope: string;
};

export const initialRuntimeEnvironmentState: RuntimeEnvironmentState = {
  status: "checking",
  identity: null,
  message: null,
};

export function beginRuntimeEnvironmentCheck(
  previous: RuntimeEnvironmentState,
): RuntimeEnvironmentState {
  return {
    status: "checking",
    identity: retainVisibleIdentity(previous.identity),
    message: null,
  };
}

export function failRuntimeEnvironmentCheck(
  previous: RuntimeEnvironmentState,
  message: string,
): RuntimeEnvironmentState {
  return {
    status: "error",
    identity: retainVisibleIdentity(previous.identity),
    message,
  };
}

export function createRuntimeEnvironmentRequestGuard() {
  let generation = 0;
  let activeScope = "";

  return {
    begin(scope: string): RuntimeEnvironmentRequestToken {
      activeScope = scope;
      generation += 1;
      return { generation, scope };
    },
    isCurrent(token: RuntimeEnvironmentRequestToken) {
      return token.generation === generation && token.scope === activeScope;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export function runtimeEnvironmentAllowsSensitiveOperations(
  state: RuntimeEnvironmentState,
) {
  return state.status === "verified";
}

function retainVisibleIdentity(identity: RuntimeEnvironmentIdentity | null) {
  return identity?.deploymentEnvironment === "real-test" ? identity : null;
}
