export type RwaAutomationVenue = "bybit";
export type RwaAutomationStrategyId = "bybit-xaut-spot-perp-v1";
export type RwaAutomationPhase = "phase_a_shadow";
export type RwaAutomationState =
  | "disabled"
  | "observing"
  | "armed"
  | "opening"
  | "hedged"
  | "rebalancing"
  | "closing"
  | "fault"
  | "manual_intervention";

export type RwaConnectorCapability =
  | "connectivity"
  | "account_mode"
  | "balances"
  | "fees"
  | "instrument_specs"
  | "orders"
  | "fills"
  | "positions";

export type RwaConnectorHealth = {
  venue: RwaAutomationVenue;
  connected: boolean;
  accountMode: "uta" | "classic" | "unknown" | null;
  readonly: true;
  permissions: {
    read: boolean;
    trade: false;
    withdraw: false;
  };
  capabilities: RwaConnectorCapability[];
  checkedAt: number;
  stale: boolean;
  errorCategory: string | null;
  message: string | null;
};

export type RwaAutomationBalance = {
  asset: "USDT" | "XAUT";
  available: number | null;
  walletBalance: number | null;
};

export type RwaAutomationFee = {
  symbol: string;
  spotTakerBps: number | null;
  perpTakerBps: number | null;
};

export type RwaAutomationInstrumentSpec = {
  symbol: string;
  kind: "spot" | "perpetual";
  status: "trading" | "paused" | "unknown";
  minOrderQty: number | null;
  qtyStep: number | null;
  minNotionalUsd: number | null;
};

export type RwaAutomationOrder = {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  status: "new" | "partially_filled" | "filled" | "cancelled" | "rejected" | "unknown";
  quantity: number | null;
  filledQuantity: number | null;
  updatedAt: number | null;
};

export type RwaAutomationFill = {
  fillId: string;
  orderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  price: number | null;
  quantity: number | null;
  fee: number | null;
  feeAsset: string | null;
  timestamp: number | null;
};

export type RwaAutomationPosition = {
  symbol: string;
  side: "long" | "short";
  quantity: number | null;
  notionalUsd: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationDistancePercent: number | null;
  updatedAt: number | null;
};

export type RwaReadOnlySnapshot = {
  connector: RwaConnectorHealth;
  balances: RwaAutomationBalance[];
  fees: RwaAutomationFee[];
  instruments: RwaAutomationInstrumentSpec[];
  orders: RwaAutomationOrder[];
  fills: RwaAutomationFill[];
  positions: RwaAutomationPosition[];
  fetchedAt: number;
};

export type RwaReadOnlyConnector = {
  venue: RwaAutomationVenue;
  readSnapshot(): Promise<RwaReadOnlySnapshot>;
  getWriteCallCount(): number;
};

export type RwaAutomationConfig = {
  phase: RwaAutomationPhase;
  globalExecutionEnabled: false;
  strategyEnabled: boolean;
  killSwitchActive: boolean;
  staleAfterMs: number;
  maxBatchNotionalUsd: number;
  maxStrategyNotionalUsd: number;
  shadowOnly: true;
};

export type RwaAutomationAuditEvent = {
  id: string;
  eventType: string;
  state: RwaAutomationState;
  idempotencyKey: string;
  occurredAt: number;
  summary: string;
  errorCategory: string | null;
};

export type RwaAutomationShadowDecision = {
  decisionId: string;
  idempotencyKey: string;
  action: "observe" | "would_open" | "would_close" | "hold" | "blocked";
  reason: string;
  wouldSendProviderWrite: false;
  target: {
    venue: RwaAutomationVenue;
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

export type RwaAutomationStatus = {
  network: "mainnet";
  phase: RwaAutomationPhase;
  strategyId: RwaAutomationStrategyId;
  ownerOnly: true;
  state: RwaAutomationState;
  status: "disabled" | "observing" | "fault";
  execution: {
    mode: "shadow";
    automaticOrdersEnabled: false;
    providerWriteCallCount: number;
  };
  connector: RwaConnectorHealth;
  account: {
    mode: RwaConnectorHealth["accountMode"];
    balances: RwaAutomationBalance[];
    fees: RwaAutomationFee[];
    instruments: RwaAutomationInstrumentSpec[];
    orders: RwaAutomationOrder[];
    fills: RwaAutomationFill[];
    positions: RwaAutomationPosition[];
  };
  shadow: RwaAutomationShadowDecision;
  recovery: {
    source: "provider_snapshot";
    restoredFromSnapshot: boolean;
    lastSnapshotAt: number | null;
  };
  audit: {
    latest: RwaAutomationAuditEvent[];
  };
  warnings: string[];
};
