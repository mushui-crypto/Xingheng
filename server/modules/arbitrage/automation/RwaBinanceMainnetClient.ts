import { createHash, createHmac } from "node:crypto";
import {
  RWA_BINANCE_PERPETUAL_SYMBOL,
  RWA_BINANCE_PRODUCT_CACHE_TTL_MS,
  RWA_BINANCE_SPOT_SYMBOL,
  type RwaBinanceAccountIdentity,
  type RwaBinanceClient,
  type RwaBinanceCredentials,
  type RwaBinancePermissions,
  type RwaBinancePreflightSnapshot,
  type RwaBinanceProductAvailability,
} from "./RwaBinanceAutomationTypes";
import type { RwaInstrumentSpec } from "./RwaNeutralExecutionTypes";

const spotBaseUrl = "https://api.binance.com";
const futuresBaseUrl = "https://fapi.binance.com";
const receiveWindow = "5000";
const timeOffsetTtlMs = 30_000;

type ProductCache = {
  availability: RwaBinanceProductAvailability;
  spot: RwaInstrumentSpec;
  perpetual: RwaInstrumentSpec;
};

export class RwaBinanceMainnetClient implements RwaBinanceClient {
  private timeOffset: { value: number; expiresAt: number } | null = null;
  private productCache: { value: ProductCache; expiresAt: number } | null = null;
  private productInFlight: Promise<ProductCache> | null = null;

