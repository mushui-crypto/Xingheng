import { Globe2 } from "lucide-react";
import { useState } from "react";
import type { OrderRecord } from "../../../api/market";
import type { FundingOrder, OnchainRecord } from "../../../api/walletApi";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import {
  formatFundingOrderDirection,
  formatFundingOrderType,
  formatNetwork,
  formatNumber,
  formatOnchainRecordType,
  formatOrderStatus,
  formatTimestamp,
  formatTradeSide,
  shortenHash,
} from "../lib/accountUtils";
import type { LedgerTab, TradeOrderFilter } from "../model/types";
import {
  ChainAddress,
  MonoText,
  OnchainStatusBadge,
  RecordEmptyState,
  RecordPanel,
  StatusBadge,
} from "./AccountDisplayPrimitives";
import {
  LedgerTabButton,
  RecordFilterButton,
} from "./AccountNavigation";

export function FundingOrdersTable({ emptyTitle, orders }: { emptyTitle: string; orders: FundingOrder[] }) {
  const columns: DataTableColumn<FundingOrder>[] = [
    { key: "time", header: "时间", render: (order) => formatTimestamp(order.createdAt) },
    { key: "category", header: "类别", render: (order) => formatFundingOrderType(order.orderType) },
    { key: "amount", header: "金额", render: (order) => formatNumber(order.amount), align: "right" },
    { key: "asset", header: "资产", render: (order) => order.asset, align: "center" },
    { key: "direction", header: "方向", render: (order) => formatFundingOrderDirection(order) },
    { key: "orderNo", header: "订单号", render: (order) => <MonoText value={order.relatedWithdrawalId ?? order.relatedTransferId ?? order.relatedLedgerId ?? order.id} /> },
    { key: "status", header: "状态", render: (order) => <StatusBadge status={order.displayStatus} />, align: "center" },
  ];

  return (
    <DataTable
      className="xh-record-table"
      columns={columns}
      rows={orders.slice(0, 10)}
      getRowKey={(order) => order.id}
      gridTemplateColumns="minmax(160px,1fr) 120px 120px 80px minmax(180px,1.2fr) minmax(180px,1fr) 120px"
      minWidth="940px"
      emptyState={<RecordEmptyState title={emptyTitle} />}
    />
  );
}

export function LedgerSection({ fundingOrders }: { fundingOrders: FundingOrder[] }) {
  const [activeTab, setActiveTab] = useState<LedgerTab>("ledger");
  const visibleOrders = activeTab === "deposits"
    ? fundingOrders.filter((order) => order.orderType === "deposit")
    : activeTab === "withdrawals"
      ? fundingOrders.filter((order) => order.orderType === "withdrawal" || order.orderType === "internal_transfer")
      : activeTab === "transfers"
        ? fundingOrders.filter((order) => order.orderType === "account_transfer")
        : fundingOrders;
  const emptyTitle = activeTab === "deposits"
    ? "暂无充值记录"
    : activeTab === "withdrawals"
      ? "暂无提现记录"
      : activeTab === "transfers"
        ? "暂无划转记录"
        : "暂无资金流水";

  return (
    <RecordPanel
      className="xh-record-panel-ledger"
      title="资金流水"
      filters={
        <>
          <LedgerTabButton active={activeTab === "ledger"} label="总览" onClick={() => setActiveTab("ledger")} />
          <LedgerTabButton active={activeTab === "deposits"} label="充值" onClick={() => setActiveTab("deposits")} />
          <LedgerTabButton active={activeTab === "withdrawals"} label="提现" onClick={() => setActiveTab("withdrawals")} />
          <LedgerTabButton active={activeTab === "transfers"} label="划转" onClick={() => setActiveTab("transfers")} />
        </>
      }
    >
      <FundingOrdersTable emptyTitle={emptyTitle} orders={visibleOrders} />
    </RecordPanel>
  );
}

