import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { fetchNeutralAutomationStatus } from "../../api/arbitrageAutomation";
import { Button } from "../../components/ui/Button";
import { NeutralAutomationConsole } from "../../features/admin/arbitrage/components/NeutralAutomationConsole";
import {
  classifyNeutralAutomationError,
  initialNeutralAutomationRequestState,
  neutralAutomationRequestReducer,
  type NeutralAutomationLoadError,
} from "../../features/admin/arbitrage/model/neutralAutomationState";

const pollingIntervalMs = 30_000;

export function AdminNeutralAutomationPage() {
  const [state, dispatch] = useReducer(neutralAutomationRequestReducer, initialNeutralAutomationRequestState);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    dispatch({ type: "started" });
    try {
      const report = await fetchNeutralAutomationStatus(controller.signal);
      if (!controller.signal.aborted) dispatch({ type: "succeeded", report });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "failed", error: classifyNeutralAutomationError(error) });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), pollingIntervalMs);
    return () => {
      window.clearInterval(timer);
      requestRef.current?.abort();
    };
  }, [load]);

  return (
    <div className="xh-page xh-neutral-page">
      <header className="xh-page-header">
        <div>
          <p className="xh-neutral-page-context">OWNER ONLY · PHASE A · READ ONLY</p>
          <h1 className="xh-title">RWA 中性套利 Shadow</h1>
          <p className="xh-subtitle">Bybit XAUT 现货与永续的私有只读状态。真实交易关闭，不发送订单。</p>
        </div>
        <Button disabled={state.loading} onClick={() => void load()} type="button" variant="secondary">
          <RefreshCw className={state.loading ? "animate-spin" : ""} size={15} />
          刷新
        </Button>
      </header>

      {state.loading && !state.report ? <NeutralAutomationState title="正在读取 Shadow 状态" /> : null}
      {state.loading && state.report ? <p className="xh-neutral-refreshing" role="status">正在刷新只读快照</p> : null}
      {state.error ? <NeutralAutomationError error={state.error} onRetry={() => void load()} /> : null}
      {state.report ? <NeutralAutomationConsole report={state.report} /> : null}
    </div>
  );
}

function NeutralAutomationState({ title }: { title: string }) {
  return <section className="xh-neutral-state" role="status"><RefreshCw className="animate-spin" size={18} /><strong>{title}</strong><span>仅请求后台只读快照。</span></section>;
}

function NeutralAutomationError({ error, onRetry }: { error: NeutralAutomationLoadError; onRetry: () => void }) {
  const content = errorContent(error);
  return (
    <section className="xh-neutral-state is-error" role="alert">
      {error.kind === "forbidden" || error.kind === "unauthorized" ? <ShieldAlert size={19} /> : <AlertTriangle size={19} />}
      <strong>{content.title}</strong>
      <span>{content.description}</span>
      <Button onClick={onRetry} type="button" variant="secondary">重新加载</Button>
    </section>
  );
}

function errorContent(error: NeutralAutomationLoadError) {
  if (error.kind === "unauthorized") return { title: "管理员登录已失效", description: error.message };
  if (error.kind === "forbidden") return { title: "当前账号无权访问", description: error.message };
  if (error.kind === "unavailable") return { title: "Shadow 状态服务不可用", description: error.message };
  if (error.kind === "network") return { title: "无法连接 Shadow 状态服务", description: error.message };
  return { title: "Shadow 状态加载失败", description: error.message };
}
