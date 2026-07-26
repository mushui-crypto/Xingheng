import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { useRuntimeEnvironment } from "./RuntimeEnvironmentProvider";
import {
  runtimeEnvironmentAllowsSensitiveOperations,
  type RuntimeEnvironmentState,
} from "./runtimeEnvironmentState";

export function RuntimeEnvironmentStatusBar() {
  const { retry, state } = useRuntimeEnvironment();
  return <RuntimeEnvironmentStatusBarView onRetry={retry} state={state} />;
}

export function RuntimeEnvironmentStatusBarView({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: RuntimeEnvironmentState;
}) {
  if (state.status === "error") {
    const retainedRealTest = state.identity?.deploymentEnvironment === "real-test";
    return (
      <div
        className="flex h-10 min-h-10 w-full min-w-0 items-center justify-center gap-2 overflow-hidden border-b border-red-400/25 bg-[#261014] px-3 text-[11px] font-semibold text-red-100 sm:text-xs"
        role="alert"
        title={retainedRealTest
          ? "真实测试环境，环境信息校验失败，可能连接真实交易所"
          : "环境信息校验失败"}
      >
        <AlertTriangle aria-hidden="true" className="shrink-0" size={15} />
        <span className="min-w-0 truncate">
          {retainedRealTest
            ? "真实测试环境 · 校验失败 · 可能连接真实交易所"
            : "环境信息校验失败"}
        </span>
        <button
          aria-label="重新获取环境信息"
          className="inline-flex h-8 min-h-8 w-8 shrink-0 items-center justify-center border border-red-200/35 text-red-50 transition hover:bg-red-200/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white"
          onClick={onRetry}
          title="重新获取"
          type="button"
        >
          <RefreshCw size={14} />
        </button>
      </div>
    );
  }

  if (state.identity?.deploymentEnvironment !== "real-test") {
    return null;
  }

  return (
    <div
      className="flex h-10 min-h-10 w-full min-w-0 items-center justify-center gap-2 overflow-hidden border-b border-amber-300/25 bg-[#211b0b] px-3 text-xs font-semibold text-amber-100"
      role="status"
      title="真实测试环境，可能连接真实交易所"
    >
      <ShieldAlert aria-hidden="true" className="shrink-0" size={15} />
      <span className="min-w-0 truncate">真实测试环境 · 可能连接真实交易所</span>
    </div>
  );
}

export function SensitiveEnvironmentGate({ children }: { children: ReactNode }) {
  const { retry, state } = useRuntimeEnvironment();
  if (runtimeEnvironmentAllowsSensitiveOperations(state)) return <>{children}</>;
  return <SensitiveEnvironmentGateView onRetry={retry} state={state} />;
}

export function SensitiveEnvironmentGateView({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: RuntimeEnvironmentState;
}) {
  const checking = state.status === "checking";

  return (
    <section
      aria-busy={checking}
      className="flex min-h-[calc(100vh-160px)] min-w-0 items-start justify-center px-4 py-10 sm:px-6 md:items-center"
    >
      <div className="w-full max-w-2xl border-y border-white/15 bg-black px-4 py-8 sm:px-6">
        <div className="flex items-start gap-3">
          {checking
            ? <RefreshCw aria-hidden="true" className="mt-0.5 shrink-0 animate-spin text-white/70 motion-reduce:animate-none" size={18} />
            : <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-red-300" size={18} />}
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-white">
              {checking ? "正在校验运行环境" : "环境信息校验失败"}
            </h1>
            <p className="mt-2 max-w-[65ch] text-sm leading-6 text-[#b8b8b8]">
              {checking
                ? "账户与交易相关操作会在环境身份确认后开放。"
                : "当前无法确认服务所属环境，账户、交易和自动化操作已暂停。请重新获取最新环境信息后继续。"}
            </p>
            {!checking ? (
              <Button className="mt-5" onClick={onRetry} type="button" variant="secondary">
                <RefreshCw size={15} />
                重新获取
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function hasRuntimeEnvironmentBar(state: RuntimeEnvironmentState) {
  return state.status === "error" || state.identity?.deploymentEnvironment === "real-test";
}