export function OnchainDepositsSection({
  ownAddress,
  records,
  onCopyAddress,
}: {
  ownAddress?: string | null;
  records: OnchainRecord[];
  onCopyAddress: (value: string) => void;
}) {
  const columns: DataTableColumn<OnchainRecord>[] = [
    { key: "time", header: "时间", render: (row) => <span className="whitespace-nowrap">{formatTimestamp(row.createdAt)}</span> },
    { key: "type", header: "类型", render: (row) => formatOnchainRecordType(row.type), align: "center" },
    { key: "amount", header: "金额", render: (row) => formatNumber(row.amount), align: "right" },
    { key: "asset", header: "资产", render: (row) => row.asset, align: "center" },
    { key: "network", header: "网络", render: (row) => formatNetwork(row.network) },
    { key: "to", header: "转入地址", render: (row) => <ChainAddress value={row.toAddress} ownAddress={ownAddress} onCopyAddress={onCopyAddress} /> },
    { key: "from", header: "转出地址", render: (row) => <ChainAddress value={row.fromAddress} ownAddress={ownAddress} onCopyAddress={onCopyAddress} /> },
    { key: "tx", header: "交易哈希", render: (row) => renderTxLink(row.txHash) },
    { key: "status", header: "状态", render: (row) => <OnchainStatusBadge type={row.type} status={row.chainStatus} />, align: "center" },
  ];

  return (
    <RecordPanel className="xh-record-panel-onchain" title="链上充提记录">
      <DataTable
        className="xh-record-table"
        columns={columns}
        rows={records.slice(0, 10)}
        getRowKey={(row) => row.id}
        gridTemplateColumns="minmax(180px,1fr) 80px 120px 80px minmax(160px,0.9fr) minmax(210px,1.1fr) minmax(210px,1.1fr) minmax(170px,1fr) 120px"
        minWidth="1260px"
        emptyState={<RecordEmptyState title="暂无链上充提记录" />}
      />
    </RecordPanel>
  );
}

export function TradeOrdersSection({ orders }: { orders: OrderRecord[] }) {
  const [activeFilter, setActiveFilter] = useState<TradeOrderFilter>("all");
  const filteredOrders = orders.filter((order) => {
    if (activeFilter === "all") {
      return true;
    }
    if (activeFilter === "buy" || activeFilter === "sell") {
      return order.side === activeFilter;
    }
    return order.status === activeFilter;
  });
  const columns: DataTableColumn<OrderRecord>[] = [
    { key: "time", header: "时间", render: (order) => formatTimestamp(order.createdAt) },
    { key: "symbol", header: "品种", render: (order) => order.symbol },
    { key: "side", header: "方向", render: (order) => formatTradeSide(order.side), align: "center" },
    { key: "action", header: "动作", render: (order) => (order.action === "open" ? "开仓" : "平仓"), align: "center" },
    { key: "volume", header: "数量", render: (order) => order.volume.toString(), align: "right" },
    { key: "price", header: "成交价", render: (order) => order.price?.toFixed(5) ?? "-", align: "right" },
    { key: "status", header: "状态", render: (order) => formatOrderStatus(order.status), align: "center" },
    { key: "reason", header: "说明", render: (order) => order.reason ?? "-" },
  ];

  return (
    <RecordPanel
      className="xh-record-panel-orders"
      title="交易订单"
      filters={
        <>
          <RecordFilterButton active={activeFilter === "all"} label="全部" onClick={() => setActiveFilter("all")} />
          <RecordFilterButton active={activeFilter === "buy"} label="买入" onClick={() => setActiveFilter("buy")} />
          <RecordFilterButton active={activeFilter === "sell"} label="卖出" onClick={() => setActiveFilter("sell")} />
          <RecordFilterButton active={activeFilter === "filled"} label="已成交" onClick={() => setActiveFilter("filled")} />
          <RecordFilterButton active={activeFilter === "rejected"} label="已拒绝" onClick={() => setActiveFilter("rejected")} />
        </>
      }
    >
      <DataTable
        className="xh-record-table"
        columns={columns}
        rows={filteredOrders.slice(0, 10)}
        getRowKey={(order) => order.id}
        gridTemplateColumns="170px 110px 90px 90px 100px 130px 100px minmax(180px,1fr)"
        minWidth="970px"
        emptyState={<RecordEmptyState title="暂无订单记录" />}
      />
    </RecordPanel>
  );
}

function renderTxLink(txHash?: string | null) {
  if (!txHash) {
    return "-";
  }
  return (
    <a
      className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-xs text-muted transition hover:text-white"
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
