import type { RealTradingSymbol } from "../../../api/realTrading";
import type { MarketSourceType, TradeStatus } from "../../../types/market";

type RealTradingMarketRecord = {
  assetId?: number;
  coin?: string;
  providerCoin?: string;
  providerMarketId?: string;
  sourceDex?: string;
  symbol?: string;
};

const enabledStatuses = new Set(["active", "enabled", "live", "trading"]);
const disabledStatuses = new Set(["delisted", "disabled", "inactive", "paused"]);

export function resolveRealTradeStatus(symbol: RealTradingSymbol): TradeStatus {
  if (symbol.tradeStatus) return symbol.tradeStatus;
  const status = String(symbol.status ?? "").trim().toLowerCase();
  if (status === "close_only") return "close_only";
  if (disabledStatuses.has(status)) return "disabled";
  if (!status || enabledStatuses.has(status)) return "enabled";
  return "disabled";
}

export function resolveRealTradingSourceType(symbol: RealTradingSymbol): MarketSourceType {
  if (symbol.sourceType) return symbol.sourceType;
  if (symbol.sourceDex && symbol.sourceDex !== "main") return "hip3";
  return symbol.providerMarketId?.includes(":") ? "hip3" : "main";
}

export function resolveRealTradingSourceDex(symbol: RealTradingSymbol): string {
  if (symbol.sourceDex) return symbol.sourceDex;
  if (resolveRealTradingSourceType(symbol) === "main") return "main";
  return symbol.providerMarketId?.split(":", 1)[0] || "hip3";
}

export function getMarketBlockReason(symbol: RealTradingSymbol): string | null {
  if (typeof symbol.assetId !== "number" || !Number.isFinite(symbol.assetId)) {
    return "该市场缺少 Hyperliquid 资产映射，暂不可交易。";
  }
  if (resolveRealTradeStatus(symbol) === "disabled") {
    return String(symbol.status ?? "").toLowerCase() === "delisted"
      ? "该市场已下架，暂不可提交订单。"
      : "该市场已暂停，暂不可提交订单。";
  }
  return null;
}

export function resolveRealTradingSymbolForRecord(
  record: RealTradingMarketRecord,
  symbols: RealTradingSymbol[],
): RealTradingSymbol | null {
  const internalSymbol = normalize(record.symbol);
  if (internalSymbol) {
    const match = symbols.find((item) => normalize(item.symbol) === internalSymbol);
    if (match) return match;
  }

  const providerMarketId = normalize(record.providerMarketId);
  if (providerMarketId) {
    const match = symbols.find((item) => normalize(item.providerMarketId) === providerMarketId);
    if (match) return match;
  }

  if (typeof record.assetId === "number" && Number.isFinite(record.assetId)) {
    const match = symbols.find((item) => item.assetId === record.assetId);
    if (match) return match;
  }

  const providerCoin = normalize(record.providerCoin ?? record.coin);
  if (!providerCoin) return null;
  const compatibleMatches = symbols.filter((item) => normalize(item.providerCoin) === providerCoin);
  return compatibleMatches.length === 1 ? compatibleMatches[0] : null;
}

export function recordBelongsToMarket(
  record: RealTradingMarketRecord,
  symbol: RealTradingSymbol,
  symbols: RealTradingSymbol[],
) {
  return resolveRealTradingSymbolForRecord(record, symbols)?.symbol === symbol.symbol;
}

export function resolveRealTradingNavigationSymbol(
  record: RealTradingMarketRecord,
  symbols: RealTradingSymbol[],
) {
  return resolveRealTradingSymbolForRecord(record, symbols)?.symbol ?? null;
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}
