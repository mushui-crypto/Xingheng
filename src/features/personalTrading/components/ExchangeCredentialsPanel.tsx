import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Pencil, ShieldAlert, Trash2 } from "lucide-react";
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

type SecretForm = { apiKey: string; apiSecret: string; passphrase: string };
const emptyForm: SecretForm = { apiKey: "", apiSecret: "", passphrase: "" };

export function ExchangeCredentialsPanel({
  onBinanceChanged,
  onSummariesChanged,
  onVenueSelect,
  selectedVenue,
}: {
  onBinanceChanged: () => void;
  onSummariesChanged?: (summaries: ExchangeCredentialSummary[]) => void;
  onVenueSelect: (venue: ExchangeVenue) => void;
  selectedVenue: ExchangeVenue;
}) {
  const [summaries, setSummaries] = useState<ExchangeCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingVenue, setEditingVenue] = useState<ExchangeVenue | null>(null);
  const [deletingVenue, setDeletingVenue] = useState<ExchangeVenue | null>(null);
  const [form, setForm] = useState<SecretForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const venues = useMemo(() => mergeCredentialSummaries(summaries), [summaries]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchExchangeCredentials(controller.signal)
      .then((items) => {
        const nextSummaries = Array.isArray(items) ? items : [];
        setSummaries(nextSummaries);
        onSummariesChanged?.(nextSummaries);
        setError("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "交易所 API 配置加载失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const openEditor = (venue: ExchangeVenue) => {
    setForm(emptyForm);
    setError("");
    setEditingVenue(venue);
  };

  const closeEditor = () => {
    if (saving) return;
    setForm(emptyForm);
    setEditingVenue(null);
  };

  const save = async () => {
    const needsPassphrase = exchangeVenues.find((item) => item.venue === editingVenue)?.needsPassphrase === true;
    if (!editingVenue || !form.apiKey.trim() || !form.apiSecret.trim() || (needsPassphrase && !form.passphrase.trim())) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveExchangeCredential(editingVenue, {
        apiKey: form.apiKey.trim(),
        apiSecret: form.apiSecret.trim(),
        ...(form.passphrase.trim() ? { passphrase: form.passphrase.trim() } : {}),
      });
      setSummaries((current) => {
        const nextSummaries = [...current.filter((item) => item.venue !== saved.venue), saved];
        onSummariesChanged?.(nextSummaries);
        return nextSummaries;
      });
      setEditingVenue(null);
      if (saved.venue === "binance") onBinanceChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "交易所 API 配置保存失败。");
    } finally {
      setForm(emptyForm);
      setSaving(false);
    }
  };

  const remove = async (venue: ExchangeVenue) => {
    setDeletingVenue(venue);
    setError("");
    try {
      const deleted = await deleteExchangeCredential(venue);
      setSummaries((current) => {
        const nextSummaries = [...current.filter((item) => item.venue !== venue), deleted];
        onSummariesChanged?.(nextSummaries);
        return nextSummaries;
      });
      if (venue === "binance") onBinanceChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "交易所 API 配置删除失败。");
    } finally {
      setDeletingVenue(null);
    }
  };

  const venueConfig = exchangeVenues.find((item) => item.venue === editingVenue);

  return (
    <section className="border border-[#25282f] bg-[#0b0d11]" aria-labelledby="credential-settings-title">
      <header className="flex flex-col gap-3 border-b border-[#25282f] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white" id="credential-settings-title">
            <KeyRound size={16} aria-hidden="true" /> 交易所 API
          </h2>
          <p className="mt-1 text-xs leading-5 text-[#8f99a5]">凭证仅在本次输入中发送，页面不会保存或回显 Secret。</p>
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-2 border-b border-red-400/30 bg-red-500/[0.08] px-4 py-3 text-xs leading-5 text-red-200" role="alert">
          <ShieldAlert className="mt-0.5 shrink-0" size={15} /> {error}
        </div>
      ) : null}

      {loading ? <CredentialSkeleton /> : (
        <div className="divide-y divide-[#25282f]">
          {venues.map((summary) => {
            const config = exchangeVenues.find((item) => item.venue === summary.venue)!;
            const selected = summary.venue === selectedVenue;
            return (
              <div className={`flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${selected ? "bg-white/[0.04] ring-1 ring-inset ring-white/15" : ""}`} key={summary.venue}>
                <button
                  aria-pressed={selected}
                  className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  onClick={() => onVenueSelect(summary.venue)}
                  type="button"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm text-white">{config.label}</strong>
                    <StatusLabel configured={summary.configured} implemented={summary.implemented} />
                  </div>
                  <p className="mt-1 break-words font-mono text-xs text-[#8f99a5]">
                    {summary.configured ? `${summary.maskedApiKey ?? "已配置"} · ${summary.accountFingerprint ?? summary.accountId ?? "账户已验证"}` : summary.message ?? "尚未配置"}
                  </p>
                  {summary.lastVerifiedAt ? <p className="mt-1 text-[11px] text-[#707985]">验证于 {formatDate(summary.lastVerifiedAt)}</p> : null}
                </button>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {!summary.configured ? (
                    <Button disabled={!summary.implemented} onClick={() => openEditor(summary.venue)} type="button" variant="secondary">
                      <Pencil size={14} /> 配置
                    </Button>
                  ) : (
                    <Button disabled={deletingVenue === summary.venue} onClick={() => void remove(summary.venue)} type="button" variant="danger">
                      <Trash2 size={14} /> {deletingVenue === summary.venue ? "删除中" : "删除"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        closeDisabled={saving}
        description={editingVenue === "binance"
          ? "保存前会由服务端验证并绑定当前登录用户。已有 Secret 不会回显。"
          : "当前交易所仅加密保存 API 凭证，不执行私有接口验证或交易动作。已有 Secret 不会回显。"}
        onClose={closeEditor}
        open={Boolean(editingVenue)}
        title={`配置 ${venueConfig?.label ?? "交易所"} API`}
      >
        <div className="space-y-4">
          <Input autoComplete="off" label="API Key" onChange={(event) => setForm((value) => ({ ...value, apiKey: event.target.value }))} type="text" value={form.apiKey} />
          <Input autoComplete="new-password" label="API Secret" onChange={(event) => setForm((value) => ({ ...value, apiSecret: event.target.value }))} type="password" value={form.apiSecret} />
          {venueConfig?.needsPassphrase ? (
            <Input autoComplete="new-password" label="Passphrase" onChange={(event) => setForm((value) => ({ ...value, passphrase: event.target.value }))} type="password" value={form.passphrase} />
          ) : null}
          <div className="flex flex-col-reverse gap-2 border-t border-[#25282f] pt-4 sm:flex-row sm:justify-end">
            <Button disabled={saving} onClick={closeEditor} type="button" variant="ghost">取消</Button>
            <Button disabled={saving || !form.apiKey.trim() || !form.apiSecret.trim() || (venueConfig?.needsPassphrase && !form.passphrase.trim())} onClick={() => void save()} type="button">
              {saving ? (editingVenue === "binance" ? "验证并保存中" : "加密保存中") : (editingVenue === "binance" ? "验证并保存" : "加密保存")}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

function StatusLabel({ configured, implemented }: { configured: boolean; implemented: boolean }) {
  if (!implemented) return <span className="border border-white/15 px-2 py-0.5 text-[11px] text-[#8f99a5]">暂未接入</span>;
  return configured ? (
    <span className="inline-flex items-center gap-1 border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[11px] text-emerald-200"><CheckCircle2 size={11} /> 已配置</span>
  ) : <span className="border border-amber-400/30 bg-amber-400/[0.07] px-2 py-0.5 text-[11px] text-amber-200">待配置</span>;
}

function CredentialSkeleton() {
  return <div className="space-y-px bg-[#25282f]" aria-label="正在加载交易所 API 配置">{[0, 1, 2, 3].map((item) => <div className="h-[76px] animate-pulse bg-[#0b0d11]" key={item} />)}</div>;
}

function formatDate(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
