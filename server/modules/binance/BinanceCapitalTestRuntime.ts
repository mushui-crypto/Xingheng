import { createHash } from "node:crypto";
import type {
  FundingArbitrageLegObservation,
} from "../cex/funding-arbitrage/FundingArbitrageExecutionCapability";
import {
  FundingArbitrageExecutionCoordinator,
  type FundingArbitrageExecutionEvent,
} from "../cex/funding-arbitrage/FundingArbitrageExecutionCoordinator";
import type { FundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { FundingArbitrageExecutionState } from "../cex/funding-arbitrage/FundingArbitrageExecutionState";
import {
  BINANCE_CAPITAL_TEST_MAX_TOTAL_PLANNED_CAPITAL_USD,
  preflightBinanceCapitalTest,
  type BinanceCapitalTestExecutionContext,
  type BinanceCapitalTestPreflightResult,
} from "./BinanceCapitalTestPreflight";
import {
  BinanceCapitalTestResidualExit,
  type BinanceCapitalTestResidualExitResult,
} from "./BinanceCapitalTestResidualExit";
import {
  BinanceExecutionCapability,
  type BoundBinanceExecutionService,
} from "./BinanceExecutionCapability";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinancePersonalTradingServiceRegistry } from "./BinancePersonalTradingServiceRegistry";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";

type BinanceCapitalTestRuntimeService = BoundBinanceExecutionService & Pick<
  BinancePersonalTradingService,
  "account" | "exit"
>;

export type BinanceCapitalTestAttempt = Readonly<{
  executionId: string;
  executionAttemptId: string;
  legId: string;
}>;

export type BinanceCapitalTestRuntimeResult = Readonly<{
  preflight: BinanceCapitalTestPreflightResult;
  executionState: FundingArbitrageExecutionState | null;
  attempts: readonly BinanceCapitalTestAttempt[];
  residualExit: BinanceCapitalTestResidualExitResult | null;
}>;

export type BinanceCapitalTestRuntimeOptions = Readonly<{
  maxSlippageBps: number;
  clock?: () => number;
}>;

export async function executeBinanceCapitalTest(
  registry: Pick<BinancePersonalTradingServiceRegistry, "run">,
  authenticatedUserId: string,
  context: BinanceCapitalTestExecutionContext,
  intent: FundingArbitrageExecutionIntent,
  options: BinanceCapitalTestRuntimeOptions,
): Promise<BinanceCapitalTestRuntimeResult> {
  if (!authenticatedUserId.trim() || authenticatedUserId !== context.userId) {
    throw new Error("Capital test authenticated user does not match the execution context.");
  }
  return registry.run(authenticatedUserId, (service) => new BinanceCapitalTestRuntime(
    service,
    { maxSlippageBps: options.maxSlippageBps },
    options.clock,
    intent.expiresAt,
  ).execute(context, intent));
}

class BinanceCapitalTestRuntime {
  private readonly capability: BinanceExecutionCapability;
  private readonly coordinator = new FundingArbitrageExecutionCoordinator();
  private readonly residualExit: BinanceCapitalTestResidualExit;
  private plannedMutationCapitalUsd = 0;

  constructor(
    private readonly service: BinanceCapitalTestRuntimeService,
    private readonly config: Pick<BinanceTradingConfig, "maxSlippageBps">,
    private readonly clock: () => number = Date.now,
    private readonly intentExpiresAt: number,
  ) {
    this.capability = new BinanceExecutionCapability(
      service,
      config,
      clock,
      (prepared) => this.assertRiskMutationAllowed(prepared),
    );
    this.residualExit = new BinanceCapitalTestResidualExit(service);
  }

