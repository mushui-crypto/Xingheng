export type AssetType = "DIGITAL_ASSET" | "RWA_ASSET";

export type AssetExternalReference = Readonly<{
  namespace: string;
  identifier: string;
}>;

export type Asset = Readonly<{
  symbol: string;
  type: AssetType;
  displayName?: string;
  externalReference?: AssetExternalReference;
}>;

export function createAsset(input: unknown): Asset {
  const value = object(input);
  assertExactKeys(value, ["symbol", "type", "displayName", "externalReference"], "Asset");

  if (value.type !== "DIGITAL_ASSET" && value.type !== "RWA_ASSET") {
    throw new Error("type must be DIGITAL_ASSET or RWA_ASSET.");
  }

  return Object.freeze({
    symbol: assetSymbol(value.symbol),
    type: value.type,
    ...(value.displayName === undefined ? {} : { displayName: displayName(value.displayName) }),
    ...(value.externalReference === undefined
      ? {}
      : { externalReference: createExternalReference(value.externalReference) }),
  });
}

function createExternalReference(input: unknown): AssetExternalReference {
  const value = object(input, "externalReference");
  assertExactKeys(value, ["namespace", "identifier"], "externalReference");

  return Object.freeze({
    namespace: identifier(value.namespace, "externalReference.namespace"),
    identifier: identifier(value.identifier, "externalReference.identifier"),
  });
}

function object(value: unknown, name = "Asset") {
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

function assetSymbol(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,12}$/u.test(value)) {
    throw new Error("symbol must be an uppercase asset symbol.");
  }
  return value;
}

function displayName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("displayName is invalid.");
  }
  return value.trim();
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
