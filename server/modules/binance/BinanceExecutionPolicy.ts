// Venue-local tolerance used when deriving the funding cycle residual.
export const BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY = 0.00001;

export type BinanceExecutionPriceMode = "IOC_LIMIT" | "MARKET";
export type BinanceUserExecutionMode = "PRICE_PRIORITY" | "EXECUTION_PRIORITY";

export function parseBinanceExecutionPriceMode(value: unknown): BinanceExecutionPriceMode {
  if (value !== "IOC_LIMIT" && value !== "MARKET") {
    throw new Error("executionPriceMode must be IOC_LIMIT or MARKET.");
  }
  return value;
}

export function toBinanceExecutionPriceMode(
  value: BinanceUserExecutionMode,
): BinanceExecutionPriceMode {
  return value === "PRICE_PRIORITY" ? "IOC_LIMIT" : "MARKET";
}
