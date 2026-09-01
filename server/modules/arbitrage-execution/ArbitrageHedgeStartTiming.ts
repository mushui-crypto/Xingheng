import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type HedgeStartTimingLeg = "LEG1" | "LEG2";
export type HedgeStartTimingMilestone =
  | "executionStart"
  | "leg1PrepareStart" | "leg1PrepareDone" | "leg1RequestSent" | "leg1Ack"
  | "leg1TerminalConfirmed" | "leg1ProjectionCommitted"
  | "spotAttributionStart" | "spotAttributionDone"
  | "leg2PrepareStart" | "leg2PrepareDone" | "leg2ContextLoadStart" | "leg2ContextLoadDone"
  | "leg2QuantityPlanStart" | "leg2QuantityPlanDone" | "leg2SafetyStart" | "leg2SafetyDone"
  | "leg2ReferenceClaimed" | "leg2ExecutionRecordPersisted" | "leg2RequestSent" | "leg2Ack"
  | "leg2TerminalConfirmed" | "lifecycleCommitted" | "apiResponseReady";

export type HedgeStartDurationMetric = "credentialUnwrapMs" | "mutationSerializerWaitMs" | "executionReferencePersistMs"
  | "executionRecordPersistMs" | "projectionCommitMs" | "persistenceMs" | "reconcileMs";
type LegIdentity = Readonly<{ leg: HedgeStartTimingLeg; childCommandId: string; venue: string; legType: "SPOT" | "PERPETUAL" }>;
type TimingState = {
  instanceId: string; commandId: string; startedAt: number; startedWallClockAt: number;
  marks: Partial<Record<HedgeStartTimingMilestone, number>>;
  legs: Partial<Record<HedgeStartTimingLeg, LegIdentity>>;
  durations: Record<HedgeStartDurationMetric, number[]>;
  providerReads: Record<string, number[]>;
  providerReadCount: number;
  reconcileAttempts: Record<HedgeStartTimingLeg, number>;
  reconcileMs: Record<HedgeStartTimingLeg, number[]>;
  outcome: string | null; stoppedStage: string | null;
};
type TimingStore = Readonly<{ state: TimingState; leg: LegIdentity | null }>;
export type HedgeStartTimingLogger = (event: "arbitrage_hedge_start_timing", facts: HedgeStartTimingSummary) => unknown;
export type HedgeStartTimingSummary = Readonly<Record<string, unknown>>;
export type HedgeProviderTimingToken = {
  state: TimingState; leg: HedgeStartTimingLeg; action: string; substage: string; startedAt: number;
  finished: boolean; acknowledged: boolean;
};

const storage = new AsyncLocalStorage<TimingStore>();
export async function withHedgeStartTiming<T>(
  input: Readonly<{ instanceId: string; commandId: string }>,
  logger: HedgeStartTimingLogger | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  let state: TimingState;
  try {
    state = createState(input);
  } catch {
    return run();
  }
  return storage.run({ state, leg: null }, async () => {
    try {
      return await run();
    } finally {
      try {
        const summary = summarize(state, performance.now());
        if (logger !== null) {
          const write = logger ?? defaultLogger;
          Promise.resolve(write("arbitrage_hedge_start_timing", summary)).catch(() => undefined);
        }
      } catch { /* Timing is non-authoritative. */ }
    }
  });
}

export function withHedgeStartLegTiming<T>(identity: LegIdentity, run: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  if (!current) return run();
  try {
    current.state.legs[identity.leg] = Object.freeze({ ...identity });
    markHedgeStartTiming(identity.leg === "LEG1" ? "leg1PrepareStart" : "leg2PrepareStart");
  } catch { /* best effort */ }
  return storage.run({ state: current.state, leg: identity }, run);
}

export function currentHedgeStartTimingLeg(): HedgeStartTimingLeg | null {
  try { return storage.getStore()?.leg?.leg ?? null; } catch { return null; }
}

export function markHedgeStartTiming(name: HedgeStartTimingMilestone) {
  try {
    const state = storage.getStore()?.state;
    if (state && state.marks[name] === undefined) state.marks[name] = performance.now();
  } catch { /* best effort */ }
}

