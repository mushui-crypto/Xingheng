import { createHmac } from "node:crypto";

const BITGET_API_BASE_URL = "https://api.bitget.com";

export type BitgetAccountReadCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
};

export type BitgetAccountBalance = {
  asset: string;
  total: number;
  available: number | null;
  locked: number | null;
};

export type BitgetAccountReadSnapshot = {
  uid: string;
  accountMode: string;
  assetMode: string | null;
  accountLevel: string | null;
  permType: string | null;
  permissions: string[] | null;
  boundIps: string | null;
  balances: BitgetAccountBalance[];
  fetchedAt: number;
};

export type BitgetPerpetualPositionSnapshot = {
  symbol: string;
  side: "long" | "short" | "flat";
  baseQuantity: string;
  updatedAt: number | null;
};

type BitgetAccountReadClientOptions = Readonly<{
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}>;

type BitgetResponse = {
  code?: string;
  msg?: string;
  message?: string;
  data?: unknown;
};

export class BitgetAccountReadError extends Error {
  constructor(readonly category: string, message: string) {
    super(message);
  }
}

export class BitgetAccountReadClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: BitgetAccountReadCredentials,
    options: BitgetAccountReadClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? BITGET_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async readAccountSnapshot(): Promise<BitgetAccountReadSnapshot> {
    const [infoPayload, settingsPayload, assetsPayload] = await Promise.all([
      this.get("/api/v3/account/info"),
      this.get("/api/v3/account/settings"),
      this.get("/api/v3/account/assets"),
    ]);
    const info = requiredRecord(infoPayload.data, "Bitget account information");
    const settings = requiredRecord(settingsPayload.data, "Bitget account settings");
    const assets = requiredRecord(assetsPayload.data, "Bitget account assets");
    const uid = requiredIdentifier(info.userId, "Bitget account userId");
    if (requiredIdentifier(settings.uid, "Bitget account uid") !== uid) {
      throw new BitgetAccountReadError("provider_response_invalid", "Bitget account identifiers do not match.");
    }
    const balances = requiredList(assets.assets, "Bitget account asset list")
      .map((value) => requiredRecord(value, "Bitget account asset"))
      .map((asset) => ({
        asset: requiredString(asset.coin, "Bitget account asset coin").toUpperCase(),
        total: finiteNumber(asset.balance, "Bitget account asset balance"),
        available: optionalFiniteNumber(asset.available, "Bitget account asset available"),
        locked: optionalFiniteNumber(asset.locked, "Bitget account asset locked"),
      }))
      .filter((asset) => asset.total !== 0
        || (asset.available !== null && asset.available !== 0)
        || (asset.locked !== null && asset.locked !== 0));
    return {
      uid,
      accountMode: requiredString(settings.accountMode, "Bitget account mode"),
      assetMode: optionalString(settings.assetMode),
      accountLevel: optionalString(settings.accountLevel),
      permType: optionalString(info.permType),
      permissions: optionalStringArray(info.permissions, "Bitget account permissions"),
      boundIps: optionalStringPreservingEmpty(info.ips),
      balances,
      fetchedAt: this.now(),
    };
  }

  async readPerpetualPosition(
    symbol: string,
    expectedSide?: "long" | "short",
  ): Promise<BitgetPerpetualPositionSnapshot> {
    const normalizedSymbol = requiredString(symbol, "Bitget position symbol").toUpperCase();
    const payload = await this.get("/api/v3/position/current-position", {
      category: "USDT-FUTURES",
      symbol: normalizedSymbol,
    });
    const data = requiredRecord(payload.data, "Bitget position data");
    const positions = requiredList(data.list, "Bitget position list")
      .map((value) => requiredRecord(value, "Bitget position"))
      .filter((position) => requiredString(position.symbol, "Bitget position symbol") === normalizedSymbol);
    const nonZero = positions.filter((position) => decimalQuantity(position.total, "Bitget position total") !== "0");
    const sideMatched = expectedSide ? nonZero.filter((position) => (
      optionalString(position.posSide)?.toLowerCase() === expectedSide
    )) : nonZero;
    if (sideMatched.length > 1 || (!expectedSide && nonZero.length > 1)
      || (expectedSide !== undefined && nonZero.length > 1 && sideMatched.length === 0)) {
      throw new BitgetAccountReadError("provider_response_invalid", "Bitget returned multiple non-zero position sides.");
    }
    const position = sideMatched[0] ?? (nonZero.length <= 1 ? nonZero[0] : undefined) ?? positions[0];
    if (!position) {
      return { symbol: normalizedSymbol, side: "flat", baseQuantity: "0", updatedAt: null };
    }
    const quantity = decimalQuantity(position.total, "Bitget position total");
    const rawSide = optionalString(position.posSide)?.toLowerCase();
    const side = quantity === "0"
      ? "flat"
      : rawSide === "long" ? "long"
        : rawSide === "short" ? "short"
          : invalidPositionSide();
    return {
      symbol: normalizedSymbol,
      side,
      baseQuantity: quantity,
      updatedAt: optionalTimestamp(position.updatedTime),
    };
  }

  private async get(path: string, query: Readonly<Record<string, string>> = {}): Promise<BitgetResponse> {
    const queryString = new URLSearchParams(
      Object.entries(query).sort(([left], [right]) => left.localeCompare(right)),
    ).toString();
    const timestamp = String(this.now());
    const requestTarget = queryString ? `${path}?${queryString}` : path;
    const signature = createHmac("sha256", this.credentials.apiSecret)
      .update(`${timestamp}GET${requestTarget}`)
      .digest("base64");
    const url = new URL(path, this.baseUrl);
    url.search = queryString;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "ACCESS-KEY": this.credentials.apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": this.credentials.passphrase,
          "Content-Type": "application/json",
          locale: "en-US",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BitgetAccountReadError("provider_read_failed", "Bitget account read request failed.");
    }
    if (!response.ok) {
      throw new BitgetAccountReadError("provider_read_failed", `Bitget account read request failed: ${response.status}.`);
    }
    let payload: BitgetResponse;
    try {
      payload = await response.json() as BitgetResponse;
    } catch {
      throw new BitgetAccountReadError("provider_response_invalid", "Bitget account read response is not valid JSON.");
    }
    if (payload.code !== "00000") {
      const category = isAuthenticationCode(payload.code)
        ? "credential_validation_failed"
        : "provider_read_failed";
      throw new BitgetAccountReadError(category, `Bitget account read rejected: ${payload.code ?? "unknown"}.`);
    }
    return payload;
  }
}

function isAuthenticationCode(code: string | undefined) {
  return code === "40001" || code === "40002" || code === "40003" || code === "40004"
    || code === "40005" || code === "40006" || code === "40008" || code === "40009";
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return value;
}

function requiredString(value: unknown, label: string) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  return result;
}

function requiredIdentifier(value: unknown, label: string) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return requiredString(value, label);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalStringPreservingEmpty(value: unknown) {
  return typeof value === "string" ? value.trim() : null;
}

function optionalStringArray(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function finiteNumber(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  return result;
}

function optionalFiniteNumber(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return finiteNumber(value, label);
}

function decimalQuantity(value: unknown, label: string) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) {
    throw new BitgetAccountReadError("provider_response_invalid", `${label} is invalid.`);
  }
  const [integer, fraction = ""] = raw.split(".");
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer!;
}

function optionalTimestamp(value: unknown) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function invalidPositionSide(): never {
  throw new BitgetAccountReadError("provider_response_invalid", "Bitget position side is invalid.");
}
