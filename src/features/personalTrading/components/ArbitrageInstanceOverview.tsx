import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Layers3 } from "lucide-react";
import {
  fetchActiveArbitrageInstances,
  fetchArbitrageInstanceHistory,
  fetchArbitragePositionVerification,
  type ArbitrageInstance,
  type ArbitrageExecutionReference,
  type ArbitrageInstanceLeg,
  type ArbitrageInstanceStatus,
  type ArbitrageLegVerificationStatus,
  type ArbitragePositionVerification,
} from "../../../api/arbitrageInstances";
import { reconcileArbitrageInstance } from "../../../api/arbitrageExecutionDraft";
import { Button } from "../../../components/ui/Button";
import { buildArbitrageResumeHref } from "../../arbitrage/lib/analysisRoute";
import { ArbitrageHedgeExitDialog } from "./ArbitrageHedgeExitDialog";
import { ArbitrageOrderCancelDialog } from "./ArbitrageOrderCancelDialog";

const HISTORY_LIMIT = 50;
const VERIFICATION_CONCURRENCY = 4;

export type VerificationState =
  | { status: "loading" }
  | { status: "success"; verification: ArbitragePositionVerification }
  | { status: "error" };

export type ArbitrageInstanceLoadState =
  | { status: "loading" }
  | { status: "success"; active: ArbitrageInstance[]; history: ArbitrageInstance[] }
  | { status: "error" };

export function ArbitrageInstanceOverview() {
  const [page, setPage] = useState(1);
  const [selectedSection, setSelectedSection] = useState<"active" | "history">("active");
  const [state, setState] = useState<ArbitrageInstanceLoadState>({ status: "loading" });
  const [verifications, setVerifications] = useState<Record<string, VerificationState>>({});
  const [exitTarget, setExitTarget] = useState<Readonly<{
    instance: ArbitrageInstance;
  }> | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Readonly<{
    instance: ArbitrageInstance;
    leg: ArbitrageInstanceLeg;
    reference: ArbitrageExecutionReference;
  }> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void Promise.all([
      fetchActiveArbitrageInstances(controller.signal),
      fetchArbitrageInstanceHistory(page, HISTORY_LIMIT, controller.signal),
    ]).then(([active, history]) => {
      if (controller.signal.aborted) return;
      setState({ status: "success", active, history });
      setVerifications(Object.fromEntries(active.map((item) => [item.arbitrageId, { status: "loading" }])));
      void loadVerifications(active, controller.signal, (arbitrageId, verificationState) => {
        setVerifications((current) => ({ ...current, [arbitrageId]: verificationState }));
      });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [page]);

  const onInstanceUpdated = (updated: ArbitrageInstance) => {
    setState((current) => current.status === "success"
      ? { ...current, active: current.active.map((item) => item.arbitrageId === updated.arbitrageId ? updated : item) }
      : current);
    setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "loading" } }));
    void fetchArbitragePositionVerification(updated.arbitrageId).then((verification) => {
      setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "success", verification } }));
    }).catch(() => {
      setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "error" } }));
    });
  };

  const reconcileHedge = async (instance: ArbitrageInstance) => {
    setVerifications((current) => ({ ...current, [instance.arbitrageId]: { status: "loading" } }));
    try {
      const { instance: updated, verification } = await reconcileArbitrageHedge(instance);
      setState((current) => current.status === "success"
        ? { ...current, active: current.active.map((item) => item.arbitrageId === updated.arbitrageId ? updated : item) }
        : current);
      setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "success", verification } }));
    } catch {
      setVerifications((current) => ({ ...current, [instance.arbitrageId]: { status: "error" } }));
    }
  };

  return <>
    <ArbitrageInstanceContent
      onCancelOrder={setCancelTarget}
      onExitHedge={setExitTarget}
      onReconcileHedge={(instance) => void reconcileHedge(instance)}
      onPageChange={setPage}
      onSectionChange={setSelectedSection}
      page={page}
      selectedSection={selectedSection}
      state={state}
      verifications={verifications}
    />
    {exitTarget ? <ArbitrageHedgeExitDialog
      instance={exitTarget.instance}
      onClose={() => setExitTarget(null)}
      onUpdated={onInstanceUpdated}
    /> : null}
    {cancelTarget ? <ArbitrageOrderCancelDialog
      instance={cancelTarget.instance}
      leg={cancelTarget.leg}
      onClose={() => setCancelTarget(null)}
      onUpdated={onInstanceUpdated}
      reference={cancelTarget.reference}
    /> : null}
  </>;
}

