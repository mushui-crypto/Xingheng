import { memo } from "react";
import type { ArbitrageMarket, ArbitrageVenue } from "../model/types";
import { formatFundingRate, formatPrice } from "../lib/formatters";

const venues: Array<{ id: ArbitrageVenue; label: string; icon?: string }> = [
  { id: "binance", label: "Binance", icon: "/assets/exchanges/binance.svg" },
  { id: "okx", label: "OKX", icon: "/assets/exchanges/okx.svg" },
  { id: "bybit", label: "Bybit", icon: "/assets/exchanges/bybit.svg" },
  { id: "bitget", label: "Bitget", icon: "/assets/exchanges/bitget.svg" },
];

export const ArbitrageMarketTable = memo(function ArbitrageMarketTable({ markets }: { markets: ArbitrageMarket[] }) {
  const columns = venues;
  const groups = new Map<string, ArbitrageMarket[]>();
  for (const market of markets) {
    if (!columns.some((venue) => venue.id === market.venue)) continue;
    const key = `${market.asset}:${market.kind}:${market.quoteAsset}:${market.settlementAsset}`;
    const group = groups.get(key) ?? [];
    group.push(market);
    groups.set(key, group);
  }

  if (!groups.size) return <div className="border border-line bg-black px-5 py-14 text-center">
    <p className="text-sm font-medium text-white">没有符合筛选条件的市场</p>
    <p className="mt-2 text-xs text-muted">调整资产搜索条件后重试。</p>
  </div>;

  return <div className="w-full min-w-0 overflow-x-auto border border-line bg-black" role="region" aria-label="市场对比，可横向滚动查看全部交易所" tabIndex={0}>
    <table className="xh-table min-w-[880px] table-fixed [&_th]:px-4 [&_th]:tracking-normal">
      <colgroup><col className="w-[100px]" /><col className="w-[120px]" />{columns.map((venue) => <col key={venue.id} />)}</colgroup>
      <thead className="xh-thead"><tr>
        <th scope="col" className="xh-th">资产</th>
        <th scope="col" className="xh-th">产品</th>
        {columns.map((venue) => <th scope="col" className="xh-th" key={venue.id}><span className="inline-flex items-center gap-2">{venue.icon ? <img src={venue.icon} alt="" width={24} height={24} className={`h-6 w-6 shrink-0 object-contain ${venue.id === "okx" ? "invert" : ""}`} /> : null}{venue.label}</span></th>)}
      </tr></thead>
      <tbody className="divide-y divide-line">{[...groups].map(([key, group]) => {
        const first = group[0];
        return <tr key={key} className="hover:bg-white/[0.025]">
          <th scope="row" className="px-4 py-5 text-left font-mono text-sm font-semibold text-white">{first.asset}</th>
          <td className="px-4 py-5"><p className="text-sm text-white">{first.kind === "spot" ? "现货" : "永续"}</p><p className="mt-1 text-xs text-muted">{first.quoteAsset} 报价</p>{first.settlementAsset !== first.quoteAsset ? <p className="mt-1 text-xs text-muted">{first.settlementAsset} 结算</p> : null}</td>
          {columns.map((venue) => {
            const matches = group.filter((market) => market.venue === venue.id);
            return <td key={venue.id} className="px-4 py-5 align-top">{matches.length ? <div className="space-y-3">{matches.map((market) => <MarketValues key={market.id} market={market} showSymbol={matches.length > 1} />)}</div> : <span className="text-muted" aria-label="暂无该市场">—</span>}</td>;
          })}
        </tr>;
      })}</tbody>
    </table>
  </div>;
});

function MarketValues({ market, showSymbol }: { market: ArbitrageMarket; showSymbol: boolean }) {
  const available = market.status !== "disconnected";
  const price = available && market.markPrice !== null && Number.isFinite(market.markPrice) && market.markPrice > 0 ? market.markPrice : null;
  const funding = available && market.fundingRate !== null && Number.isFinite(market.fundingRate) ? market.fundingRate : null;
  return <div className="min-w-0 text-xs leading-5">
    {showSymbol ? <p className="break-all font-mono text-muted">{market.symbol}</p> : null}
    <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-muted">资金费率</span><span className="font-mono text-white">{market.kind === "spot" ? "不适用" : funding === null ? "—" : formatFundingRate(funding)}</span>{market.kind === "perpetual" && funding !== null && market.fundingIntervalHours !== null && market.fundingIntervalHours > 0 ? <span className="text-muted">/ {market.fundingIntervalHours}h</span> : null}</div>
    <div className="mt-2 flex flex-wrap items-baseline gap-x-2"><span className="text-muted">当前价格</span><span className="font-mono text-white">{price === null ? "—" : formatPrice(price)}</span>{price !== null ? <span className="text-muted">{market.quoteAsset}</span> : null}</div>
  </div>;
}
