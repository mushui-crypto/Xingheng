import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, LoaderCircle, RefreshCw, WalletCards } from "lucide-react";
import {
  AccountReadRequestError,
  fetchAccountRead,
  type AccountReadSnapshot,
} from "../../../api/accountRead";
import type { ExchangeVenue } from "../../../api/exchangeCredentials";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { exchangeVenues } from "../model/personalTradingState";
import {
  accountFailureLabel,
  accountModeLabel,
  accountTypeLabel,
  estimatedTotalValue,
  estimatedValue,
  formatNumber,
  formatSyncTime,
  nullableAmount,
  permissionLabel,
} from "../model/accountReadPresentation";

export type VenueState =
  | { status: "loading" }
  | { status: "success"; snapshot: AccountReadSnapshot }
  | { status: "error"; error: AccountReadRequestError };

const venues = exchangeVenues.map(({ venue, label }) => ({ venue, label }));

export function AccountReadOverview() {
  const [states, setStates] = useState<Record<ExchangeVenue, VenueState>>(() => loadingStates());
  const [selectedVenue, setSelectedVenue] = useState<ExchangeVenue | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controllers = new Map<ExchangeVenue, AbortController>();
    for (const { venue } of venues) {
      const controller = new AbortController();
      controllers.set(venue, controller);
      setStates((current) => ({ ...current, [venue]: { status: "loading" } }));
      void fetchAccountRead(venue, controller.signal)
        .then((snapshot) => {
          if (!controller.signal.aborted) {
            setStates((current) => ({ ...current, [venue]: { status: "success", snapshot } }));
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const presented = error instanceof AccountReadRequestError
            ? error
            : new AccountReadRequestError("unavailable", "账户读取暂时不可用");
          setStates((current) => ({ ...current, [venue]: { status: "error", error: presented } }));
        });
    }
    return () => controllers.forEach((controller) => controller.abort());
  }, [reloadToken]);

  const selected = selectedVenue ? states[selectedVenue] : null;
  const selectedSnapshot = selected?.status === "success" ? selected.snapshot : null;
  const selectedLabel = venues.find(({ venue }) => venue === selectedVenue)?.label ?? "交易所";

  return (
    <section className="border border-[#25282f] bg-[#0b0d11]" aria-labelledby="account-overview-title">
      <header className="flex flex-col gap-3 border-b border-[#25282f] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white" id="account-overview-title">
            <WalletCards size={16} aria-hidden="true" /> 交易所账户概览
          </h2>
          <p className="mt-1 text-xs leading-5 text-[#8f99a5]">通过统一只读边界分别加载四个交易所的真实账户数据。</p>
        </div>
        <Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="secondary">
          <RefreshCw size={14} /> 刷新账户
        </Button>
      </header>

      <AccountReadCards onOpen={setSelectedVenue} states={states} />

      <Modal
        bodyClassName="max-h-[75vh] overflow-y-auto"
        description="以下数据来自当前交易所的只读账户接口。"
        onClose={() => setSelectedVenue(null)}
        open={Boolean(selectedSnapshot)}
        shellClassName="max-w-5xl"
        title={`${selectedLabel} 账户详情`}
      >
        {selectedSnapshot ? <AccountDetail label={selectedLabel} snapshot={selectedSnapshot} /> : null}
      </Modal>
    </section>
  );
}

export function AccountReadCards({ onOpen, states }: { onOpen: (venue: ExchangeVenue) => void; states: Record<ExchangeVenue, VenueState> }) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
      {venues.map(({ venue, label }) => (
        <AccountCard key={venue} label={label} onOpen={() => onOpen(venue)} state={states[venue]} />
      ))}
    </div>
  );
}

function AccountCard({ label, onOpen, state }: { label: string; onOpen: () => void; state: VenueState }) {
  if (state.status === "loading") {
    return (
      <article className="min-h-48 border border-[#25282f] bg-black p-4" aria-label={`${label} 账户加载中`}>
        <div className="flex items-center justify-between"><strong className="text-sm text-white">{label}</strong><LoaderCircle className="animate-spin text-[#8f99a5]" size={16} /></div>
        <p className="mt-8 text-xs text-[#8f99a5]">正在读取账户数据…</p>
      </article>
    );
  }
  if (state.status === "error") {
    return (
      <article className="min-h-48 border border-red-400/25 bg-red-500/[0.04] p-4">
        <div className="flex items-center justify-between"><strong className="text-sm text-white">{label}</strong><AlertTriangle className="text-red-300" size={16} /></div>
        <p className="mt-6 text-sm font-medium text-red-200">账户读取失败</p>
        <p className="mt-2 text-xs leading-5 text-[#aab3bd]">{accountFailureLabel(state.error.kind)}</p>
      </article>
    );
  }
  const { snapshot } = state;
  return (
    <button className="min-h-48 border border-[#25282f] bg-black p-4 text-left outline-none transition hover:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40" onClick={onOpen} type="button">
      <div className="flex items-center justify-between"><strong className="text-sm text-white">{label}</strong><CheckCircle2 className="text-emerald-300" size={16} /></div>
      <dl className="mt-4 space-y-2 text-xs">
        <CardRow label="连接状态" value="已连接" />
        <CardRow label="凭证验证" value="已验证" />
        <CardRow label="账户模式" value={accountModeLabel(snapshot)} />
        <CardRow label="估算总资产" value={estimatedTotalValue(snapshot)} />
        <CardRow label="最近同步" value={formatSyncTime(snapshot.latestSyncAt)} />
      </dl>
    </button>
  );
}