export async function loadVerifications(
  active: ArbitrageInstance[],
  signal: AbortSignal,
  onSettled: (arbitrageId: string, state: VerificationState) => void,
) {
  let nextIndex = 0;
  async function worker() {
    while (!signal.aborted) {
      const item = active[nextIndex++];
      if (!item) return;
      try {
        const verification = await fetchArbitragePositionVerification(item.arbitrageId, signal);
        if (!signal.aborted) onSettled(item.arbitrageId, { status: "success", verification });
      } catch {
        if (!signal.aborted) onSettled(item.arbitrageId, { status: "error" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VERIFICATION_CONCURRENCY, active.length) }, worker));
}

export function ArbitrageInstanceContent({
  onCancelOrder,
  onExitHedge,
  onReconcileHedge,
  onPageChange,
  onSectionChange = () => undefined,
  page,
  selectedSection = "active",
  state,
  verifications = {},
}: {
  onCancelOrder?: (target: Readonly<{ instance: ArbitrageInstance; leg: ArbitrageInstanceLeg; reference: ArbitrageExecutionReference }>) => void;
  onExitHedge?: (target: Readonly<{ instance: ArbitrageInstance }>) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  onPageChange: (page: number) => void;
  onSectionChange?: (section: "active" | "history") => void;
  page: number;
  selectedSection?: "active" | "history";
  state: ArbitrageInstanceLoadState;
  verifications?: Record<string, VerificationState>;
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
      onCancelOrder={onCancelOrder}
      history={state.history}
      onPageChange={onPageChange}
      onExitHedge={onExitHedge}
      onReconcileHedge={onReconcileHedge}
      onSectionChange={onSectionChange}
      page={page}
      selectedSection={selectedSection}
      verifications={verifications}
    />
  );
}

export function ArbitrageInstanceSections({
  active,
  history,
  onPageChange,
  onExitHedge,
  onReconcileHedge,
  onCancelOrder,
  onSectionChange = () => undefined,
  page,
  selectedSection = "active",
  verifications = {},
}: {
  active: ArbitrageInstance[];
  history: ArbitrageInstance[];
  onPageChange: (page: number) => void;
  onExitHedge?: (target: Readonly<{ instance: ArbitrageInstance }>) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  onCancelOrder?: (target: Readonly<{ instance: ArbitrageInstance; leg: ArbitrageInstanceLeg; reference: ArbitrageExecutionReference }>) => void;
  onSectionChange?: (section: "active" | "history") => void;
  page: number;
  selectedSection?: "active" | "history";
  verifications?: Record<string, VerificationState>;
}) {
  return (
    <ArbitrageInstanceShell>
      <div>
        <div className="flex border-b border-[#25282f] bg-black px-4 sm:px-5" role="tablist" aria-label="套利记录视图">
          <SectionTab active={selectedSection === "active"} count={active.length} label="当前套利" onClick={() => onSectionChange("active")} />
          <SectionTab active={selectedSection === "history"} count={history.length} label="历史记录" onClick={() => onSectionChange("history")} />
        </div>
        <div className="p-4 sm:p-5">
        {selectedSection === "active" ? <InstanceSection
          emptyText="暂无当前套利组合"
          instances={active}
          onCancelOrder={onCancelOrder}
          onExitHedge={onExitHedge}
          onReconcileHedge={onReconcileHedge}
          title="当前套利"
          verifications={verifications}
        /> : <InstanceSection
          emptyText="暂无历史套利记录"
          historical
          instances={history}
          title="历史记录"
        />}
        {selectedSection === "history" ? <div className="mt-5 flex items-center justify-end gap-3 border-t border-[#25282f] pt-4">
          <span className="text-xs text-[#8f99a5]">第 {page} 页 · 每页 {HISTORY_LIMIT} 条</span>
          <Button disabled={page <= 1} onClick={() => onPageChange(page - 1)} type="button" variant="secondary">
            上一页
          </Button>
          <Button disabled={history.length < HISTORY_LIMIT} onClick={() => onPageChange(page + 1)} type="button" variant="secondary">
            下一页
          </Button>
        </div> : null}
        </div>
      </div>
    </ArbitrageInstanceShell>
  );
}

function SectionTab({ active, count, label, onClick }: { active: boolean; count: number; label: string; onClick: () => void }) {
  return <button aria-selected={active} className={`relative min-h-12 border-b-2 px-4 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40 ${active ? "border-white text-white" : "border-transparent text-[#8f99a5] hover:text-[#d7dce2]"}`} onClick={onClick} role="tab" type="button">{label}<span className="ml-2 font-mono text-[10px] text-[#707985]">{count}</span></button>;
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
  onExitHedge,
  onReconcileHedge,
  onCancelOrder,
  title,
  verifications = {},
}: {
  emptyText: string;
  historical?: boolean;
  instances: ArbitrageInstance[];
  onExitHedge?: (target: Readonly<{ instance: ArbitrageInstance }>) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  onCancelOrder?: (target: Readonly<{ instance: ArbitrageInstance; leg: ArbitrageInstanceLeg; reference: ArbitrageExecutionReference }>) => void;
  title: string;
  verifications?: Record<string, VerificationState>;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-[#8f99a5]">{instances.length} 条</span>
      </div>
      {instances.length === 0
        ? <p className="border border-[#25282f] bg-black p-5 text-center text-sm text-[#8f99a5]">{emptyText}</p>
        : <div className="grid gap-3">{instances.map((item) => <InstanceCard historical={historical} instance={item} key={item.arbitrageId} onCancelOrder={onCancelOrder} onExitHedge={onExitHedge} onReconcileHedge={onReconcileHedge} verificationState={verifications[item.arbitrageId]} />)}</div>}
    </section>
  );
}

function InstanceCard({ historical, instance, onCancelOrder, onExitHedge, onReconcileHedge, verificationState }: {
  historical: boolean;
  instance: ArbitrageInstance;
  onCancelOrder?: (target: Readonly<{ instance: ArbitrageInstance; leg: ArbitrageInstanceLeg; reference: ArbitrageExecutionReference }>) => void;
  onExitHedge?: (target: Readonly<{ instance: ArbitrageInstance }>) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  verificationState?: VerificationState;
}) {
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
      {!historical && instance.status === "OPENING" ? (
        <div className="mt-4 flex justify-end border-t border-[#25282f] pt-4">
          <a
            className="inline-flex min-h-9 items-center justify-center border border-white/25 px-4 text-xs font-semibold text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white"
            href={buildArbitrageResumeHref(instance.arbitrageId)}
          >
            继续开仓
          </a>
        </div>
      ) : null}
      <div className="mt-4 grid gap-px bg-[#25282f] lg:grid-cols-2">
        {instance.legs.map((leg) => {
          return <div className="bg-[#0b0d11] p-4" key={leg.legId}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white">{leg.role === "LONG" ? "多头腿" : "空头腿"}</span>
              <span className="text-[11px] text-[#8f99a5]">{venueLabel(leg.venue)}</span>
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              <LegRow label="交易所" value={venueLabel(leg.venue)} />
              <LegRow label="交易标的" value={leg.instrumentId} />
              <LegRow label="方向" value={leg.role === "LONG" ? "多头" : "空头"} />
              {historical ? (
                <>
                  <LegRow label="已确认开仓数量" value={leg.confirmedOpenedQuantity} />
                  <LegRow label="已确认关闭数量" value={leg.confirmedClosedQuantity} />
                </>
              ) : <LiveLegVerification legId={leg.legId} state={verificationState} />}
            </dl>
            {!historical && onCancelOrder ? instance.executionReferences
              .filter((reference) => reference.legId === leg.legId
                && reference.executionRecordId !== null
                && (reference.status === "LINKED"
                  || reference.status === "PENDING_CONFIRMATION"
                  || reference.status === "UNKNOWN"))
              .map((reference) => <div className="mt-3" key={reference.executionIntentId}>
                <Button onClick={() => onCancelOrder({ instance, leg, reference })} type="button" variant="secondary">
                  撤销订单
                </Button>
              </div>) : null}
          </div>;
        })}
      </div>
      {!historical ? <HedgeExitActions
        instance={instance}
        onExitHedge={onExitHedge}
        onReconcileHedge={onReconcileHedge}
        verificationState={verificationState}
      /> : null}
    </article>
  );
}

