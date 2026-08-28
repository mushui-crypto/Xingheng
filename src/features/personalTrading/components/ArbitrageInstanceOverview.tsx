import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Layers3 } from "lucide-react";
import {
  deriveArbitrageManagementEndMethod,
  fetchActiveArbitrageInstances,
  fetchArbitrageCloseSafety,
  fetchArbitrageInstanceById,
  fetchArbitrageInstanceHistory,
  fetchArbitragePositionVerification,
  fetchInstanceHedgeDelta,
  type ArbitrageCloseSafety,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
  type ArbitrageInstanceStatus,
  type ArbitrageLegVerificationStatus,
  type ArbitragePositionVerification,
  type InstanceHedgeDelta,
} from "../../../api/arbitrageInstances";
import { reconcileArbitrageInstance } from "../../../api/arbitrageExecutionDraft";
import { Button } from "../../../components/ui/Button";
import { buildArbitrageResumeHref } from "../../arbitrage/lib/analysisRoute";
import { ArbitrageHedgeExitDialog } from "./ArbitrageHedgeExitDialog";
import { ArbitrageLegCloseDialog } from "./ArbitrageLegCloseDialog";
import { ArbitrageManagementReleaseDialog } from "./ArbitrageManagementReleaseDialog";
import { ArbitrageUnstartedAbandonDialog } from "./ArbitrageUnstartedAbandonDialog";

const HISTORY_LIMIT = 50;
const VERIFICATION_CONCURRENCY = 4;

export type VerificationState =
  | { status: "loading" }
  | { status: "success"; verification: ArbitragePositionVerification }
  | { status: "error" };

export type ReadState<T> = { status: "loading" } | { status: "success"; value: T } | { status: "error" };
type ExitTarget = Readonly<{ instance: ArbitrageInstance; hasQuantityRuleDust: boolean }>;

export type ArbitrageInstanceLoadState =
  | { status: "loading" }
  | { status: "success"; active: ArbitrageInstance[]; history: ArbitrageInstance[] }
  | { status: "error" };

export function ArbitrageInstanceOverview() {
  const [page, setPage] = useState(1);
  const [selectedSection, setSelectedSection] = useState<"active" | "history">("active");
  const [state, setState] = useState<ArbitrageInstanceLoadState>({ status: "loading" });
  const [verifications, setVerifications] = useState<Record<string, VerificationState>>({});
  const [exitTarget, setExitTarget] = useState<ExitTarget | null>(null);

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

  const applyInstanceUpdate = (updated: ArbitrageInstance) => {
    setState((current) => current.status === "success"
      ? updateInstanceSections(current, updated)
      : current);
    if (updated.status === "CLOSED" || updated.status === "FAILED") {
      setVerifications((current) => {
        const next = { ...current };
        delete next[updated.arbitrageId];
        return next;
      });
      return updated;
    }
    setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "loading" } }));
    void fetchArbitragePositionVerification(updated.arbitrageId).then((verification) => {
      setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "success", verification } }));
    }).catch(() => {
      setVerifications((current) => ({ ...current, [updated.arbitrageId]: { status: "error" } }));
    });
    return updated;
  };

  const refreshInstance = async (arbitrageId: string) => {
    const updated = await fetchArbitrageInstanceById(arbitrageId);
    applyInstanceUpdate(updated);
    return updated;
  };

  const reconcileHedge = async (instance: ArbitrageInstance) => {
    setVerifications((current) => ({ ...current, [instance.arbitrageId]: { status: "loading" } }));
    try {
      const { instance: updated, verification } = await reconcileArbitrageHedge(instance);
      setState((current) => current.status === "success"
        ? updateInstanceSections(current, updated)
        : current);
      setVerifications((current) => {
        if (updated.status !== "CLOSED" && updated.status !== "FAILED") {
          return { ...current, [updated.arbitrageId]: { status: "success", verification } };
        }
        const next = { ...current };
        delete next[updated.arbitrageId];
        return next;
      });
    } catch {
      setVerifications((current) => ({ ...current, [instance.arbitrageId]: { status: "error" } }));
    }
  };

  return <>
    <ArbitrageInstanceContent
      onExitHedge={setExitTarget}
      onInstanceRefresh={refreshInstance}
      onReconcileHedge={(instance) => void reconcileHedge(instance)}
      onPageChange={setPage}
      onSectionChange={setSelectedSection}
      page={page}
      selectedSection={selectedSection}
      state={state}
      verifications={verifications}
    />
    {exitTarget ? <ArbitrageHedgeExitDialog
      hasQuantityRuleDust={exitTarget.hasQuantityRuleDust}
      instance={exitTarget.instance}
      onClose={() => setExitTarget(null)}
      onUpdated={(updated) => { void refreshInstance(updated.arbitrageId); }}
    /> : null}
  </>;
}

