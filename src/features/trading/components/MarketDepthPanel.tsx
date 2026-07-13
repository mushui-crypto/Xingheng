import { useState } from "react";
import { formatPrice } from "../../../utils/price";

export type MarketDepthLevel = {
  price: number;
  size: number;
  total?: number;
  cumulativeSize?: number;
};

export type MarketTradeRow = {
  price: number;
  size: number;
  side: string;
  timestamp: number;
  tradeId?: string;
  txHash?: string;
};

export type MarketDepthBook = {
  symbol: string;
  asks: MarketDepthLevel[];
  bids: MarketDepthLevel[];
};

export function MarketDepthPanel({
  ariaLabel,
  digits,
  markPrice,
  midPrice,
  orderbook,
  trades,
}: {
  ariaLabel: string;
  digits: number;
  markPrice?: number | null;
  midPrice?: number | null;
  orderbook: MarketDepthBook | null;
  trades: MarketTradeRow[];
}) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  const asks = orderbook?.asks.slice(0, 10).reverse() ?? [];
  const bids = orderbook?.bids.slice(0, 10) ?? [];

  return (
    <section className="xh-real-depth-panel">
      <div className="xh-real-depth-tabs" role="tablist" aria-label={ariaLabel}>
        <button className={tab === "book" ? "is-active" : ""} onClick={() => setTab("book")} role="tab" type="button">Order Book</button>
        <button className={tab === "trades" ? "is-active" : ""} onClick={() => setTab("trades")} role="tab" type="button">Recent Trades</button>
      </div>
      {tab === "book" ? (
        <>
          <div className="xh-real-book-head">
            <span>Price (USDT)</span><span>Size ({orderbook?.symbol?.replace("USDT", "") || "BTC"})</span><span>Total</span>
          </div>
          <BookSide levels={asks} digits={digits} tone="ask" />
          <div className="xh-real-book-mid">
            <strong>{formatBookPrice(midPrice ?? orderbook?.bids[0]?.price ?? orderbook?.asks[0]?.price, digits)}</strong>
            <span className="xh-real-book-change">-</span>
            <span>Mark {formatBookPrice(markPrice, digits)}</span>
          </div>
          <BookSide levels={bids} digits={digits} tone="bid" />
        </>
      ) : (
        <div className="xh-real-trades-list">
          <div className="xh-real-book-head"><span>Side</span><span>Price</span><span>Size</span></div>
          {trades.length === 0 ? (
            <EmptyLine />
          ) : trades.slice(0, 24).map((trade, index) => (
            <div key={trade.tradeId ?? trade.txHash ?? `${trade.timestamp}-${index}`} className="xh-real-book-row">
              <span className={trade.side === "sell" ? "text-red-300" : "text-emerald-300"}>{trade.side}</span>
              <span className="font-mono">{formatPrice(trade.price, digits)}</span>
              <span className="text-right font-mono text-muted">{trade.size}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BookSide({ digits, levels, tone }: { digits: number; levels: MarketDepthLevel[]; tone: "ask" | "bid" }) {
  if (levels.length === 0) return <EmptyLine />;
  return (
    <div className="xh-real-book-side">
      {levels.map((level, index) => (
        <div key={`${tone}-${level.price}-${index}`} className={`xh-real-book-row is-${tone}`}>
          <span>{formatBookPrice(level.price, digits)}</span>
          <span>{level.size}</span>
          <span>{formatBookTotal(level, levels, index)}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyLine() {
  return <div className="border-b border-line px-4 py-3 text-sm text-muted">-</div>;
}

function formatBookTotal(level: MarketDepthLevel, levels: MarketDepthLevel[], index: number) {
  const explicitTotal = level.cumulativeSize ?? level.total;
  if (typeof explicitTotal === "number" && Number.isFinite(explicitTotal)) return formatNumber(explicitTotal);
  return formatNumber(levels.slice(0, index + 1).reduce((sum, item) => sum + item.size, 0));
}

function formatBookPrice(value: number | null | undefined, digits: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "-";
}

function formatNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : "-";
}
