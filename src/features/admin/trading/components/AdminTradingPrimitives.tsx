import { Globe2 } from "lucide-react";
import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import type { FundingLedgerEntry, OnchainDepositStatus, WithdrawalRequest } from "../../../../api/walletApi";
import { formatStatus, formatStatusHint, shortenHash } from "../lib/formatters";

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold">{value}</p>
    </Card>
  );
}

export function SectionTitle({ title }: { title: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold">{title}</h2>
    </div>
  );
}

export function RecordHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold">{title}</h2>
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

export function LedgerBadge({ status }: { status: FundingLedgerEntry["status"] }) {
  const tone = status === "completed" ? "success" : status === "rejected" ? "danger" : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

export function WithdrawalBadge({ status }: { status: WithdrawalRequest["status"] | OnchainDepositStatus }) {
  const tone = status === "confirmed" ? "success" : status === "rejected" || status === "failed" ? "danger" : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

export function StatusCell({ status }: { status: WithdrawalRequest["status"] | OnchainDepositStatus }) {
  return (
    <div className="space-y-1">
      <WithdrawalBadge status={status} />
      <p className="text-xs leading-5 text-muted">{formatStatusHint(status)}</p>
    </div>
  );
}

export function AddressText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="break-all font-mono text-xs text-muted">{value}</span>;
}

export function StackedChainText({ primary, secondary }: { primary: string; secondary?: string | null }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-white">{primary}</p>
      <AddressText value={secondary} />
    </div>
  );
}

export function renderTxLink(txHash?: string | null) {
  if (!txHash) {
    return "-";
  }
  return (
    <a
      className="inline-flex items-center gap-1.5 font-mono text-xs text-muted transition hover:text-white"
      href={`https://testnet.bscscan.com/tx/${txHash}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`在 BscScan Testnet 查看交易 ${txHash}`}
    >
      <span>{shortenHash(txHash)}</span>
      <Globe2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
    </a>
  );
}

export function renderReason(value?: string | null) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="block max-w-[240px] text-sm leading-5 text-amber-100">{value}</span>;
}