export function unresolvedClosingReference(instance: ArbitrageInstance, legId: string) {
  return instance.executionReferences.find((reference) => reference.legId === legId
    && reference.phase === "CLOSING"
    && (reference.status === "CLAIMED" || reference.status === "LINKED"
      || reference.status === "PENDING_CONFIRMATION" || reference.status === "UNKNOWN"));
}

export async function reconcileArbitrageHedge(
  instance: ArbitrageInstance,
  reconcile: typeof reconcileArbitrageInstance = reconcileArbitrageInstance,
) {
  return reconcile(instance.arbitrageId);
}

function HedgeExitActions({ instance, onExitHedge, onReconcileHedge, verificationState }: {
  instance: ArbitrageInstance;
  onExitHedge?: (target: Readonly<{ instance: ArbitrageInstance }>) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  verificationState?: VerificationState;
}) {
  const summary = hedgeExitSummary(instance, verificationState);
  const verification = verificationState?.status === "success" ? verificationState.verification : null;
  const canExit = summary.kind === "remaining"
    && verification !== null
    && verification.legs.every((leg) => leg.verificationStatus === "MATCHED" && leg.actualQuantity !== null)
    && !instance.legs.some((leg) => unresolvedClosingReference(instance, leg.legId));
  return <div className="mt-4 border-t border-[#25282f] pt-4">
    <p className={`text-xs font-semibold ${summary.kind === "ended" ? "text-emerald-200" : summary.kind === "unknown" ? "text-amber-200" : "text-white"}`}>
      {summary.label}
    </p>
    {summary.details.map((detail) => <p className="mt-2 text-xs text-[#8f99a5]" key={detail}>{detail}</p>)}
    {summary.progress.length > 0 ? <div className="mt-3 space-y-1 text-xs text-[#c5ccd4]">
      {summary.progress.map((item) => <p key={item}>{item}</p>)}
    </div> : null}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      {summary.kind !== "ended" && onReconcileHedge ? <Button
        disabled={verificationState?.status === "loading"}
        onClick={() => onReconcileHedge(instance)}
        type="button"
        variant="secondary"
      >
        {verificationState?.status === "loading" ? "正在核验…" : "重新核验"}
      </Button> : null}
      {summary.kind !== "ended" && onExitHedge ? <Button
        disabled={!canExit}
        onClick={() => onExitHedge({ instance })}
        type="button"
      >
        退出对冲
      </Button> : null}
    </div>
  </div>;
}

