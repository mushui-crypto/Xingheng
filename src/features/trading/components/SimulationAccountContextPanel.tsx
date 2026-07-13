import type { TradingAccount } from "../../../api/market";
import type { SimulationAccountView } from "../../../api/walletApi";
import { formatAccountMoney, formatSignedAccountMoney, getSignedTone } from "../lib/simulationAccount";

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
    <section className="xh-real-account-panel">
      <h2 className="xh-real-account-title">账户权益</h2>
      <div className="xh-real-account-metrics">
        <SimulationContextItem label="账户余额" value={formatAccountMoney(balance, currency)} />
        <SimulationContextItem label="账户权益" value={formatAccountMoney(equity, currency)} />
        <SimulationContextItem label="未实现盈亏" value={formatSignedAccountMoney(floatingPnl, currency)} tone={getSignedTone(floatingPnl)} />
        <SimulationContextItem label="保证金比例" value={marginRatio} />
        <SimulationContextItem label="已用保证金" value={formatAccountMoney(usedMargin, currency)} />
        <SimulationContextItem label="可用保证金" value={formatAccountMoney(freeMargin, currency)} />
      </div>
    </section>
  );
}

function SimulationContextItem({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "positive" | "negative" | "neutral";
  value: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={tone === "positive" ? "is-positive" : tone === "negative" ? "is-negative" : ""}>{value}</strong>
    </div>
  );
}
