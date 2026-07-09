import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import {
  fetchAdminAccounts,
  fetchAdminMarketStatus,
  fetchAdminOrders,
  fetchAdminPositions,
  fetchMarketSymbols,
  type AdminMarketStatus,
  type OrderRecord,
  type PositionView,
  type TradingAccount,
} from "../../api/market";
import {
  approveWithdrawalRequest,
  confirmAdminWithdrawals,
  depositFundingAccount,
  fetchAdminDepositAddresses,
  fetchAdminOnchainDeposits,
  fetchAdminWalletAccounts,
  fetchAdminWalletLedger,
  fetchAdminWithdrawalRequests,
  rejectWithdrawalRequest,
  runAdminOnchainScan,
  type DepositAddress,
  type FundingLedgerEntry,
  type OnchainDeposit,
  type WalletAccounts,
  type WithdrawalRequest,
} from "../../api/walletApi";
import {
  AddressText,
  EmptyState,
  InlineState,
  LedgerBadge,
  RecordHeader,
  SectionTitle,
  StackedChainText,
  Stat,
  StatusCell,
  renderReason,
  renderTxLink,
} from "../../features/admin/trading/components/AdminTradingPrimitives";
import {
  formatAssetAmount,
  formatConfirmations,
  formatLedgerType,
  formatNetwork,
} from "../../features/admin/trading/lib/formatters";
import { useSymbolStore } from "../../store/symbolStore";
import { formatPrice } from "../../utils/price";

