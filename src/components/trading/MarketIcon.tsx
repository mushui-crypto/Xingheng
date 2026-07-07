import { useEffect, useState } from "react";

type MarketIconProps = {
  iconUrl?: string | null;
  fallback: string;
  className: string;
};

export function MarketIcon({ iconUrl, fallback, className }: MarketIconProps) {
  const [failed, setFailed] = useState(false);
  const initial = fallback.trim().slice(0, 1).toUpperCase() || "?";

  useEffect(() => {
    setFailed(false);
  }, [iconUrl]);

  if (iconUrl && !failed) {
    return (
      <span className={`${className} is-image`} aria-hidden="true">
        <img className="xh-market-icon-image" src={iconUrl} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }

  return (
    <span className={className} aria-hidden="true">
      {initial}
    </span>
  );
}
