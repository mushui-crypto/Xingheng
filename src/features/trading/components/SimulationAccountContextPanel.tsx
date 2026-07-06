import type { TradingAccount } from "../../../api/market";
import type { SimulationAccountView } from "../../../api/walletApi";
import {
  formatAccountMoney,
  formatSignedAccountMoney,
  getSignedTone,
  shortSimulationId,
} from "../lib/simulationAccount";

export function SimulationAccountContextPanel({
  account,
  currency,
  simulationAccount,
}: {
  account: TradingAccount | null;
  currency: string;
  simulationAccount: SimulationAccountView | null;
}) {
  const balance = account?.balance ?? simulationAccount?.balance;
  const equity = account?.equity ?? simulationAccount?.equity;
  const usedMargin = account?.usedMargin ?? simulationAccount?.usedMargin;
  const freeMargin = account?.freeMargin ?? simulationAccount?.freeMargin ?? simulationAccount?.availableMargin;
  const floatingPnl = account?.floatingPnl ?? simulationAccount?.floatingPnl ?? simulationAccount?.unrealizedPnl;
  const marginBase = (usedMargin ?? 0) + (freeMargin ?? 0);
  const marginRatio = marginBase > 0 ? `${(((usedMargin ?? 0) / marginBase) * 100).toFixed(2)}%` : "0.00%";

  return (
    <section className="xh-trading-simulation-card">
      <div className="xh-trading-simulation-grid">
        <SimulationContextItem label="账户 ID" value={simulationAccount ? shortSimulationId(simulationAccount.id) : "-"} mono />
        <SimulationContextItem label="账户类型" value="模拟账户" />
        <SimulationContextItem label="账户资产" value={formatAccountMoney(equity, currency)} />
        <SimulationContextItem label="保证金比例" value={marginRatio} />
        <SimulationContextItem label="浮动盈亏" value={formatSignedAccountMoney(floatingPnl, currency)} tone={getSignedTone(floatingPnl)} />
        <SimulationContextItem label="账户余额" value={formatAccountMoney(balance, currency)} />
        <SimulationContextItem label="已用保证金" value={formatAccountMoney(usedMargin, currency)} />
        <SimulationContextItem label="可用保证金" value={formatAccountMoney(freeMargin, currency)} />
      </div>
    </section>
  );
}

function SimulationContextItem({
  label,
  mono = false,
  tone,
  value,
}: {
  label: string;
  mono?: boolean;
  tone?: "positive" | "negative" | "neutral";
  value: string;
}) {
  return (
    <div className="xh-trading-simulation-item">
      <p>{label}</p>
      <span className={`${mono ? "font-mono text-xs" : ""} ${tone === "positive" ? "text-emerald-300" : tone === "negative" ? "text-red-300" : ""}`}>{value}</span>
    </div>
  );
}
