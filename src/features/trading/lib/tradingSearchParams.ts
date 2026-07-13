export function mergeTradingSearchParams(
  current: URLSearchParams,
  symbol: string,
  simulationAccountId: string,
) {
  const next = new URLSearchParams(current);
  next.set("symbol", symbol);
  if (simulationAccountId) next.set("simulationAccountId", simulationAccountId);
  else next.delete("simulationAccountId");
  return next;
}
