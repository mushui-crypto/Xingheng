export function TradeStat({ actionLabel, label, onAction, tone, value }: {
  actionLabel?: string;
  label: string;
  onAction?: () => void;
  tone?: "positive" | "negative";
  value: string;
}) {
  return (
    <div className={`xh-trade-stat ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      {onAction ? (
        <button aria-label={actionLabel ?? value} className="xh-trade-stat-action" onClick={onAction} type="button">{value}</button>
      ) : <strong>{value}</strong>}
    </div>
  );
}
