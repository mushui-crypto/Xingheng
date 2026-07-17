import { SubscriptionClient, WebSocketTransport, type ISubscription } from "@nktkas/hyperliquid";
import {
  normalizeAddress,
  normalizeFill,
  normalizeHistoricalOrder,
  normalizeOpenOrder,
  normalizePositions,
} from "./HyperliquidInfoClient";
import type { HyperliquidInfoClient } from "./HyperliquidInfoClient";
import type { RealTradingOrderStateService } from "./RealTradingOrderStateService";

export type RealTradingUserStreamEvent = {
  type: "real-trading-user";
  mode: "snapshot" | "incremental";
  sequence: number;
  timestamp: number;
  status: "connected" | "stale" | "reconnecting";
  stale: boolean;
  reconnecting: boolean;
  authoritative: true;
  source: "hyperliquid-user-ws" | "hyperliquid-rest-snapshot";
  address: string;
  channel: "snapshot" | "orders" | "fills" | "open_orders" | "account" | "connection";
  data: unknown;
};

type Listener = (event: RealTradingUserStreamEvent) => void;
type AddressStream = {
  address: string;
  listeners: Set<Listener>;
  userRefs: Map<string, number>;
  sequence: number;
  transport: WebSocketTransport | null;
  subscriptions: ISubscription[];
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  starting: boolean;
  stopped: boolean;
  disconnected: boolean;
};

type UserStreamFactory = () => {
  client: Pick<SubscriptionClient, "clearinghouseState" | "openOrders" | "orderUpdates" | "userFills">;
  transport: Pick<WebSocketTransport, "close" | "ready" | "socket">;
};

export class RealTradingUserStreamManager {
  private readonly streams = new Map<string, AddressStream>();
  private readonly activeAddressByUser = new Map<string, string>();

  constructor(
    private readonly info: HyperliquidInfoClient,
    private readonly orderState: RealTradingOrderStateService,
    private readonly createUpstream: UserStreamFactory = createHyperliquidUserStream,
  ) {}

