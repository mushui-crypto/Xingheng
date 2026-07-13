import type { RealMarketSummary, RealPosition } from "../../../api/realTrading";

export async function enrichPositionMarks(
  positions: RealPosition[],
  fetchSummary: (symbol: string) => Promise<RealMarketSummary>,
) {
  const missingSymbols = Array.from(new Set(
    positions
      .filter((position) => !hasValidMark(position))
      .map((position) => position.symbol?.trim())
      .filter((symbol): symbol is string => Boolean(symbol)),
  ));

  const resolvedMarks = new Map<string, number>();
  await Promise.all(missingSymbols.map(async (symbol) => {
    try {
      const summary = await fetchSummary(symbol);
      if (isValidPrice(summary.markPrice)) resolvedMarks.set(symbol, summary.markPrice);
    } catch {
      // A single market summary failure must not hide the remaining account state.
    }
  }));

  return positions.map((position) => {
    if (hasValidMark(position) || !position.symbol) return position;
    const markPrice = resolvedMarks.get(position.symbol.trim());
    return isValidPrice(markPrice) ? { ...position, markPrice, markPx: markPrice } : position;
  });
}

function hasValidMark(position: RealPosition) {
  return isValidPrice(position.markPx) || isValidPrice(position.markPrice);
}

function isValidPrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
