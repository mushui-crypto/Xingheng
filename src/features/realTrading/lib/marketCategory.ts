import type { SymbolCategory } from "../../../types/market";

const metalMarkets = new Set(["GOLD", "SILVER", "PLATINUM", "PALLADIUM"]);
const indexMarkets = new Set(["IDX0", "JP225", "KR200", "SP500", "US500", "USTECH", "XYZ100"]);

export function resolveRealTradingCategory(
  providerMarketId: string | undefined,
  category?: SymbolCategory,
): SymbolCategory {
  if (category) return category;
  const marketId = String(providerMarketId ?? "").trim();
  if (!marketId.includes(":")) return "crypto";
  const providerCoin = marketId.split(":").at(-1)?.toUpperCase() ?? "";
  if (metalMarkets.has(providerCoin)) return "metals";
  if (indexMarkets.has(providerCoin)) return "indices";
  return "other";
}