export async function measureHedgeStartTiming<T>(metric: HedgeStartDurationMetric, run: () => Promise<T>): Promise<T> {
  const state = storage.getStore()?.state;
  if (!state) return run();
  const started = performance.now();
  try { return await run(); } finally { recordDuration(state, metric, performance.now() - started); }
}

export function measureHedgeStartTimingSync<T>(metric: HedgeStartDurationMetric, run: () => T): T {
  const state = storage.getStore()?.state;
  if (!state) return run();
  const started = performance.now();
  try { return run(); } finally { recordDuration(state, metric, performance.now() - started); }
}

export function recordHedgeStartDuration(metric: HedgeStartDurationMetric, durationMs: number) {
  try {
    const state = storage.getStore()?.state;
    if (state) recordDuration(state, metric, durationMs);
  } catch { /* best effort */ }
}

export async function persistHedgeStartExecutionRecord(run: () => Promise<void> | void): Promise<void> {
  await measureHedgeStartTiming("executionRecordPersistMs", async () => { await run(); });
  if (currentHedgeStartTimingLeg() === "LEG2") markHedgeStartTiming("leg2ExecutionRecordPersisted");
}

export function recordHedgeStartOutcome(outcome: string, stoppedStage: string | null) {
  try {
    const state = storage.getStore()?.state;
    if (state) { state.outcome = outcome; state.stoppedStage = stoppedStage; }
  } catch { /* best effort */ }
}

export function recordHedgeReconcileAttempt() {
  try {
    const current = storage.getStore();
    if (current?.leg) current.state.reconcileAttempts[current.leg.leg] += 1;
  } catch { /* best effort */ }
}

export function beginHedgeProviderTiming(action: string, substage: string): HedgeProviderTimingToken | null {
  try {
    const current = storage.getStore();
    if (!current?.leg) return null;
    const token = { state: current.state, leg: current.leg.leg, action, substage,
      startedAt: performance.now(), finished: false, acknowledged: false };
    if (action === "PLACE_ORDER") {
      markHedgeStartTiming(current.leg.leg === "LEG1" ? "leg1PrepareDone" : "leg2PrepareDone");
      markHedgeStartTiming(current.leg.leg === "LEG1" ? "leg1RequestSent" : "leg2RequestSent");
    }
    return token;
  } catch { return null; }
}

export function finishHedgeProviderTiming(token: HedgeProviderTimingToken | null) {
  try {
    if (!token || token.finished) return;
    token.finished = true;
    const duration = Math.max(0, performance.now() - token.startedAt);
    if (token.action === "READ") {
      token.state.providerReadCount += 1;
      (token.state.providerReads[token.substage] ??= []).push(duration);
    }
  } catch { /* best effort */ }
}

export function acknowledgeHedgeProviderTiming(token: HedgeProviderTimingToken | null) {
  try {
    if (!token || token.action !== "PLACE_ORDER" || token.acknowledged) return;
    token.acknowledged = true;
    const name = token.leg === "LEG1" ? "leg1Ack" : "leg2Ack";
    if (token.state.marks[name] === undefined) token.state.marks[name] = performance.now();
  } catch { /* best effort */ }
}

function createState(input: Readonly<{ instanceId: string; commandId: string }>): TimingState {
  const startedAt = performance.now();
  return {
    ...input, startedAt, startedWallClockAt: Date.now(), marks: { executionStart: startedAt }, legs: {},
    durations: {
      credentialUnwrapMs: [], mutationSerializerWaitMs: [], executionReferencePersistMs: [],
      executionRecordPersistMs: [], projectionCommitMs: [], persistenceMs: [], reconcileMs: [],
    },
    providerReads: {}, providerReadCount: 0, reconcileAttempts: { LEG1: 0, LEG2: 0 },
    reconcileMs: { LEG1: [], LEG2: [] },
    outcome: null, stoppedStage: null,
  };
}

