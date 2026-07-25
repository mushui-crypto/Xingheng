import type { RwaInstrumentSpec } from "./RwaNeutralExecutionTypes";

export class RwaAutomationMinimumOrderError extends Error {
  readonly category = "automation_order_sizing_invalid";
}

export function calculateMinimumCommonBaseQuantity(input: {
  spot: RwaInstrumentSpec & { ask: number };
  perpetual: RwaInstrumentSpec & { bid: number };
}) {
  const values = [
    input.spot.ask,
    input.perpetual.bid,
    input.spot.qtyStep,
    input.perpetual.qtyStep,
    input.spot.minOrderQty,
    input.perpetual.minOrderQty,
    input.spot.minNotionalUsd,
    input.perpetual.minNotionalUsd,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0)
    || input.spot.ask <= 0
    || input.perpetual.bid <= 0
    || input.spot.qtyStep <= 0
    || input.perpetual.qtyStep <= 0
  ) throw invalidMinimumOrder();
  const step = commonStep(input.spot.qtyStep, input.perpetual.qtyStep);
  const rawMinimum = Math.max(
    input.spot.minOrderQty,
    input.perpetual.minOrderQty,
    input.spot.minNotionalUsd / input.spot.ask,
    input.perpetual.minNotionalUsd / input.perpetual.bid,
  );
  const quantity = Math.ceil((rawMinimum - 1e-12) / step) * step;
  if (
    !Number.isFinite(quantity)
    || quantity <= 0
    || quantity * input.spot.ask + 1e-9 < input.spot.minNotionalUsd
    || quantity * input.perpetual.bid + 1e-9 < input.perpetual.minNotionalUsd
  ) throw invalidMinimumOrder();
  return { quantity, commonStep: step };
}

function commonStep(left: number, right: number) {
  const scale = 10 ** Math.max(decimalPlaces(left), decimalPlaces(right));
  const leftInteger = Math.round(left * scale);
  const rightInteger = Math.round(right * scale);
  if (
    !Number.isSafeInteger(leftInteger)
    || !Number.isSafeInteger(rightInteger)
    || leftInteger <= 0
    || rightInteger <= 0
    || Math.abs(leftInteger / scale - left) > 1e-12
    || Math.abs(rightInteger / scale - right) > 1e-12
  ) throw invalidMinimumOrder();
  const multiple = leftInteger / gcd(leftInteger, rightInteger) * rightInteger;
  if (!Number.isSafeInteger(multiple)) throw invalidMinimumOrder();
  return multiple / scale;
}

function decimalPlaces(value: number) {
  const text = value.toString().toLowerCase();
  if (!text.includes("e")) return text.split(".")[1]?.length ?? 0;
  const [coefficient, exponentText] = text.split("e");
  return Math.max(0, (coefficient!.split(".")[1]?.length ?? 0) - Number(exponentText));
}

function gcd(left: number, right: number) {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function invalidMinimumOrder() {
  return new RwaAutomationMinimumOrderError(
    "交易所数量、价格或最小金额规则无法形成有限且可执行的共同数量。",
  );
}
