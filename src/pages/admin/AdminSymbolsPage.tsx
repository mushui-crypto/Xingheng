import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { fetchMarketSymbols, syncMarketSymbols } from "../../api/market";
import { useQuoteStore } from "../../store/quoteStore";
import { useSymbolStore } from "../../store/symbolStore";
import type { SymbolCategory, TradeSymbol } from "../../types/market";
import { formatPrice } from "../../utils/price";
import { formatQuantity } from "../../utils/quantity";

type SymbolDraft = Omit<TradeSymbol, "id" | "quoteStatus" | "createdAt" | "updatedAt">;
type CategoryFilter = SymbolCategory | "all";
type BatchAction = "show" | "hide" | "status";

const categoryOptions: Array<{ value: SymbolCategory; label: string }> = [
  { value: "crypto", label: "crypto（加密永续）" },
  { value: "metals", label: "metals（贵金属合约）" },
  { value: "us_equities", label: "us_equities（美股合约）" },
  { value: "indices", label: "indices（指数合约）" },
  { value: "other", label: "other（其他）" },
];

const categoryFilterOptions: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "全部分类" },
  ...categoryOptions,
];

const tradeStatusOptions: Array<{ value: TradeSymbol["tradeStatus"]; label: string }> = [
  { value: "enabled", label: "enabled（允许开仓和平仓）" },
  { value: "close_only", label: "close_only（仅允许平仓）" },
  { value: "disabled", label: "disabled（禁止开仓）" },
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
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const [batchTradeStatus, setBatchTradeStatus] = useState<TradeSymbol["tradeStatus"]>("enabled");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const managedSymbol = editingId ? symbols.find((item) => item.id === editingId) ?? null : null;

  const quoteBySymbol = useMemo(() => new Map(quotes.map((quote) => [quote.symbol, quote])), [quotes]);
  const categoryCounts = useMemo(
    () => new Map(categoryOptions.map((option) => [option.value, symbols.filter((symbol) => symbol.category === option.value).length])),
    [symbols],
  );
  const filteredSymbols = useMemo(() => {
    const keyword = search.trim().toUpperCase();
    return symbols.filter((symbol) => {
      const matchesCategory = categoryFilter === "all" || symbol.category === categoryFilter;
      const matchesKeyword =
        !keyword ||
        symbol.symbol.toUpperCase().includes(keyword) ||
        symbol.displayName.toUpperCase().includes(keyword) ||
        symbol.apiSymbol.toUpperCase().includes(keyword) ||
        symbol.providerMarketId.toUpperCase().includes(keyword) ||
        symbol.providerCoin.toUpperCase().includes(keyword) ||
        symbol.sourceDex.toUpperCase().includes(keyword) ||
        symbol.category.toUpperCase().includes(keyword);
      return matchesCategory && matchesKeyword;
    });
  }, [categoryFilter, search, symbols]);
  const selectedSymbols = useMemo(() => symbols.filter((symbol) => selectedIds.has(symbol.id)), [selectedIds, symbols]);
  const filteredIds = useMemo(() => filteredSymbols.map((symbol) => symbol.id), [filteredSymbols]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someFilteredSelected = filteredIds.some((id) => selectedIds.has(id));
  const selectedCount = selectedSymbols.length;
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

  useEffect(() => {
    setSelectedIds((current) => {
      const validIds = new Set(symbols.map((symbol) => symbol.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [symbols]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [allFilteredSelected, someFilteredSelected]);

  const startEdit = (symbol: TradeSymbol) => {
    const { id: _id, quoteStatus: _quoteStatus, createdAt: _createdAt, updatedAt: _updatedAt, ...nextDraft } = symbol;
    setEditingId(symbol.id);
    setDraft(nextDraft);
    setMessage("");
  };

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

  const closeEdit = () => {
    if (saving) return;
    setEditingId(null);
    setDraft(null);
  };

  const applyBatchVisibility = async (isVisible: boolean) => {
    await applyBatchUpdate(isVisible ? "show" : "hide", (symbol) => ({ ...symbol, isVisible }));
  };

  const applyBatchTradeStatus = async () => {
    await applyBatchUpdate("status", (symbol) => ({ ...symbol, tradeStatus: batchTradeStatus }));
  };

  const applyBatchUpdate = async (action: BatchAction, update: (symbol: TradeSymbol) => TradeSymbol) => {
    if (selectedSymbols.length === 0) {
      setMessage("请先选择需要批量管理的品种。");
      return;
    }
    setBatchAction(action);
    setMessage("");
    try {
      const updatedAt = new Date().toISOString();
      const nextSymbols = selectedSymbols.map((symbol) => ({ ...update(symbol), updatedAt }));
      const backendSymbols = await syncMarketSymbols(nextSymbols);
      setSymbolsFromBackend(backendSymbols);
      setMessage(`已批量更新 ${selectedSymbols.length} 个品种。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量更新失败。");
    } finally {
      setBatchAction(null);
    }
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toggleFilteredSelection = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of filteredIds) {
        if (checked) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
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

      <Card className="overflow-hidden p-0">
        <div className="space-y-4 border-b border-line p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_minmax(280px,1fr)] lg:items-end">
            <Select
              label="品种分类"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}
              options={categoryFilterOptions.map((option) => ({
                ...option,
                label: option.value === "all" ? `${option.label}（${symbols.length}）` : `${option.label}（${categoryCounts.get(option.value) ?? 0}）`,
              }))}
            />
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-300">搜索</span>
              <input
                className="w-full border border-line bg-black px-3.5 py-3 text-sm text-white outline-none transition focus:border-white focus:bg-[#0d0d0d]"
                placeholder="搜索 symbol、名称、来源 coin、dex 或分类"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <div className="grid gap-3 border border-white/10 bg-white/[0.025] p-3 xl:grid-cols-[minmax(180px,260px)_1fr] xl:items-center">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-300">
              <span>
                已选择 <span className="font-semibold text-white">{selectedCount}</span> 个
              </span>
              <span className="text-white/25">/</span>
              <span>
                当前筛选 <span className="font-semibold text-white">{filteredSymbols.length}</span> 个
              </span>
              {selectedCount > 0 ? (
                <button
                  type="button"
                  className="text-xs text-slate-400 underline-offset-4 hover:text-white hover:underline"
                  onClick={() => setSelectedIds(new Set())}
                >
                  清空选择
                </button>
              ) : null}
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(260px,auto)_minmax(420px,1fr)] lg:items-end xl:justify-end">
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">批量可见性</p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <Button
                    type="button"
                    variant="secondary"
                    className="sm:min-w-[112px]"
                    disabled={selectedCount === 0 || batchAction !== null}
                    onClick={() => void applyBatchVisibility(true)}
                  >
                    {batchAction === "show" ? "更新中..." : "设为可见"}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    className="sm:min-w-[112px]"
                    disabled={selectedCount === 0 || batchAction !== null}
                    onClick={() => void applyBatchVisibility(false)}
                  >
                    {batchAction === "hide" ? "更新中..." : "设为隐藏"}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">批量交易状态</p>
                <div className="grid gap-2 sm:grid-cols-[minmax(240px,1fr)_minmax(132px,auto)]">
                  <Select
                    hideLabel
                    label="批量交易状态"
                    value={batchTradeStatus}
                    onChange={(event) => setBatchTradeStatus(event.target.value as TradeSymbol["tradeStatus"])}
                    options={tradeStatusOptions}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="sm:min-w-[132px]"
                    disabled={selectedCount === 0 || batchAction !== null}
                    onClick={() => void applyBatchTradeStatus()}
                  >
                    {batchAction === "status" ? "更新中..." : "应用状态"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
          {message ? <p className="border border-white/20 bg-white/[0.03] p-3 text-sm text-slate-200">{message}</p> : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1440px] text-left text-sm">
            <thead className="xh-thead">
              <tr>
                <th className="px-5 py-3 font-medium">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allFilteredSelected}
                      disabled={filteredIds.length === 0}
                      onChange={(event) => toggleFilteredSelection(event.target.checked)}
                    />
                    全选
                  </label>
                </th>
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
                const selected = selectedIds.has(symbol.id);
                return (
                  <tr
                    key={symbol.id}
                    className={`${!symbol.isVisible ? "opacity-55" : ""} ${selected ? "bg-white/[0.035]" : ""}`}
                  >
                    <td className="px-5 py-4 align-top">
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={`选择 ${symbol.symbol}`}
                        onChange={(event) => toggleSelected(symbol.id, event.target.checked)}
                      />
                    </td>
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
                      <Badge tone={symbol.tradeStatus === "enabled" ? "success" : symbol.tradeStatus === "disabled" ? "danger" : "neutral"}>
                        {tradeStatusLabel(symbol.tradeStatus)}
                      </Badge>
                      <p className="mt-2 text-xs text-muted">{symbol.isVisible ? "用户端可见" : "用户端隐藏"}</p>
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
                <tr><td className="px-5 py-8 text-center text-muted" colSpan={10}>没有匹配的品种。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={Boolean(draft && managedSymbol)}
        title="编辑品种配置"
        onClose={closeEdit}
        shellClassName="max-w-[1080px]"
        bodyClassName="max-h-[72vh] overflow-y-auto"
      >
        {draft && managedSymbol ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
                options={tradeStatusOptions}
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
            <div className="flex flex-col gap-3 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted">
                当前编辑：<span className="font-mono text-slate-200">{managedSymbol.symbol}</span>
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" variant="secondary" disabled={saving} onClick={closeEdit}>
                  取消
                </Button>
                <Button type="submit" disabled={saving} className="sm:min-w-[160px]">
                  {saving ? "保存中..." : "保存配置"}
                </Button>
              </div>
            </div>
          </form>
        ) : null}
      </Modal>
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
  if (status === "enabled") return "允许开仓和平仓";
  if (status === "close_only") return "仅允许平仓";
  return "禁止开仓";
}

function categoryLabel(category: SymbolCategory) {
  return categoryOptions.find((option) => option.value === category)?.label ?? "other（其他）";
}