export function updateInstanceSections(
  current: Extract<ArbitrageInstanceLoadState, { status: "success" }>,
  updated: ArbitrageInstance,
): Extract<ArbitrageInstanceLoadState, { status: "success" }> {
  const terminal = updated.status === "CLOSED" || updated.status === "FAILED";
  if (terminal) {
    return {
      ...current,
      active: current.active.filter((item) => item.arbitrageId !== updated.arbitrageId),
      history: [updated, ...current.history.filter((item) => item.arbitrageId !== updated.arbitrageId)],
    };
  }
  return {
    ...current,
    active: current.active.map((item) => item.arbitrageId === updated.arbitrageId ? updated : item),
    history: current.history.filter((item) => item.arbitrageId !== updated.arbitrageId),
  };
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
  onExitHedge,
  onInstanceRefresh,
  onReconcileHedge,
  onPageChange,
  onSectionChange = () => undefined,
  page,
  selectedSection = "active",
  state,
  verifications = {},
}: {
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
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
      history={state.history}
      onPageChange={onPageChange}
      onExitHedge={onExitHedge}
      onInstanceRefresh={onInstanceRefresh}
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
  onInstanceRefresh,
  onReconcileHedge,
  onSectionChange = () => undefined,
  page,
  selectedSection = "active",
  verifications = {},
}: {
  active: ArbitrageInstance[];
  history: ArbitrageInstance[];
  onPageChange: (page: number) => void;
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
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
          onExitHedge={onExitHedge}
          onInstanceRefresh={onInstanceRefresh}
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
  onInstanceRefresh,
  onReconcileHedge,
  title,
  verifications = {},
}: {
  emptyText: string;
  historical?: boolean;
  instances: ArbitrageInstance[];
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
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
        : <div className="grid gap-3">{instances.map((item) => <InstanceCard historical={historical} instance={item} key={item.arbitrageId} onExitHedge={onExitHedge} onInstanceRefresh={onInstanceRefresh} onReconcileHedge={onReconcileHedge} verificationState={verifications[item.arbitrageId]} />)}</div>}
    </section>
  );
}

