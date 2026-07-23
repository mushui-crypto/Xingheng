import { AlertTriangle, CheckCircle2, Clipboard, Clock3, ExternalLink, Eye, EyeOff, KeyRound, Plus, RotateCw, Trash2, XCircle } from "lucide-react";
import React, { useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import type { AutomationCredentialSummary, AutomationVenue, CredentialDraft } from "../model/controlConsoleTypes";
import { ConsoleSection, ScrollTable, StatusTag, formatDate, tableCellClass, tableHeadClass, tableHeaderCellClass, venueLabel } from "./AutomationConsoleShared";

const venueOrder: AutomationVenue[] = ["bybit", "bitget", "binance", "okx"];
const officialApiLinks: Record<AutomationVenue, string> = {
  bybit: "https://www.bybit.com/app/user/api-management",
  bitget: "https://www.bitget.com/account/newapi",
  binance: "https://www.binance.com/en/my/settings/api-management",
  okx: "https://www.okx.com/account/my-api",
};

type VenueDraft = Omit<CredentialDraft, "venue">;

export function AutomationCredentials({ credentials, onDelete, onFeedback, onGoToSafety, onValidate, productionEgressIps }: {
  credentials: AutomationCredentialSummary[];
  onDelete: (accountId: string) => Promise<void>;
  onValidate: (draft: CredentialDraft) => Promise<void>;
  onFeedback: (message: string, tone?: "error" | "info" | "success" | "warning") => void;
  onGoToSafety: () => void;
  productionEgressIps: string[];
}) {
  const credentialMap = useMemo(() => new Map(credentials.map((credential) => [credential.venue, credential])), [credentials]);
  const [open, setOpen] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState<AutomationVenue>("bybit");
  const [drafts, setDrafts] = useState<Record<AutomationVenue, VenueDraft>>(() => createDrafts(credentials));
  const [errors, setErrors] = useState<Partial<Record<AutomationVenue, string>>>({});
  const [savingVenue, setSavingVenue] = useState<AutomationVenue | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [rotationTarget, setRotationTarget] = useState<AutomationCredentialSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationCredentialSummary | null>(null);
  const [deletePhrase, setDeletePhrase] = useState("");
  const draft = drafts[selectedVenue];
  const selectedCredential = credentialMap.get(selectedVenue);
  const needsPassphrase = selectedVenue === "bitget" || selectedVenue === "okx";

  const openAuthorization = (venue: AutomationVenue = "bybit") => {
    if (!credentialMap.get(venue)?.canAuthorize) return;
    setDrafts(createDrafts(credentials));
    setErrors({});
    setSelectedVenue(venue);
    setShowSecret(false);
    setShowPassphrase(false);
    setOpen(true);
  };

  const closeAuthorization = () => {
    setOpen(false);
    setDrafts(createDrafts(credentials));
    setErrors({});
    setShowSecret(false);
    setShowPassphrase(false);
  };

  const switchVenue = (nextVenue: AutomationVenue) => {
    setDrafts((current) => ({
      ...current,
      [selectedVenue]: clearSensitiveDraft(current[selectedVenue]),
    }));
    setErrors((current) => ({ ...current, [selectedVenue]: undefined }));
    setSelectedVenue(nextVenue);
    setShowSecret(false);
    setShowPassphrase(false);
  };

  const updateDraft = <K extends keyof VenueDraft>(key: K, value: VenueDraft[K]) => {
    setDrafts((current) => ({ ...current, [selectedVenue]: { ...current[selectedVenue], [key]: value } }));
    setErrors((current) => ({ ...current, [selectedVenue]: undefined }));
  };

  const submit = async () => {
    setSavingVenue(selectedVenue);
    setErrors((current) => ({ ...current, [selectedVenue]: undefined }));
    try {
      await onValidate({ ...draft, venue: selectedVenue });
      closeAuthorization();
    } catch (error) {
      setErrors((current) => ({ ...current, [selectedVenue]: error instanceof Error ? error.message : "授权验证失败。" }));
      setDrafts((current) => ({ ...current, [selectedVenue]: clearSensitiveDraft(current[selectedVenue]) }));
    } finally {
      setSavingVenue(null);
      setShowSecret(false);
      setShowPassphrase(false);
    }
  };

  const copyIp = async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      onFeedback(`出口 IP ${ip} 已复制。`, "success");
    } catch {
      onFeedback("复制失败，请手动复制出口 IP。", "error");
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget?.accountId) return;
    setSavingVenue(deleteTarget.venue);
    try {
      await onDelete(deleteTarget.accountId);
      setDeleteTarget(null);
      setDeletePhrase("");
      setDrafts(createDrafts(credentials));
    } catch {
      // Parent feedback already exposes the contract error and preserves the old connection.
    } finally {
      setSavingVenue(null);
    }
  };

  return (
    <>
      <ConsoleSection
        title="API 账户"
        description="V1 每个 venue 限制一个账户；Bybit 为受控执行，Binance 第一阶段仅开放凭证验证与只读 Shadow 检查。"
        actions={<Button onClick={() => openAuthorization()} type="button"><Plus size={15} />添加 API 授权</Button>}
      >
        <div className="border-b border-sky-400/20 bg-sky-400/[0.05] px-4 py-3 text-xs leading-5 text-sky-100 sm:px-5">浏览器不持久化；正式接入通过登录用户 HTTPS 会话提交；服务端使用 AES-GCM 加密保存；Secret 不回显；主密钥由生产 Secret 管理。</div>
        <ScrollTable minWidth={1580}>
          <colgroup><col className="w-[100px]" /><col className="w-[180px]" /><col className="w-[150px]" /><col className="w-[160px]" /><col className="w-[240px]" /><col className="w-[220px]" /><col className="w-[150px]" /><col className="w-[170px]" /><col className="w-[120px]" /><col className="w-[180px]" /></colgroup>
          <thead className={tableHeadClass}><tr><th className={tableHeaderCellClass}>交易所</th><th className={tableHeaderCellClass}>状态 / 阶段</th><th className={tableHeaderCellClass}>Masked Key</th><th className={tableHeaderCellClass}>UID fingerprint</th><th className={tableHeaderCellClass}>权限</th><th className={tableHeaderCellClass}>产品可用性</th><th className={tableHeaderCellClass}>IP 白名单</th><th className={tableHeaderCellClass}>最近验证</th><th className={tableHeaderCellClass}>偏好</th><th className={`${tableHeaderCellClass} text-right`}>管理</th></tr></thead>
          <tbody>{credentials.map((credential) => {
            const hasExposure = credential.activeOrderCount > 0 || credential.openPositionCount > 0;
            const requiresManualExchangeAction = hasExposure && (credential.status === "expired" || credential.status === "revoked");
            const configured = credential.accountId !== null && credential.status !== "unconfigured";
            return <React.Fragment key={`${credential.venue}:${credential.accountId ?? "unconfigured"}`}><tr><td className={`${tableCellClass} font-semibold text-white`}>{venueLabel(credential.venue)}</td><td className={tableCellClass}><div className="space-y-1.5"><CredentialStatus status={credential.status} /><p className="text-xs text-muted">{credential.phaseLabel}</p>{credential.venue === "binance" ? <p className="text-xs text-amber-200">实盘执行未开放</p> : null}</div></td><td className={`${tableCellClass} font-mono`}>{credential.maskedKey ?? "-"}</td><td className={`${tableCellClass} font-mono`}>{credential.uidFingerprint ?? "-"}</td><td className={tableCellClass}>{configured ? <PermissionSummary credential={credential} /> : "-"}</td><td className={tableCellClass}><ProductAvailabilitySummary credential={credential} /></td><td className={tableCellClass}>{credential.ipWhitelistConfigured === true ? "已配置" : credential.ipWhitelistConfigured === false ? <span className="text-amber-200">未配置</span> : "-"}</td><td className={tableCellClass}>{credential.lastVerifiedAt ? formatDate(credential.lastVerifiedAt) : "-"}</td><td className={tableCellClass}>{credential.defaultExecutionAccount ? "默认执行" : configured ? credential.canExecute ? "执行账户" : "只读账户" : "-"}</td><td className={`${tableCellClass} text-right`}><div className="flex justify-end gap-2">{!credential.canAuthorize ? <Button className="min-h-9 px-3 py-2 text-xs" disabled type="button" variant="secondary">{credential.implemented ? "能力未知" : "暂未接入"}</Button> : <Button className="min-h-9 px-3 py-2 text-xs" onClick={() => credential.status === "unconfigured" ? openAuthorization(credential.venue) : setRotationTarget(credential)} type="button" variant="secondary">{credential.status === "unconfigured" ? <><KeyRound size={14} />配置</> : <><RotateCw size={14} />轮换</>}</Button>}{configured && credential.accountId ? hasExposure ? <Button className="min-h-9 px-3 py-2 text-xs" onClick={onGoToSafety} type="button" variant="danger">先退出仓位</Button> : <Button aria-label={`删除 ${venueLabel(credential.venue)} API 账户`} className="min-h-9 px-3 py-2 text-xs" onClick={() => { setDeleteTarget(credential); setDeletePhrase(""); }} type="button" variant="danger"><Trash2 size={14} /></Button> : null}</div></td></tr>{requiresManualExchangeAction ? <tr><td className="border-b border-red-400/20 bg-red-400/[0.055] px-4 py-3 text-sm text-red-100" colSpan={10}><AlertTriangle className="mr-2 inline" size={15} />凭证已失效且仍有风险敞口，自动退出不可用。请立即前往 {venueLabel(credential.venue)} 人工处理订单与仓位。</td></tr> : null}</React.Fragment>;
          })}</tbody>
        </ScrollTable>
      </ConsoleSection>

      <Modal bodyClassName="p-0" closeDisabled={savingVenue !== null} onClose={closeAuthorization} open={open} shellClassName="max-w-[1120px]" title="添加 API 授权" description="先选择交易所，再填写该 venue 专属字段。切换 venue 会清空离开页面的敏感字段。">
        <div className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto border-b border-white/10 px-4 py-3 sm:px-5" role="tablist" aria-label="选择交易所">
          {venueOrder.map((venue) => {
            const credential = credentialMap.get(venue);
            return <button aria-selected={selectedVenue === venue} className={`inline-flex min-h-11 shrink-0 items-center gap-2 border px-4 text-sm font-semibold transition ${selectedVenue === venue ? "border-white bg-white text-black" : "border-white/15 text-muted hover:border-white/50 hover:text-white"}`} disabled={!credential?.canAuthorize} key={venue} onClick={() => switchVenue(venue)} role="tab" type="button">{venueLabel(venue)}{credential?.status === "connected" ? <span className={`h-2 w-2 rounded-full ${selectedVenue === venue ? "bg-emerald-600" : "bg-emerald-300"}`} aria-label="已连接" /> : null}{!credential?.canAuthorize ? <span className="text-[10px] opacity-65">{credential?.implemented ? "能力未知" : "暂未接入"}</span> : credential.venue === "binance" ? <span className="text-[10px] opacity-70">只读</span> : null}</button>;
          })}
          <button className="min-h-11 shrink-0 border border-white/10 px-4 text-sm text-dim" disabled type="button">更多 Connector · 待接入</button>
        </div>

        <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <form className="min-w-0 space-y-4 p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-white">{venueLabel(selectedVenue)} 授权表单</h3><p className="mt-1 text-xs text-muted">{needsPassphrase ? "API Key + Secret + Passphrase" : "API Key + Secret"}</p></div><CredentialStatus status={selectedCredential?.status ?? "unconfigured"} /></div>
            {selectedCredential ? <VenueStageNotice credential={selectedCredential} /> : null}
            <Field label="API Key"><SensitiveInput onChange={(value) => updateDraft("apiKey", value)} show={false} toggle={null} value={draft.apiKey} /></Field>
            <Field label="Secret"><SensitiveInput onChange={(value) => updateDraft("secret", value)} onToggle={() => setShowSecret((current) => !current)} show={showSecret} value={draft.secret} /></Field>
            {needsPassphrase ? <Field label="Passphrase"><SensitiveInput onChange={(value) => updateDraft("passphrase", value)} onToggle={() => setShowPassphrase((current) => !current)} show={showPassphrase} value={draft.passphrase ?? ""} /></Field> : null}
            {selectedCredential?.ipWhitelistConfigured === false || selectedCredential?.ipWhitelistConfigured === null ? <div className="flex items-start gap-2 border border-amber-400/40 bg-amber-400/[0.07] p-3 text-xs leading-5 text-amber-100" role="status"><AlertTriangle className="mt-0.5 shrink-0" size={15} /><span><strong className="font-semibold">IP 白名单未确认</strong><br />仍可继续验证和保存，但 API 凭证暴露后的风险更高，强烈建议先在交易所绑定生产出口 IP。</span></div> : null}
            {errors[selectedVenue] ? <p className="border border-red-400/35 bg-red-400/[0.06] p-3 text-sm text-red-200" role="alert">{errors[selectedVenue]}</p> : null}
            <div className="border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-muted">浏览器不持久化。API Key 与 apiSecret 仅通过当前登录用户 HTTPS 会话提交；服务端验证失败不会覆盖旧连接，Secret 永不回显。</div>
            <Button className="w-full" disabled={savingVenue !== null || !draft.apiKey.trim() || !draft.secret.trim() || (needsPassphrase && !(draft.passphrase ?? "").trim())} type="submit">{savingVenue === selectedVenue ? "验证并保存中" : "验证并保存授权"}</Button>
          </form>

          <aside className="min-w-0 border-t border-white/10 bg-white/[0.018] p-4 sm:p-5 lg:border-l lg:border-t-0">
            <h3 className="text-sm font-semibold text-white">生产出口 IP（强烈建议）</h3><p className="mt-1 text-xs leading-5 text-muted">建议在交易所创建 API 时绑定生产出口 IP；不配置不会阻断保存。</p>
            <div className="mt-3 space-y-2">{productionEgressIps.length ? productionEgressIps.map((ip) => <div className="flex items-center justify-between gap-3 border border-white/10 bg-black px-3 py-2" key={ip}><code className="min-w-0 truncate text-xs text-slate-200">{ip}</code><button aria-label={`复制 ${ip}`} className="shrink-0 p-2 text-muted hover:text-white" onClick={() => void copyIp(ip)} type="button"><Clipboard size={15} /></button></div>) : <p className="border border-amber-400/30 bg-amber-400/[0.05] p-3 text-xs leading-5 text-amber-100">服务端当前未公布出口 IP，请在正式启用前向运维确认。</p>}</div>
            <a className="mt-4 inline-flex min-h-10 items-center gap-2 border border-white/20 px-3 text-xs font-semibold text-white transition hover:border-white" href={officialApiLinks[selectedVenue]} rel="noreferrer" target="_blank">打开 {venueLabel(selectedVenue)} 官方 API 管理<ExternalLink size={14} /></a>

            <div className="mt-6 border-t border-white/10 pt-5"><h3 className="text-sm font-semibold text-white">权限配置步骤</h3><ol className="mt-3 space-y-3 text-xs leading-5 text-muted"><li><strong className="mr-2 text-white">1.</strong>在官方 API 管理创建系统生成型 API，并设置独立备注。</li><li><strong className="mr-2 text-white">2.</strong>强烈建议绑定全部生产出口 IP，降低凭证泄漏风险。</li><li><strong className="mr-2 text-white">3.</strong>{selectedVenue === "binance" ? "开启读取、现货交易与 USD-M Futures 交易权限，并使用 one-way 持仓模式。" : "开启读取、现货交易与合约交易权限。"}</li><li><strong className="mr-2 text-white">4.</strong>确认提现权限关闭，再复制 Key、Secret{needsPassphrase ? " 与 Passphrase" : ""}。</li><li><strong className="mr-2 text-white">5.</strong>提交后等待服务端逐项验证，不以静态勾选代替验证。</li></ol></div>

            <div className="mt-6 border-t border-white/10 pt-5"><h3 className="text-sm font-semibold text-white">服务端验证结果</h3><div className="mt-3 space-y-2">{(selectedCredential?.verificationChecks ?? pendingChecks()).map((check) => <div className="flex items-start gap-2" key={check.id}>{check.status === "passed" ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-300" size={15} /> : check.status === "warning" ? <AlertTriangle className="mt-0.5 shrink-0 text-amber-200" size={15} /> : check.status === "failed" ? <XCircle className="mt-0.5 shrink-0 text-red-300" size={15} /> : <Clock3 className="mt-0.5 shrink-0 text-muted" size={15} />}<div><p className="text-xs font-medium text-slate-200">{check.label}</p><p className="mt-0.5 text-xs leading-5 text-dim">{check.message}</p></div></div>)}</div></div>
          </aside>
        </div>
      </Modal>

      <Modal onClose={() => setRotationTarget(null)} open={rotationTarget !== null} title={`轮换 ${rotationTarget ? venueLabel(rotationTarget.venue) : ""} API 凭证`} description="旧连接会一直保留，只有新凭证通过服务端真实签名与权限验证后才原子替换。">
        <div className="space-y-4"><div className="border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm leading-6 text-amber-100">新凭证验证失败不会覆盖旧 masked key、默认账户、权限或执行准备状态。</div><Button className="w-full" onClick={() => { if (rotationTarget) openAuthorization(rotationTarget.venue); setRotationTarget(null); }} type="button" variant="secondary"><RotateCw size={15} />继续轮换</Button></div>
      </Modal>

      <Modal closeDisabled={savingVenue !== null} onClose={() => setDeleteTarget(null)} open={deleteTarget !== null} title={`解绑 ${deleteTarget ? venueLabel(deleteTarget.venue) : ""} API 账户`} description="解绑成功后清空本页敏感草稿、默认账户与执行准备状态。">
        {deleteTarget ? <div className="space-y-4"><div className="border border-red-400/30 bg-red-400/[0.06] p-4 text-sm leading-6 text-red-100">只有服务端确认不存在活动订单和未平仓套利仓位时才允许解绑。Close-all 入口始终保留。</div><Field label={`输入“解绑 ${venueLabel(deleteTarget.venue)}”确认`}><input autoComplete="off" className="xh-account-modal-control" onChange={(event) => setDeletePhrase(event.target.value)} type="text" value={deletePhrase} /></Field><Button className="w-full" disabled={savingVenue !== null || deletePhrase !== `解绑 ${venueLabel(deleteTarget.venue)}`} onClick={() => void confirmDelete()} type="button" variant="danger">确认解绑</Button></div> : null}
      </Modal>
    </>
  );
}

function createDrafts(credentials: AutomationCredentialSummary[]): Record<AutomationVenue, VenueDraft> {
  const map = new Map(credentials.map((credential) => [credential.venue, credential]));
  return Object.fromEntries(venueOrder.map((venue): [AutomationVenue, VenueDraft] => {
    const credential = map.get(venue);
    return [venue, {
      accountId: credential && credential.status !== "unconfigured" ? credential.accountId : null,
      note: "",
      apiKey: "",
      secret: "",
      passphrase: "",
      ipWhitelist: [],
      defaultExecutionAccount: false,
      assetStatisticsEnabled: false,
    }];
  })) as Record<AutomationVenue, VenueDraft>;
}

function clearSensitiveDraft(draft: VenueDraft): VenueDraft { return { ...draft, apiKey: "", secret: "", passphrase: "" }; }
function CredentialStatus({ status }: { status: AutomationCredentialSummary["status"] }) {
  const labels: Record<AutomationCredentialSummary["status"], string> = { unconfigured: "未配置", validating: "校验中", connected: "已连接", permission_incomplete: "权限不完整", ip_unbound: "IP 未绑定", expired: "已失效", revoked: "已撤销", rotation_required: "需轮换", not_implemented: "暂未接入" };
  const tone = status === "connected" ? "success" : status === "validating" ? "info" : status === "unconfigured" || status === "not_implemented" ? "neutral" : status === "rotation_required" ? "warning" : "danger";
  return <StatusTag tone={tone}>{labels[status]}</StatusTag>;
}
function VenueStageNotice({ credential }: { credential: AutomationCredentialSummary }) {
  if (credential.venue !== "binance") {
    return <div className="border border-white/10 bg-white/[0.025] p-3 text-xs leading-5 text-muted">{credential.phaseLabel}。真实执行仍受账户、策略、preflight 和二次确认共同约束。</div>;
  }
  return (
    <div className="border border-amber-400/35 bg-amber-400/[0.06] p-3 text-xs leading-5 text-amber-100" role="status">
      <strong className="font-semibold">凭证与账户只读验证已接入</strong>
      <p className="mt-1 text-amber-100/80">实盘执行尚未开放。可保存并验证 Binance API，后续仅能查看 XAUT 双腿状态与触发 Shadow 条件检查，不会生成 challenge 或发送订单。</p>
      <div className="mt-3"><ProductAvailabilitySummary credential={credential} /></div>
    </div>
  );
}
function PermissionSummary({ credential }: { credential: AutomationCredentialSummary }) {
  const contractLabel = credential.venue === "binance" ? "USD-M" : "contract";
  return (
    <div className="space-y-1 text-xs leading-5">
      <p>{credential.permissions.read ? "read" : "no-read"} / {credential.permissions.spotTrade ? "spot" : "no-spot"} / {credential.permissions.contractTrade ? contractLabel : `no-${contractLabel}`}</p>
      {credential.venue === "binance" ? <p className="text-muted">{credential.permissions.positionModeSupported ? "one-way" : "非 one-way / 未确认"} · {credential.accountMode ? accountModeLabel(credential.accountMode) : "账户模式未确认"}</p> : null}
      <p className={credential.permissions.withdraw ? "text-red-300" : "text-emerald-300"}>{credential.permissions.withdraw ? "withdraw=true" : "withdraw=false"}</p>
    </div>
  );
}
function ProductAvailabilitySummary({ credential }: { credential: AutomationCredentialSummary }) {
  if (credential.venue !== "binance") return <span className="text-muted">按 connector 配置</span>;
  const availability = credential.productAvailability;
  if (!availability || availability.status === "unknown") return <span className="text-amber-200">XAUT 产品状态未知</span>;
  const spotAvailable = availability.status === "available" || availability.status === "perpetual_unavailable";
  const perpetualAvailable = availability.status === "available" || availability.status === "spot_unavailable";
  return (
    <div className="space-y-1 text-xs leading-5">
      <p className={spotAvailable ? "text-emerald-200" : "text-red-200"}>现货腿 {availability.spotSymbol} · {spotAvailable ? "可用" : "不可用"}</p>
      <p className={perpetualAvailable ? "text-emerald-200" : "text-red-200"}>USD-M 永续腿 {availability.perpetualSymbol} · {perpetualAvailable ? "可用" : "不可用"}</p>
      {availability.message ? <p className="text-amber-100/75">{availability.message}</p> : null}
    </div>
  );
}
function accountModeLabel(value: string) {
  if (value === "single_asset_one_way") return "Single-Asset";
  if (value === "multi_assets_one_way") return "Multi-Assets";
  if (value === "uta") return "UTA";
  return value;
}
function Field({ children, label }: { children: React.ReactNode; label: string }) { return <label className="xh-account-modal-field"><span>{label}</span>{children}</label>; }
function SensitiveInput({ onChange, onToggle, show, toggle, value }: { onChange: (value: string) => void; onToggle?: () => void; show: boolean; toggle?: null; value: string }) { return <span className="relative block"><input autoCapitalize="none" autoComplete="off" className="xh-account-modal-control pr-12" onChange={(event) => onChange(event.target.value)} spellCheck={false} type={show ? "text" : "password"} value={value} />{toggle === null ? null : <button aria-label={show ? "隐藏敏感字段" : "显示敏感字段"} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-muted hover:text-white" onClick={onToggle} type="button">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>}</span>; }
function pendingChecks(): AutomationCredentialSummary["verificationChecks"] { return [
  { id: "ip_bound", label: "生产出口 IP 已绑定", status: "pending", message: "等待提交后由服务端验证。" },
  { id: "read", label: "读取权限", status: "pending", message: "等待提交后由服务端验证。" },
  { id: "spot_trade", label: "现货交易权限", status: "pending", message: "等待提交后由服务端验证。" },
  { id: "contract_trade", label: "合约交易权限", status: "pending", message: "等待提交后由服务端验证。" },
  { id: "withdraw_disabled", label: "提现权限关闭", status: "pending", message: "必须由服务端确认 withdraw=false。" },
  { id: "account_mode", label: "账户模式满足要求", status: "pending", message: "等待服务端读取账户模式。" },
]; }
