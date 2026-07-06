import type { SimulationAccountView } from "../../../api/walletApi";
import { Button } from "../../../components/ui/Button";
import {
  formatGroupedMoney,
  formatGroupedNumber,
  formatSignedGroupedMoney,
  getSignedToneClass,
} from "../lib/accountUtils";
import {
  SimulationActionButton,
  SimulationInfo,
  SimulationUsageBadge,
} from "./AccountFeaturePrimitives";

export function SimulationSection({
  asset,
  currentAccountId,
  accounts,
  accountLimit,
  canCreate,
  isSubmitting,
  onAddAccount,
  onDelete,
  onRename,
  onReset,
  onTrade,
}: {
  asset: string;
  currentAccountId: string;
  accounts: SimulationAccountView[];
  accountLimit: number;
  canCreate: boolean;
  isSubmitting: boolean;
  onAddAccount: () => void;
  onDelete: (accountId: string) => void;
  onRename: (account: SimulationAccountView) => void;
  onReset: (accountId: string) => void;
  onTrade: (accountId: string) => void;
}) {
  const accountAsset = accounts[0]?.asset ?? asset;

  return (
    <div className="xh-simulation-page">
      <button className="xh-simulation-add-button" type="button" disabled={!canCreate || isSubmitting} onClick={onAddAccount}>
        {isSubmitting ? "处理中" : `新增模拟账户 ${accounts.length}/${accountLimit}`}
      </button>
      {accounts.length === 0 ? (
        <section className="xh-simulation-empty">
          <h2>暂无模拟账户</h2>
          <Button disabled={!canCreate || isSubmitting} onClick={onAddAccount}>
            创建模拟账户
          </Button>
        </section>
      ) : (
        accounts.map((account, index) => (
          <SimulationAccountCard
            account={account}
            asset={accountAsset}
            isCurrent={account.id === currentAccountId}
            index={index + 1}
            key={account.id}
            onDelete={() => onDelete(account.id)}
            onRename={() => onRename(account)}
            onReset={() => onReset(account.id)}
            onTrade={() => onTrade(account.id)}
          />
        ))
      )}
    </div>
  );
}

export function SimulationAccountCard({
  account,
  asset,
  isCurrent,
  index,
  onDelete,
  onRename,
  onReset,
  onTrade,
}: {
  account: SimulationAccountView;
  asset: string;
  isCurrent: boolean;
  index: number;
  onDelete: () => void;
  onRename: () => void;
  onReset: () => void;
  onTrade: () => void;
}) {
  const equity = account.equity ?? 0;
  const balance = account.balance ?? 0;
  const usedMargin = account.usedMargin ?? 0;
  const freeMargin = account.freeMargin ?? account.availableMargin ?? 0;
  const marginBase = usedMargin + freeMargin;
  const marginRatio = marginBase > 0 ? `${((usedMargin / marginBase) * 100).toFixed(2)}%` : "0.00%";
  const floatingPnl = account.floatingPnl ?? account.unrealizedPnl ?? 0;
  const infoRows = [
    [
      { label: "账户 ID", value: account.id },
      { label: "账户类型", value: "模拟账户" },
      { label: "保证金比例", value: marginRatio },
    ],
    [
      { label: "浮动盈亏", value: <span className={getSignedToneClass(floatingPnl)}>{formatSignedGroupedMoney(floatingPnl, asset)}</span> },
      { label: "账户余额", value: formatGroupedMoney(balance, asset) },
      { label: "已用保证金", value: formatGroupedMoney(usedMargin, asset) },
      { label: "可用保证金", value: formatGroupedMoney(freeMargin, asset) },
    ],
  ];

  return (
    <section className={`xh-simulation-account-card ${isCurrent ? "is-current" : "is-idle"}`}>
      <div className="xh-simulation-card-header">
        <div className="xh-simulation-card-title">
          <h2>{account.name || `模拟账户${index}`}</h2>
          <SimulationUsageBadge isCurrent={isCurrent} status={account.status} />
        </div>
        <div className="xh-simulation-card-actions">
          <SimulationActionButton label="重置资金" onClick={account.canReset === false ? undefined : onReset} disabled={account.canReset === false} />
          <SimulationActionButton asLink label="进入模拟交易" to={`/app/trading?symbol=BTCUSDT&simulationAccountId=${encodeURIComponent(account.id)}`} onClick={onTrade} />
          <SimulationMoreMenu onDelete={onDelete} onRename={onRename} />
        </div>
      </div>

      <div className="xh-simulation-primary-metric">
        <p>模拟账户资产</p>
        <div>
          <strong>{formatGroupedNumber(equity)}</strong>
          <span>{asset}</span>
        </div>
      </div>

      <div className="xh-simulation-info-grid">
        {infoRows.map((row, rowIndex) => (
          <div className="xh-simulation-info-row" key={rowIndex}>
            {row.map((item) => (
              <SimulationInfo key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export function SimulationMoreMenu({ onDelete, onRename }: { onDelete: () => void; onRename: () => void }) {
  return (
    <span className="xh-simulation-more-menu">
      <SimulationActionButton label="重命名" onClick={onRename} />
      <SimulationActionButton label="删除" onClick={onDelete} />
    </span>
  );
}
