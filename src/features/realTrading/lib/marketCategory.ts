import type { MarketSourceType, SymbolCategory } from "../../../types/market";

export function resolveRealTradingCategory(
  providerMarketId: string | undefined,
  category?: SymbolCategory,
  sourceType?: MarketSourceType,
): SymbolCategory {
  if (category) return category;
  if (sourceType) return sourceType === "main" ? "crypto" : "other";
  return String(providerMarketId ?? "").includes(":") ? "other" : "crypto";
}
