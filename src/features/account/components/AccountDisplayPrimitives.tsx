import { Copy, Globe2 } from "lucide-react";
import type { ReactNode } from "react";
import type { OnchainRecord } from "../../../api/walletApi";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import {
  formatNumber,
  formatStatus,
  shortenChainAddress,
  shortenHash,
} from "../lib/accountUtils";
import { tokenIconSrc } from "../model/constants";

export function RecordPanel({
  children,
  className = "",
  filters,
  title,
}: {
  children: ReactNode;
  className?: string;
  filters?: ReactNode;
  title: string;
}) {
  return (
    <section className={`xh-record-panel ${className}`}>
      <h2>{title}</h2>
      {filters ? <div className="xh-record-filters">{filters}</div> : null}
      {children}
    </section>
  );
}

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="xh-panel-title">{title}</h2>
      {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

export function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 break-all font-medium text-white">{value}</dd>
    </div>
  );
}

export function InfoTile({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border border-white/10 bg-white/[0.025] p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-2 break-all text-sm font-medium text-white ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

export function TokenSummary({ asset, description }: { asset: string; description?: string }) {
  return (
    <div className="flex items-center gap-3 border border-white/10 bg-white/[0.03] px-4 py-3">
      <img src={tokenIconSrc} alt={`${asset} token icon`} className="h-10 w-10 object-contain" />
      <div>
        <p className="text-sm font-medium text-white">{asset}</p>
        {description ? <p className="text-xs leading-5 text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export function ChainInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 bg-white/[0.025] p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-white">{value}</p>
    </div>
  );
}

export function RecordHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold tracking-[-0.01em] text-white">{title}</h2>
      {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mx-auto max-w-md border border-white/10 bg-white/[0.025] p-5 text-center">
      <p className="font-medium text-white">{title}</p>
      {description ? <p className="mt-2 text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

export function RecordEmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="xh-record-empty-content">
      <p>{title}</p>
      {description ? <span>{description}</span> : null}
    </div>
  );
}

export function InlineState({
  title,
  description,
  tone = "neutral",
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  tone?: "neutral" | "danger";
  actionLabel?: string;
  onAction?: () => void;
}) {
  const toneClass = tone === "danger" ? "border-red-400/40 bg-red-500/10 text-red-100" : "border-white/15 bg-white/[0.03] text-slate-200";
  return (
    <div className={`flex flex-col gap-3 border p-4 md:flex-row md:items-center md:justify-between ${toneClass}`}>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <Button className="md:shrink-0" variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function FlowStep({ title, description }: { title: string; description: string }) {
  return (
    <div className="border border-white/10 bg-white/[0.025] p-3">
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
    </div>
  );
}

export function Metric({ label, value, currency }: { label: string; value?: number; currency: string }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-2xl font-semibold md:text-3xl">
        {formatNumber(value)} <span className="text-sm text-muted">{currency}</span>
      </p>
    </Card>
  );
}

export function MonoText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return (
    <span className="break-all font-mono text-xs text-muted" title={value}>
      {shortenHash(value)}
    </span>
  );
}

export function ChainAddress({
  value,
  ownAddress,
  onCopyAddress,
}: {
  value?: string | null;
  ownAddress?: string | null;
  onCopyAddress: (value: string) => void;
}) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  const isOwnAddress = ownAddress ? value.toLowerCase() === ownAddress.toLowerCase() : false;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${isOwnAddress ? "text-emerald-300" : "text-muted"}`}>
      <span className="font-mono text-xs" title={value}>{shortenChainAddress(value)}</span>
      <a
        aria-label="查看地址链上数据"
        className="inline-flex text-white/80 transition hover:text-white"
        href={`https://testnet.bscscan.com/address/${value}`}
        target="_blank"
        rel="noreferrer"
      >
        <Globe2 size={13} />
      </a>
      <button aria-label="复制地址" className="inline-flex text-white/80 transition hover:text-white" type="button" onClick={() => onCopyAddress(value)}>
        <Copy size={13} />
      </button>
    </span>
  );
}

export function Toast({ message }: { message: string }) {
  return (
    <div className={`xh-toast ${message ? "is-visible" : ""}`} role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "completed" || status === "confirmed"
      ? "success"
      : status === "cancelled" || status === "rejected" || status === "failed" || status === "reversed"
        ? "danger"
        : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

export function OnchainStatusBadge({ type, status }: { type: OnchainRecord["type"]; status: string }) {
  if (type === "deposit" && status === "confirmed") {
    return <Badge tone="success">钱包到账</Badge>;
  }
  return <StatusBadge status={status} />;
}

export function AddressText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="break-all font-mono text-xs text-muted">{value}</span>;
}
