import type {
  FundingAccount,
  RealTradingAccount,
} from "../../../api/walletApi";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { formatMoney, formatNumber } from "../lib/accountUtils";
import { tokenIconSrc } from "../model/constants";
import { BoundaryTile } from "./AccountFeaturePrimitives";
import { WalletActionButton } from "./AccountModalPrimitives";
import { AssetSummaryPanel } from "./AccountOverviewSections";

type FundingAssetRow = {
  id: string;
  symbol: string;
  balance: number;
  available: number;
  frozen: number;
};

const fundingAssetRows: FundingAssetRow[] = [
  { id: "usd1", symbol: "USD1", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usde", symbol: "USDe", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usdi", symbol: "USDI", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usdl", symbol: "USDL", balance: 239.91, available: 239.91, frozen: 239.91 },
  { id: "usdc", symbol: "USDC", balance: 239.91, available: 239.91, frozen: 239.91 },
];

export function FundingSection({ asset, funding }: { asset: string; funding: FundingAccount | null }) {
  const columns: DataTableColumn<FundingAssetRow>[] = [
    {
      key: "asset",
      header: "资产",
      render: (row) => (
        <span className="xh-funding-token-cell">
          <img alt="星衡资产图标" className="xh-funding-token-icon" src={tokenIconSrc} />
          <span>{row.symbol}</span>
        </span>
      ),
    },
    { key: "balance", header: "余额", align: "right", render: (row) => formatNumber(row.balance) },
    { key: "available", header: "可用", align: "right", render: (row) => formatNumber(row.available) },
    { key: "frozen", header: "冻结", align: "right", render: (row) => formatNumber(row.frozen) },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: () => (
        <span className="xh-funding-row-actions">
          <button type="button">充值</button>
          <button type="button">提现</button>
        </span>
      ),
    },
  ];

  return (
    <div className="xh-funding-page">
      <AssetSummaryPanel
        className="xh-funding-summary-panel"
        title="预估总资产"
        asset={asset}
        value={funding?.available ?? 0}
        pnl={0}
        actions={
          <>
            <WalletActionButton label="充值" />
            <WalletActionButton label="提现" />
            <WalletActionButton label="划转" />
          </>
        }
        infos={[
          { label: "账户 ID", value: funding?.id ?? "FUND-USR-MR2Z51C2" },
          { label: "冻结金额", value: formatMoney(funding?.frozen ?? 0, asset) },
          { label: "可用资金", value: formatMoney(funding?.available ?? 0, asset) },
        ]}
      />

      <section className="xh-funding-assets-panel">
        <h2>资产详情</h2>
        <DataTable
          className="xh-funding-assets-table"
          columns={columns}
          rows={fundingAssetRows}
          getRowKey={(row) => row.id}
          gridTemplateColumns="minmax(320px,1fr) 160px 160px 160px 160px"
          minWidth="920px"
        />
      </section>
    </div>
  );
}

export function RealTradingSection({ account, asset, onTransfer }: { account: RealTradingAccount | null; asset: string; onTransfer: () => void }) {
  const isOpened = account?.opened !== false && account?.status !== "disabled";
  return (
    <div className="xh-trading-account-page">
      <AssetSummaryPanel
        className="xh-trading-summary-panel"
        title="预估总资产"
        asset={asset}
        value={isOpened ? account?.available ?? 0 : 0}
        pnl={0}
        actions={
          <WalletActionButton label="划转" disabled={!isOpened} onClick={isOpened ? onTransfer : undefined} />
        }
        infos={[
          { label: "账户 ID", value: account?.id ?? "REAL-USR-MR2Z51C2" },
          { label: "账户状态", value: isOpened ? "已开通" : "暂未开通" },
          { label: "余额", value: formatMoney(isOpened ? account?.balance ?? 0 : 0, asset) },
          { label: "可用余额", value: formatMoney(isOpened ? account?.available ?? 0 : 0, asset) },
        ]}
      />

      <section className="xh-trading-boundary-panel">
        <h2>当前边界</h2>
        <p>本页现在只展示交易账户账本，不混入模拟持仓、模拟订单或真实链上托管语义。</p>
        <div className="xh-trading-boundary-grid">
          <BoundaryTile title="可接收划转" description="资金账户与交易账户之间可划转。" />
          <BoundaryTile title="未接真实下单" description="真实开仓、平仓和风控接口后续接入。" />
          <BoundaryTile title="不混模拟数据" description="模拟交易只在模拟账户页面展示。" />
        </div>
      </section>
    </div>
  );
}
