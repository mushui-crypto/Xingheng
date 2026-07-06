import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TradeSymbol, TradeStatus } from "../../types/market";
import { formatQuantity } from "../../utils/quantity";
import { Modal } from "../ui/Modal";

type MarketSymbolPickerProps = {
  symbols: TradeSymbol[];
  selectedSymbol: string;
  onSelect: (symbol: string) => void;
};

type MarketFilter = "all" | TradeStatus | "high_leverage" | "small_minimum";

const marketFilters: Array<{ value: MarketFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "enabled", label: "可交易" },
  { value: "high_leverage", label: "高杠杆" },
  { value: "small_minimum", label: "小额起步" },
  { value: "close_only", label: "仅平仓" },
  { value: "disabled", label: "已暂停" },
];

export function MarketSymbolPicker({ symbols, selectedSymbol, onSelect }: MarketSymbolPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selected = symbols.find((item) => item.symbol === selectedSymbol) ?? symbols[0];
  const filteredSymbols = useMemo(() => {
    const keyword = search.trim().toUpperCase();
    return symbols
      .filter((item) => matchesFilter(item, marketFilter))
      .filter(
        (item) =>
          !keyword ||
          item.symbol.includes(keyword) ||
          item.apiSymbol.toUpperCase().includes(keyword) ||
          item.displayName.toUpperCase().includes(keyword),
      )
      .sort((a, b) => a.apiSymbol.localeCompare(b.apiSymbol));
  }, [marketFilter, search, symbols]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setMarketFilter("all");
      return;
    }
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [open]);

  if (!selected) {
    return null;
  }

  const selectSymbol = (symbol: string) => {
    onSelect(symbol);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="xh-market-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="xh-market-token" aria-hidden="true">
          {selected.apiSymbol.slice(0, 1)}
        </span>
        <span className="min-w-0 text-left">
          <span className="xh-market-trigger-symbol">
            {selected.apiSymbol}
            <span>/USDT</span>
          </span>
          <span className="xh-market-trigger-name">{selected.displayName}</span>
        </span>
        <ChevronDown className="xh-market-trigger-chevron" size={18} aria-hidden="true" />
      </button>

      <Modal
        open={open}
        title="选择市场"
        description={`${symbols.length} 个 Hyperliquid 主 DEX 活跃永续合约`}
        onClose={() => setOpen(false)}
        shellClassName="xh-market-modal"
        bodyClassName="xh-market-modal-body"
      >
        <div className="xh-market-search">
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            placeholder="搜索币种、交易对或名称"
            aria-label="搜索市场"
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button type="button" onClick={() => setSearch("")}>
              清除
            </button>
          ) : null}
        </div>

        <div className="xh-market-filters" role="tablist" aria-label="市场筛选">
          {marketFilters.map((filter) => {
            const count = symbols.filter((item) => matchesFilter(item, filter.value)).length;
            return (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={marketFilter === filter.value}
                className={marketFilter === filter.value ? "is-active" : ""}
                onClick={() => setMarketFilter(filter.value)}
              >
                {filter.label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="xh-market-list-header" aria-hidden="true">
          <span>市场</span>
          <span>杠杆</span>
          <span>最小数量</span>
          <span>状态</span>
        </div>

        <div className="xh-market-list" role="listbox" aria-label="市场列表">
          {filteredSymbols.length === 0 ? (
            <div className="xh-market-empty">
              <p>没有匹配的市场</p>
              <span>请尝试其他关键词或交易状态。</span>
            </div>
          ) : (
            filteredSymbols.map((item) => {
              const isSelected = item.symbol === selectedSymbol;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`xh-market-row ${isSelected ? "is-selected" : ""}`}
                  onClick={() => selectSymbol(item.symbol)}
                >
                  <span className="xh-market-row-main">
                    <span className="xh-market-row-token" aria-hidden="true">
                      {item.apiSymbol.slice(0, 1)}
                    </span>
                    <span className="min-w-0">
                      <strong>{item.apiSymbol}/USDT</strong>
                      <small>{item.displayName}</small>
                    </span>
                    {isSelected ? <Check className="xh-market-row-check" size={16} aria-hidden="true" /> : null}
                  </span>
                  <span className="xh-market-row-value">{item.leverage}×</span>
                  <span className="xh-market-row-value">{formatQuantity(item.minLot, item.lotStep)}</span>
                  <MarketStatus status={item.tradeStatus} />
                </button>
              );
            })
          )}
        </div>

        <div className="xh-market-modal-footer">
          <span>共 {filteredSymbols.length} 个结果</span>
          <span>点击市场即可切换</span>
        </div>
      </Modal>
    </>
  );
}

function MarketStatus({ status }: { status: TradeStatus }) {
  const label = status === "enabled" ? "可交易" : status === "close_only" ? "仅平仓" : "已暂停";
  return <span className={`xh-market-status is-${status}`}>{label}</span>;
}

function matchesFilter(symbol: TradeSymbol, filter: MarketFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "high_leverage") {
    return symbol.leverage >= 20;
  }
  if (filter === "small_minimum") {
    return symbol.minLot <= 0.01;
  }
  return symbol.tradeStatus === filter;
}
