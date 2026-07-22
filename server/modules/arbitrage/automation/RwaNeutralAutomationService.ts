import type {
  RwaAutomationAuditEvent,
  RwaAutomationConfig,
  RwaAutomationShadowDecision,
  RwaAutomationState,
  RwaAutomationStatus,
  RwaReadOnlyConnector,
  RwaReadOnlySnapshot,
} from "./RwaNeutralAutomationTypes";
import { stableHash } from "./RwaNeutralAutomationSecurity";

const defaultConfig: RwaAutomationConfig = {
  phase: "phase_a_shadow",
  globalExecutionEnabled: false,
  strategyEnabled: false,
  killSwitchActive: true,
  staleAfterMs: 30_000,
  maxBatchNotionalUsd: 25,
  maxStrategyNotionalUsd: 300,
  shadowOnly: true,
};

export type RwaNeutralAutomationServiceOptions = {
  now?: () => number;
  config?: Partial<RwaAutomationConfig>;
  restoredSnapshot?: RwaReadOnlySnapshot | null;
};

export class RwaNeutralAutomationService {
  private readonly now: () => number;
  private readonly config: RwaAutomationConfig;
  private readonly auditEvents: RwaAutomationAuditEvent[] = [];
  private lastSnapshot: RwaReadOnlySnapshot | null;
  private lastState: RwaAutomationState = "disabled";
  private seenEventKeys = new Set<string>();

  constructor(
    private readonly connector: RwaReadOnlyConnector,
    options: RwaNeutralAutomationServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.config = { ...defaultConfig, ...(options.config ?? {}), globalExecutionEnabled: false, shadowOnly: true };
    this.lastSnapshot = options.restoredSnapshot ?? null;
  }

  async getStatus(): Promise<RwaAutomationStatus> {
    const snapshot = await this.connector.readSnapshot();
    this.lastSnapshot = snapshot;
    const state = this.evaluateState(snapshot);
    const decision = this.buildShadowDecision(snapshot, state);
    this.recordAudit({
      eventType: "shadow_evaluation",
      state,
      idempotencyKey: decision.idempotencyKey,
      summary: decision.reason,
      errorCategory: snapshot.connector.errorCategory,
    });
    this.lastState = state;
    return this.toStatus(snapshot, state, decision);
  }

  restoreFromAuthoritativeSnapshot(snapshot: RwaReadOnlySnapshot) {
    this.lastSnapshot = snapshot;
    this.lastState = this.evaluateState(snapshot);
    this.recordAudit({
      eventType: "restart_recovery",
      state: this.lastState,
      idempotencyKey: this.idempotencyKey("restart_recovery", snapshot.fetchedAt),
      summary: "Recovered Phase A state from provider read-only snapshot.",
      errorCategory: snapshot.connector.errorCategory,
    });
  }

  applyEventOnce(event: { eventId: string; type: string; snapshot: RwaReadOnlySnapshot }) {
    if (this.seenEventKeys.has(event.eventId)) return false;
    if (this.lastSnapshot && event.snapshot.fetchedAt <= this.lastSnapshot.fetchedAt) return false;
    this.seenEventKeys.add(event.eventId);
    this.restoreFromAuthoritativeSnapshot(event.snapshot);
    this.recordAudit({
      eventType: event.type,
      state: this.lastState,
      idempotencyKey: this.idempotencyKey(event.type, event.snapshot.fetchedAt),
      summary: "Applied idempotent provider read event.",
      errorCategory: event.snapshot.connector.errorCategory,
    });
    if (this.seenEventKeys.size > 1_000) this.seenEventKeys = new Set([...this.seenEventKeys].slice(-500));
    return true;
  }

  getLatestAudit(limit = 20) {
    return this.auditEvents.slice(-limit).reverse();
  }

  private evaluateState(snapshot: RwaReadOnlySnapshot): RwaAutomationState {
    if (this.config.killSwitchActive || !this.config.strategyEnabled) return "disabled";
    if (!snapshot.connector.connected || snapshot.connector.stale) return "fault";
    if (this.isSnapshotStale(snapshot)) return "fault";
    return "observing";
  }

