export function getRealTradingDisplayPriceDecimals(pxDecimals: unknown, fallback = 2) {
  if (Number.isSafeInteger(pxDecimals) && Number(pxDecimals) >= 0) return Number(pxDecimals);
  return fallback;
}
