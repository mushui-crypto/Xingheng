import type { Asset } from "./Asset";
import type { TradingRules } from "./TradingRules";

export type AssetQuantity = Readonly<{
  asset: Asset;
  quantity: string;
}>;

export type VenueQuantity = Readonly<{
  quantity: string;
}>;

export function createAssetQuantity(input: unknown): AssetQuantity {
  const value = object(input, "AssetQuantity");
  assertExactKeys(value, ["asset", "quantity"], "AssetQuantity");

  return Object.freeze({
    asset: asset(value.asset),
    quantity: positiveDecimal(value.quantity, "quantity"),
  });
}

export class QuantityConverter {
  toVenueQuantity(quantity: AssetQuantity, rules: TradingRules): VenueQuantity {
    const normalized = floorToStep(quantity.quantity, rules.quantityStep);
    const withPrecision = applyPrecision(normalized, rules.precision.quantity);
    if (compareDecimal(withPrecision, rules.minQuantity) < 0) {
      throw new Error("quantity is below venue minimum quantity.");
    }

    return Object.freeze({
      quantity: withPrecision,
    });
  }

  toVenueContractQuantity(quantity: AssetQuantity, rules: TradingRules): VenueQuantity {
    if (rules.contractSize === undefined) {
      throw new Error("contractSize is required for contract quantity conversion.");
    }
    const rawContracts = divideDecimal(
      quantity.quantity,
      rules.contractSize,
      Math.max(
        rules.precision.quantity ?? 0,
        decimalPlaces(quantity.quantity) + decimalPlaces(rules.contractSize) + decimalPlaces(rules.quantityStep) + 8,
      ),
    );
    return this.toVenueQuantity(
      Object.freeze({ asset: quantity.asset, quantity: rawContracts }),
      rules,
    );
  }
}

function floorToStep(quantity: string, step: string) {
  const scale = Math.max(decimalPlaces(quantity), decimalPlaces(step));
  const quantityInt = decimalToBigInt(quantity, scale);
  const stepInt = decimalToBigInt(step, scale);
  if (stepInt <= 0n) throw new Error("quantityStep must be greater than zero.");
  return bigIntToDecimal((quantityInt / stepInt) * stepInt, scale);
}

function applyPrecision(quantity: string, precision: number | undefined) {
  if (precision === undefined) return quantity;
  const scale = decimalPlaces(quantity);
  if (scale <= precision) return quantity;
  const quantityInt = decimalToBigInt(quantity, scale);
  const divisor = 10n ** BigInt(scale - precision);
  return bigIntToDecimal((quantityInt / divisor) * divisor, precision);
}

function compareDecimal(left: string, right: string) {
  const scale = Math.max(decimalPlaces(left), decimalPlaces(right));
  const leftInt = decimalToBigInt(left, scale);
  const rightInt = decimalToBigInt(right, scale);
  if (leftInt < rightInt) return -1;
  if (leftInt > rightInt) return 1;
  return 0;
}

function divideDecimal(numerator: string, denominator: string, precision: number) {
  const numeratorScale = decimalPlaces(numerator);
  const denominatorScale = decimalPlaces(denominator);
  const numeratorInt = decimalToBigInt(numerator, numeratorScale);
  const denominatorInt = decimalToBigInt(denominator, denominatorScale);
  if (denominatorInt <= 0n) throw new Error("denominator must be greater than zero.");
  const scaled = numeratorInt * (10n ** BigInt(precision + denominatorScale));
  return bigIntToDecimal(scaled / (denominatorInt * (10n ** BigInt(numeratorScale))), precision);
}

function decimalToBigInt(value: string, scale: number) {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(`${integer}${fraction.padEnd(scale, "0")}`);
}

function bigIntToDecimal(value: bigint, scale: number) {
  if (scale === 0) return value.toString();
  const raw = value.toString().padStart(scale + 1, "0");
  const integer = raw.slice(0, -scale);
  const fraction = raw.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function decimalPlaces(value: string) {
  return value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
}

function asset(input: unknown): Asset {
  const value = object(input, "asset");
  assertExactKeys(value, ["symbol", "type", "displayName", "externalReference"], "asset");
  if (typeof value.symbol !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value.symbol)) {
    throw new Error("asset.symbol must be an uppercase asset symbol.");
  }
  if (value.type !== "DIGITAL_ASSET" && value.type !== "RWA_ASSET") {
    throw new Error("asset.type must be DIGITAL_ASSET or RWA_ASSET.");
  }
  return value as Asset;
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

function positiveDecimal(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${name} must be a positive decimal string.`);
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  const normalized = normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
  if (normalized === "0") throw new Error(`${name} must be greater than zero.`);
  return normalized;
}
