import type { AccountSection } from "../model/types";

export function AccountNav({ activeSection, onChange }: { activeSection: AccountSection; onChange: (section: AccountSection) => void }) {
  return (
    <nav className="xh-account-nav">
      <SectionButton active={activeSection === "overview"} label="账户总览" onClick={() => onChange("overview")} />
      <NavGroup title="资产" />
      <SectionButton active={activeSection === "funding"} label="资金账户" level="child" onClick={() => onChange("funding")} />
      <SectionButton active={activeSection === "wallet-overview"} label="钱包总览" level="child" onClick={() => onChange("wallet-overview")} />
      <SectionButton active={activeSection === "trading"} label="交易账户" level="child" onClick={() => onChange("trading")} />
      <SectionButton active={activeSection === "simulation"} label="模拟账户" level="child" onClick={() => onChange("simulation")} />
      <NavGroup title="订单" />
      <SectionButton active={activeSection === "ledger"} label="资金流水" level="child" onClick={() => onChange("ledger")} />
      <SectionButton active={activeSection === "onchain-deposits"} label="链上充提记录" level="child" onClick={() => onChange("onchain-deposits")} />
      <SectionButton active={activeSection === "trade-orders"} label="交易订单" level="child" onClick={() => onChange("trade-orders")} />
    </nav>
  );
}

export function NavGroup({ title }: { title: string }) {
  return <div className="xh-account-nav-group">{title}</div>;
}

export function LedgerTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <RecordFilterButton active={active} label={label} onClick={onClick} />;
}

export function RecordFilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`xh-record-filter ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function SectionButton({ active, label, level = "root", onClick }: { active: boolean; label: string; level?: "root" | "child"; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={`xh-account-nav-button ${active ? "is-active" : ""} ${level === "child" ? "is-child" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
