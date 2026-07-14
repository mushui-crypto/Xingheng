export function assertValidHyperliquidSizeDecimals(szDecimals: unknown, symbol = "当前品种") {
  if (!Number.isSafeInteger(szDecimals) || Number(szDecimals) < 0) {
    throw new Error(`${symbol} 缺少有效的 Hyperliquid 数量精度，禁止提交真实交易。`);
  }
  return Number(szDecimals);
}

export function getHyperliquidSizeInputStep(szDecimals: unknown) {
  if (!Number.isSafeInteger(szDecimals) || Number(szDecimals) < 0) return "any";
  const decimals = Number(szDecimals);
  if (decimals === 0) return "1";
  return `0.${"0".repeat(Math.max(0, decimals - 1))}1`;
}

export function formatHyperliquidOrderSizeFloor(value: number, szDecimals: unknown, symbol = "当前品种") {
  const decimals = assertValidHyperliquidSizeDecimals(szDecimals, symbol);
  if (!Number.isFinite(value) || value <= 0) return "";
  const factor = 10 ** decimals;
  const floored = Math.floor(value * factor) / factor;
  if (!Number.isFinite(floored) || floored <= 0) return "";
  const fixed = floored.toFixed(decimals);
  return trimDecimalZeros(fixed);
}

export function normalizeHyperliquidOrderSizeInput(input: string, szDecimals: unknown, symbol = "当前品种") {
  const decimals = assertValidHyperliquidSizeDecimals(szDecimals, symbol);
  const value = input.trim();
  if (!value) throw new Error("请输入有效的数量。");
  if (!/^(?:\d+|\d+\.\d+|\.\d+)$/.test(value)) {
    throw new Error("请输入有效的数量。");
  }

  const [rawInteger, rawFraction = ""] = value.startsWith(".") ? ["0", value.slice(1)] : value.split(".");
  if (rawFraction.length > decimals) {
    throw new Error(`${symbol} 数量最多允许 ${decimals} 位小数。`);
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error("请输入大于 0 的数量。");
  }

  const integer = (rawInteger || "0").replace(/^0+(?=\d)/, "") || "0";
  if (decimals === 0) return integer;
  return rawFraction ? trimDecimalZeros(`${integer}.${rawFraction}`) : integer;
}

export function trimDecimalZeros(value: string) {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
