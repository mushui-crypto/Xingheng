export function TradeStat({ label, tone, value }: { label: string; tone?: "positive" | "negative"; value: string }) {
  return (
    <div className={`xh-trade-stat ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