  async execute(
    context: BinanceCapitalTestExecutionContext,
    intent: FundingArbitrageExecutionIntent,
  ): Promise<BinanceCapitalTestRuntimeResult> {
    const snapshot = await this.service.account();
    const preflightTime = this.now();
    const preflight = preflightBinanceCapitalTest(
      context,
      intent,
      snapshot,
      preflightTime,
      this.config.maxSlippageBps,
    );
    if (preflight.status === "FAIL") {
      return { preflight, executionState: null, attempts: [], residualExit: null };
    }

    let state = this.coordinator.createExecution(intent);
    state = this.transition(state, { type: "START_EXECUTION", occurredAt: preflightTime });
    const attempts = intent.legs.map((leg) => ({
      executionId: intent.intentId,
      executionAttemptId: stableAttemptIdentity(intent.intentId, leg.legId, "submit", 0),
      legId: leg.legId,
    }));
    assertAttemptIdentities(attempts);

    let firstLegStartedAt: number | null = null;
    for (const [index, leg] of intent.legs.entries()) {
      const attempt = attempts[index]!;
      const startedAt = this.nowAtOrAfter(state.updatedAt);
      if (startedAt >= intent.expiresAt) {
        state = this.failOnlyWithoutConfirmedResidual(state, startedAt);
        break;
      }
      if (firstLegStartedAt !== null
        && startedAt - firstLegStartedAt > intent.constraints.maxLegStartSkewMs) {
        state = this.failOnlyWithoutConfirmedResidual(state, startedAt);
        break;
      }
      firstLegStartedAt ??= startedAt;
      state = this.transition(state, {
        type: "LEG_SUBMIT_STARTED",
        legId: leg.legId,
        occurredAt: startedAt,
      });

      const reference = {
        executionId: attempt.executionId,
        executionAttemptId: attempt.executionAttemptId,
        legId: attempt.legId,
      };
      try {
        const accepted = await this.capability.submitLeg({
          ...reference,
          role: leg.role,
          venue: leg.venue,
          instrumentId: leg.instrumentId,
          marketType: leg.marketType,
          targetDeltaBaseQuantity: leg.targetDeltaBaseQuantity,
        });
        if (accepted.executionAttemptId !== attempt.executionAttemptId) {
          throw new Error("Execution capability changed the caller-supplied attempt identity.");
        }
      } catch {
        state = await this.observeAfterSubmit(state, reference);
        const currentLeg = state.legs.find((candidate) => candidate.legId === leg.legId)!;
        if (currentLeg.remoteObservation === "FILLED" && currentLeg.remainingQuantity === "0") continue;
        if (isConfirmedTerminalFailure(currentLeg.remoteObservation)) {
          state = this.failOnlyWithoutConfirmedResidual(state);
        }
        break;
      }

      state = await this.observeAfterSubmit(state, reference);
      const currentLeg = state.legs.find((candidate) => candidate.legId === leg.legId)!;
      if (isConfirmedTerminalFailure(currentLeg.remoteObservation)) {
        state = this.failOnlyWithoutConfirmedResidual(state);
        break;
      }
      if (currentLeg.remoteObservation !== "FILLED" || currentLeg.remainingQuantity !== "0") break;
    }

    const residualExit = state.status === "HEDGED" || state.status === "RESIDUAL"
      ? await this.residualExit.execute(
        context,
        intent,
        state,
        attempts.map((attempt) => attempt.executionAttemptId),
      )
      : null;
    return { preflight, executionState: state, attempts, residualExit };
  }

  private async observeAfterSubmit(
    state: FundingArbitrageExecutionState,
    reference: BinanceCapitalTestAttempt,
  ) {
    let observation;
    try {
      observation = await this.capability.queryLegState(reference);
    } catch {
      return this.transition(state, {
        type: "LEG_REMOTE_UNKNOWN",
        legId: reference.legId,
        occurredAt: this.nowAtOrAfter(state.updatedAt),
      });
    }
    state = this.applyObservation(state, reference.legId, observation);
    if (observation.observation !== "UNKNOWN_REMOTE_STATE") return state;

    let reconciled;
    try {
      reconciled = await this.capability.reconcileLeg(reference);
    } catch {
      return state;
    }
    if (reconciled.observation === "UNKNOWN_REMOTE_STATE") return state;
    return this.transition(state, {
      type: "LEG_RECONCILIATION_RESOLVED",
      legId: reference.legId,
      confirmedExecutedQuantity: reconciled.confirmedExecutedQuantity,
      remoteObservation: reconciled.observation,
      occurredAt: Math.max(state.updatedAt, reconciled.observedAt),
    });
  }

