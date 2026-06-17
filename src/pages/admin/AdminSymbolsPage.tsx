import { FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { syncMarketSymbols } from "../../api/market";
import { useQuoteStore } from "../../store/quoteStore";
import { useSymbolStore } from "../../store/symbolStore";
import type { SymbolCategory, TradeSymbol } from "../../types/market";
import { formatPrice } from "../../utils/price";

type SymbolDraft = Omit<TradeSymbol, "id" | "quoteStatus" | "createdAt" | "updatedAt">;

const categories: SymbolCategory[] = ["forex", "metal", "crypto", "index", "stock"];
const emptyDraft: SymbolDraft = {
  symbol: "",
  displayName: "",
  apiSymbol: "",
  category: "forex",
  digits: 2,
  spread: 0.01,
  leverage: 100,
  contractSize: 100000,
  minLot: 0.01,
  maxLot: 10,
  lotStep: 0.01,
  tradeStatus: "enabled",
  isVisible: true,
};

export function AdminSymbolsPage() {
  const symbols = useSymbolStore((state) => state.symbols);
  const addSymbol = useSymbolStore((state) => state.addSymbol);
  const updateSymbol = useSymbolStore((state) => state.updateSymbol);
  const setTradeStatus = useSymbolStore((state) => state.setTradeStatus);
  const deleteSymbol = useSymbolStore((state) => state.deleteSymbol);
  const resetSymbols = useSymbolStore((state) => state.resetSymbols);
  const quotes = useQuoteStore((state) => state.quotes);
  const refreshAllQuotes = useQuoteStore((state) => state.refreshAllQuotes);
  const updateStatuses = useQuoteStore((state) => state.updateStatuses);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SymbolDraft>(emptyDraft);
  const [message, setMessage] = useState("");

  const quoteBySymbol = useMemo(() => new Map(quotes.map((quote) => [quote.symbol, quote])), [quotes]);
  const symbolConfigKey = useMemo(
    () =>
      JSON.stringify(
        symbols.map(({ quoteStatus: _quoteStatus, createdAt: _createdAt, updatedAt: _updatedAt, ...config }) => config),
      ),
    [symbols],
  );

  useEffect(() => {
    void syncMarketSymbols(symbols);
    updateStatuses();
    void refreshAllQuotes();
    const timer = window.setInterval(updateStatuses, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAllQuotes, symbolConfigKey, updateStatuses]);

  const startCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft);
    setMessage("");
  };

  const startEdit = (symbol: TradeSymbol) => {
    const { id: _id, quoteStatus: _quoteStatus, createdAt: _createdAt, updatedAt: _updatedAt, ...nextDraft } = symbol;
    setEditingId(symbol.id);
    setDraft(nextDraft);
    setMessage("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = { ...draft, symbol: draft.symbol.toUpperCase(), apiSymbol: draft.apiSymbol.toUpperCase() };
    if (editingId) {
      updateSymbol(editingId, normalized);
      setMessage("品种配置已更新。");
    } else {
      addSymbol(normalized);
      setMessage("品种已新增。");
    }
    void syncMarketSymbols(useSymbolStore.getState().symbols);
    startCreate();
  };

  const resetDefaults = () => {
    resetSymbols();
    void syncMarketSymbols(useSymbolStore.getState().symbols);
    setMessage("已恢复默认品种。");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">品种管理</h1>
          <p className="mt-2 text-sm text-muted">配置交易品种、公开行情 API symbol、点差和交易规格。</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => void refreshAllQuotes()}>
            刷新行情
          </Button>
          <Button variant="secondary" onClick={resetDefaults}>
            恢复默认品种
          </Button>
        </div>
      </div>

      <Card>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-4">
            <Input label="品种代码" value={draft.symbol} onChange={(event) => setDraftValue("symbol", event.target.value)} required />
            <Input label="展示名称" value={draft.displayName} onChange={(event) => setDraftValue("displayName", event.target.value)} required />
            <Input label="API Symbol" value={draft.apiSymbol} onChange={(event) => setDraftValue("apiSymbol", event.target.value)} required />
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-300">分类</span>
              <select
                className="w-full rounded-lg border border-line bg-[#0f1722] px-3.5 py-3 text-sm text-white outline-none focus:border-emerald-400"
                value={draft.category}
                onChange={(event) => setDraftValue("category", event.target.value as SymbolCategory)}
              >
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <Input label="报价小数位" type="number" value={draft.digits} onChange={(event) => setNumberValue("digits", event.target.value)} required />
            <Input label="固定点差" type="number" step="0.00001" value={draft.spread} onChange={(event) => setNumberValue("spread", event.target.value)} required />
            <Input label="杠杆" type="number" value={draft.leverage} onChange={(event) => setNumberValue("leverage", event.target.value)} required />
            <Input label="合约单位" type="number" value={draft.contractSize} onChange={(event) => setNumberValue("contractSize", event.target.value)} required />
            <Input label="最小手数" type="number" step="0.01" value={draft.minLot} onChange={(event) => setNumberValue("minLot", event.target.value)} required />
            <Input label="最大手数" type="number" step="0.01" value={draft.maxLot} onChange={(event) => setNumberValue("maxLot", event.target.value)} required />
            <Input label="手数步进" type="number" step="0.01" value={draft.lotStep} onChange={(event) => setNumberValue("lotStep", event.target.value)} required />
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-300">交易状态</span>
              <select
                className="w-full rounded-lg border border-line bg-[#0f1722] px-3.5 py-3 text-sm text-white outline-none focus:border-emerald-400"
                value={draft.tradeStatus}
                onChange={(event) => setDraftValue("tradeStatus", event.target.value as TradeSymbol["tradeStatus"])}
              >
                <option value="enabled">enabled</option>
                <option value="close_only">close_only</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={draft.isVisible}
                onChange={(event) => setDraftValue("isVisible", event.target.checked)}
              />
              用户端可见
            </label>
          </div>
          {message ? <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200">{message}</p> : null}
          <div className="flex gap-3">
            <Button type="submit">{editingId ? "保存修改" : "新增品种"}</Button>
            <Button type="button" variant="secondary" onClick={startCreate}>
              清空表单
            </Button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="border-b border-line bg-white/[0.03] text-muted">
              <tr>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">API Symbol</th>
                <th className="px-5 py-3 font-medium">规格</th>
                <th className="px-5 py-3 font-medium">交易状态</th>
                <th className="px-5 py-3 font-medium">最新价 / Bid / Ask</th>
                <th className="px-5 py-3 font-medium">行情状态</th>
                <th className="px-5 py-3 font-medium">更新时间 / 来源</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {symbols.map((symbol) => {
                const quote = quoteBySymbol.get(symbol.symbol);
                return (
                  <tr key={symbol.id} className={!symbol.isVisible ? "opacity-55" : undefined}>
                    <td className="px-5 py-4">
                      <p className="font-semibold">{symbol.symbol}</p>
                      <p className="text-xs text-muted">{symbol.displayName}</p>
                    </td>
                    <td className="px-5 py-4 text-muted">{symbol.apiSymbol}</td>
                    <td className="px-5 py-4 text-xs text-muted">
                      <p>点差 {symbol.spread} · {symbol.digits} 位</p>
                      <p>杠杆 1:{symbol.leverage} · 合约 {symbol.contractSize}</p>
                      <p>手数 {symbol.minLot}-{symbol.maxLot} / {symbol.lotStep}</p>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={symbol.tradeStatus === "enabled" ? "success" : symbol.tradeStatus === "close_only" ? "neutral" : "danger"}>
                        {symbol.tradeStatus}
                      </Badge>
                    </td>
                    <td className="px-5 py-4">
                      {quote ? (
                        <div className="space-y-1 font-mono text-xs">
                          <p>Last {formatPrice(quote.last, symbol.digits)}</p>
                          <p>Bid {formatPrice(quote.bid, symbol.digits)}</p>
                          <p>Ask {formatPrice(quote.ask, symbol.digits)}</p>
                        </div>
                      ) : (
                        <span className="text-muted">暂无行情</span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={quote?.status === "normal" ? "success" : quote?.status === "error" ? "danger" : "neutral"}>
                        {quote?.status ?? symbol.quoteStatus}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      <p>{quote?.localUpdatedAt ? new Date(quote.localUpdatedAt).toLocaleString("zh-CN") : "-"}</p>
                      <p>{quote?.source ?? "-"}</p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" onClick={() => startEdit(symbol)}>编辑</Button>
                        <Button variant="secondary" onClick={() => setTradeStatus(symbol.id, symbol.tradeStatus === "enabled" ? "disabled" : "enabled")}>
                          {symbol.tradeStatus === "enabled" ? "停用" : "启用"}
                        </Button>
                        <Button variant="danger" onClick={() => window.confirm(`确认删除 ${symbol.symbol}？`) && deleteSymbol(symbol.id)}>
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );

  function setDraftValue<Key extends keyof SymbolDraft>(key: Key, value: SymbolDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setNumberValue(key: keyof SymbolDraft, value: string) {
    setDraft((current) => ({ ...current, [key]: Number(value) }));
  }
}