  private buildShadowDecision(snapshot: RwaReadOnlySnapshot, state: RwaAutomationState): RwaAutomationShadowDecision {
    const gateChecks = [
      {
        name: "phase_a_shadow_only",
        passed: true,
        message: "Phase A only evaluates shadow decisions and never sends provider writes.",
      },
      {
        name: "global_execution_disabled",
        passed: !this.config.globalExecutionEnabled,
        message: "Global real execution is disabled.",
      },
      {
        name: "connector_readonly",
        passed: snapshot.connector.readonly && !snapshot.connector.permissions.trade && !snapshot.connector.permissions.withdraw,
        message: "Connector exposes read-only permissions.",
      },
      {
        name: "fresh_provider_snapshot",
        passed: snapshot.connector.connected && !snapshot.connector.stale && !this.isSnapshotStale(snapshot),
        message: snapshot.connector.connected ? "Provider read snapshot is fresh enough for shadow." : "Provider read snapshot is unavailable.",
      },
    ];
    const action = state === "observing" && gateChecks.every((gate) => gate.passed)
      ? "would_open"
      : state === "fault" ? "blocked" : "observe";
    const reason = action === "would_open"
      ? "Shadow criteria can be evaluated, but real execution remains disabled."
      : state === "fault"
        ? "Provider read state is unavailable or stale; Phase A is fail-closed."
        : "Strategy is disabled or kill switch is active; Phase A remains read-only.";
    return {
      decisionId: this.idempotencyKey("decision", snapshot.fetchedAt),
      idempotencyKey: this.idempotencyKey("shadow", snapshot.fetchedAt),
      action,
      reason,
      wouldSendProviderWrite: false,
      target: {
        venue: "bybit",
        spotSymbol: "XAUTUSDT",
        perpetualSymbol: "XAUTUSDT",
        notionalUsd: 0,
      },
      gateChecks,
      generatedAt: this.now(),
    };
  }

  private toStatus(
    snapshot: RwaReadOnlySnapshot,
    state: RwaAutomationState,
    shadow: RwaAutomationShadowDecision,
  ): RwaAutomationStatus {
    return {
      network: "mainnet",
      phase: "phase_a_shadow",
      strategyId: "bybit-xaut-spot-perp-v1",
      ownerOnly: true,
      state,
      status: state === "fault" ? "fault" : state === "disabled" ? "disabled" : "observing",
      execution: {
        mode: "shadow",
        automaticOrdersEnabled: false,
        providerWriteCallCount: this.connector.getWriteCallCount(),
      },
      connector: snapshot.connector,
      account: {
        mode: snapshot.connector.accountMode,
        balances: snapshot.balances,
        fees: snapshot.fees,
        instruments: snapshot.instruments,
        orders: snapshot.orders,
        fills: snapshot.fills,
        positions: snapshot.positions,
      },
      shadow,
      recovery: {
        source: "provider_snapshot",
        restoredFromSnapshot: this.lastSnapshot !== null,
        lastSnapshotAt: this.lastSnapshot?.fetchedAt ?? null,
      },
      audit: {
        latest: this.getLatestAudit(),
      },
      warnings: this.buildWarnings(snapshot, state),
    };
  }

  private buildWarnings(snapshot: RwaReadOnlySnapshot, state: RwaAutomationState) {
    const warnings: string[] = [];
    if (this.config.killSwitchActive) warnings.push("Kill switch is active; no real execution can be armed.");
    if (!this.config.strategyEnabled) warnings.push("Strategy switch is disabled.");
    if (!this.config.globalExecutionEnabled) warnings.push("Global real execution is disabled.");
    if (state === "fault") warnings.push("Provider read state is stale or unavailable; fail-closed.");
    if (snapshot.connector.message) warnings.push(snapshot.connector.message);
    return [...new Set(warnings)];
  }

  private isSnapshotStale(snapshot: RwaReadOnlySnapshot) {
    return this.now() - snapshot.fetchedAt > this.config.staleAfterMs;
  }

  private recordAudit(input: Omit<RwaAutomationAuditEvent, "id" | "occurredAt">) {
    const event: RwaAutomationAuditEvent = {
      id: this.idempotencyKey(input.eventType, this.auditEvents.length),
      occurredAt: this.now(),
      ...input,
    };
    const last = this.auditEvents[this.auditEvents.length - 1];
    if (last?.eventType === event.eventType && last.idempotencyKey === event.idempotencyKey) return;
    this.auditEvents.push(event);
    if (this.auditEvents.length > 200) this.auditEvents.splice(0, this.auditEvents.length - 200);
  }

  private idempotencyKey(scope: string, value: string | number) {
    return `rwa:${scope}:${stableHash(`${scope}:${value}:bybit-xaut-spot-perp-v1`)}`;
  }
}
