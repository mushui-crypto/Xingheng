import { canonicalInstrumentFromId } from "../cex/Instrument";
import type { FundingArbitrageExecutionIntent } from "../cex/funding-arbitrage/FundingArbitrageExecutionIntent";
import {
  FundingArbitrageManualExecutionError,
  type FundingArbitrageExecutionIntentSource,
} from "./FundingArbitrageManualExecutionService";

export class ManualRequestFundingArbitrageExecutionIntentSource
implements FundingArbitrageExecutionIntentSource {
  async loadForUser(
    userId: string,
    fundingIntentId: string,
    input: unknown,
  ): Promise<FundingArbitrageExecutionIntent> {
    identifier(userId, "authenticated userId");
    const expectedIntentId = identifier(fundingIntentId, "fundingIntentId");
    const intent = parseFundingIntent(input);
    if (intent.intentId !== expectedIntentId) {
      throw invalid("fundingIntentId must match fundingIntent.intentId.");
    }
    return intent;
  }
}

function parseFundingIntent(input: unknown): FundingArbitrageExecutionIntent {
  const value = object(input, "fundingIntent");
  assertExactKeys(value, [
    "intentId",
    "sourcePlanId",
    "strategyType",
    "objective",
    "createdAt",
    "expiresAt",
    "constraints",
    "legs",
  ], "fundingIntent");

  if (value.strategyType !== "PERPETUAL_PERPETUAL" && value.strategyType !== "SPOT_PERPETUAL") {
    throw invalid("fundingIntent.strategyType is unsupported.");
  }
  if (value.objective !== "ESTABLISH_HEDGE") {
    throw invalid("fundingIntent.objective must be ESTABLISH_HEDGE.");
  }
  const createdAt = timestamp(value.createdAt, "fundingIntent.createdAt");
  const expiresAt = timestamp(value.expiresAt, "fundingIntent.expiresAt");
  if (expiresAt <= createdAt) {
    throw invalid("fundingIntent.expiresAt must be after createdAt.");
  }

  const constraints = object(value.constraints, "fundingIntent.constraints");
  assertExactKeys(constraints, ["maxResidualBaseQuantity"], "fundingIntent.constraints");
  const maxResidualBaseQuantity = decimal(
    constraints.maxResidualBaseQuantity,
    "fundingIntent.constraints.maxResidualBaseQuantity",
    true,
  );

  if (!Array.isArray(value.legs) || value.legs.length !== 2) {
    throw invalid("fundingIntent must contain exactly two legs.");
  }
  const firstLeg = leg(value.legs[0], "fundingIntent.legs[0]");
  const secondLeg = leg(value.legs[1], "fundingIntent.legs[1]");
  if (firstLeg.role !== "long" || secondLeg.role !== "short") {
    throw invalid("fundingIntent legs must be ordered long then short.");
  }
  if (firstLeg.legId === secondLeg.legId) {
    throw invalid("fundingIntent legId values must be unique.");
  }
  if (value.strategyType === "PERPETUAL_PERPETUAL") {
    if (firstLeg.marketType !== "perpetual" || secondLeg.marketType !== "perpetual") {
      throw invalid("PERPETUAL_PERPETUAL requires two perpetual legs.");
    }
  } else {
    const spotLegCount = Number(firstLeg.marketType === "spot") + Number(secondLeg.marketType === "spot");
    if (spotLegCount !== 1) {
      throw invalid("SPOT_PERPETUAL requires one spot leg and one perpetual leg.");
    }
  }

  return Object.freeze({
    intentId: identifier(value.intentId, "fundingIntent.intentId"),
    sourcePlanId: identifier(value.sourcePlanId, "fundingIntent.sourcePlanId"),
    strategyType: value.strategyType,
    objective: "ESTABLISH_HEDGE",
    createdAt,
    expiresAt,
    constraints: Object.freeze({ maxResidualBaseQuantity }),
    legs: Object.freeze([firstLeg, secondLeg]),
  }) as FundingArbitrageExecutionIntent;
}

function leg(input: unknown, name: string) {
  const value = object(input, name);
  assertExactKeys(value, [
    "legId",
    "role",
    "venue",
    "instrumentId",
    "marketType",
    "targetDeltaBaseQuantity",
  ], name);
  if (value.role !== "long" && value.role !== "short") {
    throw invalid(`${name}.role must be long or short.`);
  }
  if (value.venue !== "binance" && value.venue !== "okx" && value.venue !== "bybit" && value.venue !== "bitget") {
    throw invalid(`${name}.venue is unsupported.`);
  }
  if (value.marketType !== "spot" && value.marketType !== "perpetual") {
    throw invalid(`${name}.marketType must be spot or perpetual.`);
  }
  const instrumentId = identifier(value.instrumentId, `${name}.instrumentId`);
  let instrument;
  try {
    instrument = canonicalInstrumentFromId(instrumentId);
  } catch {
    throw invalid(`${name}.instrumentId must be canonical.`);
  }
  if (instrument.contractType !== value.marketType) {
    throw invalid(`${name}.marketType must match its canonical instrument.`);
  }
  return Object.freeze({
    legId: identifier(value.legId, `${name}.legId`),
    role: value.role,
    venue: value.venue,
    instrumentId: instrument.instrumentId,
    marketType: value.marketType,
    targetDeltaBaseQuantity: decimal(value.targetDeltaBaseQuantity, `${name}.targetDeltaBaseQuantity`, false),
  });
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw invalid(`${name} contains unsupported field: ${unknown}.`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw invalid(`${name} is invalid.`);
  }
  return value.trim();
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}

function decimal(value: unknown, name: string, allowZero: boolean) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw invalid(`${name} must be an unsigned decimal string.`);
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw invalid(`${name} must be finite.`);
  }
  if (!allowZero && numericValue <= 0) {
    throw invalid(`${name} must be greater than zero.`);
  }
  return value;
}

function invalid(message: string) {
  return new FundingArbitrageManualExecutionError("invalid_manual_execution_request", message);
}
