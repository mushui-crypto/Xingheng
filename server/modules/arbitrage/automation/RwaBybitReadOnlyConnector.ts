import type {
  RwaAutomationBalance,
  RwaAutomationFee,
  RwaAutomationFill,
  RwaAutomationInstrumentSpec,
  RwaAutomationOrder,
  RwaAutomationPosition,
  RwaConnectorHealth,
  RwaReadOnlyConnector,
  RwaReadOnlySnapshot,
} from "./RwaNeutralAutomationTypes";
import { categoryFromRwaAutomationError, sanitizeRwaAutomationError } from "./RwaNeutralAutomationSecurity";

export type RwaBybitReadOnlyClient = {
  checkConnectivity(): Promise<Partial<RwaConnectorHealth>>;
  getBalances(): Promise<RwaAutomationBalance[]>;
  getFees(): Promise<RwaAutomationFee[]>;
  getInstrumentSpecs(): Promise<RwaAutomationInstrumentSpec[]>;
  getOrders(): Promise<RwaAutomationOrder[]>;
  getFills(): Promise<RwaAutomationFill[]>;
  getPositions(): Promise<RwaAutomationPosition[]>;
};

const capabilities = [
  "connectivity",
  "account_mode",
  "balances",
  "fees",
  "instrument_specs",
  "orders",
  "fills",
  "positions",
] as const;

export class RwaBybitReadOnlyConnector implements RwaReadOnlyConnector {
  readonly venue = "bybit" as const;
  private writeCallCount = 0;

  constructor(private readonly client: RwaBybitReadOnlyClient = new DisabledBybitReadOnlyClient()) {}

  async readSnapshot(): Promise<RwaReadOnlySnapshot> {
    const fetchedAt = Date.now();
    try {
      const [connectivity, balances, fees, instruments, orders, fills, positions] = await Promise.all([
        this.client.checkConnectivity(),
        this.client.getBalances(),
        this.client.getFees(),
        this.client.getInstrumentSpecs(),
        this.client.getOrders(),
        this.client.getFills(),
        this.client.getPositions(),
      ]);
      return {
        connector: this.connectedHealth(connectivity, fetchedAt),
        balances,
        fees,
        instruments,
        orders,
        fills,
        positions,
        fetchedAt,
      };
    } catch (error) {
      return {
        connector: {
          venue: "bybit",
          connected: false,
          accountMode: null,
          readonly: true,
          permissions: { read: false, trade: false, withdraw: false },
          capabilities: [...capabilities],
          checkedAt: fetchedAt,
          stale: true,
          errorCategory: categoryFromRwaAutomationError(error),
          message: sanitizeRwaAutomationError(error),
        },
        balances: [],
        fees: [],
        instruments: [],
        orders: [],
        fills: [],
        positions: [],
        fetchedAt,
      };
    }
  }

  private connectedHealth(connectivity: Partial<RwaConnectorHealth>, fetchedAt: number): RwaConnectorHealth {
    const connected = connectivity.connected ?? true;
    const stale = connectivity.stale ?? false;
    const read = connected && !stale;
    const message = connectivity.message ? sanitizeRwaAutomationError(connectivity.message) : null;
    if (!read) {
      return {
        venue: "bybit",
        connected,
        accountMode: connectivity.accountMode ?? "unknown",
        readonly: true,
        permissions: { read: false, trade: false, withdraw: false },
        capabilities: [...capabilities],
        checkedAt: connectivity.checkedAt ?? fetchedAt,
        stale: true,
        errorCategory: normalizeConnectorErrorCategory(connectivity.errorCategory) ?? "provider_stale",
        message: message ?? "Bybit read-only connector is unavailable.",
      };
    }
    return {
      venue: "bybit",
      connected: true,
      accountMode: connectivity.accountMode ?? "unknown",
      readonly: true,
      permissions: { read: true, trade: false, withdraw: false },
      capabilities: [...capabilities],
      checkedAt: connectivity.checkedAt ?? fetchedAt,
      stale: false,
      errorCategory: normalizeConnectorErrorCategory(connectivity.errorCategory),
      message,
    };
  }

  getWriteCallCount() {
    return this.writeCallCount;
  }

  async placeOrder(): Promise<never> {
    this.writeCallCount += 1;
    throw new Error("Phase A is read-only; provider write actions are disabled.");
  }

  async cancelOrder(): Promise<never> {
    this.writeCallCount += 1;
    throw new Error("Phase A is read-only; provider write actions are disabled.");
  }
}

function normalizeConnectorErrorCategory(input: unknown) {
  const allowed = new Set([
    "provider_timeout",
    "provider_rate_limited",
    "provider_permission_error",
    "provider_stale",
    "provider_unknown",
  ]);
  return typeof input === "string" && allowed.has(input) ? input : null;
}

export class DisabledBybitReadOnlyClient implements RwaBybitReadOnlyClient {
  async checkConnectivity() {
    return {
      connected: false,
      accountMode: "unknown" as const,
      stale: true,
      message: "Bybit read-only connector is not configured.",
    };
  }

  async getBalances() {
    return [];
  }

  async getFees() {
    return [];
  }

  async getInstrumentSpecs() {
    return [];
  }

  async getOrders() {
    return [];
  }

  async getFills() {
    return [];
  }

  async getPositions() {
    return [];
  }
}
