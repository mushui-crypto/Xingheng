import { BinanceCredential } from "./BinanceCredential";
import {
  BinanceOrderManager,
  type BinanceOrderInput,
  type BinanceProviderMutationGuard,
} from "./BinanceOrderManager";
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
    const rawClient = this.credential ? new BinanceClient(this.credential.toClientCredentials()) : null;
    this.client = rawClient;
    this.orders = this.client ? new BinanceOrderManager(this.client, this.risk, this.store, this.config) : null;
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
      this.connection = { status: "connected", checkedAt: Date.now(), accountId: access.accountId, message: null };
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

  async placeExecutionOrder(input: BinanceOrderInput, beforeProviderMutation?: BinanceProviderMutationGuard) {
    return this.requireOrders().place(input, beforeProviderMutation);
  }

  async cancelOrder(input: unknown) {
    this.risk.assertCancellationAllowed();
    const body = object(input);
    return this.requireOrders().cancel(string(body.idempotencyKey, "idempotencyKey"));
  }

  ordersState() {
    return { orders: this.requireOrders().listOrders() };
  }

  findExecutionOrderByClientOrderId(category: "spot" | "linear", clientOrderId: string) {
    return this.requireClient().findOrderByClientOrderId(category, clientOrderId);
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
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new Error(`${name} is invalid.`);
  return value.trim();
}
