import { useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { fetchMarketSymbols } from "../../api/market";
import { useQuoteStore } from "../../store/quoteStore";
import { useSymbolStore } from "../../store/symbolStore";
import type { SymbolCategory, TradeSymbol } from "../../types/market";
import { formatPrice } from "../../utils/price";

const categoryFilters: Array<{ value: SymbolCategory; label: string }> = [
  { value: "crypto", label: "Crypto" },
  { value: "metals", label: "贵金属" },
  { value: "us_equities", label: "美股合约" },
  { value: "indices", label: "指数" },
  { value: "other", label: "其他" },
];

export function MarketsPage() {
  const symbols = useSymbolStore((state) => state.symbols);
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const quotes = useQuoteStore((state) => state.quotes);
  const refreshAllQuotes = useQuoteStore((state) => state.refreshAllQuotes);
  const updateStatuses = useQuoteStore((state) => state.updateStatuses);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<SymbolCategory>("crypto");
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const normalizedSearch = search.trim().toUpperCase();
  const visibleSymbols = symbols.filter((symbol) => symbol.isVisible);
  const categoryCounts = new Map(
    categoryFilters.map((filter) => [filter.value, visibleSymbols.filter((symbol) => symbol.category === filter.value).length]),
  );
  const filteredSymbols = visibleSymbols.filter((symbol) => symbol.category === category && matchesSearch(symbol, normalizedSearch));
  const symbolConfigKey = useMemo(
    () =>
      JSON.stringify(
        symbols.map(({ quoteStatus: _quoteStatus, createdAt: _createdAt, updatedAt: _updatedAt, ...config }) => config),
      ),
    [symbols],
  );

  useEffect(() => {
    void fetchMarketSymbols().then(setSymbolsFromBackend).catch(() => undefined);
  }, [setSymbolsFromBackend]);

  useEffect(() => {
    updateStatuses();
    void refreshAllQuotes();
    const timer = window.setInterval(updateStatuses, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAllQuotes, symbolConfigKey, updateStatuses]);

  const handleRefresh = async () => {
    const nextSymbols = await fetchMarketSymbols();
    setSymbolsFromBackend(nextSymbols);
    updateStatuses();
    await refreshAllQuotes();
  };

  return (
    <div className="xh-page">
      <div className="xh-page-header">
        <div>
          <h1 className="xh-title">行情</h1>
          <p className="xh-subtitle">Hyperliquid 永续合约行情，公开行情经内部标准化后仅用于内部模拟交易。</p>
        </div>
        <div className="flex w-full gap-3 md:w-auto">
          <input
            className="min-w-0 flex-1 border border-line bg-black px-3.5 py-2.5 text-sm text-white outline-none md:w-64"
            placeholder="搜索 symbol、名称、来源 coin 或 dex"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button variant="secondary" onClick={() => void handleRefresh()}>
            <RefreshCw size={16} />
            刷新行情
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap gap-2 border-b border-line p-4">
          {categoryFilters.map((filter) => {
            const count = categoryCounts.get(filter.value) ?? 0;
            return (
              <button
                key={filter.value}
                type="button"
                className={`border px-3 py-2 text-sm transition ${
                  category === filter.value ? "border-white bg-white text-black" : "border-line text-muted hover:text-white"
                }`}
                onClick={() => setCategory(filter.value)}
              >
                {filter.label} <span className="ml-1 text-xs opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
        {filteredSymbols.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-medium">暂无可见品种</p>
            <p className="mt-2 text-sm text-muted">请尝试其他分类或关键词；特殊市场需在后台启用并设置为用户端可见。</p>
          </div>
        ) : (
          <>
          <div className="grid gap-0 divide-y divide-line md:hidden">
            {filteredSymbols.map((symbol) => {
              const quote = quoteBySymbol.get(symbol.symbol);
              const closeOnly = symbol.tradeStatus !== "enabled";
              return (
                <article key={symbol.id} className={closeOnly ? "space-y-4 p-4 opacity-60" : "space-y-4 p-4"}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold">{symbol.symbol}</p>
                      <p className="mt-1 text-xs text-muted">{symbol.displayName}</p>
                    </div>
                    <Badge tone={quote?.status === "connected" ? "success" : quote?.status === "disconnected" ? "danger" : "neutral"}>
                      {closeOnly ? "仅平仓" : quote?.status ?? "stale"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <MarketMetric label="Bid" value={formatPrice(quote?.bid, symbol.digits)} />
                    <MarketMetric label="Ask" value={formatPrice(quote?.ask, symbol.digits)} />
                    <MarketMetric label="Last" value={formatPrice(quote?.last, symbol.digits)} />
                    <MarketMetric
                      label="Change"
                      tone={Number(quote?.changePercent ?? 0) >= 0 ? "positive" : "negative"}
                      value={quote ? `${quote.changePercent.toFixed(2)}%` : "-"}
                    />
                  </div>
                  <div className="flex flex-col gap-3 border-t border-line pt-4">
                    <p className="text-xs leading-5 text-muted">
                      更新时间：{quote?.localUpdatedAt ? new Date(quote.localUpdatedAt).toLocaleString("zh-CN") : "-"}
                    </p>
                    <Link className="xh-action-link justify-center" to={`/app/trading?symbol=${symbol.symbol}`}>
                      查看图表 <ArrowRight size={15} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="xh-table min-w-[980px]">
              <thead className="xh-thead">
                <tr>
                  <th className="xh-th">品种</th>
                  <th className="xh-th">分类 / 来源</th>
                  <th className="xh-th">Bid</th>
                  <th className="xh-th">Ask</th>
                  <th className="xh-th">Last</th>
                  <th className="xh-th">Change %</th>
                  <th className="xh-th">状态</th>
                  <th className="xh-th">更新时间</th>
                  <th className="xh-th">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredSymbols.map((symbol) => {
                  const quote = quoteBySymbol.get(symbol.symbol);
                  const closeOnly = symbol.tradeStatus !== "enabled";
                  return (
                    <tr key={symbol.id} className={closeOnly ? "opacity-55" : undefined}>
                      <td className="px-5 py-4">
                        <p className="font-semibold">{symbol.symbol}</p>
                        <p className="text-xs text-muted">{symbol.displayName}</p>
                      </td>
                      <td className="px-5 py-4 text-xs text-muted">
                        <p>{categoryLabel(symbol.category)}</p>
                        <p>{symbol.sourceDex} · {symbol.providerCoin}</p>
                      </td>
                      <td className="px-5 py-4 font-mono">{formatPrice(quote?.bid, symbol.digits)}</td>
                      <td className="px-5 py-4 font-mono">{formatPrice(quote?.ask, symbol.digits)}</td>
                      <td className="px-5 py-4 font-mono">{formatPrice(quote?.last, symbol.digits)}</td>
                      <td className={`px-5 py-4 ${Number(quote?.changePercent ?? 0) >= 0 ? "text-white" : "text-red-300"}`}>
                        {quote ? `${quote.changePercent.toFixed(2)}%` : "-"}
                      </td>
                      <td className="px-5 py-4">
                        <Badge tone={quote?.status === "connected" ? "success" : quote?.status === "disconnected" ? "danger" : "neutral"}>
                          {closeOnly ? "仅允许平仓" : quote?.status ?? "stale"}
                        </Badge>
                      </td>
                      <td className="px-5 py-4 text-muted">
                        {quote?.localUpdatedAt ? new Date(quote.localUpdatedAt).toLocaleString("zh-CN") : "-"}
                      </td>
                      <td className="px-5 py-4">
                        <Link
                          className="xh-action-link"
                          to={`/app/trading?symbol=${symbol.symbol}`}
                        >
                          查看图表 <ArrowRight size={15} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
    </div>
  );
}

function matchesSearch(symbol: TradeSymbol, keyword: string) {
  if (!keyword) {
    return true;
  }
  return [
    symbol.symbol,
    symbol.displayName,
    symbol.apiSymbol,
    symbol.providerMarketId,
    symbol.providerCoin,
    symbol.sourceDex,
  ].some((value) => String(value ?? "").toUpperCase().includes(keyword));
}

function categoryLabel(category: SymbolCategory) {
  return categoryFilters.find((filter) => filter.value === category)?.label ?? "其他";
}

function MarketMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "positive" | "negative" }) {
  const toneClass = tone === "negative" ? "text-red-300" : "text-white";
  return (
    <div className="border border-line bg-black p-3">
      <p className="text-[11px] uppercase tracking-[0.14em] text-dim">{label}</p>
      <p className={`mt-2 break-all font-mono text-base font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
