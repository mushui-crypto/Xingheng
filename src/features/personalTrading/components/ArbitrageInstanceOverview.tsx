import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleHelp, Layers3 } from "lucide-react";
import {
  deriveArbitrageManagementEndMethod,
  fetchActiveArbitrageInstances,
  fetchArbitragePositionPresentations,
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
  type ArbitragePositionPresentation,
  type InstanceHedgeDelta,
} from "../../../api/arbitrageInstances";
import { formatFundingCountdown } from "../../arbitrage/lib/formatters";
import { startVisibilityAwarePolling } from "../../arbitrage/lib/visibilityPolling";
import {
  reconcileArbitrageInstance,
  type ArbitrageTerminalAuthoritativeSnapshot,
} from "../../../api/arbitrageExecutionDraft";
import { Button } from "../../../components/ui/Button";
import { ArbitrageExecutionDraftEntry } from "../../arbitrage/components/ArbitrageExecutionDraftEntry";
import { ArbitrageHedgeExitDialog } from "./ArbitrageHedgeExitDialog";
import { ArbitrageLegCloseDialog } from "./ArbitrageLegCloseDialog";
import { ArbitrageManagementReleaseDialog } from "./ArbitrageManagementReleaseDialog";
import { ArbitrageUnstartedAbandonDialog } from "./ArbitrageUnstartedAbandonDialog";

const HISTORY_LIMIT = 50;
const VERIFICATION_CONCURRENCY = 4;
const CLOSE_SAFETY_READ_ATTEMPTS = 3;
const CLOSE_SAFETY_RETRY_DELAY_MS = 250;
export const POSITION_PRESENTATION_REFRESH_INTERVAL_MS = 20_000;
export const POSITION_COUNTDOWN_REFRESH_INTERVAL_MS = 1_000;

export type VerificationState =
  | { status: "loading" }
  | { status: "success"; verification: ArbitragePositionVerification }
  | { status: "error" };

export type ReadState<T> = { status: "loading" } | { status: "success"; value: T } | { status: "error" };
type ExitTarget = Readonly<{ instance: ArbitrageInstance; hasQuantityRuleDust: boolean }>;

export type ExitCapabilitiesState = Readonly<{
  verification: VerificationState;
  closeSafeties: Record<string, ReadState<ArbitrageCloseSafety>>;
  delta: ReadState<InstanceHedgeDelta>;
}>;