  private applyObservation(
    state: FundingArbitrageExecutionState,
    legId: string,
    observation: FundingArbitrageLegObservation,
  ) {
    const occurredAt = Math.max(state.updatedAt, observation.observedAt);
    if (observation.observation === "UNKNOWN_REMOTE_STATE") {
      return this.transition(state, { type: "LEG_REMOTE_UNKNOWN", legId, occurredAt });
    }
    if (observation.observation === "FILLED") {
      return this.transition(state, {
        type: "LEG_CONFIRMED_FILLED",
        legId,
        confirmedExecutedQuantity: observation.confirmedExecutedQuantity,
        occurredAt,
      });
    }
    if (observation.observation === "OPEN") {
      return this.transition(state, {
        type: "LEG_CONFIRMED_PARTIAL",
        legId,
        confirmedExecutedQuantity: observation.confirmedExecutedQuantity,
        occurredAt,
      });
    }
    return this.transition(state, {
      type: "LEG_RECONCILIATION_RESOLVED",
      legId,
      confirmedExecutedQuantity: observation.confirmedExecutedQuantity,
      remoteObservation: observation.observation,
      occurredAt,
    });
  }

  private transition(state: FundingArbitrageExecutionState, event: FundingArbitrageExecutionEvent) {
    return this.coordinator.transition(state, event);
  }

  private failOnlyWithoutConfirmedResidual(
    state: FundingArbitrageExecutionState,
    occurredAt = this.nowAtOrAfter(state.updatedAt),
  ) {
    if (state.status === "RESIDUAL" && state.residualExposure.residualQuantity !== "0") return state;
    return this.transition(state, {
      type: "MARK_FAILED",
      occurredAt,
    });
  }

  private now() {
    const value = this.clock();
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error("Capital test runtime clock must return a non-negative integer timestamp.");
    }
    return value;
  }

  private nowAtOrAfter(timestamp: number) {
    return Math.max(timestamp, this.now());
  }

  private assertRiskMutationAllowed(prepared: Readonly<{ quantityXaut: number; limitPrice: number }>) {
    if (this.now() >= this.intentExpiresAt) {
      throw new Error("Capital test intent expired before risk-increasing mutation.");
    }
    const mutationCapitalUsd = prepared.quantityXaut * prepared.limitPrice;
    const nextPlannedCapitalUsd = this.plannedMutationCapitalUsd + mutationCapitalUsd;
    if (!Number.isFinite(mutationCapitalUsd)
      || mutationCapitalUsd <= 0
      || !Number.isFinite(nextPlannedCapitalUsd)
      || nextPlannedCapitalUsd > BINANCE_CAPITAL_TEST_MAX_TOTAL_PLANNED_CAPITAL_USD + 1e-9) {
      throw new Error("Capital test mutation would exceed the 40 USD total planned capital limit.");
    }
    this.plannedMutationCapitalUsd = nextPlannedCapitalUsd;
  }
}

function assertAttemptIdentities(attempts: readonly BinanceCapitalTestAttempt[]) {
  const identities = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.executionAttemptId.trim() || attempt.executionAttemptId.length > 200) {
      throw new Error("Capital test execution attempt identity is invalid.");
    }
    if (identities.has(attempt.executionAttemptId)) {
      throw new Error("Capital test execution attempt identities must be unique.");
    }
    identities.add(attempt.executionAttemptId);
  }
}

function stableAttemptIdentity(
  executionId: string,
  legId: string,
  operation: "submit",
  attemptVersion: number,
) {
  const digest = createHash("sha256")
    .update(`${executionId}\u0000${legId}\u0000${operation}\u0000${attemptVersion}`)
    .digest("hex");
  return `funding-arbitrage-attempt:${attemptVersion}:${digest}`;
}

function isConfirmedTerminalFailure(observation: string | null) {
  return observation === "REMOTE_NOT_FOUND" || observation === "CANCELED" || observation === "REJECTED";
}
