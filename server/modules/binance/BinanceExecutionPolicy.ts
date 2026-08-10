export const BINANCE_MAX_UNHEDGED_DURATION_MS = 5_000;

// Binance Personal Trading currently supports only the XAUT hedge. This venue-local
// tolerance prevents exchange quantity precision from turning confirmed dust into
// a failed hedge without changing the shared execution Intent model.
export const BINANCE_XAUT_STRATEGY_MAX_RESIDUAL_QUANTITY = 0.00001;
export const BINANCE_EXISTING_EXPOSURE_RISK_ACKNOWLEDGEMENT =
  "ALLOW_ENTRY_AND_TOTAL_XAUT_RECOVERY" as const;

export type BinanceExecutionPriceMode = "IOC_LIMIT" | "MARKET";
export type BinanceUserExecutionMode = "PRICE_PRIORITY" | "EXECUTION_PRIORITY";

export function parseBinanceExecutionPriceMode(value: unknown): BinanceExecutionPriceMode {
  if (value !== "IOC_LIMIT" && value !== "MARKET") {
    throw new Error("executionPriceMode must be IOC_LIMIT or MARKET.");
  }
  return value;
}

export function parseBinanceUserExecutionMode(value: unknown): BinanceUserExecutionMode {
  if (value !== "PRICE_PRIORITY" && value !== "EXECUTION_PRIORITY") {
    throw new Error("executionMode must be PRICE_PRIORITY or EXECUTION_PRIORITY.");
  }
  return value;
}

export function toBinanceExecutionPriceMode(
  value: BinanceUserExecutionMode,
): BinanceExecutionPriceMode {
  return value === "PRICE_PRIORITY" ? "IOC_LIMIT" : "MARKET";
}
