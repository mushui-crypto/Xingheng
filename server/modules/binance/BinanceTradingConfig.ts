export type BinanceTradingConfig = {
  liveTradingEnabled: boolean;
  killSwitchActive: boolean;
  maxOrderUsd: number;
  maxPositionUsd: number;
  maxEntryBasisBps: number;
  minNetAprPercent: number;
  maxSlippageBps: number;
  orderTimeoutMs: number;
  processingTimeoutMs: number;
  allowUntradeableSpotDustEntry: boolean;
  gitCommit: string;
};

export function loadBinanceTradingConfig(source: NodeJS.ProcessEnv = process.env): BinanceTradingConfig {
  const maxOrderUsd = positiveNumber(source.MAX_ORDER_USD, 25, "MAX_ORDER_USD");
  const maxPositionUsd = positiveNumber(source.MAX_POSITION_USD, 100, "MAX_POSITION_USD");
  if (maxOrderUsd > maxPositionUsd) {
    throw new Error("MAX_ORDER_USD must not exceed MAX_POSITION_USD.");
  }
  return {
    liveTradingEnabled: source.LIVE_TRADING_ENABLED === "true",
    killSwitchActive: source.BINANCE_KILL_SWITCH !== "false",
    maxOrderUsd,
    maxPositionUsd,
    maxEntryBasisBps: positiveNumber(source.BINANCE_MAX_ENTRY_BASIS_BPS, 30, "BINANCE_MAX_ENTRY_BASIS_BPS"),
    minNetAprPercent: positiveNumber(source.BINANCE_MIN_NET_APR_PERCENT, 8, "BINANCE_MIN_NET_APR_PERCENT"),
    maxSlippageBps: positiveNumber(source.BINANCE_MAX_SLIPPAGE_BPS, 20, "BINANCE_MAX_SLIPPAGE_BPS"),
    orderTimeoutMs: positiveInteger(source.BINANCE_ORDER_TIMEOUT_MS, 10_000, "BINANCE_ORDER_TIMEOUT_MS"),
    processingTimeoutMs: positiveInteger(source.BINANCE_PROCESSING_TIMEOUT_MS, 60_000, "BINANCE_PROCESSING_TIMEOUT_MS"),
    allowUntradeableSpotDustEntry: source.BINANCE_ALLOW_UNTRADEABLE_SPOT_DUST_ENTRY === "true",
    gitCommit: normalizeGitCommit(source.GIT_COMMIT),
  };
}

function positiveNumber(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function normalizeGitCommit(value: string | undefined) {
  const commit = value?.trim() ?? "";
  if (!commit) return "development";
  if (!/^[a-f0-9]{7,40}$/u.test(commit)) throw new Error("GIT_COMMIT must be a lowercase Git commit hash.");
  return commit;
}
