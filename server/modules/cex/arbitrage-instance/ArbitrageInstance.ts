import type { ExecutionVenue } from "../ExecutionIntent";
import type { FundingArbitrageStrategyType } from "../funding-arbitrage/FundingArbitragePlan";

export type ArbitrageInstanceStatus =
  | "OPENING"
  | "HOLDING"
  | "RESIDUAL"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";

export type ArbitrageExecutionPhase = "OPENING" | "ADJUSTMENT" | "CLOSING";
export type ArbitrageQuantityEffect = "INCREASE" | "DECREASE";
export type ArbitrageExecutionReferenceStatus =
  | "CLAIMED"
  | "LINKED"
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "FAILED"
  | "UNKNOWN";

export type ArbitrageInstanceLeg = Readonly<{
  legId: string;
  role: "LONG" | "SHORT";
  venue: ExecutionVenue;
  accountId: string;
  instrumentId: string;
  plannedQuantity: string;
  confirmedOpenedQuantity: string;
  confirmedClosedQuantity: string;
}>;

export type ArbitrageExecutionReference = Readonly<{
  arbitrageId: string;
  legId: string;
  phase: ArbitrageExecutionPhase;
  quantityEffect: ArbitrageQuantityEffect;
  executionIntentId: string;
  executionRecordId: string | null;
  requestedQuantity: string;
  confirmedQuantity: string;
  status: ArbitrageExecutionReferenceStatus;
  createdAt: number;
  updatedAt: number;
}>;

export type ArbitrageLegManagementRelease = Readonly<{
  releaseId: string;
  arbitrageId: string;
  legId: string;
  releasedQuantity: string;
  reason: "USER_CONFIRMED_STOP_MANAGEMENT";
  source: "AUTHENTICATED_API";
  requestedByUserId: string;
  requestedAt: number;
  confirmedAt: number;
  venue: ExecutionVenue;
  accountId: string;
  instrumentId: string;
  positionMode: "ONE_WAY" | "HEDGE";
  actualQuantity: string;
  actualSignedNetQuantity: string | null;
  actualLongQuantity: string;
  actualShortQuantity: string;
  availableQuantity: string | null;
  realityCheckedAt: number;
}>;

export type ArbitragePnlSummary = Readonly<{
  asset: string | null;
  cumulativeFundingPnl: string | null;
  realizedTradingPnl: string | null;
  feesCosts: string | null;
  cumulativeNetPnl: string | null;
  updatedAt: number | null;
}>;

export type ArbitrageInstance = Readonly<{
  arbitrageId: string;
  userId: string;
  strategyType: FundingArbitrageStrategyType;
  sourcePlanId: string | null;
  maxResidualBaseQuantity: string;
  status: ArbitrageInstanceStatus;
  createdAt: number;
  openedAt: number | null;
  updatedAt: number;
  /** Time Xingheng's management responsibility ended; not necessarily a Provider close fill time. */
  closedAt: number | null;
  legs: readonly [ArbitrageInstanceLeg, ArbitrageInstanceLeg];
  executionReferences: readonly ArbitrageExecutionReference[];
  /** Explicit user decisions to stop managing a leg; never execution evidence. */
  managementReleases?: readonly ArbitrageLegManagementRelease[];
  pnl: ArbitragePnlSummary;
}>;

export type NewArbitrageInstance = Readonly<{
  arbitrageId: string;
  userId: string;
  strategyType: FundingArbitrageStrategyType;
  sourcePlanId?: string | null;
  maxResidualBaseQuantity: string;
  createdAt: number;
  legs: readonly [Readonly<{
    legId: string;
    role: "LONG" | "SHORT";
    venue: ExecutionVenue;
    accountId: string;
    instrumentId: string;
    plannedQuantity: string;
  }>, Readonly<{
    legId: string;
    role: "LONG" | "SHORT";
    venue: ExecutionVenue;
    accountId: string;
    instrumentId: string;
    plannedQuantity: string;
  }>];
}>;

export function managedCurrentQuantity(leg: ArbitrageInstanceLeg) {
  return subtractUnsignedDecimals(leg.confirmedOpenedQuantity, leg.confirmedClosedQuantity);
}

/** Remaining quantity Xingheng may still operate after explicit management release. */
export function activeManagedQuantity(instance: ArbitrageInstance, leg: ArbitrageInstanceLeg) {
  const release = instance.managementReleases?.find((candidate) => candidate.legId === leg.legId);
  if (release) return "0";
  return managedCurrentQuantity(leg);
}

export function activeManagedSignedQuantity(instance: ArbitrageInstance, leg: ArbitrageInstanceLeg) {
  const quantity = activeManagedQuantity(instance, leg);
  return quantity === "0" || leg.role === "LONG" ? quantity : `-${quantity}`;
}

/** Canonical signed delta still outstanding for this arbitrage leg. */
export function managedSignedDelta(leg: ArbitrageInstanceLeg) {
  const quantity = managedCurrentQuantity(leg);
  return quantity === "0" || leg.role === "LONG" ? quantity : `-${quantity}`;
}

export function normalizeUnsignedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be an unsigned decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

export function normalizePositiveDecimal(value: unknown, name: string) {
  const normalized = normalizeUnsignedDecimal(value, name);
  if (normalized === "0") throw new Error(`${name} must be greater than zero.`);
  return normalized;
}

export function normalizeSignedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be a signed decimal string.`);
  }
  const negative = value.startsWith("-");
  const normalized = normalizeUnsignedDecimal(negative ? value.slice(1) : value, name);
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

export function compareUnsignedDecimals(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  return aligned.left === aligned.right ? 0 : aligned.left > aligned.right ? 1 : -1;
}

export function addUnsignedDecimals(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  return formatScaledInteger(aligned.left + aligned.right, aligned.scale);
}

export function subtractUnsignedDecimals(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  if (aligned.right > aligned.left) {
    throw new Error("Confirmed closed quantity cannot exceed confirmed opened quantity.");
  }
  return formatScaledInteger(aligned.left - aligned.right, aligned.scale);
}

export function absoluteDifference(left: string, right: string) {
  const aligned = alignUnsignedDecimals(left, right);
  const difference = aligned.left >= aligned.right
    ? aligned.left - aligned.right
    : aligned.right - aligned.left;
  return formatScaledInteger(difference, aligned.scale);
}

function alignUnsignedDecimals(left: string, right: string) {
  const parsedLeft = parseUnsignedDecimal(left);
  const parsedRight = parseUnsignedDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return {
    left: parsedLeft.value * 10n ** BigInt(scale - parsedLeft.scale),
    right: parsedRight.value * 10n ** BigInt(scale - parsedRight.scale),
    scale,
  };
}

function parseUnsignedDecimal(value: string) {
  const normalized = normalizeUnsignedDecimal(value, "quantity");
  const [integer, fraction = ""] = normalized.split(".");
  return { value: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function formatScaledInteger(value: bigint, scale: number) {
  if (value === 0n) return "0";
  const digits = value.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}
