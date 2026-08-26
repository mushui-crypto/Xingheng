import { createHash } from "node:crypto";

export function createArbitrageCommandPayloadFingerprint(parts: readonly string[]) {
  if (parts.length === 0 || parts.some((part) => typeof part !== "string" || part.includes("\u0000"))) {
    throw new Error("Arbitrage command fingerprint parts are invalid.");
  }
  // An ordered scalar tuple is deliberate: it cannot vary with object key order
  // and it contains no Provider Reality or other time-varying derived facts.
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function canonicalCommandDecimal(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Arbitrage command decimal is invalid.");
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}
