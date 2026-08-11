import type { Asset } from "../Asset";
import { createExecutionIntent, type ExecutionIntent } from "../ExecutionIntent";
import type { FundingArbitrageExecutionIntent } from "./FundingArbitrageExecutionIntent";

type FundingArbitrageExecutionLeg = FundingArbitrageExecutionIntent["legs"][number];

export type FundingArbitrageLegExecutionConfirmation = Readonly<{
  confirmed: true;
  intentId: string;
  legId: string;
  userId: string;
  accountId: string;
  venue: ExecutionIntent["venue"];
  quantityAsset: Asset;
  orderConstraints: ExecutionIntent["orderConstraints"];
  executionMode: ExecutionIntent["executionMode"];
  confirmedAt: number;
  expiresAt: number;
}>;

export class FundingArbitrageIntentAdapter {
  createExecutionIntent(
    fundingIntent: FundingArbitrageExecutionIntent,
    confirmationInput: unknown,
  ): ExecutionIntent {
    const confirmation = parseConfirmation(confirmationInput);
    const leg = findLeg(fundingIntent, confirmation.legId);
    assertConfirmationWindow(fundingIntent, confirmation);
    if (confirmation.venue !== leg.venue) {
      throw new Error("confirmation venue must match the funding leg venue.");
    }
    assertQuantityAssetMatchesInstrument(confirmation.quantityAsset, leg.instrumentId);

    return createExecutionIntent({
      intentId: confirmation.intentId,
      userId: confirmation.userId,
      venue: confirmation.venue,
      accountId: confirmation.accountId,
      instrumentId: leg.instrumentId,
      side: leg.role === "long" ? "buy" : "sell",
      quantity: {
        asset: confirmation.quantityAsset,
        quantity: leg.targetDeltaBaseQuantity,
      },
      orderConstraints: confirmation.orderConstraints,
      executionMode: confirmation.executionMode,
      createdAt: confirmation.confirmedAt,
      expiresAt: confirmation.expiresAt,
    });
  }
}

function findLeg(
  fundingIntent: FundingArbitrageExecutionIntent,
  legId: string,
): FundingArbitrageExecutionLeg {
  const leg = fundingIntent.legs.find((candidate) => candidate.legId === legId);
  if (!leg) throw new Error("funding leg does not belong to the funding intent.");
  return leg;
}

function assertConfirmationWindow(
  fundingIntent: FundingArbitrageExecutionIntent,
  input: FundingArbitrageLegExecutionConfirmation,
) {
  if (input.confirmedAt < fundingIntent.createdAt || input.confirmedAt >= fundingIntent.expiresAt) {
    throw new Error("confirmation must be within the funding intent validity window.");
  }
  if (input.expiresAt <= input.confirmedAt) {
    throw new Error("execution intent expiry must be after confirmation.");
  }
  if (input.expiresAt > fundingIntent.expiresAt) {
    throw new Error("execution intent expiry cannot exceed funding intent expiry.");
  }
}

function assertQuantityAssetMatchesInstrument(asset: Asset, instrumentId: string) {
  const match = /^([A-Z0-9]{2,12})-[A-Z0-9]{2,12}-(?:SPOT|PERP)$/u.exec(instrumentId);
  if (!match) throw new Error("funding leg instrumentId must be a canonical instrument id.");
  if (asset.symbol !== match[1]) {
    throw new Error("quantity asset must match the funding leg instrument base asset.");
  }
}

function parseConfirmation(input: unknown): FundingArbitrageLegExecutionConfirmation {
  const value = object(input, "FundingArbitrageLegExecutionConfirmation");
  assertExactKeys(value, [
    "confirmed",
    "intentId",
    "legId",
    "userId",
    "accountId",
    "venue",
    "quantityAsset",
    "orderConstraints",
    "executionMode",
    "confirmedAt",
    "expiresAt",
  ], "FundingArbitrageLegExecutionConfirmation");
  if (value.confirmed !== true) throw new Error("explicit human confirmation is required.");
  if (value.venue !== "binance" && value.venue !== "okx" && value.venue !== "bybit" && value.venue !== "bitget") {
    throw new Error("venue must be binance, okx, bybit, or bitget.");
  }
  if (value.executionMode !== "PRICE_PRIORITY" && value.executionMode !== "EXECUTION_PRIORITY") {
    throw new Error("executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }

  const constraints = object(value.orderConstraints, "orderConstraints");
  assertExactKeys(constraints, ["reduceOnly"], "orderConstraints");
  if (typeof constraints.reduceOnly !== "boolean") {
    throw new Error("orderConstraints.reduceOnly must be a boolean.");
  }

  return Object.freeze({
    confirmed: true,
    intentId: identifier(value.intentId, "intentId"),
    legId: identifier(value.legId, "legId"),
    userId: identifier(value.userId, "userId"),
    accountId: identifier(value.accountId, "accountId"),
    venue: value.venue,
    quantityAsset: asset(value.quantityAsset),
    orderConstraints: Object.freeze({ reduceOnly: constraints.reduceOnly }),
    executionMode: value.executionMode,
    confirmedAt: timestamp(value.confirmedAt, "confirmedAt"),
    expiresAt: timestamp(value.expiresAt, "expiresAt"),
  });
}

function asset(input: unknown): Asset {
  const value = object(input, "quantityAsset");
  assertExactKeys(value, ["symbol", "type", "displayName", "externalReference"], "quantityAsset");
  if (typeof value.symbol !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value.symbol)) {
    throw new Error("quantityAsset.symbol must be an uppercase asset symbol.");
  }
  if (value.type !== "DIGITAL_ASSET" && value.type !== "RWA_ASSET") {
    throw new Error("quantityAsset.type must be DIGITAL_ASSET or RWA_ASSET.");
  }
  return Object.freeze({
    symbol: value.symbol,
    type: value.type,
    ...(value.displayName === undefined ? {} : { displayName: identifier(value.displayName, "quantityAsset.displayName") }),
    ...(value.externalReference === undefined
      ? {}
      : { externalReference: reference(value.externalReference, "quantityAsset.externalReference") }),
  });
}

function reference(input: unknown, name: string) {
  const value = object(input, name);
  assertExactKeys(value, ["namespace", "identifier"], name);
  return Object.freeze({
    namespace: identifier(value.namespace, `${name}.namespace`),
    identifier: identifier(value.identifier, `${name}.identifier`),
  });
}

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`${name} contains unsupported field: ${unknown}.`);
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
  return value;
}
