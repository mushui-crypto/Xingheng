import type {
  BalanceAdjustment,
  MarketSource,
  MarketSymbol,
  OrderRecord,
  Position,
  PositionSide,
  PositionView,
  TradeSide,
  TradingAccount,
} from "../types";
import type { TradingStore } from "../storage/TradingStore";

const defaultInitialBalance = 10_000;

type TradingMarket = {
  getSymbol(symbol: string): MarketSymbol | null;
  getTicker(symbol: string): {
    symbol: string;
    status: "connected" | "stale" | "disconnected";
    tick?: {
      bid: number;
      ask: number;
      last: number;
      spread: number;
      source: MarketSource;
      timestamp: number;
    };
  };
};

export class TradingService {
  private accounts = new Map<string, TradingAccount>();
  private positions: Position[] = [];
  private orders: OrderRecord[] = [];
  private adjustments: BalanceAdjustment[] = [];

  constructor(
    private market: TradingMarket,
    private store?: TradingStore,
  ) {
    for (const account of store?.listAccounts() ?? []) {
      this.accounts.set(account.userId, account);
    }
    this.positions = store?.listPositions() ?? [];
    this.orders = store?.listOrders() ?? [];
    this.adjustments = store?.listAdjustments() ?? [];
  }

  getAccount(userId: string, currency = "USD") {
    const account = this.ensureAccount(userId, currency);
    return this.toAccountView(account);
  }

  listAccounts() {
    return [...this.accounts.values()].map((account) => this.toAccountView(account));
  }

  adjustBalance(userId: string, type: BalanceAdjustment["type"], amount: number, note?: string) {
    const normalizedUserId = normalizeUserId(userId);
    const account = this.ensureAccount(normalizedUserId);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("调整金额不能小于 0。");
    }

    const previousBalance = account.balance;
    if (type === "deposit") {
      account.balance += amount;
    }
    if (type === "withdraw") {
      account.balance = Math.max(0, account.balance - amount);
    }
    if (type === "reset") {
      account.balance = amount;
    }
    account.updatedAt = Date.now();
    this.accounts.set(normalizedUserId, account);
    this.store?.upsertAccount(account);