function recordDuration(state: TimingState, metric: HedgeStartDurationMetric, duration: number) {
  try {
    const normalized = Math.max(0, duration);
    state.durations[metric].push(normalized);
    if (metric === "reconcileMs") {
      const leg = storage.getStore()?.leg?.leg;
      if (leg) state.reconcileMs[leg].push(normalized);
    }
    if (metric === "executionReferencePersistMs" || metric === "executionRecordPersistMs"
      || metric === "projectionCommitMs") state.durations.persistenceMs.push(normalized);
  } catch { /* best effort */ }
}

function summarize(state: TimingState, completedAt: number): HedgeStartTimingSummary {
  const mark = (name: HedgeStartTimingMilestone) => state.marks[name];
  const between = (end: HedgeStartTimingMilestone, start: HedgeStartTimingMilestone) => {
    const left = mark(end); const right = mark(start);
    return left === undefined || right === undefined ? null : rounded(Math.max(0, left - right));
  };
  const duration = (name: HedgeStartDurationMetric) => aggregate(state.durations[name]);
  const readDurations = Object.values(state.providerReads).flat();
  const lastMilestone = Object.entries(state.marks).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  return Object.freeze({
    instanceId: state.instanceId, commandId: state.commandId, startedAt: state.startedWallClockAt,
    outcome: state.outcome ?? "ERROR", stoppedStage: state.stoppedStage,
    lastMilestone,
    legs: Object.freeze({ ...state.legs }),
    milestonesMs: Object.freeze(Object.fromEntries(Object.entries(state.marks)
      .map(([name, value]) => [name, rounded(value - state.startedAt)]))),
    totalHedgeMs: between("leg2TerminalConfirmed", "executionStart"),
    leg1TotalMs: between("leg1TerminalConfirmed", "leg1PrepareStart"),
    legGapMs: between("leg2RequestSent", "leg1TerminalConfirmed"),
    leg2MutationMs: between("leg2Ack", "leg2RequestSent"),
    leg2ConfirmMs: between("leg2TerminalConfirmed", "leg2Ack"),
    apiTailMs: between("apiResponseReady", "leg2TerminalConfirmed"),
    commandTotalMs: rounded(Math.max(0, completedAt - state.startedAt)),
    credentialUnwrapCount: state.durations.credentialUnwrapMs.length,
    credentialUnwrapTotalMs: duration("credentialUnwrapMs").totalMs,
    credentialUnwrapMaxMs: duration("credentialUnwrapMs").maxMs,
    providerReadCount: state.providerReadCount,
    providerReadTotalMs: rounded(readDurations.reduce((sum, value) => sum + value, 0)),
    providerReadMaxMs: rounded(readDurations.length ? Math.max(...readDurations) : 0),
    providerReadsBySubstage: Object.freeze(Object.fromEntries(Object.entries(state.providerReads)
      .map(([name, values]) => [name, aggregate(values)]))),
    mutationSerializerWaitMs: duration("mutationSerializerWaitMs").totalMs,
    executionReferencePersistMs: duration("executionReferencePersistMs").totalMs,
    executionRecordPersistMs: duration("executionRecordPersistMs").totalMs,
    projectionCommitMs: duration("projectionCommitMs").totalMs,
    persistenceMs: duration("persistenceMs").totalMs,
    leg1ReconcileMs: rounded(state.reconcileMs.LEG1.reduce((sum, value) => sum + value, 0)),
    leg1ReconcileAttempts: state.reconcileAttempts.LEG1,
    leg2ReconcileMs: rounded(state.reconcileMs.LEG2.reduce((sum, value) => sum + value, 0)),
    leg2ReconcileAttempts: state.reconcileAttempts.LEG2,
  });
}

function aggregate(values: readonly number[]) {
  return Object.freeze({ count: values.length, totalMs: rounded(values.reduce((sum, value) => sum + value, 0)),
    maxMs: rounded(values.length ? Math.max(...values) : 0) });
}

function rounded(value: number) { return Math.round(value * 1_000) / 1_000; }
function defaultLogger(event: "arbitrage_hedge_start_timing", facts: HedgeStartTimingSummary) {
  try { console.info(event, facts); } catch { /* best effort */ }
}
