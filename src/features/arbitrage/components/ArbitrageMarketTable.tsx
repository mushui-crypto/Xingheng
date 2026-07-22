import { AlertTriangle, CheckCircle2, CircleOff } from "lucide-react";
import type { ArbitrageMarket } from "../model/types";
import { formatApr, formatBps, formatFundingRate, formatPrice, formatRatio, formatUsd } from "../lib/formatters";
import { ArbitrageHelp } from "./ArbitrageHelp";
import { FundingCountdown, useFundingClock } from "./FundingCountdown";

export function ArbitrageMarketTable({ markets }: { markets: ArbitrageMarket[] }) {
  const now = useFundingClock();

  if (markets.length === 0) {
    return <EmptyRows />;
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-auto border border-line bg-black [contain:paint]">
      <table className="xh-table min-w-[1520px]">
        <thead className="xh-thead">
          <tr>
            <th className="xh-th sticky left-0 z-10 bg-[#121212]">资产 / 市场</th>
            <th className="xh-th">交易所</th>
            <th className="xh-th">产品</th>
            <th className="xh-th text-right"><HeaderLabel label="Bid / Ask" help="当前最优买价与最优卖价。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="Mark / Index" help="永续合约标记价格与指数价格；现货市场两者均使用最新成交价。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="当前 Funding" help="显示交易所最新一期原始资金费率、结算周期、等效APR和下次结算倒计时。正费率由多方支付给空方，负费率由空方支付给多方。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="近90天 Funding APR" help="最近90天资金费率按日汇总后取平均并年化；覆盖率不足时可靠性会降低。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="正费率占比" help="最近90天资金费率样本中大于零的比例。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="盘口点差" help="当前最优买卖价差相对于中间价的bps。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="$10k 滑点" help="按当前订单簿模拟1万美元单向市价成交的价格冲击。" /></th>
            <th className="xh-th text-right"><HeaderLabel label="双向深度" help="当前抓取档位内买卖盘可成交名义金额的较小值。" /></th>
            <th className="xh-th">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {markets.map((market) => {
            return (
              <tr key={market.id} className="hover:bg-white/[0.025]">
                <td className="sticky left-0 z-[1] bg-black px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-8 min-w-12 items-center justify-center border border-white/15 bg-panel px-2 font-mono text-xs font-semibold text-white">
                      {market.asset}
                    </span>
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-white">{market.symbol}</p>
                      <p className="mt-1 text-xs text-dim">{market.quoteAsset} 报价 · {market.settlementAsset} 结算</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-4 font-medium text-white">{market.venueLabel}</td>
                <td className="px-5 py-4">
                  <ProductBadge kind={market.kind} />
                </td>
                <td className="px-5 py-4 text-right font-mono text-xs font-normal leading-5 text-muted">
                  <p>{formatPrice(market.bid)}</p>
                  <p>{formatPrice(market.ask)}</p>
                </td>
                <td className="px-5 py-4 text-right font-mono text-xs font-normal leading-5 text-muted">
                  <p>{formatPrice(market.markPrice)}</p>
                  <p>{formatPrice(market.indexPrice)}</p>
                </td>
                <td className="px-5 py-4 text-right">
                  <MarketFunding market={market} now={now} />
                </td>
                <td className="px-5 py-4 text-right font-mono font-normal text-muted">
                  {formatApr(market.historicalFundingApr, true)}
                  <p className="mt-1 text-[11px] font-normal text-dim">覆盖 {formatRatio(market.fundingCoverageRatio)}</p>
                </td>
                <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatRatio(market.fundingPositiveRatio)}</td>
                <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatBps(market.spreadBps)}</td>
                <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatBps(market.slippageBps10k)}</td>
                <td className="px-5 py-4 text-right font-mono font-normal text-muted">{formatUsd(market.depthUsd)}</td>
                <td className="px-5 py-4">
                  <MarketStatus market={market} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MarketFunding({ market, now }: { market: ArbitrageMarket; now: number }) {
  if (market.kind === "spot") {
    return <span className="whitespace-nowrap text-xs font-normal text-dim">无资金费率</span>;
  }
  return (
    <div className="min-w-[160px] font-mono tabular-nums">
      <p className="whitespace-nowrap font-normal text-muted">
        {formatFundingRate(market.fundingRate)}
        {market.fundingIntervalHours ? <span> / {formatInterval(market.fundingIntervalHours)}h</span> : null}
      </p>
      <p className="mt-1 whitespace-nowrap text-[11px] font-normal text-muted">APR {formatApr(market.currentFundingApr, true)}</p>
      <p className="mt-1 text-[11px] font-normal"><FundingCountdown nextFundingTime={market.nextFundingTime} now={now} /></p>
    </div>
  );
}

function ProductBadge({ kind }: { kind: ArbitrageMarket["kind"] }) {
  return (
    <span className={`inline-flex border px-2.5 py-1 text-xs font-medium ${kind === "spot" ? "border-sky-400/30 bg-sky-400/[0.08] text-sky-200" : "border-white/20 bg-panel2 text-slate-200"}`}>
      {kind === "spot" ? "现货" : "永续"}
    </span>
  );
}

function MarketStatus({ market }: { market: ArbitrageMarket }) {
  const config = market.status === "connected"
    ? { icon: CheckCircle2, label: "正常", className: "text-emerald-300" }
    : market.status === "degraded"
      ? { icon: AlertTriangle, label: "受限", className: "text-amber-300" }
      : { icon: CircleOff, label: "断开", className: "text-red-300" };
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${config.className}`}>
      <Icon aria-hidden="true" size={14} />
      {config.label}
      {market.warnings.length > 0 ? <ArbitrageHelp content={market.warnings.join("；")} label={`查看${config.label}状态说明`} /> : null}
    </span>
  );
}

function HeaderLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="flex items-center justify-end gap-1.5">
      <span>{label}</span>
      <ArbitrageHelp content={help} label={`查看${label}说明`} />
    </span>
  );
}

function EmptyRows() {
  return (
    <div className="border border-line bg-black px-5 py-14 text-center">
      <p className="text-sm font-medium text-white">没有符合筛选条件的市场</p>
      <p className="mt-2 text-xs text-muted">调整资产或交易所筛选条件后重试。</p>
    </div>
  );
}

function formatInterval(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}