  constructor(
    private readonly credentials: RwaBinanceCredentials,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async validateAccess() {
    const [restrictionsValue, spotAccountValue, futuresAccountValue, positionModeValue] = await Promise.all([
      this.signedRequest("spot", "/sapi/v1/account/apiRestrictions"),
      this.signedRequest("spot", "/api/v3/account", { omitZeroBalances: "true" }),
      this.signedRequest("futures", "/fapi/v2/account"),
      this.signedRequest("futures", "/fapi/v1/positionSide/dual"),
    ]);
    const restrictions = record(restrictionsValue);
    const spotAccount = record(spotAccountValue);
    const futuresAccount = record(futuresAccountValue);
    const positionMode = record(positionModeValue);
    const uid = String(spotAccount.uid ?? "").trim();
    if (!uid) {
      throw new RwaBinanceProviderError("provider_identity_unavailable", "Binance 未返回可核对的账户 UID。");
    }
    const dualSidePosition = boolean(positionMode.dualSidePosition);
    const multiAssetsMargin = boolean(futuresAccount.multiAssetsMargin);
    const accountMode: RwaBinanceAccountIdentity["accountMode"] = multiAssetsMargin
      ? dualSidePosition ? "multi_assets_hedge" : "multi_assets_one_way"
      : dualSidePosition ? "single_asset_hedge" : "single_asset_one_way";
    const permissions: RwaBinancePermissions = {
      read: boolean(restrictions.enableReading),
      spotTrade: boolean(restrictions.enableSpotAndMarginTrading) && boolean(spotAccount.canTrade),
      contractTrade: boolean(restrictions.enableFutures) && boolean(futuresAccount.canTrade),
      withdraw: boolean(restrictions.enableWithdrawals),
      ipRestricted: boolean(restrictions.ipRestrict),
      spotAccount: true,
      futuresAccount: true,
      positionModeSupported: !dualSidePosition,
    };
    const accountFingerprint = createHash("sha256")
      .update(`binance:${uid}`)
      .digest("hex")
      .slice(0, 16);
    return {
      accountId: `binance:${accountFingerprint}`,
      accountFingerprint,
      accountMode,
      permissions,
    };
  }

  async readProductAvailability() {
    return (await this.loadProducts()).availability;
  }

  async readPreflightSnapshot(): Promise<RwaBinancePreflightSnapshot> {
    const products = await this.loadProducts();
    if (!products.availability.available) {
      throw new RwaBinanceProviderError("provider_product_unavailable", products.availability.message ?? "Binance XAUT 双腿产品不可用。");
    }
    const [
      access,
      spotAccountValue,
      futuresAccountValue,
      positionModeValue,
      spotFeeValue,
      futuresFeeValue,
      positionRiskValue,
      spotOrdersValue,
      futuresOrdersValue,
      spotBookValue,
      futuresBookValue,
      premiumValue,
      fundingInfoValue,
      spotDepthValue,
      futuresDepthValue,
    ] = await Promise.all([
      this.validateAccess(),
      this.signedRequest("spot", "/api/v3/account"),
      this.signedRequest("futures", "/fapi/v2/account"),
      this.signedRequest("futures", "/fapi/v1/positionSide/dual"),
      this.signedRequest("spot", "/sapi/v1/asset/tradeFee", { symbol: RWA_BINANCE_SPOT_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/commissionRate", { symbol: RWA_BINANCE_PERPETUAL_SYMBOL }),
      this.signedRequest("futures", "/fapi/v2/positionRisk", { symbol: RWA_BINANCE_PERPETUAL_SYMBOL }),
      this.signedRequest("spot", "/api/v3/openOrders", { symbol: RWA_BINANCE_SPOT_SYMBOL }),
      this.signedRequest("futures", "/fapi/v1/openOrders", { symbol: RWA_BINANCE_PERPETUAL_SYMBOL }),
      this.publicRequest("spot", "/api/v3/ticker/bookTicker", { symbol: RWA_BINANCE_SPOT_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/ticker/bookTicker", { symbol: RWA_BINANCE_PERPETUAL_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/premiumIndex", { symbol: RWA_BINANCE_PERPETUAL_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/fundingInfo"),
      this.publicRequest("spot", "/api/v3/depth", { symbol: RWA_BINANCE_SPOT_SYMBOL, limit: "20" }),
      this.publicRequest("futures", "/fapi/v1/depth", { symbol: RWA_BINANCE_PERPETUAL_SYMBOL, limit: "20" }),
    ]);
    const spotAccount = record(spotAccountValue);
    const futuresAccount = record(futuresAccountValue);
    const positionMode = record(positionModeValue);
    const spotBook = record(spotBookValue);
    const futuresBook = record(futuresBookValue);
    const premium = record(premiumValue);
    const position = list(positionRiskValue)
      .map(record)
      .find((item) => item.symbol === RWA_BINANCE_PERPETUAL_SYMBOL && Math.abs(number(item.positionAmt)) > 0);
    const spotBalances = list(spotAccount.balances).map(record);
    const usdt = spotBalances.find((item) => item.asset === "USDT");
    const xaut = spotBalances.find((item) => item.asset === "XAUT");
    const futuresUsdt = list(futuresAccount.assets).map(record).find((item) => item.asset === "USDT");
    const fundingInfo = list(fundingInfoValue).map(record).find((item) => item.symbol === RWA_BINANCE_PERPETUAL_SYMBOL);
    const spotBid = positiveNumber(spotBook.bidPrice);
    const spotAsk = positiveNumber(spotBook.askPrice);
    const perpetualBid = positiveNumber(futuresBook.bidPrice);
    const perpetualAsk = positiveNumber(futuresBook.askPrice);
    const mark = positiveNumber(premium.markPrice);
    const liquidationPrice = positiveNumberOrNull(position?.liquidationPrice);
    const liquidationDistancePercent = liquidationPrice && mark
      ? Math.abs(mark - liquidationPrice) / mark * 100
      : null;
    const dualSidePosition = boolean(positionMode.dualSidePosition);
    const multiAssetsMargin = boolean(futuresAccount.multiAssetsMargin);
    const accountMode: RwaBinanceAccountIdentity["accountMode"] = multiAssetsMargin
      ? dualSidePosition ? "multi_assets_hedge" : "multi_assets_one_way"
      : dualSidePosition ? "single_asset_hedge" : "single_asset_one_way";
    return {
      accountId: access.accountId,
      accountFingerprint: access.accountFingerprint,
      fetchedAt: this.now(),
      accountMode,
      permissions: { ...access.permissions, positionModeSupported: !dualSidePosition },
      productAvailability: products.availability,
      spotAvailableUsdt: positiveNumber(usdt?.free),
      futuresAvailableUsdt: positiveNumber(futuresUsdt?.availableBalance ?? futuresAccount.availableBalance),
      existingSpotQuantityXaut: number(xaut?.free) + number(xaut?.locked),
      existingPerpetualQuantityXaut: Math.abs(number(position?.positionAmt)),
      openSpotOrderCount: list(spotOrdersValue).length,
      openPerpetualOrderCount: list(futuresOrdersValue).length,
      spot: {
        ...products.spot,
        bid: spotBid,
        ask: spotAsk,
        depthUsd: depthUsd(spotDepthValue),
      },
      perpetual: {
        ...products.perpetual,
        bid: perpetualBid,
        ask: perpetualAsk,
        depthUsd: depthUsd(futuresDepthValue),
        mark,
        fundingRate: number(premium.lastFundingRate),
        fundingIntervalHours: positiveNumber(fundingInfo?.fundingIntervalHours) || 8,
        nextFundingTime: nullableTimestamp(premium.nextFundingTime),
        liquidationDistancePercent,
      },
      fees: {
        spotTakerBps: number(record(list(spotFeeValue)[0]).takerCommission) * 10_000,
        perpetualTakerBps: number(record(futuresFeeValue).takerCommissionRate) * 10_000,
      },
    };
  }

  private async loadProducts() {
    const cached = this.productCache;
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.productInFlight) return this.productInFlight;
    const request = this.fetchProducts().then((value) => {
      this.productCache = { value, expiresAt: this.now() + RWA_BINANCE_PRODUCT_CACHE_TTL_MS };
      return value;
    }).finally(() => {
      if (this.productInFlight === request) this.productInFlight = null;
    });
    this.productInFlight = request;
    return request;
  }

  private async fetchProducts(): Promise<ProductCache> {
    const [spotValue, futuresValue] = await Promise.all([
      this.publicRequest("spot", "/api/v3/exchangeInfo", { symbol: RWA_BINANCE_SPOT_SYMBOL }),
      this.publicRequest("futures", "/fapi/v1/exchangeInfo"),
    ]);
    const spotRow = list(record(spotValue).symbols).map(record)
      .find((item) => item.symbol === RWA_BINANCE_SPOT_SYMBOL && item.baseAsset === "XAUT" && item.quoteAsset === "USDT");
    const perpetualRow = list(record(futuresValue).symbols).map(record)
      .find((item) => item.symbol === RWA_BINANCE_PERPETUAL_SYMBOL && item.baseAsset === "XAUT"
        && item.quoteAsset === "USDT" && item.contractType === "PERPETUAL");
    const status = spotRow && perpetualRow
      ? "available"
      : spotRow ? "perpetual_unavailable" : perpetualRow ? "spot_unavailable" : "both_unavailable";
    const checkedAt = this.now();
    return {
      availability: {
        available: status === "available",
        status,
        spotSymbol: RWA_BINANCE_SPOT_SYMBOL,
        perpetualSymbol: RWA_BINANCE_PERPETUAL_SYMBOL,
        checkedAt,
        message: status === "available"
          ? null
          : status === "spot_unavailable"
            ? "Binance Mainnet 当前没有可用的 XAUTUSDT 现货产品。"
            : status === "perpetual_unavailable"
              ? "Binance Mainnet 当前没有可用的 XAUTUSDT USD-M 永续产品。"
              : "Binance Mainnet 当前没有可组成 XAUT 同所中性的现货与 USD-M 永续产品。",
      },
      spot: spotRow ? spotSpec(spotRow) : unavailableSpec(),
      perpetual: perpetualRow ? perpetualSpec(perpetualRow) : unavailableSpec(),
    };
  }

  private async signedRequest(
    scope: "spot" | "futures",
    path: string,
    params: Record<string, string> = {},
    allowTimestampRetry = true,
  ): Promise<unknown> {
    const offset = await this.serverTimeOffset();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params).sort(([left], [right]) => left.localeCompare(right))) query.set(key, value);
    query.set("recvWindow", receiveWindow);
    query.set("timestamp", String(this.now() + offset));
    const signature = createHmac("sha256", this.credentials.apiSecret).update(query.toString()).digest("hex");
    query.set("signature", signature);
    const url = new URL(path, scope === "spot" ? spotBaseUrl : futuresBaseUrl);
    url.search = query.toString();
    try {
      return await this.parseResponse(await this.fetchFn(url, {
        headers: { Accept: "application/json", "X-MBX-APIKEY": this.credentials.apiKey },
        signal: AbortSignal.timeout(5_000),
      }));
    } catch (error) {
      if (allowTimestampRetry && error instanceof RwaBinanceProviderError && error.providerCode === -1021) {
        this.timeOffset = null;
        return this.signedRequest(scope, path, params, false);
      }
      throw error;
    }
  }

  private async serverTimeOffset() {
    if (this.timeOffset && this.timeOffset.expiresAt > this.now()) return this.timeOffset.value;
    const before = this.now();
    const payload = record(await this.publicRequest("spot", "/api/v3/time"));
    const after = this.now();
    const serverTime = number(payload.serverTime);
    if (!serverTime) throw new RwaBinanceProviderError("provider_time_unavailable", "Binance 未返回有效服务端时间。");
    const value = serverTime - Math.floor((before + after) / 2);
    this.timeOffset = { value, expiresAt: after + timeOffsetTtlMs };
    return value;
  }

  private async publicRequest(scope: "spot" | "futures", path: string, params: Record<string, string> = {}) {
    const url = new URL(path, scope === "spot" ? spotBaseUrl : futuresBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.parseResponse(await this.fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }));
  }

  private async parseResponse(response: Response) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RwaBinanceProviderError("provider_invalid_response", "Binance 返回了无法解析的响应。");
    }
    const root = record(payload);
    const code = Number(root.code ?? response.status);
    if (response.ok && !(Number.isFinite(code) && code < 0)) return payload;
    const category = response.status === 429 || code === -1003
      ? "provider_rate_limited"
      : code === -1021
        ? "provider_timestamp_error"
        : [-2014, -2015].includes(code)
          ? "provider_credential_invalid"
          : [-2010, -2011, -2018, -2019].includes(code)
            ? "provider_rejected"
            : response.status === 401 || response.status === 403
              ? "provider_permission_error"
              : "provider_unavailable";
    throw new RwaBinanceProviderError(category, `Binance 请求失败（code=${Number.isFinite(code) ? code : "unknown"}）。`, code);
  }
}

