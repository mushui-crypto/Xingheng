import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { BinanceCredential } from "./BinanceCredential";
import { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import { loadBinanceTradingConfig } from "./BinanceTradingConfig";

type ConnectionState = {
  status: "not_configured" | "checking" | "connected" | "failed";
  checkedAt: number | null;
  accountId: string | null;
  message: string | null;
};

type PersonalTradingService = Pick<
  BinancePersonalTradingService,
  | "checkConnection"
  | "account"
  | "executionAccountIdentity"
  | "readExecutionPositionMode"
  | "market"
  | "placeExecutionOrder"
  | "loadExecutionReadContext"
  | "readExecutionRiskSnapshot"
  | "readSpotOrderFills"
  | "cancelOrder"
  | "ordersState"
  | "executionOrderState"
  | "findExecutionOrderByClientOrderId"
  | "close"
>;

export class BinancePersonalTradingServiceRegistry {
  private readonly locks = new Map<string, AsyncLock>();
  private readonly connections = new Map<string, ConnectionState>();

  constructor(
    private readonly credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForExecution" | "delete">,
    private readonly options: {
      serviceFactory?: (credential: BinanceCredential, orderDbPath: string) => PersonalTradingService;
      orderDbPathForUser?: (userId: string) => string;
    } = {},
  ) {}

  status(userId: string) {
    const credential = this.credentials.findSummary(userId, "binance");
    const config = loadBinanceTradingConfig();
    return {
      mode: "personal" as const,
      version: config.gitCommit,
      credential: {
        configured: Boolean(credential),
        maskedApiKey: credential?.maskedApiKey ?? null,
      },
      connection: credential
        ? this.connections.get(userId) ?? {
          status: "connected" as const,
          checkedAt: credential.lastVerifiedAt,
          accountId: credential.accountId,
          message: null,
        }
        : notConfiguredConnection(),
      risk: {
        liveTradingEnabled: config.liveTradingEnabled,
        killSwitchActive: config.killSwitchActive,
        maxOrderUsd: config.maxOrderUsd,
        maxPositionUsd: config.maxPositionUsd,
      },
    };
  }

  async checkConnection(userId: string) {
    this.connections.set(userId, { status: "checking", checkedAt: null, accountId: null, message: null });
    return this.run(userId, async (service) => {
      const status = await service.checkConnection();
      this.connections.set(userId, status.connection);
      return { ...status, credential: this.status(userId).credential };
    }).catch((error) => {
      this.connections.set(userId, {
        status: "failed",
        checkedAt: Date.now(),
        accountId: null,
        message: error instanceof Error ? error.message : "Binance connection check failed.",
      });
      throw error;
    });
  }

  run<T>(userId: string, operation: (service: PersonalTradingService) => Promise<T> | T) {
    return this.lock(userId).run(() => this.withService(userId, operation));
  }

  async assertCanDeleteCredential(userId: string) {
    const snapshot = await this.run(userId, (service) => service.account());
    if (
      snapshot.openSpotOrderCount > 0
      || snapshot.openPerpetualOrderCount > 0
      || snapshot.existingSpotQuantityXaut > 1e-9
      || snapshot.existingPerpetualQuantityXaut > 1e-9
    ) {
      throw new BinanceCredentialInUseError();
    }
  }

  deleteCredential(userId: string) {
    return this.lock(userId).run(async () => {
      if (!this.credentials.findSummary(userId, "binance")) return false;
      const snapshot = await this.withService(userId, (service) => service.account());
      if (
        snapshot.openSpotOrderCount > 0
        || snapshot.openPerpetualOrderCount > 0
        || snapshot.existingSpotQuantityXaut > 1e-9
        || snapshot.existingPerpetualQuantityXaut > 1e-9
      ) {
        throw new BinanceCredentialInUseError();
      }
      this.credentials.delete(userId, "binance");
      this.clearUser(userId);
      return true;
    });
  }

  clearUser(userId: string) {
    this.connections.delete(userId);
  }

  private createService(credential: BinanceCredential, orderDbPath: string) {
    return this.options.serviceFactory?.(credential, orderDbPath)
      ?? new BinancePersonalTradingService({ credential, orderDbPath });
  }

  private async withService<T>(userId: string, operation: (service: PersonalTradingService) => Promise<T> | T) {
    const secret = await this.credentials.loadForExecution(userId, "binance");
    const credential = BinanceCredential.fromValues(secret.apiKey, secret.apiSecret);
    const service = this.createService(credential, this.orderDbPath(userId));
    try {
      return await operation(service);
    } finally {
      service.close();
    }
  }

  private orderDbPath(userId: string) {
    return this.options.orderDbPathForUser?.(userId) ?? defaultOrderDbPath(userId);
  }

  private lock(userId: string) {
    let lock = this.locks.get(userId);
    if (!lock) {
      lock = new AsyncLock();
      this.locks.set(userId, lock);
    }
    return lock;
  }
}

export class BinanceCredentialInUseError extends Error {
  readonly category = "credential_in_use";

  constructor() {
    super("Binance credential cannot be removed while XAUT orders or exposure remain.");
  }
}

function defaultOrderDbPath(userId: string) {
  const directory = process.env.BINANCE_USER_ORDER_DB_DIR
    ?? resolve(process.cwd(), "server/data/binance-users");
  const userDomain = createHash("sha256").update(`binance-personal:${userId}`).digest("hex").slice(0, 32);
  return resolve(directory, `${userDomain}.sqlite`);
}

function notConfiguredConnection(): ConnectionState {
  return { status: "not_configured", checkedAt: null, accountId: null, message: null };
}

class AsyncLock {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