export function hedgeExitSummary(instance: ArbitrageInstance, state?: VerificationState) {
  const hasClosingProgress = instance.executionReferences.some((reference) => reference.phase === "CLOSING");
  const progress = hasClosingProgress ? instance.legs.map((leg) => {
    const reference = latestClosingReference(instance, leg.legId);
    const label = instanceLegLabel(instance, leg);
    if (!reference) return `○ ${label}等待退出`;
    if (reference.status === "CONFIRMED") return [`✓ ${label}已退出`];
    if (reference.status === "FAILED") return [`○ ${label}退出失败`];
    return `○ ${label}确认中`;
  }).flat() : [];
  if (instance.status === "CLOSED") {
    return { kind: "ended" as const, label: "对冲已结束", details: [] as string[], progress };
  }
  if (!state || state.status === "loading" || state.status === "error") {
    return { kind: "unknown" as const, label: "仓位状态待确认", details: [] as string[], progress };
  }
  if (state.verification.legs.some((leg) => leg.actualQuantity === null || leg.verificationStatus === "UNKNOWN")) {
    return { kind: "unknown" as const, label: "仓位状态待确认", details: [] as string[], progress };
  }
  const remaining = state.verification.legs.filter((leg) => !isZeroDecimal(leg.actualQuantity!));
  if (remaining.length === 0) {
    return { kind: "ended" as const, label: "对冲已结束", details: [] as string[], progress };
  }
  return {
    kind: "remaining" as const,
    label: "对冲尚未完全退出",
    details: remaining.map((fact) => {
      const leg = instance.legs.find((candidate) => candidate.legId === fact.legId)!;
      return `${instanceLegLabel(instance, leg)}剩余 ${fact.actualQuantity}`;
    }),
    progress,
  };
}