    const adjustment: BalanceAdjustment = {
      id: `ADJ-${Date.now().toString(36).toUpperCase()}`,
      accountId: account.id,
      userId: normalizedUserId,
      type,
      amount,
      previousBalance,
      nextBalance: account.balance,
      note,
      createdAt: Date.now(),
    };
    this.adjustments = [adjustment, ...this.adjustments].slice(0, 200);
    this.store?.saveAdjustment(adjustment);
    return this.toAccountView(account);
  }

  marketOrder(userId: string, symbol: string, side: TradeSide, volume: number) {
    const account = this.ensureAccount(userId);
    const config = this.market.getSymbol(symbol);
    const rejection = this.validateOpenOrder(config, symbol, side, volume, account);
    if (rejection) {
      this.recordRejectedOrder(userId, account.id, config?.symbol ?? symbol, side, volume, rejection);
      throw new Error(rejection);
    }

    const safeConfig = config as MarketSymbol;
    const ticker = this.market.getTicker(safeConfig.symbol);
    const tick = ticker.tick!;
    const positionSide: PositionSide = side === "buy" ? "long" : "short";
    const entryPrice = side === "buy" ? tick.ask : tick.bid;
    const margin = this.calculateMargin(safeConfig, entryPrice, volume);
    const position: Position = {
      id: `POS-${Date.now().toString(36).toUpperCase()}`,
      userId,
      symbol: safeConfig.symbol,
      side: positionSide,
      volume,
      entryPrice,
      margin,
      openedAt: Date.now(),
      source: tick.source,
      quoteTime: tick.timestamp,
      entryBid: tick.bid,
      entryAsk: tick.ask,
      entrySpread: tick.spread,
    };
    this.positions = [position, ...this.positions].slice(0, 200);
    this.store?.savePosition(position);
    this.recordFilledOrder({
      userId,
      accountId: account.id,
      positionId: position.id,
      symbol: safeConfig.symbol,
      side,
      positionSide,
      action: "open",
      volume,
      price: entryPrice,
      bid: tick.bid,
      ask: tick.ask,
      spread: tick.spread,
      source: tick.source,
      quoteTime: tick.timestamp,
    });

    return this.toView(position);
  }

  closePosition(userId: string, positionId: string) {
    const position = this.positions.find((item) => item.id === positionId && item.userId === userId);
    const account = this.ensureAccount(userId);
    if (!position) {
      throw new Error("持仓不存在或已平仓。");
    }

    const config = this.market.getSymbol(position.symbol);
    const ticker = this.market.getTicker(position.symbol);
    const rejection = this.validateCloseOrder(config, position, ticker);
    if (rejection) {
      this.recordRejectedOrder(
        userId,
        account.id,
        position.symbol,
        position.side === "long" ? "sell" : "buy",
        position.volume,
        rejection,
        "close",
        position.id,
      );
      throw new Error(rejection);
    }

    const tick = ticker.tick!;
    const closeSide: TradeSide = position.side === "long" ? "sell" : "buy";
    const closePrice = position.side === "long" ? tick.bid : tick.ask;
    const pnl = this.calculatePnl(position, closePrice);
    account.balance = roundMoney(account.balance + pnl);
    account.updatedAt = Date.now();
    this.accounts.set(userId, account);
    this.store?.upsertAccount(account);
    this.positions = this.positions.filter((item) => item.id !== position.id);
    this.store?.deletePosition(position.id);

    this.recordFilledOrder({
      userId,
      accountId: account.id,
      positionId: position.id,
      symbol: position.symbol,
      side: closeSide,
      positionSide: position.side,
      action: "close",
      volume: position.volume,
      price: closePrice,
      bid: tick.bid,
      ask: tick.ask,
      spread: tick.spread,
      source: tick.source,
      quoteTime: tick.timestamp,
      pnl,
    });

    return {
      positionId: position.id,
      closePrice,
      pnl,
      account: this.toAccountView(account),
    };
  }

  listPositions(userId?: string) {
    return this.positions.filter((position) => !userId || position.userId === userId).map((position) => this.toView(position));
  }

  listOrders(userId?: string) {
    return this.orders.filter((order) => !userId || order.userId === userId);
  }

  listAdjustments(userId?: string) {
    return this.adjustments.filter((adjustment) => !userId || adjustment.userId === userId);
  }

  private ensureAccount(userId: string, currency = "USD") {
    const normalized = normalizeUserId(userId);
    const existing = this.accounts.get(normalized);
    if (existing) {
      return existing;
    }

    const account: TradingAccount = {
      id: `ACC-${normalized}`,
      userId: normalized,
      currency,
      balance: defaultInitialBalance,
      equity: defaultInitialBalance,
      usedMargin: 0,
      freeMargin: defaultInitialBalance,
      floatingPnl: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.accounts.set(normalized, account);
    this.store?.upsertAccount(account);
    return account;
  }

  private toAccountView(account: TradingAccount) {
    const positions = this.listPositions(account.userId);
    const floatingPnl = roundMoney(positions.reduce((sum, position) => sum + (position.pnl ?? 0), 0));
    const usedMargin = roundMoney(positions.reduce((sum, position) => sum + position.margin, 0));
    const equity = roundMoney(account.balance + floatingPnl);
    return {
      ...account,
      floatingPnl,
      usedMargin,
      equity,
      freeMargin: roundMoney(equity - usedMargin),
      updatedAt: Date.now(),
    };
  }

  private toView(position: Position): PositionView {
    const ticker = this.market.getTicker(position.symbol);
    const markPrice = ticker.tick ? (position.side === "long" ? ticker.tick.bid : ticker.tick.ask) : null;
    const pnl = markPrice === null ? null : this.calculatePnl(position, markPrice);

    return {
      ...position,
      markPrice,
      pnl,
    };
  }

  private validateOpenOrder(
    config: MarketSymbol | null,
    symbol: string,
    _side: TradeSide,
    volume: number,
    account: TradingAccount,
  ) {
    if (!config) {
      return `品种 ${symbol.toUpperCase()} 未配置。`;
    }
    if (config.tradeStatus === "disabled") {
      return "品种已停用，禁止交易。";
    }
    if (config.tradeStatus === "close_only") {
      return "品种仅允许平仓，禁止新开仓。";
    }
    const ticker = this.market.getTicker(config.symbol);
    const quoteRejection = this.validateTicker(ticker, config);
    if (quoteRejection) {
      return quoteRejection;
    }
    const lotRejection = this.validateVolume(config, volume);
    if (lotRejection) {
      return lotRejection;
    }
    const entryPrice = _side === "buy" ? ticker.tick!.ask : ticker.tick!.bid;
    const margin = this.calculateMargin(config, entryPrice, volume);
    if (this.toAccountView(account).freeMargin < margin) {
      return "可用保证金不足，市价单已拒绝。";
    }
    return null;
  }

  private validateCloseOrder(config: MarketSymbol | null, position: Position, ticker: ReturnType<TradingMarket["getTicker"]>) {
    if (!config) {
      return `品种 ${position.symbol} 未配置。`;
    }
    if (config.tradeStatus === "disabled") {
      return "品种已停用，禁止平仓。";
    }
    return this.validateTicker(ticker, config);
  }

  private validateTicker(ticker: ReturnType<TradingMarket["getTicker"]>, config: MarketSymbol) {
    if (!ticker.tick) {
      return "行情不存在，禁止市价成交。";
    }
    if (ticker.status !== "connected") {
      return ticker.status === "stale" ? "行情延迟，禁止市价成交。" : "行情连接中断，禁止市价成交。";
    }
    const { bid, ask, spread, timestamp } = ticker.tick;
    if (![bid, ask, spread].every((value) => Number.isFinite(value) && value > 0) || ask <= bid) {
      return "Bid/Ask 异常，禁止市价成交。";
    }
    if (Date.now() - timestamp > 10_000) {
      return "行情已过期，禁止市价成交。";
    }
    if (spread > config.spread * 10) {
      return "点差异常扩大，市价单已拒绝。";
    }
    return null;
  }

  private validateVolume(config: MarketSymbol, volume: number) {
    if (!Number.isFinite(volume) || volume <= 0) {
      return "手数必须大于 0。";
    }
    if (volume < config.minLot || volume > config.maxLot) {
      return `手数需在 ${config.minLot} 到 ${config.maxLot} 之间。`;
    }
    const steps = Math.round((volume - config.minLot) / config.lotStep);
    const expected = config.minLot + steps * config.lotStep;
    if (Math.abs(expected - volume) > 1e-8) {
      return `手数步进必须为 ${config.lotStep}。`;
    }
    return null;
  }

  private calculateMargin(config: MarketSymbol, price: number, volume: number) {
    return roundMoney((price * volume * config.contractSize) / config.leverage);
  }

  private calculatePnl(position: Position, markPrice: number) {
    const config = this.market.getSymbol(position.symbol);
    const contractSize = config?.contractSize ?? 1;
    const raw =
      (position.side === "long" ? markPrice - position.entryPrice : position.entryPrice - markPrice) *
      position.volume *
      contractSize;
    return roundMoney(raw);
  }

  private recordRejectedOrder(
    userId: string,
    accountId: string,
    symbol: string,
    side: TradeSide,
    volume: number,
    reason: string,
    action: OrderRecord["action"] = "open",
    positionId?: string,
  ) {
    const ticker = this.market.getTicker(symbol);
    const tick = ticker.tick;
    const positionSide: PositionSide = side === "buy" ? "long" : "short";
    const order: OrderRecord = {
      id: `ORD-${Date.now().toString(36).toUpperCase()}`,
      userId,
      accountId,
      positionId,
      symbol,
      side,
      positionSide,
      orderType: "Market",
      action,
      status: "rejected",
      volume,
      price: null,
      bid: tick?.bid ?? null,
      ask: tick?.ask ?? null,
      spread: tick?.spread ?? null,
      source: tick?.source ?? "unknown",
      quoteTime: tick?.timestamp ?? null,
      simulated: true,
      reason,
      createdAt: Date.now(),
    };
    this.orders = [order, ...this.orders].slice(0, 500);
    this.store?.saveOrder(order);
  }

  private recordFilledOrder(input: {
    userId: string;
    accountId: string;
    positionId: string;
    symbol: string;
    side: TradeSide;
    positionSide: PositionSide;
    action: OrderRecord["action"];
    volume: number;
    price: number;
    bid: number;
    ask: number;
    spread: number;
    source: MarketSource;
    quoteTime: number;
    pnl?: number;
  }) {
    const order: OrderRecord = {
      id: `ORD-${Date.now().toString(36).toUpperCase()}`,
      userId: input.userId,
      accountId: input.accountId,
      positionId: input.positionId,
      symbol: input.symbol,
      side: input.side,
      positionSide: input.positionSide,
      orderType: "Market",
      action: input.action,
      status: "filled",
      volume: input.volume,
      price: input.price,
      bid: input.bid,
      ask: input.ask,
      spread: input.spread,
      source: input.source,
      quoteTime: input.quoteTime,
      simulated: true,
      pnl: input.pnl,
      createdAt: Date.now(),
    };
    this.orders = [order, ...this.orders].slice(0, 500);
    this.store?.saveOrder(order);
  }
}

function normalizeUserId(userId: string) {
  return userId?.trim() || "demo-user";
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}
