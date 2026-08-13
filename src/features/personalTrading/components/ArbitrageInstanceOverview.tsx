import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Layers3 } from "lucide-react";
import {
  fetchActiveArbitrageInstances,
  fetchArbitrageInstanceHistory,
  type ArbitrageInstance,
  type ArbitrageInstanceStatus,
} from "../../../api/arbitrageInstances";
import { Button } from "../../../components/ui/Button";

const HISTORY_LIMIT = 50;

export type ArbitrageInstanceLoadState =
  | { status: "loading" }
  | { status: "success"; active: ArbitrageInstance[]; history: ArbitrageInstance[] }
  | { status: "error" };

export function ArbitrageInstanceOverview() {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ArbitrageInstanceLoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void Promise.all([
      fetchActiveArbitrageInstances(controller.signal),
      fetchArbitrageInstanceHistory(page, HISTORY_LIMIT, controller.signal),
    ]).then(([active, history]) => {
      if (!controller.signal.aborted) setState({ status: "success", active, history });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [page]);

  return <ArbitrageInstanceContent onPageChange={setPage} page={page} state={state} />;
}

export function ArbitrageInstanceContent({
  onPageChange,
  page,
  state,
}: {
  onPageChange: (page: number) => void;
  page: number;
  state: ArbitrageInstanceLoadState;
}) {
  if (state.status === "loading") {
    return <ArbitrageInstanceShell><p className="p-5 text-sm text-[#8f99a5]">正在加载套利组合…</p></ArbitrageInstanceShell>;
  }
  if (state.status === "error") {
    return (
      <ArbitrageInstanceShell>
        <div className="flex items-center gap-2 p-5 text-sm text-red-200">
          <AlertTriangle size={16} /> 套利组合加载失败，请稍后重试
        </div>
      </ArbitrageInstanceShell>
    );
  }
  return (
    <ArbitrageInstanceSections
      active={state.active}
      history={state.history}
      onPageChange={onPageChange}
      page={page}
    />
  );
}

export function ArbitrageInstanceSections({
  active,
  history,
  onPageChange,
  page,
}: {
  active: ArbitrageInstance[];
  history: ArbitrageInstance[];
  onPageChange: (page: number) => void;
  page: number;
}) {
  return (
    <ArbitrageInstanceShell>
      <div className="space-y-6 p-4 sm:p-5">
        <InstanceSection
          emptyText="暂无当前套利组合"
          instances={active}
          title="当前套利"
        />
        <InstanceSection
          emptyText="暂无历史套利记录"
          historical
          instances={history}
          title="历史套利"
        />
        <div className="flex items-center justify-end gap-3 border-t border-[#25282f] pt-4">
          <span className="text-xs text-[#8f99a5]">第 {page} 页 · 每页 {HISTORY_LIMIT} 条</span>
          <Button disabled={page <= 1} onClick={() => onPageChange(page - 1)} type="button" variant="secondary">
            上一页
          </Button>
          <Button disabled={history.length < HISTORY_LIMIT} onClick={() => onPageChange(page + 1)} type="button" variant="secondary">
            下一页
          </Button>
        </div>
      </div>
    </ArbitrageInstanceShell>
  );
}

function ArbitrageInstanceShell({ children }: { children: ReactNode }) {
  return (
    <section className="mt-4 border border-[#25282f] bg-[#0b0d11]" aria-labelledby="arbitrage-instance-title">
      <header className="border-b border-[#25282f] px-4 py-4 sm:px-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white" id="arbitrage-instance-title">
          <Layers3 size={16} aria-hidden="true" /> 套利组合
        </h2>
        <p className="mt-1 text-xs leading-5 text-[#8f99a5]">仅展示由 StellaX 创建并绑定套利 ID 的组合记录。</p>
      </header>
      {children}
    </section>
  );
}

function InstanceSection({
  emptyText,
  historical = false,
  instances,
  title,
}: {
  emptyText: string;
  historical?: boolean;
  instances: ArbitrageInstance[];
  title: string;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-[#8f99a5]">{instances.length} 条</span>
      </div>
      {instances.length === 0
        ? <p className="border border-[#25282f] bg-black p-5 text-center text-sm text-[#8f99a5]">{emptyText}</p>
        : <div className="grid gap-3 xl:grid-cols-2">{instances.map((item) => <InstanceCard historical={historical} instance={item} key={item.arbitrageId} />)}</div>}
    </section>
  );
}

function InstanceCard({ historical, instance }: { historical: boolean; instance: ArbitrageInstance }) {
  return (
    <article className="min-w-0 border border-[#25282f] bg-black p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-[#707985]">套利 ID</p>
          <p className="mt-1 break-all font-mono text-xs text-white">{instance.arbitrageId}</p>
        </div>
        <StatusBadge status={instance.status} />
      </div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <Metric label="策略类型" value={strategyTypeLabel(instance.strategyType)} />
        <Metric label="创建时间" value={formatTime(instance.createdAt)} />
        <Metric label="更新时间" value={formatTime(instance.updatedAt)} />
        <Metric label="建仓完成时间" value={formatOptionalTime(instance.openedAt)} />
        {historical ? <Metric label="关闭时间" value={formatOptionalTime(instance.closedAt)} /> : null}
      </dl>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {instance.legs.map((leg) => (
          <div className="border border-[#25282f] p-3" key={leg.legId}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white">{leg.role === "LONG" ? "LONG 腿" : "SHORT 腿"}</span>
              <span className="text-[11px] text-[#8f99a5]">{venueLabel(leg.venue)}</span>
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              <LegRow label="账户" value={maskAccountId(leg.accountId)} />
              <LegRow label="交易标的" value={leg.instrumentId} />
              <LegRow label="计划数量" value={leg.plannedQuantity} />
            </dl>
          </div>
        ))}
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: ArbitrageInstanceStatus }) {
  const warning = status === "RESIDUAL" || status === "FAILED";
  return (
    <span className={`border px-2 py-1 text-[11px] font-medium ${warning ? "border-amber-400/30 text-amber-200" : "border-white/20 text-[#c5ccd4]"}`}>
      {statusLabel(status)}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[#707985]">{label}</dt><dd className="mt-1 font-mono text-[#c5ccd4]">{value}</dd></div>;
}

function LegRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3"><dt className="text-[#707985]">{label}</dt><dd className="break-all text-right font-mono text-[#c5ccd4]">{value}</dd></div>;
}

export function statusLabel(status: ArbitrageInstanceStatus) {
  return {
    OPENING: "建仓中",
    HOLDING: "持有中",
    RESIDUAL: "存在残余",
    CLOSING: "退出中",
    CLOSED: "已关闭",
    FAILED: "失败",
  }[status];
}

export function maskAccountId(accountId: string) {
  if (accountId.length <= 8) return "••••";
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

function strategyTypeLabel(strategyType: ArbitrageInstance["strategyType"]) {
  return strategyType === "PERPETUAL_PERPETUAL" ? "永续-永续" : "现货-永续";
}

function venueLabel(venue: ArbitrageInstance["legs"][number]["venue"]) {
  return { binance: "Binance", okx: "OKX", bybit: "Bybit", bitget: "Bitget" }[venue];
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(new Date(value));
}

function formatOptionalTime(value: number | null) {
  return value === null ? "—" : formatTime(value);
}