function instanceLegLabel(instance: ArbitrageInstance, leg: ArbitrageInstanceLeg) {
  if (leg.instrumentId.endsWith("-SPOT")) return "现货腿";
  return instance.strategyType === "PERPETUAL_PERPETUAL"
    ? `${leg.role === "LONG" ? "多头" : "空头"}永续腿`
    : "永续腿";
}

function latestClosingReference(instance: ArbitrageInstance, legId: string) {
  return instance.executionReferences
    .filter((reference) => reference.legId === legId && reference.phase === "CLOSING")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function isZeroDecimal(value: string) {
  return /^-?0(?:\.0+)?$/u.test(value);
}

function LiveLegVerification({ legId, state }: { legId: string; state?: VerificationState }) {
  if (!state || state.status === "loading") {
    return <><LegRow label="系统管理数量" value="核验中…" /><LegRow label="当前真实数量" value="核验中…" /><VerificationNotice status="loading" /></>;
  }
  if (state.status === "error") {
    return <><LegRow label="系统管理数量" value="暂无可靠数据" /><LegRow label="当前真实数量" value="暂无可靠数据" /><VerificationNotice status="error" /></>;
  }
  const verification = state.verification.legs.find((item) => item.legId === legId);
  if (!verification) {
    return <><LegRow label="系统管理数量" value="暂无可靠数据" /><LegRow label="当前真实数量" value="暂无可靠数据" /><VerificationNotice status="error" /></>;
  }
  return (
    <>
      <LegRow label="系统管理数量" value={verification.expectedManagedQuantity} />
      <LegRow label="当前真实数量" value={verification.actualQuantity ?? "暂无可靠数据"} />
      <VerificationNotice status={verification.verificationStatus} />
    </>
  );
}

function VerificationNotice({ status }: { status: ArbitrageLegVerificationStatus | "loading" | "error" }) {
  if (status === "loading") return <div className="mt-3 border-t border-[#25282f] pt-3 text-xs text-[#8f99a5]">正在核验当前仓位…</div>;
  if (status === "error" || status === "UNKNOWN") {
    return <div className="mt-3 flex items-start gap-2 border-t border-[#25282f] pt-3 text-xs text-amber-200"><CircleHelp className="mt-0.5 shrink-0" size={14} /><span>当前仓位暂无法可靠确认</span></div>;
  }
  if (status === "MISMATCH") {
    return <div className="mt-3 flex items-start gap-2 border-t border-[#25282f] pt-3 text-xs text-red-200"><AlertTriangle className="mt-0.5 shrink-0" size={14} /><span>交易所当前数量与 StellaX 管理记录存在差异</span></div>;
  }
  return <div className="mt-3 flex items-center gap-2 border-t border-[#25282f] pt-3 text-xs text-emerald-200"><CheckCircle2 size={14} /><span>仓位一致</span></div>;
}

export function verificationStatusLabel(status: ArbitrageLegVerificationStatus) {
  return { MATCHED: "仓位一致", MISMATCH: "仓位存在差异", UNKNOWN: "暂无法确认" }[status];
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