type ExitCapabilityLoaders = Readonly<{
  verification: typeof fetchArbitragePositionVerification;
  closeSafety: typeof fetchArbitrageCloseSafety;
  delta: typeof fetchInstanceHedgeDelta;
  wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

export type ArbitrageInstanceLoadState =
  | { status: "loading" }
  | {
      status: "success";
      active: ArbitrageInstance[];
      history: ArbitrageInstance[];
      presentations?: ArbitragePositionPresentation[];
      presentationStatus?: "loading" | "success" | "error";
    }
  | { status: "error" };

export function coreArbitrageDataLoaded(
  active: ArbitrageInstance[],
  history: ArbitrageInstance[],
): ArbitrageInstanceLoadState {
  return { status: "success", active, history, presentations: [], presentationStatus: "loading" };
}

export function beginPositionPresentationLoad(
  current: ArbitrageInstanceLoadState,
): ArbitrageInstanceLoadState {
  return current.status === "success" ? { ...current, presentationStatus: "loading" } : current;
}

export function updatePositionPresentations(
  current: ArbitrageInstanceLoadState,
  presentations: ArbitragePositionPresentation[],
): ArbitrageInstanceLoadState {
  return current.status === "success"
    ? { ...current, presentations, presentationStatus: "success" }
    : current;
}

export function failPositionPresentationLoad(
  current: ArbitrageInstanceLoadState,
): ArbitrageInstanceLoadState {
  return current.status === "success" ? { ...current, presentationStatus: "error" } : current;
}

export function ArbitrageInstanceOverview() {
  const [page, setPage] = useState(1);
  const [selectedSection, setSelectedSection] = useState<"active" | "history">("active");
  const [state, setState] = useState<ArbitrageInstanceLoadState>({ status: "loading" });
  const [exitTarget, setExitTarget] = useState<ExitTarget | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    const presentationRequest = fetchArbitragePositionPresentations(controller.signal).then(
      (presentations) => ({ status: "success" as const, presentations }),
      () => ({ status: "error" as const }),
    );
    void Promise.all([
      fetchActiveArbitrageInstances(controller.signal),
      fetchArbitrageInstanceHistory(page, HISTORY_LIMIT, controller.signal),
    ]).then(([active, history]) => {
      if (controller.signal.aborted) return;
      setState(coreArbitrageDataLoaded(active, history));
      void presentationRequest
        .then((result) => {
          if (controller.signal.aborted) return;
          setState((current) => result.status === "success"
            ? updatePositionPresentations(current, result.presentations)
            : failPositionPresentationLoad(current));
        });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [page]);

  useEffect(() => {
    if (selectedSection !== "active") return;
    let refreshing = false;
    const controller = new AbortController();
    const refreshPresentations = () => {
      if (refreshing) return;
      refreshing = true;
      setState((current) => beginPositionPresentationLoad(current));
      void fetchArbitragePositionPresentations(controller.signal)
        .then((presentations) => {
          if (controller.signal.aborted) return;
          setState((current) => updatePositionPresentations(current, presentations));
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setState((current) => failPositionPresentationLoad(current));
          }
        })
        .finally(() => { refreshing = false; });
    };
    const stopPolling = startVisibilityAwarePolling(
      refreshPresentations,
      POSITION_PRESENTATION_REFRESH_INTERVAL_MS,
    );
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [selectedSection]);

  const applyInstanceUpdate = (updated: ArbitrageInstance) => {
    setState((current) => current.status === "success"
      ? updateInstanceSections(current, updated)
      : current);
    return updated;
  };

  const refreshInstance = async (arbitrageId: string) => {
    const updated = await fetchArbitrageInstanceById(arbitrageId);
    applyInstanceUpdate(updated);
    return updated;
  };

  const reconcileHedge = async (instance: ArbitrageInstance) => {
    try {
      const { instance: updated } = await reconcileArbitrageHedge(instance);
      setState((current) => current.status === "success"
        ? updateInstanceSections(current, updated)
        : current);
    } catch {}
  };

  return <>
    <ArbitrageInstanceContent
      onExitHedge={setExitTarget}
      onInstanceRefresh={refreshInstance}
      onInstanceUpdated={applyInstanceUpdate}
      onReconcileHedge={reconcileHedge}
      onPageChange={setPage}
      onSectionChange={setSelectedSection}
      page={page}
      selectedSection={selectedSection}
      state={state}
    />
    {exitTarget ? <ArbitrageHedgeExitDialog
      hasQuantityRuleDust={exitTarget.hasQuantityRuleDust}
      instance={exitTarget.instance}
      onClose={() => setExitTarget(null)}
      onUpdated={applyInstanceUpdate}
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

export function loadingExitCapabilities(instance: ArbitrageInstance): ExitCapabilitiesState {
  return {
    verification: { status: "loading" },
    closeSafeties: Object.fromEntries(instance.legs.map((leg) => [leg.legId, { status: "loading" }])),
    delta: { status: "loading" },
  };
}

export function terminalSnapshotExitCapabilities(
  snapshot: ArbitrageTerminalAuthoritativeSnapshot,
): ExitCapabilitiesState {
  return {
    verification: snapshot.verification
      ? { status: "success", verification: snapshot.verification }
      : { status: "error" },
    closeSafeties: Object.fromEntries(snapshot.instance.legs.map((leg) => {
      const safety = snapshot.closeSafeties[leg.legId];
      return [leg.legId, safety ? { status: "success", value: safety } : { status: "error" }];
    })),
    delta: snapshot.delta ? { status: "success", value: snapshot.delta } : { status: "error" },
  };
}

function terminalSnapshotKey(instance: ArbitrageInstance) {
  return `${instance.arbitrageId}\0${instance.status}\0${instance.updatedAt}`;
}

export async function loadExitCapabilities(
  instance: ArbitrageInstance,
  signal: AbortSignal,
  options: Partial<ExitCapabilityLoaders> & { closeSafetyAttempts?: number; retryDelayMs?: number } = {},
): Promise<ExitCapabilitiesState> {
  const loaders: ExitCapabilityLoaders = {
    verification: options.verification ?? fetchArbitragePositionVerification,
    closeSafety: options.closeSafety ?? fetchArbitrageCloseSafety,
    delta: options.delta ?? fetchInstanceHedgeDelta,
    wait: options.wait ?? waitForExitCapabilityRetry,
  };
  const attempts = options.closeSafetyAttempts ?? CLOSE_SAFETY_READ_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? CLOSE_SAFETY_RETRY_DELAY_MS;
  const verification = loaders.verification(instance.arbitrageId, signal)
    .then((value): VerificationState => ({ status: "success", verification: value }))
    .catch((): VerificationState => ({ status: "error" }));
  const delta = loaders.delta(instance.arbitrageId, signal)
    .then((value): ReadState<InstanceHedgeDelta> => ({ status: "success", value }))
    .catch((): ReadState<InstanceHedgeDelta> => ({ status: "error" }));
  const safetyEntries = await Promise.all(instance.legs.map(async (leg) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const value = await loaders.closeSafety(instance.arbitrageId, leg.legId, signal);
        if (value.reason === "PROVIDER_REALITY_UNAVAILABLE" && attempt < attempts) {
          await loaders.wait(retryDelayMs * (2 ** (attempt - 1)), signal);
          continue;
        }
        return [leg.legId, { status: "success", value } satisfies ReadState<ArbitrageCloseSafety>] as const;
      } catch {
        if (signal.aborted || attempt === attempts) break;
        await loaders.wait(retryDelayMs * (2 ** (attempt - 1)), signal);
      }
    }
    return [leg.legId, { status: "error" } satisfies ReadState<ArbitrageCloseSafety>] as const;
  }));
  return {
    verification: await verification,
    closeSafeties: Object.fromEntries(safetyEntries),
    delta: await delta,
  };
}

function waitForExitCapabilityRetry(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function ArbitrageInstanceContent({
  onExitHedge,
  onInstanceRefresh,
  onInstanceUpdated,
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
  onInstanceUpdated?: (instance: ArbitrageInstance) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void | Promise<void>;
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
      presentations={state.presentations ?? []}
      onPageChange={onPageChange}
      onExitHedge={onExitHedge}
      onInstanceRefresh={onInstanceRefresh}
      onInstanceUpdated={onInstanceUpdated}
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
  onInstanceUpdated,
  onReconcileHedge,
  onSectionChange = () => undefined,
  page,
  selectedSection = "active",
  verifications = {},
  presentations = [],
}: {
  active: ArbitrageInstance[];
  history: ArbitrageInstance[];
  onPageChange: (page: number) => void;
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
  onInstanceUpdated?: (instance: ArbitrageInstance) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void | Promise<void>;
  onSectionChange?: (section: "active" | "history") => void;
  page: number;
  selectedSection?: "active" | "history";
  verifications?: Record<string, VerificationState>;
  presentations?: ArbitragePositionPresentation[];
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
          onInstanceUpdated={onInstanceUpdated}
          onReconcileHedge={onReconcileHedge}
          title="当前套利"
          presentations={presentations}
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
  onInstanceUpdated,
  onReconcileHedge,
  title,
  verifications = {},
  presentations = [],
}: {
  emptyText: string;
  historical?: boolean;
  instances: ArbitrageInstance[];
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
  onInstanceUpdated?: (instance: ArbitrageInstance) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void | Promise<void>;
  title: string;
  verifications?: Record<string, VerificationState>;
  presentations?: ArbitragePositionPresentation[];
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-[#8f99a5]">{instances.length} 条</span>
      </div>
      {instances.length === 0
        ? <p className="border border-[#25282f] bg-black p-5 text-center text-sm text-[#8f99a5]">{emptyText}</p>
        : <div className="grid gap-3">{instances.map((item) => <InstanceCard historical={historical} instance={item} key={item.arbitrageId} onExitHedge={onExitHedge} onInstanceRefresh={onInstanceRefresh} onInstanceUpdated={onInstanceUpdated} onReconcileHedge={onReconcileHedge} presentation={presentations.find((value) => value.arbitrageId === item.arbitrageId)} verificationState={verifications[item.arbitrageId]} />)}</div>}
    </section>
  );
}

function InstanceCard({ historical, instance, onExitHedge, onInstanceRefresh, onInstanceUpdated, onReconcileHedge, presentation, verificationState }: {
  historical: boolean;
  instance: ArbitrageInstance;
  onExitHedge?: (target: ExitTarget) => void;
  onInstanceRefresh?: (arbitrageId: string) => Promise<ArbitrageInstance>;
  onInstanceUpdated?: (instance: ArbitrageInstance) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void | Promise<void>;
  presentation?: ArbitragePositionPresentation;
  verificationState?: VerificationState;
}) {
  const [expanded, setExpanded] = useState(false);
  const [capabilities, setCapabilities] = useState<ExitCapabilitiesState>(() => ({
    ...loadingExitCapabilities(instance),
    verification: verificationState ?? { status: "loading" },
  }));
  const [closeTarget, setCloseTarget] = useState<ArbitrageInstanceLeg | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ArbitrageInstanceLeg | null>(null);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [capabilityRefreshError, setCapabilityRefreshError] = useState(false);
  const refreshController = useRef<AbortController | null>(null);
  const refreshGeneration = useRef(0);
  const appliedTerminalSnapshotKey = useRef<string | null>(null);
  const legIds = instance.legs.map((leg) => leg.legId).join("\0");

  const refreshExitCapabilities = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    const generation = ++refreshGeneration.current;
    refreshController.current = controller;
    setCapabilityRefreshError(false);
    setCapabilities(loadingExitCapabilities(instance));
    const refreshed = await loadExitCapabilities(instance, controller.signal);
    if (!controller.signal.aborted && generation === refreshGeneration.current) {
      setCapabilities(refreshed);
      setCapabilityRefreshError(!exitCapabilityReadsComplete(instance, refreshed));
    }
  }, [instance.arbitrageId, legIds]);

  useEffect(() => {
    if (historical) return;
    if (appliedTerminalSnapshotKey.current === terminalSnapshotKey(instance)) {
      appliedTerminalSnapshotKey.current = null;
      return;
    }
    void refreshExitCapabilities();
    return () => refreshController.current?.abort();
  }, [historical, instance.arbitrageId, instance.status, instance.updatedAt, refreshExitCapabilities]);

  const closeSafeties = capabilities.closeSafeties;
  const deltaState = capabilities.delta;
  const effectiveVerification = capabilities.verification;

  const safetyValues = Object.fromEntries(Object.entries(closeSafeties)
    .filter((entry): entry is [string, Extract<ReadState<ArbitrageCloseSafety>, { status: "success" }>] => entry[1].status === "success")
    .map(([legId, state]) => [legId, state.value]));
  const exitCapabilitiesComplete = effectiveVerification.status === "success"
    && instance.legs.every((leg) => {
      const safety = closeSafeties[leg.legId];
      if (safety?.status !== "success") return false;
      if (isZeroDecimal(safety.value.activeManagedQuantity)) return true;
      const verification = effectiveVerification.verification.legs.find((item) => item.legId === leg.legId);
      return verification?.verificationStatus !== "UNKNOWN" && safety.value.realityReliable;
    });
  const exitCapabilitiesLoading = effectiveVerification.status === "loading"
    || deltaState.status === "loading"
    || instance.legs.some((leg) => closeSafeties[leg.legId]?.status === "loading");
  const canExitFully = exitCapabilitiesComplete && instanceExitAvailability(instance, effectiveVerification, safetyValues);
  const releaseCandidates = exitCapabilitiesComplete
    ? managementReleaseCandidates(instance, effectiveVerification, safetyValues)
    : [];
  const closeTargetVerification = closeTarget && effectiveVerification.status === "success"
    ? effectiveVerification.verification.legs.find((item) => item.legId === closeTarget.legId)
    : null;
  const closeTargetSafety = closeTarget ? safetyValues[closeTarget.legId] : null;
  const releaseTargetSafety = releaseTarget ? safetyValues[releaseTarget.legId] : null;
  const canAbandon = canAbandonUnstartedArbitrage(instance);
  const pair = instancePair(instance);
  const longLeg = instance.legs.find((leg) => leg.role === "LONG")!;
  const shortLeg = instance.legs.find((leg) => leg.role === "SHORT")!;
  const exitPresentation = currentExitPresentation(instance, canExitFully, exitCapabilitiesLoading, effectiveVerification, safetyValues);
  return <>
    <article className="min-w-0 overflow-hidden rounded-lg border border-[#232830] bg-[#030405]">
      <div className="flex min-w-0 flex-col border-b border-[#232830] md:flex-row md:items-stretch">
        <button
          aria-controls={`arbitrage-details-${instance.arbitrageId}`}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 flex-col items-stretch justify-between gap-3 px-[22px] py-[17px] text-left outline-none transition-colors duration-200 hover:bg-white/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 motion-reduce:transition-none sm:flex-row sm:items-center sm:gap-4"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-[9px]">
              <h4 className="text-[21px] font-bold leading-none tracking-[-0.01em] text-[#f3f5f8]">{pair.base} / {pair.quote}</h4>
              <span className="rounded bg-[#13161a] px-[9px] py-[5px] text-[11px] font-bold leading-none text-[#b7bfca]">资金费率套利</span>
              <span className="rounded bg-[#13161a] px-[9px] py-[5px] text-[11px] font-bold leading-none text-[#b7bfca]">{instance.legs[0].venue === instance.legs[1].venue ? "同所" : "跨所"}</span>
              <StatusBadge instance={instance} />
            </div>
            {instance.legs[0].venue !== instance.legs[1].venue ? <p className="mt-2 truncate text-[11px] leading-4 text-[#798493]">{venuePath(instance)}</p> : null}
          </div>
          <span className="flex shrink-0 items-center justify-between gap-[10px] sm:justify-start">
            <span className={`rounded px-[9px] py-[5px] text-[11px] font-bold leading-none ${exitToneClass(exitPresentation.tone)}`}>{exitPresentation.label}</span>
            <ChevronDown className={`shrink-0 text-white transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} size={18} strokeWidth={1.5} aria-hidden="true" />
          </span>
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-[10px] border-b border-[#232830] p-[18px] md:grid-cols-3 xl:grid-cols-6">
        <PrimaryMetric label="净资金费率" {...fundingRatePresentation(presentation)} />
        <PrimaryMetric label="下次预计净资金费用" {...estimatedFundingPresentation(presentation)} />
        <PrimaryMetric label="距下次结算" value={<PositionFundingCountdown presentation={presentation} />} valueClassName="tabular-nums" />
        <PrimaryMetric label="当前退出价差" {...spreadPresentation(presentation, pair.quote)} />
        <PrimaryMetric label="管理规模" {...managedScalePresentation(presentation)} />
        <PrimaryMetric label="累计资金费收入" {...cumulativeFundingPresentation(presentation)} />
      </dl>

      {!historical && (canResumeOpeningWorkflow(instance) || canAbandon) ? (
        <div className="flex flex-wrap justify-end gap-2 px-4 py-3 sm:px-5" onClick={(event) => event.stopPropagation()}>
          {canAbandon && onInstanceRefresh ? <Button onClick={() => setAbandonOpen(true)} type="button" variant="ghost">
            放弃套利
          </Button> : null}
          {canResumeOpeningWorkflow(instance)
            ? <ArbitrageExecutionDraftEntry
                onTerminalSnapshot={(snapshot) => {
                  if (snapshot.instance.arbitrageId !== instance.arbitrageId) return;
                  refreshController.current?.abort();
                  refreshGeneration.current += 1;
                  appliedTerminalSnapshotKey.current = terminalSnapshotKey(snapshot.instance);
                  setCapabilities(terminalSnapshotExitCapabilities(snapshot));
                  setCapabilityRefreshError(!snapshot.complete);
                  onInstanceUpdated?.(snapshot.instance);
                }}
                resumeArbitrageId={instance.arbitrageId}
              />
            : null}
        </div>
      ) : null}
      <div hidden={!expanded} id={`arbitrage-details-${instance.arbitrageId}`}>
        <section className="border-b border-[#232830] p-[18px]">
          <div className="mb-3 flex items-center justify-between">
            <h5 className="text-[13px] font-bold leading-none text-[#b7bfca]">仓位明细</h5>
            <ChevronDown className="text-white" size={18} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(240px,1fr)]">
            <PositionLegPanel funding={presentation?.market.legs?.find((leg) => leg.legId === longLeg.legId)} historical={historical} instance={instance} leg={longLeg} verificationState={effectiveVerification} closeSafetyState={closeSafeties[longLeg.legId]}>
              {!historical ? <LegCloseActions closeSafetyState={closeSafeties[longLeg.legId]} onClose={() => setCloseTarget(longLeg)} verificationState={effectiveVerification} legId={longLeg.legId} enabled={Boolean(onInstanceRefresh)} exitCapabilitiesComplete={exitCapabilitiesComplete} instanceFullExitAvailable={canExitFully} /> : null}
            </PositionLegPanel>
            <PositionLegPanel funding={presentation?.market.legs?.find((leg) => leg.legId === shortLeg.legId)} historical={historical} instance={instance} leg={shortLeg} verificationState={effectiveVerification} closeSafetyState={closeSafeties[shortLeg.legId]}>
              {!historical ? <LegCloseActions closeSafetyState={closeSafeties[shortLeg.legId]} onClose={() => setCloseTarget(shortLeg)} verificationState={effectiveVerification} legId={shortLeg.legId} enabled={Boolean(onInstanceRefresh)} exitCapabilitiesComplete={exitCapabilitiesComplete} instanceFullExitAvailable={canExitFully} /> : null}
            </PositionLegPanel>
            <PositionHealthPanel canExitFully={canExitFully} closeSafeties={safetyValues} deltaState={deltaState} instance={instance} verificationState={effectiveVerification} />
          </div>
        </section>

        <RevenueDetails instance={instance} presentation={presentation} />

        <details className="border-t border-[#232830] px-[18px] py-3 text-xs">
          <summary className="cursor-pointer select-none text-[#8f99a5] outline-none hover:text-white focus-visible:ring-1 focus-visible:ring-white/50">技术与价格详情</summary>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Instance ID" value={instance.arbitrageId} />
            <Metric label="创建时间" value={formatTime(instance.createdAt)} />
            <Metric label="建仓完成时间" value={formatOptionalTime(instance.openedAt)} />
            <Metric label="最后更新时间" value={formatTime(instance.updatedAt)} />
            {historical ? <Metric label="管理结束时间" value={formatOptionalTime(instance.closedAt)} /> : null}
            {historical ? <Metric label="管理结束方式" value={managementEndMethodLabel(deriveArbitrageManagementEndMethod(instance))} /> : null}
            <Metric label="开仓均价" value="暂无可靠数据" />
            <Metric label="当前价格" value="暂无可靠数据" />
            <Metric label="标记价格" value="暂无可靠数据" />
            <Metric label="基差变动影响" value="暂无可靠数据" />
            <Metric label="Position Mode" value={instance.legs.map((leg) => safetyValues[leg.legId]?.positionMode ?? "暂无可靠数据").join(" / ")} />
            <Metric label="Position Bucket" value={instance.legs.map((leg) => leg.role).join(" / ")} />
            <Metric label="Execution / Reference / Audit" value={`${instance.executionReferences.length} 条执行引用`} />
            <Metric label="Verification" value={effectiveVerification.status === "success" ? formatTime(effectiveVerification.verification.checkedAt) : "暂无可靠数据"} />
          </dl>
          {!historical ? <InstanceDeltaPanel instance={instance} state={deltaState} /> : null}
          <ManagementHistory instance={instance} />
          <LegacyUnresolvedSealHistory instance={instance} />
        </details>

        {!historical ? <HedgeExitActions
          canExit={canExitFully}
          hasQuantityRuleDust={Object.values(safetyValues).some((safety) => safety.reason === "QUANTITY_STEP_DUST")}
          instance={instance}
          onExitHedge={onExitHedge}
          onReconcileHedge={onReconcileHedge ? async () => {
            setCapabilities(loadingExitCapabilities(instance));
            try {
              await onReconcileHedge(instance);
            } finally {
              await refreshExitCapabilities();
            }
          } : undefined}
          onRefreshExitCapabilities={() => void refreshExitCapabilities()}
          refreshError={capabilityRefreshError}
          refreshing={exitCapabilitiesLoading}
          verificationState={effectiveVerification}
        /> : null}
      </div>

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

type MetricTone = "neutral" | "success" | "warning" | "risk";

function PrimaryMetric({ compact = false, detail, label, tone = "neutral", unit, value, valueClassName = "" }: {
  compact?: boolean;
  detail?: string;
  label: string;
  tone?: MetricTone;
  unit?: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  const toneClass = tone === "success" ? "text-[#6ee7b7]" : tone === "warning" ? "text-[#fbbf24]" : tone === "risk" ? "text-[#f87171]" : "text-[#f3f5f8]";
  return <div className="min-w-0 rounded-md bg-[#0c0e11] p-4">
    <dt className="text-[11px] leading-none text-[#798493]">{label}</dt>
    <dd className={`mt-[7px] min-w-0 break-words font-mono font-medium leading-5 ${compact ? "text-[15px]" : "text-[17px]"} ${toneClass} ${valueClassName}`}>
      {value}{unit ? <span className="ml-1 font-mono text-[12px] font-medium text-current">{unit}</span> : null}
    </dd>
    {detail ? <span className="mt-1 block text-[10px] leading-4 text-[#798493]">{detail}</span> : null}
  </div>;
}

function PositionLegPanel({ children, closeSafetyState, funding, historical, instance, leg, verificationState }: {
  children?: ReactNode;
  closeSafetyState?: ReadState<ArbitrageCloseSafety>;
  funding?: NonNullable<ArbitragePositionPresentation["market"]["legs"]>[number];
  historical: boolean;
  instance: ArbitrageInstance;
  leg: ArbitrageInstanceLeg;
  verificationState: VerificationState;
}) {
  const spot = leg.instrumentId.endsWith("-SPOT");
  const verification = verificationState.status === "success"
    ? verificationState.verification.legs.find((item) => item.legId === leg.legId)
    : null;
  const safety = closeSafetyState?.status === "success" ? closeSafetyState.value : null;
  const providerReality = spot
    ? verification?.actualQuantity ?? "暂无可靠数据"
    : leg.role === "LONG"
      ? safety?.actualLongQuantity ?? verification?.actualQuantity ?? "暂无可靠数据"
      : safety?.actualShortQuantity ?? verification?.actualQuantity ?? "暂无可靠数据";
  const managed = safety?.activeManagedQuantity ?? verification?.expectedManagedQuantity ?? activeManagedFallback(leg);
  const exitQuantity = historical ? "—" : safety?.safeClosableQuantity ?? "暂无可靠数据";
  const quantityAsset = canonicalBaseAsset(instance) ?? "";
  const exitStatus = historical ? statusLabel(instance.status)
    : !safety || !safety.realityReliable ? "需同步确认"
      : safety.fullManagedCloseAvailable ? "可安全退出"
        : !isZeroDecimal(safety.safeClosableQuantity) ? "可部分安全退出" : "当前不可安全退出";
  const title = leg.role === "LONG" ? "多头腿" : "空头腿";
  return <section className="min-w-0 rounded-md bg-[#0c0e11] p-[18px]">
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-[9px] font-bold leading-none text-[#3b82f6]">{leg.role} LEG</p>
        <h5 className="mt-[3px] text-[15px] font-bold leading-5 text-[#f3f5f8]">{title}</h5>
      </div>
    </div>
    <dl className="mt-[14px] space-y-[10px] text-[12px] leading-none">
      <LegRow label="交易所" value={<VenueValue venue={leg.venue} />} />
      <LegRow label="交易类型" value={spot ? "现货" : "永续合约"} />
      <LegRow label="管理数量" value={quantityWithAsset(managed, quantityAsset)} />
      <LegRow label="本腿资金费率" value={legFundingValue(spot, funding)} />
      <LegRow label={spot ? "交易所实际数量" : "交易所实际仓位"} value={quantityWithAsset(providerReality, quantityAsset)} />
      <LegRow label={spot ? "可安全退出" : "可安全平仓"} value={quantityWithAsset(exitQuantity, quantityAsset)} />
      <LegRow label="退出状态" value={exitStatus} />
      {historical ? <>
        <LegRow label="已确认开仓数量" value={leg.confirmedOpenedQuantity} />
        <LegRow label="正常确认退出数量" value={leg.confirmedClosedQuantity} />
      </> : null}
    </dl>
    {!historical && verification ? <VerificationNotice status={verification.verificationStatus} /> : null}
    {children}
  </section>;
}

function PositionHealthPanel({ canExitFully, closeSafeties, deltaState, instance, verificationState }: {
  canExitFully: boolean;
  closeSafeties: Record<string, ArbitrageCloseSafety | undefined>;
  deltaState: ReadState<InstanceHedgeDelta>;
  instance: ArbitrageInstance;
  verificationState: VerificationState;
}) {
  const health = derivePositionHealth(instance, verificationState, closeSafeties, deltaState, canExitFully);
  const delta = deltaState.status === "success" ? deltaValue(deltaState.value.activeManagedDelta, canonicalBaseAsset(instance)) : "暂无可靠数据";
  const status = { ALIGNED: "仓位已对齐", NON_TRADEABLE_RESIDUAL: "存在不可交易残余", HEDGE_DEVIATION: "存在对冲偏差", NEEDS_SYNC: "需同步确认" }[health.status];
  const badgeTone = health.status === "ALIGNED" ? "bg-[#0a2b21] text-[#6ee7b7]" : health.status === "HEDGE_DEVIATION" ? "bg-[#351417] text-[#f87171]" : "bg-[#332408] text-[#fbbf24]";
  return <section className="min-w-0 rounded-md bg-[#0c0e11] p-[18px] md:col-span-2 lg:col-span-1">
    <div>
      <p className="text-[9px] font-bold leading-none text-[#3b82f6]">POSITION HEALTH</p>
      <h5 className="mt-[3px] text-[15px] font-bold leading-5 text-[#f3f5f8]">仓位状态</h5>
    </div>
    <dl className="mt-[14px] space-y-[10px] text-[12px] leading-none">
      <LegRow label="健康状态" value={<span className={`inline-flex rounded px-[9px] py-[5px] text-[11px] font-bold leading-none ${badgeTone}`}>{status}</span>} />
      <LegRow emphasized label="两腿数量差" value={delta} />
      <LegRow label="差额原因" value={health.residualReason ?? "无明显差额"} />
      <LegRow label="影响完整退出" value={health.affectsFullExit === null ? "暂无可靠数据" : health.affectsFullExit ? "是" : "否"} />
      <LegRow label="数据同步状态" value={health.status === "NEEDS_SYNC" || health.lastSyncedAt === null ? "数据待同步" : `已同步 · ${formatTime(health.lastSyncedAt)}`} />
    </dl>
  </section>;
}

export function derivePositionHealth(
  instance: ArbitrageInstance,
  verification: VerificationState,
  closeSafeties: Record<string, ArbitrageCloseSafety | undefined>,
  delta: ReadState<InstanceHedgeDelta>,
  canExitFully: boolean,
) {
  const timestamps = [
    verification.status === "success" ? verification.verification.checkedAt : null,
    delta.status === "success" ? delta.value.derivedAt : null,
    ...Object.values(closeSafeties).map((value) => value?.checkedAt ?? null),
  ].filter((value): value is number => value !== null);
  const lastSyncedAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const complete = verification.status === "success" && delta.status === "success"
    && delta.value.activeManagedDelta.status === "KNOWN"
    && instance.legs.every((leg) => closeSafeties[leg.legId]?.realityReliable)
    && !instance.executionReferences.some((reference) => reference.status === "UNKNOWN" || reference.status === "PENDING_CONFIRMATION");
  if (!complete || verification.status !== "success" || verification.verification.legs.some((leg) => leg.verificationStatus === "UNKNOWN")) {
    const unresolved = instance.executionReferences.some((reference) => reference.status === "UNKNOWN" || reference.status === "PENDING_CONFIRMATION");
    return { status: "NEEDS_SYNC" as const, residualReason: unresolved ? "存在未确认执行" : "数据待同步", residualTradeable: null, affectsFullExit: null, lastSyncedAt };
  }
  if (verification.verification.legs.some((leg) => leg.verificationStatus === "MISMATCH")) {
    return { status: "HEDGE_DEVIATION" as const, residualReason: "仓位发生变化", residualTradeable: null, affectsFullExit: !canExitFully, lastSyncedAt };
  }
  if (Object.values(closeSafeties).some((safety) => safety?.reason === "QUANTITY_STEP_DUST")) {
    return { status: "NON_TRADEABLE_RESIDUAL" as const, residualReason: "数量精度限制 / 交易规则残余", residualTradeable: false, affectsFullExit: false, lastSyncedAt };
  }
  return { status: "ALIGNED" as const, residualReason: null, residualTradeable: null, affectsFullExit: !canExitFully, lastSyncedAt };
}

function RevenueDetails({ instance, presentation }: { instance: ArbitrageInstance; presentation?: ArbitragePositionPresentation }) {
  const revenue = presentation?.revenue;
  const hasReliableValue = revenue !== undefined && (
    revenue.cumulativeFundingIncomeCompleteness === "COMPLETE"
    || revenue.incurredFeesCompleteness === "COMPLETE"
    || revenue.realizedSpreadProfitCompleteness === "COMPLETE"
    || revenue.realizedNetProfitCompleteness === "COMPLETE"
  );
  if (!hasReliableValue) return <section className="flex items-center justify-between gap-3 px-[18px] py-4">
    <h5 className="text-[13px] font-bold leading-none text-[#b7bfca]">收益明细</h5>
    <p className="text-[11px] text-[#798493]">暂无可靠收益数据</p>
  </section>;
  return <section className="px-[18px] py-4">
    <h5 className="text-[13px] font-bold leading-none text-[#b7bfca]">收益明细</h5>
    <dl className="mt-3 grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
      <RevenueMetric label="累计资金费收入" value={revenueValue(revenue.cumulativeFundingIncome, revenue.cumulativeFundingIncomeCompleteness)} />
      <RevenueMetric label="已发生手续费" tone="cost" value={feeRevenueValue(revenue.incurredFees, revenue.incurredFeesCompleteness)} />
      <RevenueMetric label="已实现价差收益" value={realizedSpreadRevenueValue(instance, revenue)} />
      <RevenueMetric label="已实现净收益" tone="profit" value={revenueValue(revenue.realizedNetProfit, revenue.realizedNetProfitCompleteness)} />
    </dl>
  </section>;
}

function realizedSpreadRevenueValue(
  instance: ArbitrageInstance,
  revenue: ArbitragePositionPresentation["revenue"],
) {
  if (revenue.realizedSpreadProfitCompleteness !== "COMPLETE" || revenue.realizedSpreadProfit === null
    || revenue.realizedSpreadDisplayState === "INCOMPLETE") return "暂无可靠数据";
  const state = revenue.realizedSpreadDisplayState
    ?? (instance.legs.every((leg) => !isZeroDecimal(leg.confirmedClosedQuantity)) ? "REALIZED" : "NO_REALIZED_CLOSE");
  if (state === "NO_REALIZED_CLOSE") return "尚未产生已实现收益";
  return revenueValue(revenue.realizedSpreadProfit, revenue.realizedSpreadProfitCompleteness);
}

function RevenueMetric({ label, tone = "neutral", value }: { label: string; tone?: "neutral" | "profit" | "cost"; value: string }) {
  const valueClass = value === "暂无可靠数据" ? "text-[#798493]" : value.endsWith(" rebate") || tone === "profit" ? "text-[#22c55e]" : tone === "cost" ? "text-[#f87171]" : "text-[#f3f5f8]";
  return <div className="min-w-0 rounded-md bg-[#0c0e11] p-4"><dt className="text-[11px] leading-none text-[#798493]">{label}</dt><dd className={`mt-[7px] break-words font-mono text-[17px] font-medium leading-5 ${valueClass}`}>{value}</dd></div>;
}

function revenueValue(value: string | null, completeness: "COMPLETE" | "INCOMPLETE") {
  if (completeness !== "COMPLETE" || value === null) return "暂无可靠数据";
  return `${value.startsWith("-") || value === "0" ? "" : "+"}${value} USDT`;
}

function feeRevenueValue(value: string | null, completeness: "COMPLETE" | "INCOMPLETE") {
  if (completeness !== "COMPLETE" || value === null) return "暂无可靠数据";
  if (value === "0") return "0 USDT";
  return value.startsWith("-")
    ? `+${value.slice(1)} USDT rebate`
    : `-${value} USDT`;
}

function fundingRatePresentation(presentation?: ArbitragePositionPresentation) {
  const fundingRate = presentation?.market.netFundingRate8h ?? presentation?.market.fundingRate;
  if (fundingRate == null) return { value: "--", detail: "数据更新中" };
  return {
    value: `${fundingRate >= 0 ? "+" : ""}${(fundingRate * 100).toFixed(4)}%`,
    valueClassName: "whitespace-nowrap",
  };
}

export function estimatedFundingTone(presentation?: ArbitragePositionPresentation): MetricTone {
  const event = presentation?.market.nextFundingEvent;
  const estimated = event ? event.estimatedNetFee : presentation?.market.nextEstimatedFundingFee;
  if (event?.completeness === "INCOMPLETE" || estimated == null) return "neutral";
  const value = Number(estimated);
  return value > 0 ? "success" : value < 0 ? "risk" : "neutral";
}

function managedScalePresentation(presentation?: ArbitragePositionPresentation) {
  const market = presentation?.market;
  if (market?.managedScaleCompleteness !== "COMPLETE" || market.managedScaleUsdt == null) {
    return { value: "暂无可靠数据", tone: "neutral" as const };
  }
  return { value: compactDecimal(market.managedScaleUsdt, 4), unit: "USDT", detail: "当前配对名义规模", tone: "neutral" as const, valueClassName: "whitespace-nowrap" };
}

function cumulativeFundingPresentation(presentation?: ArbitragePositionPresentation) {
  const revenue = presentation?.revenue;
  if (revenue === undefined) return { value: "--", detail: "数据更新中", tone: "neutral" as const };
  return {
    value: revenueValue(revenue.cumulativeFundingIncome, revenue.cumulativeFundingIncomeCompleteness),
    tone: "neutral" as const,
    valueClassName: "whitespace-nowrap",
  };
}

function legFundingValue(
  spot: boolean,
  funding?: NonNullable<ArbitragePositionPresentation["market"]["legs"]>[number],
) {
  if (spot) return "不适用";
  if (!funding || funding.completeness !== "COMPLETE" || funding.fundingRate == null || funding.fundingIntervalHours == null) {
    return "暂无可靠数据";
  }
  const direction = funding.cashflowDirection === "INCOME" ? "收入"
    : funding.cashflowDirection === "EXPENSE" ? "支出" : "收支为零";
  return `${funding.fundingRate >= 0 ? "+" : ""}${(funding.fundingRate * 100).toFixed(4)}% / ${funding.fundingIntervalHours}h · ${direction}`;
}

function estimatedFundingPresentation(presentation?: ArbitragePositionPresentation) {
  const event = presentation?.market.nextFundingEvent;
  const value = event ? event.estimatedNetFee : presentation?.market.nextEstimatedFundingFee;
  if (event?.completeness === "INCOMPLETE" || value == null) return { value: "--", detail: "数据更新中", tone: "neutral" as const };
  return { value: compactDecimal(value, 8), unit: "USDT", tone: estimatedFundingTone(presentation), valueClassName: "whitespace-nowrap" };
}

function spreadPresentation(presentation: ArbitragePositionPresentation | undefined, quoteAsset: string) {
  const value = presentation?.market.spreadQuotePerBase;
  const bps = presentation?.market.spreadBps;
  if (presentation?.market.quotedAt == null || value == null || bps == null) return { value: "--", detail: "数据更新中" };
  return { value: `${bps.toFixed(2)} bps`, detail: `${value.toFixed(6)} ${quoteAsset} / base`, valueClassName: "whitespace-nowrap" };
}

function compactDecimal(value: string, maximumFractionDigits: number) {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return value;
  const [integer, fraction = ""] = value.split(".");
  const compactFraction = fraction.slice(0, maximumFractionDigits).replace(/0+$/u, "");
  return compactFraction ? `${integer}.${compactFraction}` : integer!;
}

function quantityWithAsset(value: string, asset: string) {
  return asset && /^-?\d+(?:\.\d+)?$/u.test(value) ? `${value} ${asset}` : value;
}

function marketFreshnessValue(presentation?: ArbitragePositionPresentation) {
  if (!presentation || presentation.market.completeness !== "COMPLETE" || presentation.market.marketDataAsOf == null) {
    return "行情数据更新中";
  }
  return `行情截至 ${formatTime(presentation.market.marketDataAsOf)} · 数据完整`;
}

export function PositionFundingCountdown({ presentation }: { presentation?: ArbitragePositionPresentation }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), POSITION_COUNTDOWN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const countdown = positionFundingCountdownValue(presentation, now);
  return <>{countdown.value}{countdown.detail ? <span className="block font-sans text-[10px] font-normal leading-4 text-[#707985]">{countdown.detail}</span> : null}</>;
}

export function positionFundingCountdownValue(presentation: ArbitragePositionPresentation | undefined, now: number) {
  const event = presentation?.market.nextFundingEvent;
  const nextFundingTime = event ? event.time : presentation?.market.nextFundingTime;
  if (event?.completeness === "INCOMPLETE" || nextFundingTime == null) return { value: "--", detail: "等待更新" };
  const label = formatFundingCountdown(nextFundingTime, now).replace("距结算 ", "");
  return label === "等待结算更新"
    ? { value: "--", detail: "等待下一周期数据" }
    : { value: label, detail: null };
}

function instancePair(instance: ArbitrageInstance) {
  const parts = instance.legs[0].instrumentId.split("-");
  return { base: parts[0] || "—", quote: parts[1] || "—" };
}

function venuePath(instance: ArbitrageInstance) {
  const long = instance.legs.find((leg) => leg.role === "LONG")!;
  const short = instance.legs.find((leg) => leg.role === "SHORT")!;
  return `${venueLabel(long.venue)} ${long.instrumentId.endsWith("-SPOT") ? "现货" : "永续"} → ${venueLabel(short.venue)} 永续`;
}

function truncateInstanceId(arbitrageId: string) {
  return arbitrageId.length <= 20 ? arbitrageId : `${arbitrageId.slice(0, 12)}…${arbitrageId.slice(-6)}`;
}

function activeManagedFallback(leg: ArbitrageInstanceLeg) {
  return leg.confirmedOpenedQuantity === leg.confirmedClosedQuantity ? "0" : leg.confirmedOpenedQuantity;
}

export function firstLevelManagedQuantity(instance: ArbitrageInstance, verification: VerificationState, safeties: Record<string, ArbitrageCloseSafety | undefined>) {
  const values = instance.legs.map((leg) => safeties[leg.legId]?.activeManagedQuantity
    ?? (verification.status === "success" ? verification.verification.legs.find((item) => item.legId === leg.legId)?.expectedManagedQuantity : null)
    ?? activeManagedFallback(leg));
  const display = compareUnsignedDecimalStrings(values[0]!, values[1]!) <= 0 ? values[0]! : values[1]!;
  return { value: display, unit: canonicalBaseAsset(instance) ?? "基础资产" };
}

function compareUnsignedDecimalStrings(left: string, right: string) {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  const normalizedLeftInteger = leftInteger.replace(/^0+(?=\d)/u, "");
  const normalizedRightInteger = rightInteger.replace(/^0+(?=\d)/u, "");
  if (normalizedLeftInteger.length !== normalizedRightInteger.length) return normalizedLeftInteger.length < normalizedRightInteger.length ? -1 : 1;
  if (normalizedLeftInteger !== normalizedRightInteger) return normalizedLeftInteger < normalizedRightInteger ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(width, "0").localeCompare(rightFraction.padEnd(width, "0"));
}

function currentExitPresentation(
  instance: ArbitrageInstance,
  canExitFully: boolean,
  loading: boolean,
  verification: VerificationState,
  safeties: Record<string, ArbitrageCloseSafety | undefined>,
): { label: string; tone: "neutral" | "success" | "warning" | "risk" } {
  if (instance.status === "CLOSED") return { label: "管理已结束", tone: "neutral" };
  if (instance.status === "CLOSING") return { label: "退出中", tone: "warning" };
  if (loading) return { label: "同步中", tone: "neutral" };
  if (canExitFully) return { label: "可安全退出", tone: "success" };
  if (verification.status !== "success" || verification.verification.legs.some((leg) => leg.verificationStatus === "UNKNOWN")) return { label: "需同步后退出", tone: "warning" };
  if (Object.values(safeties).some((safety) => safety && !safety.fullManagedCloseAvailable && !isZeroDecimal(safety.safeClosableQuantity))) return { label: "可部分安全退出", tone: "warning" };
  return { label: "当前不可完整退出", tone: "risk" };
}

export function canResumeOpeningWorkflow(instance: ArbitrageInstance) {
  return instance.status === "OPENING"
    && instance.executionReferences.length === 0
    && instance.managementReleases.length === 0
    && instance.legs.every((leg) => leg.confirmedOpenedQuantity === "0"
      && leg.confirmedClosedQuantity === "0");
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

function LegCloseActions({ closeSafetyState, enabled, exitCapabilitiesComplete, instanceFullExitAvailable, legId, onClose, verificationState }: {
  closeSafetyState?: ReadState<ArbitrageCloseSafety>;
  enabled: boolean;
  exitCapabilitiesComplete: boolean;
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
  if (!enabled || !exitCapabilitiesComplete || !actions.partialClose) return null;
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
  const activeLegsReliable = instance.legs.every((leg) => {
    const safety = safeties[leg.legId];
    if (!safety || isZeroDecimal(safety.activeManagedQuantity)) return true;
    const verification = verificationState.verification.legs.find((item) => item.legId === leg.legId);
    return verification?.verificationStatus !== "UNKNOWN" && safety.realityReliable;
  });
  if (!activeLegsReliable) return [];
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
  return <section className="border-t border-[#25282f] px-4 py-4 sm:px-5">
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

function HedgeExitActions({ canExit, hasQuantityRuleDust, instance, onExitHedge, onReconcileHedge, onRefreshExitCapabilities, refreshError, refreshing, verificationState }: {
  canExit: boolean;
  hasQuantityRuleDust: boolean;
  instance: ArbitrageInstance;
  onExitHedge?: (target: ExitTarget) => void;
  onReconcileHedge?: (instance: ArbitrageInstance) => void | Promise<void>;
  onRefreshExitCapabilities: () => void;
  refreshError: boolean;
  refreshing: boolean;
  verificationState?: VerificationState;
}) {
  const summary = hedgeExitSummary(instance, verificationState);
  return <div className="flex shrink-0 flex-col justify-center border-b border-[#232830] px-[18px] py-3" onClick={(event) => event.stopPropagation()}>
    {summary.progress.length > 0 ? <div className="mb-2 space-y-1 text-xs text-[#c5ccd4]">
      {summary.progress.map((item) => <p key={item}>{item}</p>)}
    </div> : null}
    {refreshError ? <p className="mb-2 max-w-56 text-xs text-amber-200" role="alert">状态刷新失败，请重新刷新。系统不会自动重发交易命令。</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      {summary.kind !== "ended" ? <Button
        className="min-h-9 px-3 py-1.5 text-xs"
        disabled={refreshing}
        onClick={() => {
          if (onReconcileHedge) void onReconcileHedge(instance);
          else onRefreshExitCapabilities();
        }}
        type="button"
        variant="secondary"
      >
        {refreshing ? "正在刷新…" : "刷新退出状态"}
      </Button> : null}
      {summary.kind !== "ended" && canExit && onExitHedge ? <Button
        className="min-h-9 px-3 py-1.5 text-xs"
        onClick={() => onExitHedge({ instance, hasQuantityRuleDust })}
        type="button"
      >
        完整退出
      </Button> : null}
    </div>
  </div>;
}

export function exitCapabilityReadsComplete(instance: ArbitrageInstance, state: ExitCapabilitiesState) {
  return state.verification.status === "success"
    && state.delta.status === "success"
    && instance.legs.every((leg) => state.closeSafeties[leg.legId]?.status === "success");
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
    : status === "HOLDING" ? "持有中"
      : status === "CLOSING" ? "退出中"
        : status === "CLOSED" ? "管理已结束"
          : status === "OPENING" ? "建仓中" : "需检查";
  return (
    <span className={`rounded px-[9px] py-[5px] text-[11px] font-bold leading-none ${warning ? "bg-[#332408] text-[#fbbf24]" : status === "HOLDING" ? "bg-[#0a2b21] text-[#6ee7b7]" : "bg-[#13161a] text-[#b7bfca]"}`}>
      {label}
    </span>
  );
}

function exitToneClass(tone: "neutral" | "success" | "warning" | "risk") {
  return tone === "success" ? "bg-[#0a2b21] text-[#6ee7b7]"
    : tone === "warning" ? "bg-[#332408] text-[#fbbf24]"
      : tone === "risk" ? "bg-[#351417] text-[#f87171]"
        : "bg-[#13161a] text-[#b7bfca]";
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[#707985]">{label}</dt><dd className="mt-1 font-mono text-[#c5ccd4]">{value}</dd></div>;
}

function LegRow({ emphasized = false, label, value }: { emphasized?: boolean; label: string; value: ReactNode }) {
  return <div className="flex min-w-0 items-start justify-between gap-3"><dt className="shrink-0 text-[#798493]">{label}</dt><dd className={`min-w-0 break-words text-right font-mono ${emphasized ? "font-medium text-[#f3f5f8]" : "text-[#f3f5f8]"}`}>{value}</dd></div>;
}

function VenueValue({ venue }: { venue: ArbitrageInstance["legs"][number]["venue"] }) {
  const meta = {
    binance: { label: "Binance", icon: "https://cdn.simpleicons.org/binance/F0B90B" },
    bybit: { label: "Bybit", icon: "https://cdn.simpleicons.org/bybit/F7A600" },
    bitget: { label: "Bitget", icon: "https://cdn.simpleicons.org/bitget/00C2A8" },
    okx: { label: "OKX", icon: "https://cdn.simpleicons.org/okx/FFFFFF" },
  }[venue];
  return <span className="inline-flex items-center gap-1.5"><img className="h-3.5 w-3.5 object-contain" src={meta.icon} alt="" />{meta.label}</span>;
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
