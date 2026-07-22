export type NeutralAutomationStateName =
  | "disabled"
  | "observing"
  | "armed"
  | "opening"
  | "hedged"
  | "rebalancing"
  | "closing"
  | "fault"
  | "manual_intervention";

export type NeutralAutomationStatus = {
  network: "mainnet";
  phase: "phase_a_shadow";
  strategyId: "bybit-xaut-spot-perp-v1";
  ownerOnly: true;
  state: NeutralAutomationStateName;
  status: "disabled" | "observing" | "fault";
  execution: {
    mode: "shadow";
    automaticOrdersEnabled: false;
    providerWriteCallCount: number;
  };
  connector: {
    venue: "bybit";
    connected: boolean;
    accountMode: "uta" | "classic" | "unknown" | null;
    readonly: true;
    permissions: {
      read: boolean;
      trade: false;
      withdraw: false;
    };
    capabilities: string[];
    checkedAt: number;
    stale: boolean;
    errorCategory: string | null;
    message: string | null;
  };
  account: {
    mode: "uta" | "classic" | "unknown" | null;
    balances: Array<{
      asset: "USDT" | "XAUT";
      available: number | null;
      walletBalance: number | null;
    }>;
    fees: Array<{
      symbol: string;
      spotTakerBps: number | null;
      perpTakerBps: number | null;
    }>;
    instruments: Array<{
      symbol: string;
      kind: "spot" | "perpetual";
      status: "trading" | "paused" | "unknown";
      minOrderQty: number | null;
      qtyStep: number | null;
      minNotionalUsd: number | null;
    }>;
    orders: Array<{
      orderId: string;
      symbol: string;
      side: "buy" | "sell";
      status: "new" | "partially_filled" | "filled" | "cancelled" | "rejected" | "unknown";
      quantity: number | null;
      filledQuantity: number | null;
      updatedAt: number | null;
    }>;
    fills: Array<{
      fillId: string;
      orderId: string | null;
      symbol: string;
      side: "buy" | "sell";
      price: number | null;
      quantity: number | null;
      fee: number | null;
      feeAsset: string | null;
      timestamp: number | null;
    }>;
    positions: Array<{
      symbol: string;
      side: "long" | "short";
      quantity: number | null;
      notionalUsd: number | null;
      entryPrice: number | null;
      markPrice: number | null;
      liquidationDistancePercent: number | null;
      updatedAt: number | null;
    }>;
  };
  shadow: {
    decisionId: string;
    idempotencyKey: string;
    action: "observe" | "would_open" | "would_close" | "hold" | "blocked";
    reason: string;
    wouldSendProviderWrite: false;
    target: {
      venue: "bybit";
      spotSymbol: "XAUTUSDT";
      perpetualSymbol: "XAUTUSDT";
      notionalUsd: 0;
    };
    gateChecks: Array<{
      name: string;
      passed: boolean;
      message: string;
    }>;
    generatedAt: number;
  };
  recovery: {
    source: "provider_snapshot";
    restoredFromSnapshot: boolean;
    lastSnapshotAt: number | null;
  };
  audit: {
    latest: Array<{
      id: string;
      eventType: string;
      state: NeutralAutomationStateName;
      idempotencyKey: string;
      occurredAt: number;
      summary: string;
      errorCategory: string | null;
    }>;
  };
  warnings: string[];
};