export class RwaBinanceProviderError extends Error {
  constructor(readonly category: string, message: string, readonly providerCode: number | null = null) {
    super(message);
  }
}

function spotSpec(row: Record<string, unknown>): RwaInstrumentSpec {
  const filters = filterMap(row.filters);
  return {
    status: row.status === "TRADING" && boolean(row.isSpotTradingAllowed) ? "Trading" : row.status === "BREAK" ? "Paused" : "Unknown",
    minOrderQty: positiveNumber(filters.LOT_SIZE?.minQty),
    qtyStep: positiveNumber(filters.LOT_SIZE?.stepSize),
    minNotionalUsd: positiveNumber(filters.NOTIONAL?.minNotional ?? filters.MIN_NOTIONAL?.minNotional),
    priceTick: positiveNumber(filters.PRICE_FILTER?.tickSize),
  };
}

function perpetualSpec(row: Record<string, unknown>): RwaInstrumentSpec {
  const filters = filterMap(row.filters);
  return {
    status: row.status === "TRADING" && row.contractType === "PERPETUAL" ? "Trading" : row.status === "PENDING_TRADING" ? "Paused" : "Unknown",
    minOrderQty: positiveNumber(filters.LOT_SIZE?.minQty),
    qtyStep: positiveNumber(filters.LOT_SIZE?.stepSize),
    minNotionalUsd: positiveNumber(filters.MIN_NOTIONAL?.notional),
    priceTick: positiveNumber(filters.PRICE_FILTER?.tickSize),
  };
}

function unavailableSpec(): RwaInstrumentSpec {
  return { status: "Unknown", minOrderQty: 0, qtyStep: 0, minNotionalUsd: 0, priceTick: 0 };
}

function filterMap(value: unknown) {
  return Object.fromEntries(list(value).map(record).map((item) => [String(item.filterType ?? ""), item])) as Record<string, Record<string, unknown>>;
}

function depthUsd(value: unknown) {
  const root = record(value);
  const side = (rows: unknown) => list(rows).reduce<number>((sum, level) => {
    const [price, quantity] = Array.isArray(level) ? level : [];
    return sum + positiveNumber(price) * positiveNumber(quantity);
  }, 0);
  return Math.min(side(root.bids), side(root.asks));
}

function nullableTimestamp(value: unknown) {
  const parsed = number(value);
  return parsed > 0 ? parsed : null;
}

function positiveNumberOrNull(value: unknown) {
  const parsed = positiveNumber(value);
  return parsed || null;
}

function positiveNumber(value: unknown) {
  const parsed = number(value);
  return parsed > 0 ? parsed : 0;
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
