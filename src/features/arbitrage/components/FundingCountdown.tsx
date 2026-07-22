import { useEffect, useState } from "react";
import { formatFundingCountdown } from "../lib/formatters";

export function useFundingClock() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}

export function FundingCountdown({ nextFundingTime, now }: { nextFundingTime: number | null; now: number }) {
  const label = formatFundingCountdown(nextFundingTime, now);
  return (
    <span className="inline-block min-w-[16ch] whitespace-nowrap font-mono tabular-nums text-dim" aria-label={label} aria-live="off">
      {label}
    </span>
  );
}
