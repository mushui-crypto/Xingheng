import { useEffect, useMemo } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { fetchMarketSymbols } from "../../api/market";
import { useQuoteStore } from "../../store/quoteStore";
import { useSymbolStore } from "../../store/symbolStore";
import { formatPrice } from "../../utils/price";

export function MarketsPage() {
  const symbols = useSymbolStore((state) => state.symbols);
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const quotes = useQuoteStore((state) => state.quotes);
  const refreshAllQuotes = useQuoteStore((state) => state.refreshAllQuotes);
  const updateStatuses = useQuoteStore((state) => state.updateStatuses);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const visibleSymbols = symbols.filter((symbol) => symbol.isVisible);
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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">行情</h1>
          <p className="mt-2 text-sm text-muted">公开行情报价经内部标准化后生成 Bid / Ask，供图表和后续模拟交易模块使用。</p>
        </div>
        <Button variant="secondary" onClick={() => void handleRefresh()}>
          <RefreshCw size={16} />
          刷新行情
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        {visibleSymbols.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-medium">暂无可见品种</p>
            <p className="mt-2 text-sm text-muted">请在后台品种管理中启用品种并设置为用户端可见。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="border-b border-line bg-white/[0.03] text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">品种</th>
                  <th className="px-5 py-3 font-medium">Bid</th>
                  <th className="px-5 py-3 font-medium">Ask</th>
                  <th className="px-5 py-3 font-medium">Last</th>
                  <th className="px-5 py-3 font-medium">Change %</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                  <th className="px-5 py-3 font-medium">更新时间</th>
                  <th className="px-5 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visibleSymbols.map((symbol) => {
                  const quote = quoteBySymbol.get(symbol.symbol);
                  const disabled = symbol.tradeStatus === "disabled";
                  return (
                    <tr key={symbol.id} className={disabled ? "opacity-55" : undefined}>
                      <td className="px-5 py-4">
                        <p className="font-semibold">{symbol.symbol}</p>
                        <p className="text-xs text-muted">{symbol.displayName}</p>
                      </td>
                      <td className="px-5 py-4 font-mono">{formatPrice(quote?.bid, symbol.digits)}</td>
                      <td className="px-5 py-4 font-mono">{formatPrice(quote?.ask, symbol.digits)}</td>
                      <td className="px-5 py-4 font-mono">{formatPrice(quote?.last, symbol.digits)}</td>
                      <td className={`px-5 py-4 ${Number(quote?.changePercent ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                        {quote ? `${quote.changePercent.toFixed(2)}%` : "-"}
                      </td>
                      <td className="px-5 py-4">
                        <Badge tone={quote?.status === "normal" ? "success" : quote?.status === "error" ? "danger" : "neutral"}>
                          {disabled ? "disabled" : quote?.status ?? "stale"}
                        </Badge>
                      </td>
                      <td className="px-5 py-4 text-muted">
                        {quote?.localUpdatedAt ? new Date(quote.localUpdatedAt).toLocaleString("zh-CN") : "-"}
                      </td>
                      <td className="px-5 py-4">
                        <Link
                          className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-slate-200 transition hover:border-slate-500"
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
        )}
      </Card>
    </div>
  );
}
