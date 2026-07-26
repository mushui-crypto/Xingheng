import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchRuntimeEnvironmentIdentity } from "../../api/runtimeEnvironment";
import { useAdminAuthStore } from "../../store/adminAuthStore";
import { useAuthStore } from "../../store/authStore";
import {
  beginRuntimeEnvironmentCheck,
  createRuntimeEnvironmentRequestGuard,
  failRuntimeEnvironmentCheck,
  initialRuntimeEnvironmentState,
  type RuntimeEnvironmentState,
} from "./runtimeEnvironmentState";

type RuntimeEnvironmentContextValue = {
  retry: () => void;
  state: RuntimeEnvironmentState;
};

const RuntimeEnvironmentContext = createContext<RuntimeEnvironmentContextValue | null>(null);

export function RuntimeEnvironmentProvider({ children }: { children: ReactNode }) {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const isAdminLoggedIn = useAdminAuthStore((state) => state.isAdminLoggedIn);
  const [state, setState] = useState(initialRuntimeEnvironmentState);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestGuardRef = useRef(createRuntimeEnvironmentRequestGuard());
  const sessionScope = `${isLoggedIn ? currentUserId ?? "user-pending" : "guest"}:${isAdminLoggedIn ? "admin" : "no-admin"}`;

  const retry = useCallback(() => {
    setRetryGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const token = requestGuardRef.current.begin(sessionScope);

    setState((previous) => beginRuntimeEnvironmentCheck(previous));
    void fetchRuntimeEnvironmentIdentity(controller.signal)
      .then((identity) => {
        if (!requestGuardRef.current.isCurrent(token)) return;
        setState({ status: "verified", identity, message: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !requestGuardRef.current.isCurrent(token)) return;
        const message = error instanceof Error
          ? error.message
          : "环境信息校验失败，请重新获取后继续操作。";
        setState((previous) => failRuntimeEnvironmentCheck(previous, message));
      });

    return () => {
      controller.abort();
      requestGuardRef.current.invalidate();
    };
  }, [retryGeneration, sessionScope]);

  const value = useMemo(() => ({ retry, state }), [retry, state]);

  return (
    <RuntimeEnvironmentContext.Provider value={value}>
      {children}
    </RuntimeEnvironmentContext.Provider>
  );
}

export function useRuntimeEnvironment() {
  const value = useContext(RuntimeEnvironmentContext);
  if (!value) {
    throw new Error("useRuntimeEnvironment 必须在 RuntimeEnvironmentProvider 内使用。");
  }
  return value;
}
