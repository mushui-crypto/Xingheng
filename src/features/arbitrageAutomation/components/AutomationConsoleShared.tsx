import React, { type ReactNode } from "react";
import { ArbitrageHelp } from "../../arbitrage/components/ArbitrageHelp";
import type { AutomationStatus, AutomationVenue } from "../model/controlConsoleTypes";

export function ConsoleSection({ actions, children, description, title }: {
  actions?: ReactNode;
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="min-w-0 border border-white/15 bg-[#101010]">
      <header className="flex min-w-0 flex-col gap-3 border-b border-white/10 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-5 text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function StatusTag({ children, tone = "neutral" }: { children: ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  const classes = {
    success: "border-emerald-400/35 bg-emerald-400/[0.08] text-emerald-200",
    warning: "border-amber-400/35 bg-amber-400/[0.08] text-amber-100",
    danger: "border-red-400/35 bg-red-400/[0.08] text-red-200",
    info: "border-sky-400/35 bg-sky-400/[0.08] text-sky-100",
    neutral: "border-white/20 bg-white/[0.035] text-slate-200",
  } as const;
  return <span className={`inline-flex w-fit items-center whitespace-nowrap border px-2 py-1 text-xs font-medium ${classes[tone]}`}>{children}</span>;
}

export function SummaryMetric({ label, value, detail, help, tone = "default" }: { label: string; value: string; detail?: string; help?: string; tone?: "default" | "positive" | "negative" | "warning" }) {
  const valueClass = tone === "positive" ? "text-emerald-300" : tone === "negative" ? "text-red-300" : tone === "warning" ? "text-amber-200" : "text-white";
  return (
    <div className="min-w-0 border-b border-r border-white/10 px-4 py-4 last:border-r-0 sm:px-5">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span>{label}</span>
        {help ? <ArbitrageHelp content={help} label={`查看${label}说明`} /> : null}
      </div>
      <p className={`mt-2 truncate font-mono text-xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {detail ? <p className="mt-1 truncate text-xs text-dim">{detail}</p> : null}
    </div>
  );
}

export function ScrollTable({ children, minWidth = 980 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="w-full min-w-0 max-w-full overflow-x-auto">
      <table className="w-full table-fixed text-left text-sm [&_td]:align-middle [&_th]:align-middle" style={{ minWidth }}>{children}</table>
    </div>
  );
}

export const tableHeadClass = "border-b border-white/10 bg-white/[0.025] text-xs text-muted";
export const tableHeaderCellClass = "px-4 py-3 align-middle font-medium";
export const tableCellClass = "border-b border-white/[0.07] px-4 py-3 align-middle text-sm text-slate-200";
export const stickyActionHeaderClass = "sticky right-0 z-20 border-l border-white/10 bg-[#141414]";
export const stickyActionCellClass = "sticky right-0 z-10 border-l border-white/10 bg-[#101010]";

export function venueLabel(venue: AutomationVenue) {
  return ({ binance: "Binance", bybit: "Bybit", bitget: "Bitget", okx: "OKX" } as const)[venue];
}

export function statusTone(status: AutomationStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  if (status === "blocked") return "danger";
  return "neutral";
}

export function formatMoney(value: number, signed = false) {
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

export function formatPercent(value: number, signed = false) {
  const percent = value * 100;
  const sign = signed && percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(2)}%`;
}

export function formatDate(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function pnlTone(value: number): "positive" | "negative" | "default" {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "default";
}