export function AccountDetail({ label, snapshot }: { label: string; snapshot: AccountReadSnapshot }) {
  return (
    <div className="space-y-5">
      <dl className="grid gap-px border border-[#25282f] bg-[#25282f] sm:grid-cols-2 lg:grid-cols-3">
        <DetailItem label="交易所" value={label} />
        <DetailItem label="Account ID" value={snapshot.accountId} />
        <DetailItem label="账户指纹" value={snapshot.accountFingerprint} />
        <DetailItem label="账户模式" value={accountModeLabel(snapshot)} />
        <DetailItem label="连接状态" value="已连接" />
        <DetailItem label="凭证验证状态" value="已验证" />
        <DetailItem label="只读权限" value={permissionLabel(snapshot.permissions.read)} />
        <DetailItem label="现货交易权限" value={permissionLabel(snapshot.permissions.spotTrade)} />
        <DetailItem label="衍生品交易权限" value={permissionLabel(snapshot.permissions.derivativesTrade)} />
        <DetailItem label="提现权限" value={permissionLabel(snapshot.permissions.withdraw)} />
        <DetailItem label="IP 限制" value={permissionLabel(snapshot.permissions.ipRestricted)} />
        <DetailItem label="最近同步时间" value={formatSyncTime(snapshot.latestSyncAt)} />
      </dl>

      <div>
        <h3 className="text-sm font-semibold text-white">账户余额</h3>
        {snapshot.balances.length === 0 ? <p className="mt-3 border border-[#25282f] p-4 text-xs text-[#8f99a5]">当前没有非零余额。</p> : (
          <div className="mt-3 overflow-x-auto border border-[#25282f]">
            <table className="min-w-[760px] w-full text-left text-xs">
              <thead className="border-b border-[#25282f] bg-black text-[#8f99a5]"><tr>{["资产", "账户类型", "可用", "冻结 / 锁定", "总量", "USDT 估值"].map((item) => <th className="px-3 py-3 font-medium" key={item}>{item}</th>)}</tr></thead>
              <tbody className="divide-y divide-[#25282f]">
                {snapshot.balances.map((balance) => (
                  <tr key={`${balance.accountType}:${balance.asset}`}>
                    <td className="px-3 py-3 font-semibold text-white">{balance.asset}</td>
                    <td className="px-3 py-3 text-[#c5ccd4]">{accountTypeLabel(balance.accountType)}</td>
                    <td className="px-3 py-3 font-mono text-[#c5ccd4]">{nullableAmount(balance.available)}</td>
                    <td className="px-3 py-3 font-mono text-[#c5ccd4]">{nullableAmount(balance.locked)}</td>
                    <td className="px-3 py-3 font-mono text-white">{formatNumber(balance.total)}</td>
                    <td className="px-3 py-3 font-mono text-[#c5ccd4]">{estimatedValue(balance.estimatedValueUsdt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2 border border-white/15 bg-white/[0.03] p-3 text-xs leading-5 text-[#aab3bd]">
        <CircleHelp className="mt-0.5 shrink-0" size={15} /> 权限状态仅反映交易所接口可以可靠确认的信息；“无法确认”不代表已启用或未启用。
      </div>
    </div>
  );
}

function CardRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3"><dt className="text-[#707985]">{label}</dt><dd className="break-all text-right text-[#c5ccd4]">{value}</dd></div>;
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-[#0b0d11] p-3"><dt className="text-[11px] text-[#8f99a5]">{label}</dt><dd className="mt-1 break-all font-mono text-sm text-white">{value}</dd></div>;
}

function loadingStates(): Record<ExchangeVenue, VenueState> {
  return { binance: { status: "loading" }, okx: { status: "loading" }, bybit: { status: "loading" }, bitget: { status: "loading" } };
}
