import { FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { fetchMarketSymbols, syncMarketSymbols } from "../../api/market";
import { useQuoteStore } from "../../store/quoteStore";
import { useSymbolStore } from "../../store/symbolStore";
import type { SymbolCategory, TradeSymbol } from "../../types/market";
import { formatPrice } from "../../utils/price";
import { formatQuantity } from "../../utils/quantity";

type SymbolDraft = Omit<TradeSymbol, "id" | "quoteStatus" | "createdAt" | "updatedAt">;

const categoryOptions: Array<{ value: SymbolCategory; label: string }> = [
  { value: "crypto", label: "crypto（加密永续）" },
  { value: "metals", label: "metals（贵金属合约）" },
  { value: "us_equities", label: "us_equities（美股合约）" },
  { value: "indices", label: "indices（指数合约）" },
  { value: "other", label: "other（其他）" },
];

export function AdminSymbolsPage() {
  const symbols = useSymbolStore((state) => state.symbols);
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const quotes = useQuoteStore((state) => state.quotes);
  const refreshAllQuotes = useQuoteStore((state) => state.refreshAllQuotes);
  const updateStatuses = useQuoteStore((state) => state.updateStatuses);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SymbolDraft | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const managedSymbol = symbols.find((item) => item.id === editingId) ?? symbols[0] ?? null;

  const quoteBySymbol = useMemo(() => new Map(quotes.map((quote) => [quote.symbol, quote])), [quotes]);
  const filteredSymbols = useMemo(() => {
    const keyword = search.trim().toUpperCase();
    return symbols.filter(
      (symbol) =>
        !keyword ||
        symbol.symbol.toUpperCase().includes(keyword) ||
        symbol.displayName.toUpperCase().includes(keyword) ||
        symbol.apiSymbol.toUpperCase().includes(keyword) ||
        symbol.providerMarketId.toUpperCase().includes(keyword) ||
        symbol.providerCoin.toUpperCase().includes(keyword) ||
        symbol.sourceDex.toUpperCase().includes(keyword) ||
        symbol.category.toUpperCase().includes(keyword),
    );
  }, [search, symbols]);
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

  const startEdit = (symbol: TradeSymbol) => {
    const { id: _id, quoteStatus: _quoteStatus, createdAt: _createdAt, updatedAt: _updatedAt, ...nextDraft } = symbol;
    setEditingId(symbol.id);
    setDraft(nextDraft);
    setMessage("");
  };

  useEffect(() => {
    if (!draft && managedSymbol) {
      startEdit(managedSymbol);
    }
  }, [draft, managedSymbol]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingId || !draft || !managedSymbol) {
      setMessage("请选择需要编辑的品种。");
      return;
    }
    const normalized: SymbolDraft = {
      ...managedSymbol,
      displayName: draft.displayName,
      category: draft.category,
      spread: draft.spread,
      leverage: draft.leverage,
      contractSize: draft.contractSize,
      minLot: draft.minLot,
      maxLot: draft.maxLot,
      lotStep: draft.lotStep,
      tradeStatus: draft.tradeStatus,
      isVisible: draft.isVisible,
    };
    setSaving(true);
    try {
      const backendSymbols = await syncMarketSymbols([{ ...managedSymbol, ...normalized, updatedAt: new Date().toISOString() }]);
      setSymbolsFromBackend(backendSymbols);
      setMessage(`${managedSymbol.symbol} 品种配置已保存。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "品种配置保存失败。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="xh-page">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">品种管理</h1>
          <p className="mt-2 text-sm text-muted">品种目录自动同步自 Hyperliquid；symbol、来源标识、精度与最小手数不可编辑。</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => void refreshAllQuotes()}>
            刷新行情
          </Button>
        </div>
      </div>

      <Card>
        {draft ? (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-4">
            <Input label="品种代码" value={draft.symbol} onChange={() => undefined} disabled required />
            <Input label="展示名称" value={draft.displayName} onChange={(event) => setDraftValue("displayName", event.target.value)} required />
            <Input label="API Symbol" value={draft.apiSymbol} onChange={() => undefined} disabled required />
            <Input label="Provider Market ID" value={draft.providerMarketId} onChange={() => undefined} disabled required />
            <Input label="Provider Coin" value={draft.providerCoin} onChange={() => undefined} disabled required />
            <Input label="Source DEX" value={draft.sourceDex} onChange={() => undefined} disabled required />
            <Input label="Source Type" value={draft.sourceType} onChange={() => undefined} disabled required />
            <Select
              label="分类"
              value={draft.category}
              onChange={(event) => setDraftValue("category", event.target.value as SymbolCategory)}
              options={categoryOptions}
            />
            <Input label="固定点差" type="number" step="0.00001" value={draft.spread} onChange={(event) => setNumberValue("spread", event.target.value)} required />
            <Input label="杠杆" type="number" value={draft.leverage} onChange={(event) => setNumberValue("leverage", event.target.value)} required />
            <Input label="合约单位" type="number" value={draft.contractSize} onChange={(event) => setNumberValue("contractSize", event.target.value)} required />
            <Input label="最小手数" type="number" value={draft.minLot} onChange={() => undefined} disabled required />
            <Input label="最大手数" type="number" step="0.01" value={draft.maxLot} onChange={(event) => setNumberValue("maxLot", event.target.value)} required />
            <Input label="手数步进" type="number" value={draft.lotStep} onChange={() => undefined} disabled required />
            <Select
              label="交易状态"
              value={draft.tradeStatus}
              onChange={(event) => setDraftValue("tradeStatus", event.target.value as TradeSymbol["tradeStatus"])}
              options={[
                { value: "enabled", label: "enabled（允许开仓和平仓）" },
                { value: "close_only", label: "close_only（仅允许平仓）" },
                { value: "disabled", label: "disabled（仅允许平仓）" },
              ]}
            />
            <label className="flex items-end gap-2 pb-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={draft.isVisible}
                onChange={(event) => setDraftValue("isVisible", event.target.checked)}
              />
              用户端可见
            </label>
          </div>
          {message ? <p className="border border-white/25 bg-white/[0.03] p-3 text-sm text-slate-200">{message}</p> : null}
          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>{saving ? "保存中..." : `保存 ${managedSymbol?.symbol ?? "品种"}`}</Button>
          </div>
        </form>
        ) : (
          <p className="text-sm text-muted">尚未取得 Hyperliquid 品种目录，请稍后刷新。</p>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line p-4">
          <input
            className="w-full border border-line bg-black px-3.5 py-2.5 text-sm text-white outline-none md:w-96"
            placeholder="搜索 symbol、名称、来源 coin、dex 或分类"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1360px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">品种</th>
                <th className="px-5 py-3 font-medium">分类 / 来源</th>
                <th className="px-5 py-3 font-medium">来源标识</th>
                <th className="px-5 py-3 font-medium">规格</th>
                <th className="px-5 py-3 font-medium">交易状态</th>
                <th className="px-5 py-3 font-medium">最新价 / Bid / Ask</th>
                <th className="px-5 py-3 font-medium">行情状态</th>
                <th className="px-5 py-3 font-medium">更新时间 / 来源</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredSymbols.map((symbol) => {
                const quote = quoteBySymbol.get(symbol.symbol);
                return (
                  <tr key={symbol.id} className={!symbol.isVisible ? "opacity-55" : undefined}>
                    <td className="px-5 py-4">
                      <p className="font-semibold">{symbol.symbol}</p>
                      <p className="text-xs text-muted">{symbol.displayName}</p>
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      <p>{categoryLabel(symbol.category)}</p>
                      <p>{symbol.sourceType} · {symbol.sourceDex}</p>
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      <p>API {symbol.apiSymbol}</p>
                      <p>Market {symbol.providerMarketId}</p>
                      <p>Coin {symbol.providerCoin}</p>
                    </td>
                    <td className="px-5 py-4 text-xs text-muted">
                      <p>点差 {symbol.spread} · {symbol.digits} 位</p>
                      <p>杠杆 1:{symbol.leverage} · 合约 {symbol.contractSize}</p>
                      <p>手数 {formatQuantity(symbol.minLot, symbol.lotStep)}-{formatQuantity(symbol.maxLot, symbol.lotStep)} / {formatQuantity(symbol.lotStep, symbol.lotStep)}</p>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={symbol.tradeStatus === "enabled" ? "success" : "neutral"}>
                        {tradeStatusLabel(symbol.tradeStatus)}
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
                      <Badge tone={quote?.status === "connected" ? "success" : quote?.status === "disconnected" ? "danger" : "neutral"}>
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
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredSymbols.length === 0 ? (
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={8}>没有匹配的品种。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );

  function setDraftValue<Key extends keyof SymbolDraft>(key: Key, value: SymbolDraft[Key]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function setNumberValue(key: keyof SymbolDraft, value: string) {
    setDraft((current) => (current ? { ...current, [key]: Number(value) } : current));
  }
}

function tradeStatusLabel(status: TradeSymbol["tradeStatus"]) {
  return status === "enabled" ? "允许开仓和平仓" : "仅允许平仓";
}

function categoryLabel(category: SymbolCategory) {
  return categoryOptions.find((option) => option.value === category)?.label ?? "other（其他）";
}
