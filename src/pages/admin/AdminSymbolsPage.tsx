import { FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { fetchMarketSymbols, syncMarketSymbols } from "../../api/market";
import { useQuoteStore } from "../../store/quoteStore";
import { useSymbolStore } from "../../store/symbolStore";
import type { TradeSymbol } from "../../types/market";
import { formatPrice } from "../../utils/price";

type SymbolDraft = Omit<TradeSymbol, "id" | "quoteStatus" | "createdAt" | "updatedAt">;

const MANAGED_SYMBOL = "BTCUSDT";

export function AdminSymbolsPage() {
  const symbols = useSymbolStore((state) => state.symbols);
  const setSymbolsFromBackend = useSymbolStore((state) => state.setSymbolsFromBackend);
  const updateSymbol = useSymbolStore((state) => state.updateSymbol);
  const quotes = useQuoteStore((state) => state.quotes);
  const refreshAllQuotes = useQuoteStore((state) => state.refreshAllQuotes);
  const updateStatuses = useQuoteStore((state) => state.updateStatuses);
  const managedSymbol = symbols.find((item) => item.symbol === MANAGED_SYMBOL) ?? symbols[0] ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SymbolDraft | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const quoteBySymbol = useMemo(() => new Map(quotes.map((quote) => [quote.symbol, quote])), [quotes]);
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
    if (!editingId || !draft || !managedSymbol || managedSymbol.symbol !== MANAGED_SYMBOL) {
      setMessage("当前阶段仅允许编辑 BTCUSDT。");
      return;
    }
    const normalized: SymbolDraft = {
      ...managedSymbol,
      displayName: draft.displayName,
      spread: draft.spread,
      leverage: draft.leverage,
      contractSize: draft.contractSize,
      minLot: draft.minLot,
      maxLot: draft.maxLot,
      lotStep: draft.lotStep,
      tradeStatus: draft.tradeStatus,
      isVisible: draft.isVisible,
    };
    const nextSymbols = symbols.map((item) => (item.id === editingId ? { ...item, ...normalized, updatedAt: new Date().toISOString() } : item));
    setSaving(true);
    try {
      const backendSymbols = await syncMarketSymbols(nextSymbols);
      setSymbolsFromBackend(backendSymbols);
      updateSymbol(editingId, normalized);
      setMessage("BTCUSDT 品种配置已保存。");
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
          <p className="mt-2 text-sm text-muted">当前阶段只允许维护 BTCUSDT，symbol 与 apiSymbol 固定不可编辑。</p>
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
            <Input label="固定点差" type="number" step="0.00001" value={draft.spread} onChange={(event) => setNumberValue("spread", event.target.value)} required />
            <Input label="杠杆" type="number" value={draft.leverage} onChange={(event) => setNumberValue("leverage", event.target.value)} required />
            <Input label="合约单位" type="number" value={draft.contractSize} onChange={(event) => setNumberValue("contractSize", event.target.value)} required />
            <Input label="最小手数" type="number" step="0.01" value={draft.minLot} onChange={(event) => setNumberValue("minLot", event.target.value)} required />
            <Input label="最大手数" type="number" step="0.01" value={draft.maxLot} onChange={(event) => setNumberValue("maxLot", event.target.value)} required />
            <Input label="手数步进" type="number" step="0.01" value={draft.lotStep} onChange={(event) => setNumberValue("lotStep", event.target.value)} required />
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
            <Button type="submit" disabled={saving}>{saving ? "保存中..." : "保存 BTCUSDT"}</Button>
          </div>
        </form>
        ) : (
          <p className="text-sm text-muted">未取得 BTCUSDT 配置，请刷新行情后重试。</p>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="xh-thead">
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
