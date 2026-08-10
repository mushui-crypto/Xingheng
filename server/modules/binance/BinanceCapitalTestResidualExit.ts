import { createHash } from "node:crypto";
import type { FundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import type { FundingArbitrageExecutionState } from "../cex/funding-arbitrage/FundingArbitrageExecutionState";
import type { BinanceCapitalTestExecutionContext } from "./BinanceCapitalTestPreflight";
import {
  BINANCE_PERPETUAL_INSTRUMENT_ID,
  BINANCE_SPOT_INSTRUMENT_ID,
} from "./BinanceInstrumentCatalog";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { classifyBinanceExposure } from "./BinanceExposureClassifier";

type BinanceCapitalTestResidualExitService = Readonly<{
  account: BinancePersonalTradingService["account"];
  exit: (input: unknown) => Promise<unknown>;
}>;

export type BinanceCapitalTestResidualExitIdentity = Readonly<{
  executionAttemptId: string;
  operationId: string;
}>;

export type BinanceCapitalTestResidualExitResult =
  | Readonly<{
    status: "NOT_REQUIRED";
    identity: null;
    reason: string;
  }>
  | Readonly<{
    status: "EXITED";
    identity: BinanceCapitalTestResidualExitIdentity | null;
    reason: null;
    message: "Capital Test closed successfully";
  }>
  | Readonly<{
    status: "FAILED";
    identity: BinanceCapitalTestResidualExitIdentity;
    reason: string;
  }>;

export class BinanceCapitalTestResidualExit {
  constructor(private readonly service: BinanceCapitalTestResidualExitService) {}

  async execute(
    context: BinanceCapitalTestExecutionContext,
    intent: FundingArbitrageExecutionIntent,
    state: FundingArbitrageExecutionState,
    openingAttemptIds: readonly string[],
  ): Promise<BinanceCapitalTestResidualExitResult> {
    assertScope(context, intent, state);
    const confirmedHedge = isConfirmedHedge(state);
    const confirmedResidual = isConfirmedTerminalResidual(state);
    if (!confirmedHedge && !confirmedResidual) {
      return {
        status: "NOT_REQUIRED",
        identity: null,
        reason: state.status === "PENDING_RECONCILIATION"
          ? "Remote state remains unknown; residual exit mutation is prohibited."
          : "Execution state does not contain a confirmed terminal residual exposure.",
      };
    }
    if (confirmedResidual && compareUnsignedDecimals(
      state.residualExposure.residualQuantity,
      intent.constraints.maxResidualBaseQuantity,
    ) <= 0) {
      return {
        status: "NOT_REQUIRED",
        identity: null,
        reason: "Confirmed residual exposure is within the approved maximum tolerance.",
      };
    }

    const beforeExit = await this.service.account();
    if (beforeExit.accountId !== context.accountId) {
      return failureWithoutMutation(intent.intentId, openingAttemptIds,
        "Residual exit account does not match the bound execution context.");
    }
    if (classifyBinanceExposure(beforeExit) !== "TRADABLE_RESIDUAL") {
      return { status: "EXITED", identity: null, reason: null, message: "Capital Test closed successfully" };
    }

    const identity = createExitIdentity(intent.intentId, openingAttemptIds);
    try {
      await this.service.exit({ idempotencyKey: identity.operationId });
    } catch (error) {
      const exitReason = errorMessage(error);
      let confirmation: string;
      try {
        const afterFailure = await this.service.account();
        confirmation = afterFailure.accountId !== context.accountId
          ? "post-failure account binding could not be confirmed"
          : classifyBinanceExposure(afterFailure) !== "TRADABLE_RESIDUAL"
            ? "post-failure account read is flat"
            : "post-failure account read still contains XAUT exposure";
      } catch (confirmationError) {
        confirmation = `post-failure account confirmation failed: ${errorMessage(confirmationError)}`;
      }
      return {
        status: "FAILED",
        identity,
        reason: `Binance residual exit failed: ${exitReason}; ${confirmation}.`,
      };
    }

    let afterExit;
    try {
      afterExit = await this.service.account();
    } catch (error) {
      return {
        status: "FAILED",
        identity,
        reason: `Binance residual exit account confirmation failed: ${errorMessage(error)}`,
      };
    }
    if (afterExit.accountId !== context.accountId) {
      return {
        status: "FAILED",
        identity,
        reason: "Residual exit confirmation does not match the bound execution account.",
      };
    }
    if (classifyBinanceExposure(afterExit) === "TRADABLE_RESIDUAL") {
      return {
        status: "FAILED",
        identity,
        reason: "Binance capital test exit completed without confirming flat exposure and zero open orders.",
      };
    }
    return { status: "EXITED", identity, reason: null, message: "Capital Test closed successfully" };
  }
}

function isConfirmedTerminalResidual(state: FundingArbitrageExecutionState) {
  return state.status === "RESIDUAL"
    && state.residualExposure.residualQuantity !== "0"
    && state.legs.some((leg) => leg.confirmedExecutedQuantity !== "0")
    && state.legs.every((leg) => leg.remoteObservation !== "UNKNOWN_REMOTE_STATE")
    && state.legs.every((leg) => leg.remoteObservation !== "OPEN");
}

function isConfirmedHedge(state: FundingArbitrageExecutionState) {
  return state.status === "HEDGED"
    && state.legs.every((leg) => leg.confirmedExecutedQuantity !== "0")
    && state.legs.every((leg) => leg.status === "TERMINAL")
    && state.legs.every((leg) => leg.remoteObservation !== null)
    && state.legs.every((leg) => leg.remoteObservation !== "OPEN")
    && state.legs.every((leg) => leg.remoteObservation !== "UNKNOWN_REMOTE_STATE");
}

function assertScope(
  context: BinanceCapitalTestExecutionContext,
  intent: FundingArbitrageExecutionIntent,
  state: FundingArbitrageExecutionState,
) {
  if (!context.userId.trim() || !context.accountId.trim() || context.venue !== "binance") {
    throw new Error("Residual exit requires a valid bound Binance execution context.");
  }
  if (intent.strategyType !== "SPOT_PERPETUAL"
    || intent.legs[0].venue !== "binance"
    || intent.legs[1].venue !== "binance"
    || intent.legs[0].instrumentId !== BINANCE_SPOT_INSTRUMENT_ID
    || intent.legs[1].instrumentId !== BINANCE_PERPETUAL_INSTRUMENT_ID
    || intent.legs[0].marketType !== "spot"
    || intent.legs[1].marketType !== "perpetual") {
    throw new Error("Residual exit supports only Binance XAUT/USDT SPOT_PERPETUAL capital tests.");
  }
  if (state.intentId !== intent.intentId) {
    throw new Error("Residual exit state does not belong to the supplied capital test intent.");
  }
}

function createExitIdentity(
  intentId: string,
  openingAttemptIds: readonly string[],
) {
  const identity = {
    executionAttemptId: stableIdentity(intentId, "execution-attempt"),
    operationId: stableIdentity(intentId, "operation"),
  };
  const all = [identity.executionAttemptId, identity.operationId];
  if (all.some((value) => !value.trim() || value.length > 200)
    || new Set([...openingAttemptIds, ...all]).size !== openingAttemptIds.length + all.length) {
    throw new Error("Residual exit identities must be valid, unique, and separate from opening attempts.");
  }
  return identity;
}

function failureWithoutMutation(
  intentId: string,
  openingAttemptIds: readonly string[],
  reason: string,
): BinanceCapitalTestResidualExitResult {
  return { status: "FAILED", identity: createExitIdentity(intentId, openingAttemptIds), reason };
}

function stableIdentity(intentId: string, identity: "execution-attempt" | "operation") {
  const digest = createHash("sha256")
    .update(`${intentId}\u0000residual-exit\u0000${identity}\u00000`)
    .digest("hex");
  return `funding-arbitrage-residual-exit:${identity}:${digest}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compareUnsignedDecimals(left: string, right: string) {
  const parsedLeft = parseUnsignedDecimal(left);
  const parsedRight = parseUnsignedDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  const leftValue = parsedLeft.value * 10n ** BigInt(scale - parsedLeft.scale);
  const rightValue = parsedRight.value * 10n ** BigInt(scale - parsedRight.scale);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

function parseUnsignedDecimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Residual quantities must be unsigned decimal strings.");
  }
  const [integer, fraction = ""] = value.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}