export function AdminTradingPage() {
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [walletAccounts, setWalletAccounts] = useState<WalletAccounts[]>([]);
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [ledger, setLedger] = useState<FundingLedgerEntry[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [depositAddresses, setDepositAddresses] = useState<DepositAddress[]>([]);
  const [deposits, setDeposits] = useState<OnchainDeposit[]>([]);
  const [marketStatus, setMarketStatus] = useState<AdminMarketStatus[]>([]);
  const [depositUserId, setDepositUserId] = useState("demo-user");
  const [depositAmount, setDepositAmount] = useState(1000);
  const [depositRemark, setDepositRemark] = useState("后台手动充值");
  const [reviewNote, setReviewNote] = useState("后台审核");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      const nextSymbols = await fetchMarketSymbols();
      setSymbolsFromBackend(nextSymbols);
      const [nextAccounts, nextWalletAccounts, nextPositions, nextOrders, nextLedger, nextWithdrawals, nextDepositAddresses, nextDeposits, nextMarketStatus] = await Promise.all([
        fetchAdminAccounts(),
        fetchAdminWalletAccounts(),
        fetchAdminPositions(),
        fetchAdminOrders(),
        fetchAdminWalletLedger(),
        fetchAdminWithdrawalRequests(),
        fetchAdminDepositAddresses(),
        fetchAdminOnchainDeposits(),
        fetchAdminMarketStatus(),
      ]);
      setAccounts(nextAccounts);
      setWalletAccounts(nextWalletAccounts);
      setPositions(nextPositions);
      setOrders(nextOrders);
      setLedger(nextLedger);
      setWithdrawals(nextWithdrawals);
      setDepositAddresses(nextDepositAddresses);
      setDeposits(nextDeposits);
      setMarketStatus(nextMarketStatus);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "后台资金数据加载失败，请稍后重试。");
    } finally {
      setIsLoading(false);
    }
  };

  const submitDeposit = async () => {
    setMessage("");
    try {
      await depositFundingAccount(depositUserId.trim(), depositAmount, depositRemark);
      await loadData();
      setMessage("后台充值已进入资金账户。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "后台充值失败。");
    }
  };

  const reviewWithdrawal = async (id: string, action: "approve" | "reject") => {
    setMessage("");
    try {
      if (action === "approve") {
        await approveWithdrawalRequest(id, reviewNote);
      } else {
        await rejectWithdrawalRequest(id, reviewNote);
      }
      await loadData();
      setMessage(action === "approve" ? "提现申请已进入链上广播流程。" : "提现申请已拒绝，冻结金额已释放。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提现审核失败。");
    }
  };

  const triggerOnchainScan = async () => {
    setMessage("");
    try {
      const result = await runAdminOnchainScan();
      await loadData();
      if (result.status === "rate_limited" || result.rateLimited) {
        setMessage(result.message ?? "RPC 限流，请稍后重试或更换 RPC。");
        return;
      }
      setMessage(
        result.message
          ?? `链上扫描已执行。扫描区块：${result.scannedBlocks ?? 0}，新增记录：${result.deposits ?? 0}，已入账：${result.credited ?? 0}。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "链上扫描执行失败。");
    }
  };

  const triggerWithdrawalConfirm = async () => {
    setMessage("");
    try {
      const result = await confirmAdminWithdrawals();
      await loadData();
      setMessage(`提现确认已执行，状态变化 ${result.length} 笔。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提现确认执行失败。");
    }
  };

  return (
    <div className="xh-page">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">交易 / 资金查询</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={isLoading} onClick={() => void triggerOnchainScan()}>扫描充值</Button>
          <Button variant="secondary" disabled={isLoading} onClick={() => void triggerWithdrawalConfirm()}>确认提现</Button>
          <Button variant="secondary" disabled={isLoading} onClick={() => void loadData()}>刷新数据</Button>
        </div>
      </div>

      {isLoading ? <InlineState title="后台资金数据同步中" /> : null}
      {loadError ? <InlineState tone="danger" title="后台资金数据加载失败" description={loadError} actionLabel="重新加载" onAction={() => void loadData()} /> : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="资金账户" value={walletAccounts.length} />
        <Stat label="提现申请" value={withdrawals.length} />
        <Stat label="当前持仓" value={positions.length} />
        <Stat label="资金流水" value={ledger.length} />
      </div>

      <Card>
        <h2 className="font-semibold">后台充值到资金账户</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_180px_1fr_auto] md:items-end">
          <Input label="用户 ID" value={depositUserId} onChange={(event) => setDepositUserId(event.target.value)} placeholder="demo-user" />
          <Input label="金额" type="number" min={0} value={depositAmount} onChange={(event) => setDepositAmount(Number(event.target.value))} />
          <Input label="备注" value={depositRemark} onChange={(event) => setDepositRemark(event.target.value)} />
          <Button disabled={!depositUserId.trim() || depositAmount <= 0} onClick={() => void submitDeposit()}>确认充值</Button>
        </div>
        {message ? <p className="mt-4 xh-message">{message}</p> : null}
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="资金账户" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">用户 ID</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">Balance</th>
                <th className="px-5 py-3 font-medium">Frozen</th>
                <th className="px-5 py-3 font-medium">Available</th>
                <th className="px-5 py-3 font-medium">模拟账户权益</th>
                <th className="px-5 py-3 font-medium">交易账户可用</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {walletAccounts.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={7}>暂无资金账户。</td></tr>
              ) : walletAccounts.map(({ funding, simulation, realTrading, trading }) => {
                const simulationAccount = simulation ?? trading ?? null;
                return (
                  <tr key={funding.id}>
                    <td className="px-5 py-4 font-mono text-xs">{funding.userId}</td>
                    <td className="px-5 py-4">{funding.asset}</td>
                    <td className="px-5 py-4">{funding.balance.toFixed(2)}</td>
                    <td className="px-5 py-4">{funding.frozen.toFixed(2)}</td>
                    <td className="px-5 py-4">{funding.available.toFixed(2)}</td>
                    <td className="px-5 py-4">{formatAssetAmount(simulationAccount?.equity)}</td>
                    <td className="px-5 py-4">{formatAssetAmount(realTrading?.available)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="交易账户" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">用户 ID</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">Balance</th>
                <th className="px-5 py-3 font-medium">Equity</th>
                <th className="px-5 py-3 font-medium">Used Margin</th>
                <th className="px-5 py-3 font-medium">Free Margin</th>
                <th className="px-5 py-3 font-medium">Floating P/L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {accounts.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={7}>暂无账户，用户进入交易页后会自动创建。</td></tr>
              ) : accounts.map((account) => (
                <tr key={account.id}>
                  <td className="px-5 py-4 font-mono text-xs">{account.userId}</td>
                  <td className="px-5 py-4">{account.asset}</td>
                  <td className="px-5 py-4">{account.balance.toFixed(2)}</td>
                  <td className="px-5 py-4">{account.equity.toFixed(2)}</td>
                  <td className="px-5 py-4">{account.usedMargin.toFixed(2)}</td>
                  <td className="px-5 py-4">{account.freeMargin.toFixed(2)}</td>
                  <td className={`px-5 py-4 ${account.floatingPnl >= 0 ? "text-white" : "text-red-300"}`}>{account.floatingPnl.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <RecordHeader
          title="充值地址分配"
          description="每个用户在 BNB Smart Chain Testnet 上对应一个专属充值地址，用于把链上充值归属到正确用户。"
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">用户 ID</th>
                <th className="px-5 py-3 font-medium">网络</th>
                <th className="px-5 py-3 font-medium">充值地址</th>
                <th className="px-5 py-3 font-medium">派生序号</th>
                <th className="px-5 py-3 font-medium">更新时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {depositAddresses.length === 0 ? (
                <tr>
                  <td className="px-5 py-8" colSpan={5}>
                    <EmptyState title="暂无充值地址记录" />
                  </td>
                </tr>
              ) : depositAddresses.map((item) => (
                <tr key={item.id}>
                  <td className="px-5 py-4 font-mono text-xs">{item.userId}</td>
                  <td className="px-5 py-4">{formatNetwork(item.network)}</td>
                  <td className="px-5 py-4"><AddressText value={item.address} /></td>
                  <td className="px-5 py-4">{item.derivationIndex}</td>
                  <td className="px-5 py-4 text-muted">{new Date(item.updatedAt).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <RecordHeader title="链上充值记录" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1520px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">确认数</th>
                <th className="px-5 py-3 font-medium">来源地址</th>
                <th className="px-5 py-3 font-medium">充值地址</th>
                <th className="px-5 py-3 font-medium">交易哈希</th>
                <th className="px-5 py-3 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deposits.length === 0 ? (
                <tr>
                  <td className="px-5 py-8" colSpan={10}>
                    <EmptyState title="暂无链上充值记录" />
                  </td>
                </tr>
              ) : deposits.map((deposit) => (
                <tr key={deposit.id}>
                  <td className="px-5 py-4 text-muted">{new Date(deposit.detectedAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{deposit.userId}</td>
                  <td className="px-5 py-4">{deposit.amountDecimal.toFixed(2)}</td>
                  <td className="px-5 py-4">{deposit.asset}</td>
                  <td className="px-5 py-4"><StatusCell status={deposit.status} /></td>
                  <td className="px-5 py-4 text-muted">{formatConfirmations(deposit.confirmations)}</td>
                  <td className="px-5 py-4"><AddressText value={deposit.fromAddress} /></td>
                  <td className="px-5 py-4"><AddressText value={deposit.toAddress} /></td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(deposit.txHash)}</td>
                  <td className="px-5 py-4">{renderReason(deposit.failedReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-line p-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-semibold">提现申请审核</h2>
          </div>
          <Input className="md:w-72" label="审核说明" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1640px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">申请状态</th>
                <th className="px-5 py-3 font-medium">链上状态</th>
                <th className="px-5 py-3 font-medium">确认数</th>
                <th className="px-5 py-3 font-medium">网络 / 目标地址</th>
                <th className="px-5 py-3 font-medium">热钱包 / 合约</th>
                <th className="px-5 py-3 font-medium">交易哈希</th>
                <th className="px-5 py-3 font-medium">审核说明</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {withdrawals.length === 0 ? (
                <tr>
                  <td className="px-5 py-8" colSpan={12}>
                    <EmptyState title="暂无提现申请" />
                  </td>
                </tr>
              ) : withdrawals.map((withdrawal) => (
                <tr key={withdrawal.id}>
                  <td className="px-5 py-4 text-muted">{new Date(withdrawal.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{withdrawal.userId}</td>
                  <td className="px-5 py-4">{withdrawal.amount.toFixed(2)}</td>
                  <td className="px-5 py-4">{withdrawal.asset}</td>
                  <td className="px-5 py-4"><StatusCell status={withdrawal.status} /></td>
                  <td className="px-5 py-4">{withdrawal.onchainStatus ? <StatusCell status={withdrawal.onchainStatus} /> : <span className="text-muted">待审核后生成</span>}</td>
                  <td className="px-5 py-4 text-muted">{formatConfirmations(withdrawal.confirmations ?? 0)}</td>
                  <td className="px-5 py-4">
                    <StackedChainText primary={formatNetwork(withdrawal.network)} secondary={withdrawal.toAddress} />
                  </td>
                  <td className="px-5 py-4">
                    <StackedChainText primary={withdrawal.fromAddress ?? "-"} secondary={withdrawal.tokenAddress} />
                  </td>
                  <td className="px-5 py-4 text-muted">{renderTxLink(withdrawal.broadcastTxHash ?? withdrawal.txHash)}</td>
                  <td className="px-5 py-4">{renderReason(withdrawal.failedReason ?? withdrawal.reviewNote ?? withdrawal.remark)}</td>
                  <td className="px-5 py-4">
                    {withdrawal.status === "pending_review" ? (
                      <div className="flex gap-2">
                        <Button onClick={() => void reviewWithdrawal(withdrawal.id, "approve")}>通过</Button>
                        <Button variant="danger" onClick={() => void reviewWithdrawal(withdrawal.id, "reject")}>拒绝</Button>
                      </div>
                    ) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="行情状态" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">分类 / 来源</th>
                <th className="px-5 py-3 font-medium">来源标识</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">Bid / Ask</th>
                <th className="px-5 py-3 font-medium">来源</th>
                <th className="px-5 py-3 font-medium">行情时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {marketStatus.map((item) => (
                <tr key={item.symbol}>
                  <td className="px-5 py-4">{item.symbol}<p className="text-xs text-muted">{item.displayName}</p></td>
                  <td className="px-5 py-4 text-xs text-muted">
                    <p>{item.category}</p>
                    <p>{item.sourceType} · {item.sourceDex}</p>
                  </td>
                  <td className="px-5 py-4 text-xs text-muted">
                    <p>API {item.apiSymbol}</p>
                    <p>Market {item.providerMarketId}</p>
                    <p>Coin {item.providerCoin}</p>
                  </td>
                  <td className="px-5 py-4"><Badge tone={item.status === "connected" ? "success" : item.status === "stale" ? "neutral" : "danger"}>{item.status}</Badge></td>
                  <td className="px-5 py-4">{formatPrice(item.ticker?.bid, 5)} / {formatPrice(item.ticker?.ask, 5)}</td>
                  <td className="px-5 py-4 text-muted">{item.ticker?.source ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{item.ticker?.timestamp ? new Date(item.ticker.timestamp).toLocaleString("zh-CN") : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="最近订单" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">动作</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">方向/手数</th>
                <th className="px-5 py-3 font-medium">价格</th>
                <th className="px-5 py-3 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={8}>暂无订单。</td></tr>
              ) : orders.slice(0, 30).map((order) => (
                <tr key={order.id}>
                  <td className="px-5 py-4 text-muted">{new Date(order.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{order.userId}</td>
                  <td className="px-5 py-4">{order.action === "open" ? "开仓" : "平仓"}</td>
                  <td className="px-5 py-4"><Badge tone={order.status === "filled" ? "success" : "danger"}>{order.status}</Badge></td>
                  <td className="px-5 py-4">{order.symbol}</td>
                  <td className="px-5 py-4">{order.side} / {order.volume}</td>
                  <td className="px-5 py-4">{order.price?.toFixed(5) ?? "-"}</td>
                  <td className="px-5 py-4 text-muted">{order.reason ?? (typeof order.pnl === "number" ? `P/L ${order.pnl.toFixed(2)}` : "模拟成交")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionTitle title="统一资金流水" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">时间</th>
                <th className="px-5 py-3 font-medium">用户</th>
                <th className="px-5 py-3 font-medium">账户</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">金额</th>
                <th className="px-5 py-3 font-medium">资产</th>
                <th className="px-5 py-3 font-medium">余额变化</th>
                <th className="px-5 py-3 font-medium">冻结变化</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">备注</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ledger.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={10}>暂无资金流水。</td></tr>
              ) : ledger.slice(0, 40).map((entry) => (
                <tr key={entry.id}>
                  <td className="px-5 py-4 text-muted">{new Date(entry.createdAt).toLocaleString("zh-CN")}</td>
                  <td className="px-5 py-4 font-mono text-xs">{entry.userId}</td>
                  <td className="px-5 py-4">{entry.accountType === "funding" ? "资金账户" : "交易账户"}</td>
                  <td className="px-5 py-4">{formatLedgerType(entry.type)}</td>
                  <td className="px-5 py-4">{entry.amount.toFixed(2)}</td>
                  <td className="px-5 py-4">{entry.asset}</td>
                  <td className="px-5 py-4 text-muted">{entry.balanceBefore.toFixed(2)} → {entry.balanceAfter.toFixed(2)}</td>
                  <td className="px-5 py-4 text-muted">{entry.frozenBefore.toFixed(2)} → {entry.frozenAfter.toFixed(2)}</td>
                  <td className="px-5 py-4"><LedgerBadge status={entry.status} /></td>
                  <td className="px-5 py-4 text-muted">{entry.remark || entry.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
