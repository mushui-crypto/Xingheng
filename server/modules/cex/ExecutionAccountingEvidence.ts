export type ExecutionAccountingEvidence = Readonly<{
  providerOrderId: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  feeAmountProvider: string | null;
  feeAsset: string | null;
  tradingFeeNetCostUsdt: string | null;
  confirmedAt: number;
  completeness: "COMPLETE" | "INCOMPLETE";
}>;

export function createExecutionAccountingEvidence(input: unknown): ExecutionAccountingEvidence {
  const value = object(input);
  const averageFillPrice = nullablePositiveDecimal(value.averageFillPrice, "averageFillPrice");
  const feeAmountProvider = nullableSignedDecimal(value.feeAmountProvider, "feeAmountProvider");
  const feeAsset = nullableAsset(value.feeAsset);
  const tradingFeeNetCostUsdt = nullableSignedDecimal(
    value.tradingFeeNetCostUsdt,
    "tradingFeeNetCostUsdt",
  );
  const completeness = value.completeness === "COMPLETE" || value.completeness === "INCOMPLETE"
    ? value.completeness
    : invalid("accounting evidence completeness is invalid.");
  if (completeness === "COMPLETE"
    && (averageFillPrice === null || feeAmountProvider === null || tradingFeeNetCostUsdt === null)) {
    throw new Error("Complete accounting evidence requires fill price and normalized fee facts.");
  }
  return Object.freeze({
    providerOrderId: identifier(value.providerOrderId, "providerOrderId"),
    filledQuantity: unsignedDecimal(value.filledQuantity, "filledQuantity"),
    averageFillPrice,
    feeAmountProvider,
    feeAsset,
    tradingFeeNetCostUsdt,
    confirmedAt: timestamp(value.confirmedAt),
    completeness,
  });
}

export function negateSignedDecimal(value: string) {
  const normalized = signedDecimal(value, "fee");
  return normalized === "0" ? "0" : normalized.startsWith("-") ? normalized.slice(1) : `-${normalized}`;
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Execution accounting evidence must be an object.");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${name} is invalid.`);
  return value.trim();
}

function unsignedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be an unsigned decimal string.`);
  }
  return normalizeDecimal(value);
}

function signedDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be a signed decimal string.`);
  }
  const negative = value.startsWith("-");
  const normalized = normalizeDecimal(negative ? value.slice(1) : value);
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function nullablePositiveDecimal(value: unknown, name: string) {
  if (value === null || value === undefined) return null;
  const normalized = unsignedDecimal(value, name);
  if (normalized === "0") throw new Error(`${name} must be positive when present.`);
  return normalized;
}

function nullableSignedDecimal(value: unknown, name: string) {
  return value === null || value === undefined ? null : signedDecimal(value, name);
}

function nullableAsset(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value)) throw new Error("feeAsset is invalid.");
  return value;
}

function normalizeDecimal(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const normalized = fraction.replace(/0+$/u, "");
  return normalized ? `${integer}.${normalized}` : integer!;
}

function timestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("confirmedAt must be a non-negative integer timestamp.");
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(message);
}
