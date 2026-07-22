import { memo, useSyncExternalStore } from "react";
import { fundingClock } from "../lib/fundingClock";
import { formatFundingCountdown } from "../lib/formatters";

export const FundingCountdown = memo(function FundingCountdown({ nextFundingTime }: { nextFundingTime: number | null }) {
  const now = useSyncExternalStore(fundingClock.subscribe, fundingClock.getSnapshot, fundingClock.getSnapshot);
  const label = formatFundingCountdown(nextFundingTime, now);
  return (
    <span className="inline-block min-w-[16ch] whitespace-nowrap font-mono tabular-nums text-dim" aria-label={label} aria-live="off">
      {label}
    </span>
  );
});