function InstanceCard({ historical, instance, onExitHedge, onInstanceRefresh, onReconcileHedge, verificationState }: {
  historical: boolean;
  instance: ArbitrageInstance;
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  verificationState?: VerificationState;
}) {
  const [closeSafeties, setCloseSafeties] = useState<Record<string, ReadState<ArbitrageCloseSafety>>>({});
  const [deltaState, setDeltaState] = useState<ReadState<InstanceHedgeDelta>>({ status: "loading" });
  const [closeTarget, setCloseTarget] = useState<ArbitrageInstanceLeg | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ArbitrageInstanceLeg | null>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);

  useEffect(() => {
    if (historical) return;
    const controller = new AbortController();
    setCloseSafeties(Object.fromEntries(instance.legs.map((leg) => [leg.legId, { status: "loading" }])));
    setDeltaState({ status: "loading" });
    for (const leg of instance.legs) {
      void fetchArbitrageCloseSafety(instance.arbitrageId, leg.legId, controller.signal).then((value) => {
        if (!controller.signal.aborted) setCloseSafeties((current) => ({ ...current, [leg.legId]: { status: "success", value } }));
      }).catch(() => {
        if (!controller.signal.aborted) setCloseSafeties((current) => ({ ...current, [leg.legId]: { status: "error" } }));
      });
    }
    void fetchInstanceHedgeDelta(instance.arbitrageId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setDeltaState({ status: "success", value });
    }).catch(() => {
      if (!controller.signal.aborted) setDeltaState({ status: "error" });
    });
    return () => controller.abort();
  }, [historical, instance.arbitrageId, instance.updatedAt]);

  const safetyValues = Object.fromEntries(Object.entries(closeSafeties)
    .filter((entry): entry is [string, Extract<ReadState<ArbitrageCloseSafety>, { status: "success" }>] => entry[1].status === "success")
    .map(([legId, state]) => [legId, state.value]));
  const canExitFully = instanceExitAvailability(instance, verificationState, safetyValues);
  const releaseCandidates = managementReleaseCandidates(instance, verificationState, safetyValues);
  const closeTargetVerification = closeTarget && verificationState?.status === "success"
    ? verificationState.verification.legs.find((item) => item.legId === closeTarget.legId)
    : null;
  const closeTargetSafety = closeTarget ? safetyValues[closeTarget.legId] : null;
  const releaseTargetSafety = releaseTarget ? safetyValues[releaseTarget.legId] : null;
  const canAbandon = canAbandonUnstartedArbitrage(instance);
  return <>
    <article className="min-w-0 border border-[#25282f] bg-black p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-[#707985]">套利 ID</p>
          <p className="mt-1 break-all font-mono text-xs text-white">{instance.arbitrageId}</p>
        </div>
        <StatusBadge instance={instance} />
      </div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <Metric label="策略类型" value={strategyTypeLabel(instance.strategyType)} />
        <Metric label="创建时间" value={formatTime(instance.createdAt)} />
        <Metric label="更新时间" value={formatTime(instance.updatedAt)} />
        <Metric label="建仓完成时间" value={formatOptionalTime(instance.openedAt)} />
        {historical ? <Metric label="管理结束时间" value={formatOptionalTime(instance.closedAt)} /> : null}
        {historical ? <Metric label="管理结束方式" value={managementEndMethodLabel(deriveArbitrageManagementEndMethod(instance))} /> : null}
      </dl>
      {!historical && (canResumeOpeningWorkflow(instance) || canAbandon) ? (
        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-[#25282f] pt-4">
          {canAbandon && onInstanceRefresh ? <Button onClick={() => setAbandonOpen(true)} type="button" variant="ghost">
            放弃套利
          </Button> : null}
          {canResumeOpeningWorkflow(instance) ? <a
              className="inline-flex min-h-11 items-center justify-center border border-white/25 px-4 py-2.5 text-sm font-semibold uppercase tracking-[0.08em] text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white"
              href={buildArbitrageResumeHref(instance.arbitrageId)}
            >
              继续开仓
            </a> : null}
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
                  <LegRow label="正常确认退出数量" value={leg.confirmedClosedQuantity} />
                </>
              ) : <LiveLegVerification legId={leg.legId} state={verificationState} />}
              {!historical ? <LiveCloseSafety state={closeSafeties[leg.legId]} /> : null}
            </dl>
            {!historical ? <LegCloseActions
              closeSafetyState={closeSafeties[leg.legId]}
              onClose={() => setCloseTarget(leg)}
              verificationState={verificationState}
              legId={leg.legId}
              enabled={Boolean(onInstanceRefresh)}
              instanceFullExitAvailable={canExitFully}
            /> : null}
          </div>;
        })}
      </div>
      {historical ? null : <InstanceDeltaPanel instance={instance} state={deltaState} />}
      <ManagementHistory instance={instance} />
      <LegacyUnresolvedSealHistory instance={instance} />
      {!historical && instance.status === "RESIDUAL" ? <p className="mt-4 text-xs text-amber-200">存在管理残余；当前证据不足以进一步判断具体原因。</p> : null}
      {!historical ? <HedgeExitActions
        canExit={canExitFully}
        hasQuantityRuleDust={Object.values(safetyValues).some((safety) => safety.reason === "QUANTITY_STEP_DUST")}
        instance={instance}
        onExitHedge={onExitHedge}
        onReconcileHedge={onReconcileHedge}
        verificationState={verificationState}
      /> : null}
      {!historical && onInstanceRefresh ? <ManagementReleaseActions
        candidates={releaseCandidates}
        instanceFullExitAvailable={canExitFully}
        onRelease={setReleaseTarget}
      /> : null}
    </article>
    {closeTarget && closeTargetSafety && closeTargetVerification && onInstanceRefresh ? <ArbitrageLegCloseDialog
      closeSafety={closeTargetSafety}
      instance={instance}
      leg={closeTarget}
      onClose={() => setCloseTarget(null)}
      onUpdated={async () => {
        await onInstanceRefresh(instance.arbitrageId);
        setCloseTarget(null);
      }}
      verification={closeTargetVerification}
    /> : null}
    {releaseTarget && releaseTargetSafety && onInstanceRefresh ? <ArbitrageManagementReleaseDialog
      closeSafety={releaseTargetSafety}
      instance={instance}
      leg={releaseTarget}
      onClose={() => setReleaseTarget(null)}
      onReleased={async (arbitrageId) => {
        await onInstanceRefresh(arbitrageId);
        setReleaseTarget(null);
      }}
    /> : null}
    {abandonOpen && canAbandon && onInstanceRefresh ? <ArbitrageUnstartedAbandonDialog
      instance={instance}
      onAbandoned={async (updated) => {
        await onInstanceRefresh(updated.arbitrageId);
        setAbandonOpen(false);
      }}
      onClose={() => setAbandonOpen(false)}
    /> : null}
  </>;
}

