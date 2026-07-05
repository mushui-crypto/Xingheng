import { useEffect, useState } from "react";
import { Globe2 } from "lucide-react";
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
  type OnchainDepositStatus,
  type WalletAccounts,
  type WithdrawalRequest,
} from "../../api/walletApi";
import { useSymbolStore } from "../../store/symbolStore";
import { formatPrice } from "../../utils/price";

const bscTestnetLabel = "BNB Smart Chain Testnet";
const requiredConfirmations = 1;

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
                    <StackedChainText primary={formatNetwork(withdrawal.network)} secondary={withdrawal.walletAddress} />
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
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">API Symbol</th>
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
                  <td className="px-5 py-4 text-muted">{item.apiSymbol}</td>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold">{value}</p>
    </Card>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold">{title}</h2>
    </div>
  );
}

function RecordHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border-b border-line p-4">
      <h2 className="font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mx-auto max-w-md border border-white/10 bg-white/[0.025] p-5 text-center">
      <p className="font-medium text-white">{title}</p>
      {description ? <p className="mt-2 text-sm leading-6 text-muted">{description}</p> : null}
    </div>
  );
}

function InlineState({
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

function formatLedgerType(type: FundingLedgerEntry["type"]) {
  const labels: Record<FundingLedgerEntry["type"], string> = {
    deposit: "充值",
    withdrawal_freeze: "提现冻结",
    withdrawal_approved: "提现通过",
    withdrawal_rejected: "提现拒绝",
    transfer_in: "转入",
    transfer_out: "转出",
    internal_transfer_in: "内部转入",
    internal_transfer_out: "内部转出",
    adjustment: "调整",
  };
  return labels[type];
}

function LedgerBadge({ status }: { status: FundingLedgerEntry["status"] }) {
  const tone = status === "completed" ? "success" : status === "rejected" ? "danger" : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

function WithdrawalBadge({ status }: { status: WithdrawalRequest["status"] | OnchainDepositStatus }) {
  const tone = status === "confirmed" ? "success" : status === "rejected" || status === "failed" ? "danger" : "neutral";
  return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

function StatusCell({ status }: { status: WithdrawalRequest["status"] | OnchainDepositStatus }) {
  return (
    <div className="space-y-1">
      <WithdrawalBadge status={status} />
      <p className="text-xs leading-5 text-muted">{formatStatusHint(status)}</p>
    </div>
  );
}

function formatStatus(status: FundingLedgerEntry["status"] | WithdrawalRequest["status"] | OnchainDepositStatus) {
  const labels: Record<string, string> = {
    pending: "处理中",
    completed: "已完成",
    rejected: "已拒绝",
    pending_review: "待审核",
    broadcasting: "广播中",
    broadcasted: "已广播",
    confirmed: "已确认",
    failed: "失败",
    detected: "已检测",
    confirming: "确认中",
  };
  return labels[status] ?? status;
}

function formatStatusHint(status: WithdrawalRequest["status"] | OnchainDepositStatus) {
  const hints: Record<string, string> = {
    pending_review: "等待人工审核",
    broadcasting: "准备提交链上",
    broadcasted: "已提交链上",
    confirmed: "链上已确认",
    failed: "失败后需排查",
    rejected: "已释放冻结",
    detected: "已扫到交易",
    confirming: "等待区块确认",
  };
  return hints[status] ?? "等待同步";
}

function AddressText({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="break-all font-mono text-xs text-muted">{value}</span>;
}

function StackedChainText({ primary, secondary }: { primary: string; secondary?: string | null }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-white">{primary}</p>
      <AddressText value={secondary} />
    </div>
  );
}

function formatConfirmations(value: number) {
  return `${value} / ${requiredConfirmations}`;
}

function formatNetwork(value?: string | null) {
  return value === "BSC_TESTNET" ? bscTestnetLabel : value ?? "-";
}

function formatAssetAmount(value: number | undefined | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

function renderTxLink(txHash?: string | null) {
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

function renderReason(value?: string | null) {
  if (!value) {
    return <span className="text-muted">-</span>;
  }
  return <span className="block max-w-[240px] text-sm leading-5 text-amber-100">{value}</span>;
}

function shortenHash(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}
