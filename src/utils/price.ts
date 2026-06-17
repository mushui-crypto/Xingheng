export function roundByDigits(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function calculateBidAsk(last: number, spread: number, digits: number) {
  return {
    bid: roundByDigits(last - spread / 2, digits),
    ask: roundByDigits(last + spread / 2, digits),
  };
}

export function formatPrice(value: number | undefined, digits: number) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}
