import { Copy } from "lucide-react";
import { Link } from "react-router-dom";
import type { MouseEvent, ReactNode } from "react";
import type { SimulationAccountView } from "../../../api/walletApi";
import {
  formatMoney,
  formatSignedMoney,
  getSignedToneClass,
  shortenWalletAddress,
} from "../lib/accountUtils";
import { SectionHeader } from "./AccountDisplayPrimitives";

export function OverviewPanelHeader({ actions, title }: { actions?: ReactNode; title: string }) {
  return (
    <div className="xh-overview-panel-header">
      <SectionHeader title={title} />
      {actions ? <div className="xh-overview-actions">{actions}</div> : null}
    </div>
  );
}

export function OverviewInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="xh-overview-info">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function OverviewActionButton({ disabled = false, label, onClick }: { disabled?: boolean; label: string; onClick?: () => void }) {
  return (
    <button className="xh-overview-action" disabled={disabled} type="button" onClick={onClick}>
      {label}
    </button>
  );
}

export function OverviewAssetMetric({
  asset,
  changeLabel = "今日盈亏",
  pnl,
  pnlText,
  value,
}: {
  asset: string;
  changeLabel?: string;
  pnl?: number;
  pnlText?: string;
  value: number;
}) {
  return (
    <div className="xh-overview-metric">
      <p className="xh-overview-metric-value">{formatMoney(value, asset)}</p>
      <p className="xh-overview-pnl">
        <span>{changeLabel}</span>
        <span className={getSignedToneClass(pnl ?? 0)}>{pnlText ?? formatSignedMoney(pnl ?? 0, asset)}</span>
      </p>
    </div>
  );
}

export function WalletAddressLine({ address, full = false, onCopyAddress }: { address: string; full?: boolean; onCopyAddress?: () => void }) {
  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (onCopyAddress) {
      onCopyAddress();
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // 复制失败不影响地址展示；用户仍可手动选择完整地址。
    }
  };

  return (
    <span className="xh-wallet-address-line">
      <span className={`xh-wallet-address-text ${full ? "is-full" : ""}`} title={address}>
        {full ? address : shortenWalletAddress(address)}
      </span>
      <button aria-label="复制钱包地址" className="xh-wallet-copy-icon" type="button" onClick={(event) => void handleCopy(event)}>
        <Copy size={13} strokeWidth={1.8} />
      </button>
    </span>
  );
}

export function FundingInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="xh-funding-info">
      <p>{label}</p>
      <span>{value}</span>
    </div>
  );
}

export function BoundaryTile({ title, description }: { title: string; description: string }) {
  return (
    <div className="xh-trading-boundary-tile">
      <p>{title}</p>
      <strong>—</strong>
      <span>{description}</span>
    </div>
  );
}

export function SimulationUsageBadge({ isCurrent, status }: { isCurrent: boolean; status?: SimulationAccountView["status"] }) {
  if (status === "disabled") {
    return <span className="xh-simulation-usage-badge is-disabled">已禁用</span>;
  }
  if (status === "deleted") {
    return <span className="xh-simulation-usage-badge is-disabled">已删除</span>;
  }
  return <span className={`xh-simulation-usage-badge ${isCurrent ? "is-current" : "is-idle"}`}>{isCurrent ? "使用中" : "未使用"}</span>;
}

export function SimulationActionButton({
  asLink = false,
  disabled = false,
  label,
  onClick,
  to,
}: {
  asLink?: boolean;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  to?: string;
}) {
  if (asLink && to) {
    return (
      <Link className="xh-simulation-action-button" to={to} onClick={onClick}>
        {label}
      </Link>
    );
  }

  return (
    <button className="xh-simulation-action-button" type="button" onClick={onClick} disabled={disabled || !onClick} title={disabled ? "暂不可用" : undefined}>
      {label}
    </button>
  );
}

export function SimulationInfo({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="xh-simulation-info">
      <p>{label}</p>
      <span>{value}</span>
    </div>
  );
}
