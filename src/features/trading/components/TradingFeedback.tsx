import { formatPrice } from "../../../utils/price";

export function Toast({ message }: { message: string }) {
  return (
    <div className={`xh-toast ${message ? "is-visible" : ""}`} aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

export function Quote({ label, value, digits }: { label: string; value?: number; digits: number }) {
  return (
    <div className="border border-line bg-black p-3">
      <p className="text-xs uppercase text-muted">{label}</p>
      <p className="mt-2 text-lg font-semibold">{formatPrice(value, digits)}</p>
    </div>
  );
}
