import { BinanceCredential } from "./BinanceCredential";
import { BinanceFundingArbitrageStrategy } from "./BinanceFundingArbitrageStrategy";
import { BinanceOrderManager, type BinanceOrderInput } from "./BinanceOrderManager";
import { BinanceOrderStore } from "./BinanceOrderStore";
import { BinanceRiskGuard } from "./BinanceRiskGuard";
import { loadBinanceTradingConfig } from "./BinanceTradingConfig";
import { BinanceClient } from "./BinanceClient";

export type BinancePersonalTradingServiceOptions = {
  credential?: BinanceCredential | null;
  orderDbPath?: string;
};

export class BinancePersonalTradingService {
  private readonly config;
  private readonly credential;
  private readonly store;
  private readonly risk;
  private readonly client;
  private readonly orders;
  private readonly strategy;
  private connection: {
    status: "not_configured" | "checking" | "connected" | "failed";
    checkedAt: number | null;
    accountId: string | null;
    message: string | null;
  };

  constructor(options: BinancePersonalTradingServiceOptions = {}) {
    this.config = loadBinanceTradingConfig();
    this.credential = Object.hasOwn(options, "credential")
      ? options.credential ?? null
      : BinanceCredential.fromEnvironment();
    this.store = new BinanceOrderStore(options.orderDbPath);
    this.risk = new BinanceRiskGuard(this.config);
    this.client = this.credential ? new BinanceClient(this.credential.toClientCredentials()) : null;
    this.orders = this.client ? new BinanceOrderManager(this.client, this.risk, this.store, this.config) : null;
    this.strategy = this.client && this.orders
      ? new BinanceFundingArbitrageStrategy(this.client, this.orders, this.config)
      : null;
    this.connection = {
      status: this.credential ? "checking" : "not_configured",
      checkedAt: null,
      accountId: null,
      message: null,
    };
  }

  async start() {
    if (!this.client) return this.getStatus();
    try {
      const access = await this.client.validateAccess();
      const snapshot = await this.orders!.syncPositions();
      assertBinanceStartupLeverage(snapshot.perpetual.leverage);
      this.connection = { status: "connected", checkedAt: Date.now(), accountId: access.accountId, message: null };
      await this.orders!.reconcile();
    } catch (error) {
      this.connection = {
        status: "failed",
        checkedAt: Date.now(),
        accountId: null,
        message: error instanceof Error ? error.message : "Binance connection check failed.",
      };
    }
    return this.getStatus();
  }

  getStatus() {
    return {
      mode: "personal" as const,
      version: this.config.gitCommit,
      credential: {
        configured: Boolean(this.credential),
        maskedApiKey: this.credential?.maskedApiKey() ?? null,
      },
      connection: this.connection,
      risk: this.risk.status(),
    };
  }

  async checkConnection() {
    this.requireClient();
    this.connection = { ...this.connection, status: "checking", message: null };
    return this.start();
  }

  async account() {
    return this.requireOrders().syncPositions();
  }

  async market() {
    const snapshot = await this.requireOrders().syncPositions();
    return {
      fetchedAt: snapshot.fetchedAt,
      productAvailability: snapshot.productAvailability,
      spot: snapshot.spot,
      perpetual: snapshot.perpetual,
      fees: snapshot.fees,
    };
  }

  async strategyStatus() {
    return this.requireStrategy().status();
  }

  async enter(input: unknown) {
    const body = object(input);
    return this.requireStrategy().enter({
      idempotencyKey: string(body.idempotencyKey, "idempotencyKey"),
      ...(body.budgetUsd === undefined ? {} : { budgetUsd: positiveNumber(body.budgetUsd, "budgetUsd") }),
    });
  }

  async exit(input: unknown) {
    const body = object(input);
    return this.requireStrategy().exit({ idempotencyKey: string(body.idempotencyKey, "idempotencyKey") });
  }

  async placeOrder(input: unknown) {
    return this.requireOrders().place(parseOrderInput(input));
  }

  async placeTestOrder(input: unknown) {
    return this.requireOrders().placeTestOrder(parseOrderInput(input));
  }

  async cancelOrder(input: unknown) {
    const body = object(input);
    return this.requireOrders().cancel(string(body.idempotencyKey, "idempotencyKey"));
  }

  ordersState() {
    return { orders: this.requireOrders().listOrders() };
  }

  reconciliation() {
    return this.requireOrders().reconcile();
  }

  close() {
    this.store.close();
  }

  private requireClient() {
    if (!this.client) throw new Error("BINANCE_API_KEY and BINANCE_API_SECRET are not configured.");
    return this.client;
  }

  private requireOrders() {
    if (!this.orders) throw new Error("Binance personal trading is not configured.");
    return this.orders;
  }

  private requireStrategy() {
    if (!this.strategy) throw new Error("Binance personal trading is not configured.");
    return this.strategy;
  }
}

function parseOrderInput(input: unknown): BinanceOrderInput {
  const body = object(input);
  const category = body.category;
  const side = body.side;
  if (category !== "spot" && category !== "linear") throw new Error("category must be spot or linear.");
  if (side !== "Buy" && side !== "Sell") throw new Error("side must be Buy or Sell.");
  return {
    idempotencyKey: string(body.idempotencyKey, "idempotencyKey"),
    category,
    symbol: "XAUTUSDT",
    side,
    quantityXaut: positiveNumber(body.quantityXaut, "quantityXaut"),
    limitPrice: positiveNumber(body.limitPrice, "limitPrice"),
    reduceOnly: body.reduceOnly === true,
  };
}

export function assertBinanceStartupLeverage(leverage: number | null) {
  if (leverage !== 1) {
    throw new Error("Binance XAUTUSDT perpetual leverage must be configured to 1x before startup.");
  }
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new Error(`${name} is invalid.`);
  return value.trim();
}

function positiveNumber(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}