export function canResumeOpeningWorkflow(instance: ArbitrageInstance) {
  if (instance.status !== "OPENING" && instance.status !== "RESIDUAL") return false;
  const opening = instance.executionReferences.filter((reference) => reference.phase === "OPENING");
  return instance.status === "OPENING" ? opening.length <= 1 : opening.length === 1;
}

export function canAbandonUnstartedArbitrage(instance: ArbitrageInstance) {
  return instance.status === "OPENING"
    && instance.executionReferences.length === 0
    && instance.managementReleases.length === 0
    && instance.legs.every((leg) => leg.confirmedOpenedQuantity === "0"
      && leg.confirmedClosedQuantity === "0");
}

function LiveCloseSafety({ state }: { state?: ReadState<ArbitrageCloseSafety> }) {
  if (!state || state.status === "loading") return <LegRow label="退出安全状态" value="读取中…" />;
  if (state.status === "error" || !state.value.realityReliable) return <LegRow label="退出安全状态" value="暂无法可靠确认" />;
  return <>
    <LegRow label="当前可安全退出数量" value={state.value.safeClosableQuantity} />
    <LegRow label="正常完整退出" value={state.value.fullManagedCloseAvailable ? "可用" : "不可用"} />
  </>;
}

function LegCloseActions({ closeSafetyState, enabled, instanceFullExitAvailable, legId, onClose, verificationState }: {
  closeSafetyState?: ReadState<ArbitrageCloseSafety>;
  enabled: boolean;
  instanceFullExitAvailable: boolean;
  legId: string;
  onClose: () => void;
  verificationState?: VerificationState;
}) {
  const verification = verificationState?.status === "success"
    ? verificationState.verification.legs.find((item) => item.legId === legId)
    : null;
  const safety = closeSafetyState?.status === "success" ? closeSafetyState.value : null;
  const actions = legActionAvailability(verification?.verificationStatus, safety, instanceFullExitAvailable);
  if (!enabled || !actions.partialClose) return null;
  return <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-[#25282f] pt-3">
    <Button onClick={onClose} type="button" variant="secondary">安全部分退出</Button>
  </div>;
}

export function legActionAvailability(
  verificationStatus: ArbitrageLegVerificationStatus | undefined,
  safety: ArbitrageCloseSafety | null,
  instanceFullExitAvailable = false,
) {
  const reliable = verificationStatus !== undefined && verificationStatus !== "UNKNOWN"
    && safety?.realityReliable === true;
  return {
    partialClose: reliable && !instanceFullExitAvailable
      && !safety.fullManagedCloseAvailable && !isZeroDecimal(safety.safeClosableQuantity),
    release: reliable && safety.releaseEligible,
  };
}

export function managementReleaseCandidates(
  instance: ArbitrageInstance,
  verificationState: VerificationState | undefined,
  safeties: Record<string, ArbitrageCloseSafety | undefined>,
) {
  if (verificationState?.status !== "success") return [];
  return instance.legs.filter((leg) => {
    const verification = verificationState.verification.legs.find((item) => item.legId === leg.legId);
    const safety = safeties[leg.legId];
    return verification?.verificationStatus !== undefined
      && verification.verificationStatus !== "UNKNOWN"
      && safety?.realityReliable === true
      && safety.releaseEligible;
  });
}

export function ManagementReleaseActions({ candidates, instanceFullExitAvailable, onRelease }: {
  candidates: ArbitrageInstanceLeg[];
  instanceFullExitAvailable: boolean;
  onRelease: (leg: ArbitrageInstanceLeg) => void;
}) {
  if (instanceFullExitAvailable || candidates.length === 0) return null;
  return <section className="mt-4 border-t border-[#25282f] pt-4">
    <p className="text-xs font-semibold text-amber-100">异常处置</p>
    <p className="mt-2 max-w-3xl text-xs leading-5 text-[#8f99a5]">
      正常完整退出不可用时，可以保留交易所中的残余仓位并结束 Xingheng 对对应套利腿的跟踪。本操作不会提交平仓订单。
    </p>
    <div className="mt-3 grid gap-3">
      {candidates.map((leg) => <div className="flex flex-wrap items-center justify-between gap-3" key={leg.legId}>
        <div className="min-w-0 text-xs">
          <p className="font-semibold text-[#c5ccd4]">{leg.role === "LONG" ? "多头腿" : "空头腿"}</p>
          <p className="mt-1 break-all font-mono text-[#707985]">{leg.instrumentId}</p>
        </div>
        <Button onClick={() => onRelease(leg)} type="button" variant="danger">保留残余并结束跟踪</Button>
      </div>)}
    </div>
  </section>;
}

export function instanceExitAvailability(
  instance: ArbitrageInstance,
  verificationState: VerificationState | undefined,
  safeties: Record<string, ArbitrageCloseSafety | undefined>,
) {
  if (verificationState?.status !== "success"
    || verificationState.verification.legs.some((leg) => leg.verificationStatus === "UNKNOWN")
    || instance.executionReferences.some((reference) => reference.status === "CLAIMED"
      || reference.status === "LINKED"
      || reference.status === "PENDING_CONFIRMATION"
      || reference.status === "UNKNOWN")) return false;
  const relevant = instance.legs.map((leg) => safeties[leg.legId])
    .filter((safety): safety is ArbitrageCloseSafety => Boolean(safety) && !isZeroDecimal(safety!.activeManagedQuantity));
  return relevant.length > 0 && relevant.every((safety) => safety.realityReliable
    && (safety.fullManagedCloseAvailable || safety.reason === "QUANTITY_STEP_DUST"));
}

export function InstanceDeltaPanel({ instance, state }: { instance: ArbitrageInstance; state: ReadState<InstanceHedgeDelta> }) {
  const asset = canonicalBaseAsset(instance);
  if (state.status === "loading") return <section className="mt-4 border-t border-[#25282f] pt-4"><p className="text-xs text-[#8f99a5]">正在读取本实例 Hedge Delta…</p></section>;
  if (state.status === "error") return <section className="mt-4 border-t border-[#25282f] pt-4"><p className="text-xs text-amber-200">本实例 Hedge Delta 暂无法可靠计算</p></section>;
  const delta = state.value;
  return <section className="mt-4 border-t border-[#25282f] pt-4">
    <h4 className="text-xs font-semibold text-white">本实例 Hedge Delta</h4>
    <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
      <Metric label="本实例开仓 Delta" value={deltaValue(delta.openingDelta, asset)} />
      <Metric label="当前管理 Delta" value={deltaValue(delta.activeManagedDelta, asset)} />
      <Metric label="计划残差" value={withAsset(delta.plannedResidualDelta, asset)} />
      <Metric label="实际开仓残差" value={delta.actualResidualDelta === null ? "暂无法可靠计算" : withAsset(delta.actualResidualDelta, asset)} />
    </dl>
    {delta.openingWorkflow.secondLegRequired ? <div className="mt-3 text-xs leading-5 text-amber-200">
      <p>第二腿尚待执行</p>
      {delta.openingWorkflow.requiredSecondLegSignedExposure !== null
        ? <p>理论所需对冲暴露：{withAsset(delta.openingWorkflow.requiredSecondLegSignedExposure, asset)}</p>
        : null}
    </div> : null}
  </section>;
}

export function ManagementHistory({ instance }: { instance: ArbitrageInstance }) {
  if (instance.managementReleases.length === 0) return null;
  return <section className="mt-4 border-t border-[#25282f] pt-4">
    <h4 className="text-xs font-semibold text-white">残余保留与跟踪结束记录</h4>
    <p className="mt-2 text-xs leading-5 text-amber-200">以下记录表示用户保留交易所残余并结束系统跟踪，不代表 Xingheng 已执行平仓。</p>
    <div className="mt-3 grid gap-2">{instance.managementReleases.map((release) => {
      const leg = instance.legs.find((candidate) => candidate.legId === release.legId);
      return <dl className="grid gap-2 border border-[#25282f] bg-[#0b0d11] p-3 text-xs sm:grid-cols-2" key={release.releaseId}>
        <Metric label="套利腿" value={leg ? `${leg.role === "LONG" ? "多头腿" : "空头腿"} · ${leg.instrumentId}` : release.legId} />
        <Metric label="已保留残余数量" value={release.releasedQuantity} />
        <Metric label="确认时间" value={formatTime(release.confirmedAt)} />
        <Metric label="原因" value="用户确认保留残余并结束跟踪" />
        <Metric label="Release 时交易所真实数量（历史快照）" value={release.actualQuantity} />
        <Metric label="Reality 快照时间" value={formatTime(release.realityCheckedAt)} />
      </dl>;
    })}</div>
  </section>;
}

export function LegacyUnresolvedSealHistory({ instance }: { instance: ArbitrageInstance }) {
  if (instance.legacyUnresolvedExecutionSeals.length === 0) return null;
  return <section className="mt-4 border-t border-[#25282f] pt-4">
    <h4 className="text-xs font-semibold text-white">历史异常封存记录</h4>
    <p className="mt-2 text-xs leading-5 text-amber-200">封存仅终结该旧实例的管理责任；原始交易事实仍为 UNKNOWN，未被改写为成交、失败或未派发。</p>
    <div className="mt-3 grid gap-2">{instance.legacyUnresolvedExecutionSeals.map((seal) => <dl
      className="grid gap-2 border border-[#25282f] bg-[#0b0d11] p-3 text-xs sm:grid-cols-2"
      key={seal.commandId}
    >
      <Metric label="交易状态" value="历史 UNKNOWN" />
      <Metric label="处理状态" value="历史异常已封存" />
      <Metric label="交易标的" value={seal.instrumentId} />
      <Metric label="封存时间" value={formatTime(seal.sealedAt)} />
    </dl>)}</div>
  </section>;
}

export function managementEndMethodLabel(method: ReturnType<typeof deriveArbitrageManagementEndMethod>) {
  return method === "NORMAL_CLOSE" ? "正常退出完成"
    : method === "MANAGEMENT_RELEASE" ? "保留残余并结束跟踪"
      : method === "MIXED" ? "部分正常退出 + 保留残余结束跟踪"
        : method === "LEGACY_UNRESOLVED_SEAL" ? "历史异常已封存" : "—";
}

function deltaValue(value: InstanceHedgeDelta["openingDelta"], asset: string | null) {
  return value.status === "KNOWN" && value.signedDeltaBaseQuantity !== null
    ? withAsset(value.signedDeltaBaseQuantity, asset)
    : "暂无法可靠计算";
}

function withAsset(quantity: string, asset: string | null) {
  return asset ? `${quantity} ${asset}` : `${quantity} 基础资产`;
}

export function canonicalBaseAsset(instance: ArbitrageInstance) {
  const assets = instance.legs.map((leg) => leg.instrumentId.split("-")[0]).filter(Boolean);
  return assets.length === 2 && assets[0] === assets[1] ? assets[0]! : null;
}

function isZeroDecimal(value: string) {
  return /^0+(?:\.0+)?$/u.test(value);
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

function HedgeExitActions({ canExit, hasQuantityRuleDust, instance, onExitHedge, onReconcileHedge, verificationState }: {
  canExit: boolean;
  hasQuantityRuleDust: boolean;
  instance: ArbitrageInstance;
  onExitHedge?: (target: ExitTarget) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void;
  verificationState?: VerificationState;
}) {
  const summary = hedgeExitSummary(instance, verificationState);
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
      {summary.kind !== "ended" && canExit && onExitHedge ? <Button
        onClick={() => onExitHedge({ instance, hasQuantityRuleDust })}
        type="button"
      >
        完整退出
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
    return { kind: "ended" as const, label: "实例管理已结束", details: [] as string[], progress };
  }
  if (!state || state.status === "loading" || state.status === "error") {
    return { kind: "unknown" as const, label: "当前真实仓位暂无法可靠确认", details: [] as string[], progress };
  }
  if (state.verification.legs.some((leg) => leg.actualQuantity === null || leg.verificationStatus === "UNKNOWN")) {
    return { kind: "unknown" as const, label: "当前真实仓位暂无法可靠确认", details: [] as string[], progress };
  }
  const conflict = state.verification.legs.some((leg) => leg.verificationStatus === "MISMATCH");
  return {
    kind: "remaining" as const,
    label: conflict ? "当前真实仓位已无法完整支持系统管理数量" : "实例仍在管理",
    details: state.verification.legs.map((fact) => {
      const leg = instance.legs.find((candidate) => candidate.legId === fact.legId)!;
      return `${instanceLegLabel(instance, leg)}交易所真实数量 ${fact.actualQuantity}`;
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

function LiveLegVerification({ legId, state }: { legId: string; state?: VerificationState }) {
  if (!state || state.status === "loading") {
    return <><LegRow label="系统管理数量" value="核验中…" /><LegRow label="交易所真实数量" value="核验中…" /><VerificationNotice status="loading" /></>;
  }
  if (state.status === "error") {
    return <><LegRow label="系统管理数量" value="暂无可靠数据" /><LegRow label="交易所真实数量" value="暂无可靠数据" /><VerificationNotice status="error" /></>;
  }
  const verification = state.verification.legs.find((item) => item.legId === legId);
  if (!verification) {
    return <><LegRow label="系统管理数量" value="暂无可靠数据" /><LegRow label="交易所真实数量" value="暂无可靠数据" /><VerificationNotice status="error" /></>;
  }
  return (
    <>
      <LegRow label="系统管理数量" value={verification.expectedManagedQuantity} />
      <LegRow label="交易所真实数量" value={verification.actualQuantity ?? "暂无可靠数据"} />
      <VerificationNotice status={verification.verificationStatus} />
    </>
  );
}

function VerificationNotice({ status }: { status: ArbitrageLegVerificationStatus | "loading" | "error" }) {
  if (status === "loading") return <div className="mt-3 border-t border-[#25282f] pt-3 text-xs text-[#8f99a5]">正在核验当前仓位…</div>;
  if (status === "error" || status === "UNKNOWN") {
    return <div className="mt-3 flex items-start gap-2 border-t border-[#25282f] pt-3 text-xs text-amber-200"><CircleHelp className="mt-0.5 shrink-0" size={14} /><span>当前真实仓位暂无法可靠确认</span></div>;
  }
  if (status === "MISMATCH") {
    return <div className="mt-3 flex items-start gap-2 border-t border-[#25282f] pt-3 text-xs text-red-200"><AlertTriangle className="mt-0.5 shrink-0" size={14} /><span>当前真实仓位已无法完整支持系统管理数量</span></div>;
  }
  return <div className="mt-3 flex items-center gap-2 border-t border-[#25282f] pt-3 text-xs text-emerald-200"><CheckCircle2 size={14} /><span>当前仓位关系正常</span></div>;
}

export function verificationStatusLabel(status: ArbitrageLegVerificationStatus) {
  return {
    MATCHED: "当前仓位关系正常",
    MISMATCH: "当前真实仓位已无法完整支持系统管理数量",
    UNKNOWN: "当前真实仓位暂无法可靠确认",
  }[status];
}

function StatusBadge({ instance }: { instance: ArbitrageInstance }) {
  const status = instance.status;
  const warning = status === "RESIDUAL" || status === "FAILED";
  const label = status === "FAILED"
    && instance.executionReferences.length === 0
    && instance.legs.every((leg) => leg.confirmedOpenedQuantity === "0"
      && leg.confirmedClosedQuantity === "0")
    ? "未开始 / 已终止"
    : statusLabel(status);
  return (
    <span className={`border px-2 py-1 text-[11px] font-medium ${warning ? "border-amber-400/30 text-amber-200" : "border-white/20 text-[#c5ccd4]"}`}>
      {label}
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
    CLOSED: "实例管理已结束",
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
