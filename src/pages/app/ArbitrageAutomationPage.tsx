import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { presentAutomationConsoleError, userAutomationConsoleClient } from "../../api/arbitrageAutomationConsole";
import { Button } from "../../components/ui/Button";
import { AutomationControlConsole } from "../../features/arbitrageAutomation/components/AutomationControlConsole";
import type { AutomationConsoleSnapshot } from "../../features/arbitrageAutomation/model/controlConsoleTypes";
import { useUserStore } from "../../store/userStore";

const pollingIntervalMs = 30_000;

export function ArbitrageAutomationPage() {
  const currentUser = useUserStore((state) => state.currentUser);
  const [snapshot, setSnapshot] = useState<AutomationConsoleSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof presentAutomationConsoleError> | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const nextSnapshot = await userAutomationConsoleClient.load(controller.signal);
      if (!controller.signal.aborted) setSnapshot(nextSnapshot);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setSnapshot(null);
        setError(presentAutomationConsoleError(loadError));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), pollingIntervalMs);
    return () => { window.clearInterval(timer); requestRef.current?.abort(); };
  }, [load]);

  return (
    <div className="xh-page min-w-0 space-y-5">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3"><h1 className="xh-title">我的自动套利</h1><span className="inline-flex border border-red-400/35 bg-red-400/[0.07] px-2.5 py-1 text-xs font-medium text-red-100">MAINNET · REAL EXECUTION</span></div>
          <p className="xh-subtitle">当前用户 {currentUser?.email ?? "-"} 的 API 账户、候选门禁、策略级持仓与 PnL、参数和安全操作。</p>
        </div>
        <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary"><RefreshCw className={loading ? "animate-spin" : ""} size={15} />刷新</Button>
      </header>

      {loading && !snapshot ? <ConsoleState icon={<RefreshCw className="animate-spin" size={18} />} title="正在加载我的套利账户" description="正在读取用户隔离的 API 账户、配置、候选、持仓与策略盈亏。" /> : null}
      {loading && snapshot ? <p className="text-xs text-muted" role="status">正在刷新控制台快照</p> : null}
      {error ? <ConsoleState icon={error.retryable ? <AlertTriangle size={18} /> : <ShieldAlert size={18} />} title={error.title} description={error.message} action={error.retryable ? <Button onClick={() => void load()} type="button" variant="secondary">重新加载</Button> : undefined} error /> : null}
      {snapshot ? <AutomationControlConsole client={userAutomationConsoleClient} onReload={load} snapshot={snapshot} /> : null}
    </div>
  );
}

function ConsoleState({ action, description, error = false, icon, title }: { action?: React.ReactNode; description: string; error?: boolean; icon: React.ReactNode; title: string }) {
  return <section className={`flex min-h-48 flex-col items-center justify-center border px-5 text-center ${error ? "border-red-400/35 bg-red-400/[0.04] text-red-100" : "border-white/15 text-white"}`} role={error ? "alert" : "status"}>{icon}<strong className="mt-3 text-sm">{title}</strong><span className="mt-2 max-w-lg text-xs leading-5 text-muted">{description}</span>{action ? <div className="mt-4">{action}</div> : null}</section>;
}