  async acquire(userId: string, addressInput: unknown, listener: Listener) {
    const address = normalizeAddress(addressInput);
    const activeAddress = this.activeAddressByUser.get(userId);
    if (activeAddress && activeAddress !== address) {
      throw new Error("同一用户同时只能订阅一个真实交易主账户地址。");
    }
    let stream = this.streams.get(address);
    if (!stream) {
      const maxStreams = readMaxStreams();
      if (this.streams.size >= maxStreams) throw new Error(`真实交易实时订阅地址已达到服务端上限 ${maxStreams}。`);
      stream = {
        address,
        listeners: new Set(),
        userRefs: new Map(),
        sequence: 0,
        transport: null,
        subscriptions: [],
        reconnectTimer: null,
        starting: false,
        stopped: false,
        disconnected: false,
      };
      this.streams.set(address, stream);
    }
    this.activeAddressByUser.set(userId, address);
    stream.listeners.add(listener);
    stream.userRefs.set(userId, (stream.userRefs.get(userId) ?? 0) + 1);
    if (!stream.transport && !stream.reconnectTimer && !stream.starting) void this.start(stream);
    else void this.emitSnapshot(stream);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      stream!.listeners.delete(listener);
      const refs = Math.max(0, (stream!.userRefs.get(userId) ?? 1) - 1);
      if (refs === 0) {
        stream!.userRefs.delete(userId);
        if (this.activeAddressByUser.get(userId) === address) this.activeAddressByUser.delete(userId);
      } else stream!.userRefs.set(userId, refs);
      if (stream!.listeners.size === 0) void this.stopStream(stream!);
    };
  }

  async stop() {
    await Promise.all([...this.streams.values()].map((stream) => this.stopStream(stream)));
  }

  private async start(stream: AddressStream) {
    if (stream.stopped || stream.listeners.size === 0 || stream.starting) return;
    stream.starting = true;
    this.emit(stream, "connection", null, "reconnecting", true, true, "incremental", "hyperliquid-user-ws");
    try {
      await this.emitSnapshot(stream);
      if (stream.stopped || stream.listeners.size === 0) return;
      const { client, transport } = this.createUpstream();
      stream.transport = transport as WebSocketTransport;
      const handleDisconnect = () => {
        if (stream.stopped) return;
        stream.disconnected = true;
        this.emit(stream, "connection", null, "reconnecting", true, true, "incremental", "hyperliquid-user-ws");
      };
      const handleOpen = () => {
        if (stream.stopped) return;
        if (stream.disconnected) {
          stream.disconnected = false;
          void this.emitSnapshot(stream);
        }
      };
      transport.socket.addEventListener("close", handleDisconnect);
      transport.socket.addEventListener("open", handleOpen);
      const onError = () => this.scheduleReconnect(stream);
      await transport.ready(AbortSignal.timeout(10_000));
      if (stream.stopped || stream.listeners.size === 0) {
        transport.close();
        stream.transport = null;
        return;
      }
      stream.subscriptions = await Promise.all([
        client.orderUpdates({ user: stream.address as `0x${string}` }, (rows) => {
          this.emit(stream, "orders", rows.map(normalizeHistoricalOrder), "connected", false, false);
        }, { onError }),
        client.userFills({ user: stream.address as `0x${string}` }, (event) => {
          if (event.isSnapshot) return;
          this.emit(stream, "fills", event.fills.map(normalizeFill), "connected", false, false);
        }, { onError }),
        client.openOrders({ user: stream.address as `0x${string}` }, (event) => {
          this.emit(stream, "open_orders", event.orders.map(normalizeOpenOrder), "connected", false, false);
        }, { onError }),
        client.clearinghouseState({ user: stream.address as `0x${string}` }, (event) => {
          this.emit(stream, "account", normalizeRealtimeAccountState(stream.address, event.clearinghouseState), "connected", false, false);
        }, { onError }),
      ]);
      if (stream.stopped || stream.listeners.size === 0) {
        await Promise.all(stream.subscriptions.splice(0).map((subscription) => subscription.unsubscribe().catch(() => {})));
        transport.close();
        stream.transport = null;
        return;
      }
      this.emit(stream, "connection", null, "connected", false, false, "incremental", "hyperliquid-user-ws");
    } catch {
      this.scheduleReconnect(stream);
    } finally {
      stream.starting = false;
    }
  }

  private async emitSnapshot(stream: AddressStream) {
    try {
      const [orders, account, positions] = await Promise.all([
        this.orderState.read(stream.address),
        this.info.getAccountSummary(stream.address),
        this.info.getPositions(stream.address),
      ]);
      const stale = orders.stale || account.status !== "connected" || Date.now() - account.timestamp > 10_000;
      this.emit(
        stream,
        "snapshot",
        { orders, account, positions },
        stale ? "reconnecting" : "connected",
        stale,
        stale,
        "snapshot",
        "hyperliquid-rest-snapshot",
      );
    } catch {
      this.emit(stream, "snapshot", { orders: [], account: null, positions: [] }, "reconnecting", true, true, "snapshot", "hyperliquid-rest-snapshot");
    }
  }

  private scheduleReconnect(stream: AddressStream) {
    if (stream.stopped || stream.listeners.size === 0 || stream.reconnectTimer) return;
    this.emit(stream, "connection", null, "reconnecting", true, true, "incremental", "hyperliquid-user-ws");
    stream.subscriptions.splice(0).forEach((subscription) => void subscription.unsubscribe().catch(() => {}));
    stream.transport?.close();
    stream.transport = null;
    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null;
      void this.start(stream);
    }, 2_000);
    stream.reconnectTimer.unref?.();
  }

  private emit(
    stream: AddressStream,
    channel: RealTradingUserStreamEvent["channel"],
    data: unknown,
    status: RealTradingUserStreamEvent["status"],
    stale: boolean,
    reconnecting: boolean,
    mode: RealTradingUserStreamEvent["mode"] = "incremental",
    source: RealTradingUserStreamEvent["source"] = "hyperliquid-user-ws",
  ) {
    const event: RealTradingUserStreamEvent = {
      type: "real-trading-user",
      mode,
      sequence: ++stream.sequence,
      timestamp: Date.now(),
      status,
      stale,
      reconnecting,
      authoritative: true,
      source,
      address: stream.address,
      channel,
      data,
    };
    stream.listeners.forEach((listener) => listener(event));
  }

  private async stopStream(stream: AddressStream) {
    if (stream.stopped) return;
    stream.stopped = true;
    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = null;
    await Promise.all(stream.subscriptions.splice(0).map((subscription) => subscription.unsubscribe().catch(() => {})));
    stream.transport?.close();
    stream.transport = null;
    this.streams.delete(stream.address);
    for (const userId of stream.userRefs.keys()) {
      if (this.activeAddressByUser.get(userId) === stream.address) this.activeAddressByUser.delete(userId);
    }
  }
}

function normalizeRealtimeAccountState(address: string, state: any) {
  const margin = state?.marginSummary ?? {};
  return {
    account: {
      address,
      accountValue: nullableNumber(margin.accountValue),
      withdrawable: nullableNumber(state?.withdrawable),
      usedMargin: nullableNumber(margin.totalMarginUsed),
      crossAccountValue: nullableNumber(state?.crossMarginSummary?.accountValue),
      crossMaintenanceMarginUsed: nullableNumber(state?.crossMaintenanceMarginUsed),
      crossTotalMarginUsed: nullableNumber(state?.crossMarginSummary?.totalMarginUsed),
      crossTotalNotionalPosition: nullableNumber(state?.crossMarginSummary?.totalNtlPos),
      timestamp: Date.now(),
      status: "connected" as const,
      network: "hyperliquid-testnet" as const,
    },
    positions: normalizePositions(state?.assetPositions),
  };
}

function nullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readMaxStreams() {
  const value = Number(process.env.REAL_TRADING_REALTIME_MAX_ADDRESSES);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 100;
}

function createHyperliquidUserStream(): ReturnType<UserStreamFactory> {
  const transport = new WebSocketTransport({ isTestnet: true, resubscribe: true });
  return { client: new SubscriptionClient({ transport }), transport };
}
