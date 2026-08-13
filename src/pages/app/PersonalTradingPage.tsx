import { useState } from "react";
import { Activity, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import type { ExchangeCredentialSummary, ExchangeVenue } from "../../api/exchangeCredentials";
import { BinanceTradingWorkbench } from "../../features/personalTrading/components/BinanceTradingWorkbench";
import { AccountReadOverview } from "../../features/personalTrading/components/AccountReadOverview";
import { ArbitrageInstanceOverview } from "../../features/personalTrading/components/ArbitrageInstanceOverview";
import { ExchangeCredentialsPanel } from "../../features/personalTrading/components/ExchangeCredentialsPanel";
import { exchangeVenues, mergeCredentialSummaries } from "../../features/personalTrading/model/personalTradingState";

export function PersonalTradingPage() {
  const [binanceReloadToken, setBinanceReloadToken] = useState(0);
  const [selectedVenue, setSelectedVenue] = useState<ExchangeVenue>("binance");
  const [credentialSummaries, setCredentialSummaries] = useState<ExchangeCredentialSummary[]>([]);
  const selectedSummary = mergeCredentialSummaries(credentialSummaries).find((item) => item.venue === selectedVenue) ?? null;

  return (
    <div className="xh-page min-w-0 pb-8">
      <header className="xh-page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="xh-title">我的套利</h1>
            <span className="inline-flex items-center gap-1.5 border border-white/20 px-2.5 py-1 text-xs font-medium text-[#c5ccd4]">
              <Activity size={13} /> 套利系统 · 真实资产
            </span>
          </div>
          <p className="xh-subtitle">查看个人交易所账户的真实只读数据，并管理交易所连接。</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#8f99a5]">
          <LockKeyhole size={14} /> 密钥不回显、不在浏览器持久化
        </div>
      </header>

      <AccountReadOverview />

      <div className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <ExchangeCredentialsPanel
          onBinanceChanged={() => setBinanceReloadToken((value) => value + 1)}
          onSummariesChanged={setCredentialSummaries}
          onVenueSelect={setSelectedVenue}
          selectedVenue={selectedVenue}
        />
        {selectedVenue === "binance"
          ? <BinanceTradingWorkbench reloadToken={binanceReloadToken} />
          : <CredentialOnlyVenueDetail summary={selectedSummary} venue={selectedVenue} />}
      </div>

      <ArbitrageInstanceOverview />
    </div>
  );
}

function CredentialOnlyVenueDetail({ summary, venue }: { summary: ExchangeCredentialSummary | null; venue: ExchangeVenue }) {
  const label = exchangeVenues.find((item) => item.venue === venue)?.label ?? venue.toUpperCase();
  const configured = summary?.configured === true;

  return (
    <section className="min-w-0 border border-[#25282f] bg-[#0b0d11]" aria-labelledby="venue-detail-title">
      <header className="flex flex-col gap-3 border-b border-[#25282f] px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-white" id="venue-detail-title">{label} 凭证详情</h2>
            <span className={`border px-2 py-0.5 text-[11px] ${configured ? "border-emerald-400/30 text-emerald-200" : "border-amber-400/30 text-amber-200"}`}>
              {configured ? "凭证已保存" : "待配置"}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#8f99a5]">此处管理加密凭证；真实账户级只读数据请查看上方账户概览。</p>
        </div>
      </header>

      <div className="grid gap-px border-b border-[#25282f] bg-[#25282f] sm:grid-cols-2 xl:grid-cols-4">
        <DetailMetric label="交易所" value={label} />
        <DetailMetric label="凭证状态" tone={configured ? "success" : "warning"} value={configured ? "已加密保存" : "尚未配置"} />
        <DetailMetric label="账户读取" value="已接入上方概览" />
        <DetailMetric label="执行能力" value="尚未接入" />
      </div>

      <div className="space-y-3 px-4 py-5 sm:px-5">
        <div className="flex items-start gap-3 border border-[#25282f] bg-black px-4 py-4">
          <KeyRound className="mt-0.5 shrink-0 text-[#aab3bd]" size={17} />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">凭证存储</h3>
            <p className="mt-1 break-words font-mono text-xs text-[#8f99a5]">
              {configured ? `${summary?.maskedApiKey ?? "已配置"} · ${summary?.accountFingerprint ?? summary?.accountId ?? "账户已验证"}` : summary?.message ?? "未保存 API 凭证"}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 border border-[#25282f] bg-black px-4 py-4">
          <ShieldCheck className="mt-0.5 shrink-0 text-[#aab3bd]" size={17} />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">私有账户能力</h3>
            <p className="mt-1 text-xs leading-5 text-[#8f99a5]">账户级只读数据已接入；持仓、订单与执行能力本阶段未接入。</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DetailMetric({ label, tone, value }: { label: string; tone?: "success" | "warning"; value: string }) {
  return (
    <div className="min-w-0 bg-[#0b0d11] px-4 py-3">
      <p className="text-[11px] text-[#8f99a5]">{label}</p>
      <p className={`mt-1 break-words font-mono text-sm font-semibold ${tone === "success" ? "text-emerald-200" : tone === "warning" ? "text-amber-200" : "text-white"}`}>{value}</p>
    </div>
  );
}
