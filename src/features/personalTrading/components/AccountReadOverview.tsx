import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, LoaderCircle, MoreHorizontal, RefreshCw, ShieldAlert, Trash2, WalletCards } from "lucide-react";
import {
  AccountReadRequestError,
  fetchAccountRead,
  type AccountReadSnapshot,
} from "../../../api/accountRead";
import {
  deleteExchangeCredential,
  fetchExchangeCredentials,
  saveExchangeCredential,
  type ExchangeCredentialSummary,
  type ExchangeVenue,
} from "../../../api/exchangeCredentials";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Modal } from "../../../components/ui/Modal";
import { exchangeVenues, mergeCredentialSummaries } from "../model/personalTradingState";
import { BinanceAccountDiagnostics } from "./BinanceAccountDiagnostics";
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

type SecretForm = { apiKey: string; apiSecret: string; passphrase: string };
const emptyForm: SecretForm = { apiKey: "", apiSecret: "", passphrase: "" };

export function AccountReadOverview({ onBinanceChanged = () => undefined }: { onBinanceChanged?: () => void }) {
  const [states, setStates] = useState<Record<ExchangeVenue, VenueState>>(() => loadingStates());
  const [credentialSummaries, setCredentialSummaries] = useState<ExchangeCredentialSummary[]>([]);
  const [credentialsLoading, setCredentialsLoading] = useState(true);
  const [credentialError, setCredentialError] = useState("");
  const [selectedVenue, setSelectedVenue] = useState<ExchangeVenue | null>(null);
  const [editingVenue, setEditingVenue] = useState<ExchangeVenue | null>(null);
  const [deletingVenue, setDeletingVenue] = useState<ExchangeVenue | null>(null);
  const [confirmDeleteVenue, setConfirmDeleteVenue] = useState<ExchangeVenue | null>(null);
  const [form, setForm] = useState<SecretForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const summaries = useMemo(() => mergeCredentialSummaries(credentialSummaries), [credentialSummaries]);

  useEffect(() => {
    const controller = new AbortController();
    setCredentialsLoading(true);
    void fetchExchangeCredentials(controller.signal).then((items) => {
      if (!controller.signal.aborted) {
        setCredentialSummaries(items);
        setCredentialError("");
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) setCredentialError(reason instanceof Error ? reason.message : "交易所 API 配置加载失败。");
    }).finally(() => {
      if (!controller.signal.aborted) setCredentialsLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controllers = new Map<ExchangeVenue, AbortController>();
    for (const { venue } of venues) {
      const controller = new AbortController();
      controllers.set(venue, controller);
      setStates((current) => ({ ...current, [venue]: { status: "loading" } }));
      void fetchAccountRead(venue, { signal: controller.signal })
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
  const selectedConfigured = summaries.find((item) => item.venue === selectedVenue)?.configured === true;
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

      {credentialError ? <div className="flex items-start gap-2 border-b border-red-400/30 bg-red-500/[0.08] px-4 py-3 text-xs leading-5 text-red-200" role="alert"><ShieldAlert className="mt-0.5 shrink-0" size={15} />{credentialError}</div> : null}

      <AccountReadCards
        credentialsLoading={credentialsLoading}
        onConfigure={(venue) => { setForm(emptyForm); setCredentialError(""); setEditingVenue(venue); }}
        onDelete={setConfirmDeleteVenue}
        onOpen={setSelectedVenue}
        states={states}
        summaries={summaries}
      />

      <Modal
        bodyClassName="max-h-[75vh] overflow-y-auto"
        description="以下数据来自当前交易所的只读账户接口。"
        onClose={() => setSelectedVenue(null)}
        open={Boolean(selectedVenue && selectedConfigured)}
        shellClassName="max-w-5xl"
        title={`${selectedLabel} 账户详情`}
      >
        <div className="space-y-5">
          {selectedSnapshot ? <AccountDetail label={selectedLabel} snapshot={selectedSnapshot} /> : <div className="flex items-center gap-2 border border-amber-400/25 bg-amber-500/[0.05] p-4 text-xs text-amber-100"><AlertTriangle size={15} />通用账户快照暂时不可用，仍可查看该交易所已有的独立诊断数据。</div>}
          {selectedVenue === "binance" ? <BinanceAccountDiagnostics /> : null}
        </div>
      </Modal>

      <CredentialEditorModal
        error={credentialError}
        form={form}
        onChange={setForm}
        onClose={() => { if (!saving) { setEditingVenue(null); setForm(emptyForm); } }}
        onSave={async () => {
          if (!editingVenue) return;
          const venueConfig = exchangeVenues.find((item) => item.venue === editingVenue);
          if (!form.apiKey.trim() || !form.apiSecret.trim() || (venueConfig?.needsPassphrase && !form.passphrase.trim())) return;
          setSaving(true);
          setCredentialError("");
          try {
            const saved = await saveExchangeCredential(editingVenue, {
              apiKey: form.apiKey.trim(), apiSecret: form.apiSecret.trim(),
              ...(form.passphrase.trim() ? { passphrase: form.passphrase.trim() } : {}),
            });
            setCredentialSummaries((current) => [...current.filter((item) => item.venue !== saved.venue), saved]);
            setEditingVenue(null);
            setForm(emptyForm);
            setReloadToken((value) => value + 1);
            if (saved.venue === "binance") onBinanceChanged();
          } catch (reason) {
            setCredentialError(reason instanceof Error ? reason.message : "交易所 API 配置保存失败。");
          } finally {
            setSaving(false);
          }
        }}
        saving={saving}
        venue={editingVenue}
      />

      <Modal
        closeDisabled={deletingVenue !== null}
        description="删除后 StellaX 将无法继续读取该交易所账户数据。此操作不会修改交易所账户中的资产或仓位。"
        onClose={() => setConfirmDeleteVenue(null)}
        open={Boolean(confirmDeleteVenue)}
        title={`删除 ${venueLabel(confirmDeleteVenue)} API 配置`}
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={deletingVenue !== null} onClick={() => setConfirmDeleteVenue(null)} type="button" variant="ghost">取消</Button>
          <Button disabled={deletingVenue !== null} onClick={async () => {
            if (!confirmDeleteVenue) return;
            const venue = confirmDeleteVenue;
            setDeletingVenue(venue);
            setCredentialError("");
            try {
              const deleted = await deleteExchangeCredential(venue);
              setCredentialSummaries((current) => [...current.filter((item) => item.venue !== venue), deleted]);
              setConfirmDeleteVenue(null);
              setSelectedVenue((current) => current === venue ? null : current);
              setReloadToken((value) => value + 1);
              if (venue === "binance") onBinanceChanged();
            } catch (reason) {
              setCredentialError(reason instanceof Error ? reason.message : "交易所 API 配置删除失败。");
            } finally {
              setDeletingVenue(null);
            }
          }} type="button" variant="danger"><Trash2 size={14} />{deletingVenue ? "删除中" : "确认删除"}</Button>
        </div>
      </Modal>
    </section>
  );
}

export function AccountReadCards({ credentialsLoading = false, onConfigure, onDelete, onOpen, states, summaries }: {
  credentialsLoading?: boolean;
  onConfigure: (venue: ExchangeVenue) => void;
  onDelete: (venue: ExchangeVenue) => void;
  onOpen: (venue: ExchangeVenue) => void;
  states: Record<ExchangeVenue, VenueState>;
  summaries: ExchangeCredentialSummary[];
}) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
      {venues.map(({ venue, label }) => (
        <AccountCard credentialsLoading={credentialsLoading} key={venue} label={label} onConfigure={() => onConfigure(venue)} onDelete={() => onDelete(venue)} onOpen={() => onOpen(venue)} state={states[venue]} summary={summaries.find((item) => item.venue === venue)!} />
      ))}
    </div>
  );
}

function AccountCard({ credentialsLoading, label, onConfigure, onDelete, onOpen, state, summary }: {
  credentialsLoading: boolean; label: string; onConfigure: () => void; onDelete: () => void; onOpen: () => void; state: VenueState; summary: ExchangeCredentialSummary;
}) {
  const configured = summary?.configured === true;
  const snapshot = state.status === "success" ? state.snapshot : null;
  const connection = credentialsLoading ? "加载中" : !configured ? "未配置" : state.status === "loading" ? "连接中" : state.status === "success" ? "已连接" : "读取失败";
  return (
    <article className={`relative min-h-48 border bg-black p-4 ${configured && state.status === "error" ? "border-red-400/25" : "border-[#25282f]"}`}>
      <div className="flex min-h-9 items-start justify-between gap-3">
        <div><strong className="text-sm text-white">{label}</strong><p className={`mt-1 text-[11px] ${connection === "已连接" ? "text-emerald-200" : connection === "读取失败" ? "text-red-200" : "text-[#8f99a5]"}`}>{connection}</p></div>
        {credentialsLoading ? <LoaderCircle className="animate-spin text-[#8f99a5]" size={16} /> : configured ? <AccountCardMenu onDelete={onDelete} onOpen={onOpen} /> : <button className="min-h-9 border border-white/25 px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-white transition hover:border-white hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50" disabled={!summary?.implemented} onClick={onConfigure} type="button">配置 API</button>}
      </div>
      <dl className="mt-5 space-y-3 text-xs">
        <CardRow label="连接状态" value={connection} />
        <CardRow label="最近同步时间" value={snapshot ? formatSyncTime(snapshot.latestSyncAt) : "暂无可靠数据"} />
        <CardRow label="预估总资产" value={snapshot ? estimatedTotalValue(snapshot) : "暂无可靠数据"} />
      </dl>
      {configured && state.status === "error" ? <p className="mt-3 text-[11px] leading-4 text-red-200">{accountFailureLabel(state.error.kind)}</p> : null}
    </article>
  );
}

function AccountCardMenu({ onDelete, onOpen }: { onDelete: () => void; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return (
    <div className="relative" ref={rootRef}>
      <button aria-expanded={open} aria-haspopup="menu" aria-label="更多账户操作" className="flex size-9 items-center justify-center border border-transparent text-[#8f99a5] outline-none transition hover:border-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40" onClick={() => setOpen((value) => !value)} type="button"><MoreHorizontal size={18} /></button>
      {open ? <div className="absolute right-0 top-10 z-20 min-w-36 border border-[#30343b] bg-[#0b0d11] py-1 shadow-2xl" role="menu">
        <button className="block w-full px-3 py-2 text-left text-xs text-[#d7dce2] hover:bg-white/[0.06] focus:bg-white/[0.06] focus:outline-none" onClick={() => { setOpen(false); onOpen(); }} role="menuitem" type="button">账户详情</button>
        <button className="block w-full px-3 py-2 text-left text-xs text-red-200 hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none" onClick={() => { setOpen(false); onDelete(); }} role="menuitem" type="button">删除 API 配置</button>
      </div> : null}
    </div>
  );
}

function CredentialEditorModal({ error, form, onChange, onClose, onSave, saving, venue }: {
  error: string; form: SecretForm; onChange: (form: SecretForm) => void; onClose: () => void; onSave: () => void; saving: boolean; venue: ExchangeVenue | null;
}) {
  const config = exchangeVenues.find((item) => item.venue === venue);
  return <Modal closeDisabled={saving} description={venue === "binance" ? "保存前会由服务端验证并绑定当前登录用户。Secret 不会回显。" : "凭证将加密保存，Secret 不会回显。"} onClose={onClose} open={Boolean(venue)} title={`配置 ${config?.label ?? "交易所"} API`}>
    <div className="space-y-4">
      {error ? <div className="flex items-start gap-2 border border-red-400/30 bg-red-500/[0.08] p-3 text-xs leading-5 text-red-200" role="alert"><ShieldAlert className="mt-0.5 shrink-0" size={15} />{error}</div> : null}
      <Input autoComplete="off" label="API Key" onChange={(event) => onChange({ ...form, apiKey: event.target.value })} type="text" value={form.apiKey} />
      <Input autoComplete="new-password" label="API Secret" onChange={(event) => onChange({ ...form, apiSecret: event.target.value })} type="password" value={form.apiSecret} />
      {config?.needsPassphrase ? <Input autoComplete="new-password" label="Passphrase" onChange={(event) => onChange({ ...form, passphrase: event.target.value })} type="password" value={form.passphrase} /> : null}
      <div className="flex flex-col-reverse gap-2 border-t border-[#25282f] pt-4 sm:flex-row sm:justify-end"><Button disabled={saving} onClick={onClose} type="button" variant="ghost">取消</Button><Button disabled={saving || !form.apiKey.trim() || !form.apiSecret.trim() || (config?.needsPassphrase && !form.passphrase.trim())} onClick={onSave} type="button">{saving ? "保存中" : venue === "binance" ? "验证并保存" : "加密保存"}</Button></div>
    </div>
  </Modal>;
}

function venueLabel(venue: ExchangeVenue | null) {
  return exchangeVenues.find((item) => item.venue === venue)?.label ?? "交易所";
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
