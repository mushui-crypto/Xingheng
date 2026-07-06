import { useState } from "react";
import type {
  DepositAddress,
  ExternalWalletBinding,
  FundingAccount,
} from "../../../api/walletApi";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import {
  formatExternalWalletBindStatus,
  formatMoney,
  formatNumber,
  shortenWalletAddress,
} from "../lib/accountUtils";
import { bscTestnetLabel, tokenIconSrc } from "../model/constants";
import { ChainInfo, RecordEmptyState } from "./AccountDisplayPrimitives";
import {
  OverviewAssetMetric,
  WalletAddressLine,
} from "./AccountFeaturePrimitives";
import { WalletActionButton } from "./AccountModalPrimitives";
import { AssetSummaryPanel } from "./AccountOverviewSections";

export function WalletOverviewSection({
  asset,
  depositAddress,
  externalWalletBinding,
  externalWalletError,
  wallet,
  onAddWallet,
  onCopyChainAddress,
  onCopyDepositAddress,
  onDeposit,
  onExchange,
  onTrade,
  onWithdraw,
}: {
  asset: string;
  depositAddress: DepositAddress | null;
  externalWalletBinding: ExternalWalletBinding | null;
  externalWalletError: string;
  wallet: FundingAccount | null;
  onAddWallet: () => void;
  onCopyChainAddress: (value: string) => void;
  onCopyDepositAddress: () => void;
  onDeposit: () => void;
  onExchange: () => void;
  onTrade: () => void;
  onWithdraw: () => void;
}) {
  const [selectedWalletId, setSelectedWalletId] = useState("primary");
  const fallbackAddress = "0x7A3B2fE4C9aA0fA0A5d9b2Ca6D13F905AfB99F12";
  const walletBalance = wallet?.balance ?? 0;
  const walletAvailable = wallet?.available ?? 0;
  const walletFrozen = wallet?.frozen ?? 0;
  const walletPnl = 0;
  const thirdPartyWalletLabel = externalWalletBinding
    ? `${shortenWalletAddress(externalWalletBinding.walletAddress)} 已绑定`
    : "未绑定";
  const walletCards: WalletOverviewCard[] = [
    {
      id: "primary",
      name: "Stella X 钱包",
      address: depositAddress?.address ?? fallbackAddress,
      balance: walletBalance,
      change24h: walletPnl,
      onCopyAddress: depositAddress?.address ? onCopyDepositAddress : undefined,
    },
    ...(externalWalletBinding ? [{
      id: externalWalletBinding.id,
      name: "第三方钱包",
      address: externalWalletBinding.walletAddress,
      balance: 0,
      change24h: 0,
      bindStatus: externalWalletBinding.bindStatus,
    }] : []),
  ];
  const selectedWallet = walletCards.find((wallet) => wallet.id === selectedWalletId) ?? walletCards[0];
  const assetRows = Array.from({ length: 5 }, (_, index) => ({
    id: `stlx-${index + 1}`,
    symbol: asset,
    balance: formatNumber(index === 0 ? walletBalance : 0),
  }));

  return (
    <div className="xh-wallet-overview">
      <AssetSummaryPanel
        className="xh-wallet-hero"
        title="预估总资产"
        asset={asset}
        value={walletBalance}
        pnl={walletPnl}
        infos={[
          { label: "钱包网络", value: bscTestnetLabel },
          { label: "第三方钱包", value: thirdPartyWalletLabel },
          { label: "可划转", value: formatMoney(walletAvailable, asset) },
          { label: "已归集", value: formatMoney(walletFrozen, asset) },
        ]}
      />

      <div className="xh-wallet-panel">
        <div className="xh-wallet-list-pane">
          <div className="xh-wallet-pane-header">
            <h3>钱包列表</h3>
            <WalletActionButton label={externalWalletBinding ? "管理第三方钱包" : "绑定第三方钱包"} onClick={onAddWallet} />
          </div>
          {externalWalletError ? <p className="xh-wallet-bind-warning">{externalWalletError}</p> : null}
          <div className="xh-wallet-list">
            {walletCards.map((wallet) => (
              <div
                key={wallet.id}
                aria-pressed={selectedWallet.id === wallet.id}
                className={`xh-wallet-list-card ${selectedWallet.id === wallet.id ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedWalletId(wallet.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedWalletId(wallet.id);
                  }
                }}
              >
                <span className="xh-wallet-list-card-top">
                  <span className="xh-wallet-list-card-title">
                    <strong>{wallet.name}</strong>
                    {wallet.bindStatus ? <span className="xh-wallet-bind-status">{formatExternalWalletBindStatus(wallet.bindStatus)}</span> : null}
                  </span>
                  <b>{wallet.id === "primary" ? formatMoney(wallet.balance, asset) : "MetaMask"}</b>
                </span>
                <span className="xh-wallet-list-card-bottom">
                  <WalletAddressLine address={wallet.address} onCopyAddress={wallet.onCopyAddress ?? (() => onCopyChainAddress(wallet.address))} />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="xh-wallet-detail-column">
          <div className="xh-wallet-detail-pane">
            <div className="xh-wallet-detail-header">
              <div className="xh-wallet-detail-title">
                <h3>{selectedWallet.name}</h3>
                <WalletAddressLine address={selectedWallet.address} full onCopyAddress={selectedWallet.onCopyAddress ?? (() => onCopyChainAddress(selectedWallet.address))} />
              </div>
              <div className="xh-wallet-actions">
                {selectedWallet.id === "primary" ? (
                  <>
                    <WalletActionButton label="交易" onClick={onTrade} />
                    <WalletActionButton label="兑换" onClick={onExchange} />
                    <WalletActionButton label="发送" onClick={onWithdraw} />
                    <WalletActionButton label="收款" onClick={selectedWallet.onCopyAddress} />
                  </>
                ) : (
                  <Badge tone="neutral">MetaMask</Badge>
                )}
              </div>
            </div>

            <div className="xh-wallet-detail-balance">
              {selectedWallet.id === "primary" ? (
                <OverviewAssetMetric value={selectedWallet.balance} asset={asset} pnl={selectedWallet.change24h} />
              ) : (
                <div className="xh-external-wallet-boundary">
                  <p>链上余额</p>
                  <strong>暂未读取</strong>
                </div>
              )}
            </div>
          </div>

          {selectedWallet.id === "primary" ? (
            <div className="xh-wallet-asset-pane">
              <div className="xh-wallet-tabs">
                <button className="is-active" type="button">资产</button>
                <button type="button">活动</button>
              </div>

              <div className="xh-wallet-asset-header">
                <span>币种</span>
                <span>余额</span>
                <span>操作</span>
              </div>

              <div className="xh-wallet-asset-list">
                {assetRows.map((row) => (
                  <div className="xh-wallet-asset-row" key={row.id}>
                    <span className="xh-wallet-token-cell">
                      <img alt="STLX" className="xh-wallet-token-icon" src={tokenIconSrc} />
                      <span>{row.symbol}</span>
                    </span>
                    <span>{row.balance}</span>
                    <span className="xh-wallet-row-actions">
                      <button type="button" onClick={onDeposit}>充值</button>
                      <button type="button" onClick={onWithdraw}>提现</button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="xh-wallet-asset-pane">
              <div className="xh-wallet-tabs">
                <button className="is-active" type="button">资产</button>
                <button type="button">活动</button>
              </div>

              <div className="xh-wallet-asset-header">
                <span>币种</span>
                <span>余额</span>
                <span>操作</span>
              </div>

              <div className="xh-wallet-asset-empty">
                <RecordEmptyState title="暂无第三方钱包资产" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type WalletOverviewCard = {
  id: string;
  name: string;
  address: string;
  balance: number;
  change24h: number;
  bindStatus?: ExternalWalletBinding["bindStatus"];
  onCopyAddress?: () => void;
};

export function ExternalWalletBindPanel({
  binding,
  error,
  isSubmitting,
  status,
  onBind,
  onUnbind,
}: {
  binding: ExternalWalletBinding | null;
  error: string;
  isSubmitting: boolean;
  status: string;
  onBind: () => void;
  onUnbind: () => void;
}) {
  if (binding) {
    return (
      <div className="space-y-4">
        <ChainInfo label="钱包类型" value="MetaMask" />
        <ChainInfo label="网络" value={bscTestnetLabel} />
        <ChainInfo label="绑定地址" value={binding.walletAddress} />
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="success">已绑定</Badge>
          <Button variant="secondary" disabled={isSubmitting} onClick={onUnbind}>
            解除绑定
          </Button>
        </div>
        {error ? <p className="border border-red-400/35 bg-red-500/10 p-3 text-sm leading-6 text-red-100">{error}</p> : null}
      </div>
    );
  }

  const hasMetaMask = typeof window !== "undefined" && Boolean(window.ethereum?.isMetaMask);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2">
        <ChainInfo label="钱包类型" value="MetaMask" />
        <ChainInfo label="网络" value={bscTestnetLabel} />
      </div>
      <div className="border border-white/10 bg-white/[0.025] p-4">
        <p className="text-sm font-medium text-white">第三方钱包绑定</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone={hasMetaMask ? "success" : "danger"}>{hasMetaMask ? "MetaMask 已检测" : "未检测到 MetaMask"}</Badge>
          <Badge tone="neutral">单地址绑定</Badge>
        </div>
      </div>
      <Button disabled={!hasMetaMask || isSubmitting} onClick={onBind}>
        {isSubmitting ? status || "绑定中" : "连接并签名"}
      </Button>
      {status && isSubmitting ? <p className="border border-white/15 bg-white/[0.035] p-3 text-sm leading-6 text-slate-200">{status}</p> : null}
      {error ? <p className="border border-red-400/35 bg-red-500/10 p-3 text-sm leading-6 text-red-100">{error}</p> : null}
    </div>
  );
}
