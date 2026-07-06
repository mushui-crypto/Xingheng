export function normalizeQuantity(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(12));
}

export function formatQuantity(value: number | null | undefined, step?: number) {
  if (!Number.isFinite(value)) return "-";
  const normalizedValue = normalizeQuantity(value ?? 0);
  const normalizedStep = step && Number.isFinite(step) && step > 0 ? normalizeQuantity(step) : undefined;
  const decimals = normalizedStep ? getDecimalPlaces(normalizedStep) : Math.min(8, getDecimalPlaces(normalizedValue));
  return normalizedValue.toFixed(decimals).replace(/\.?0+$/, "");
}

function getDecimalPlaces(value: number) {
  const text = normalizeQuantity(value).toString();
  if (!text.includes(".")) return 0;
  return text.split(".")[1]?.length ?? 0;
}
