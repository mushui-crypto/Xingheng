import assert from "node:assert/strict";
import test from "node:test";
import { RwaBybitReadOnlyConnector, type RwaBybitReadOnlyClient } from "./automation/RwaBybitReadOnlyConnector";
import { RwaNeutralAutomationService } from "./automation/RwaNeutralAutomationService";
import { sanitizeRwaAutomationError } from "./automation/RwaNeutralAutomationSecurity";
import type { RwaReadOnlySnapshot } from "./automation/RwaNeutralAutomationTypes";

test("Phase A shadow enters observing without provider writes when read-only snapshot is fresh", async () => {
  const connector = new RwaBybitReadOnlyConnector(fixtureClient());
  const service = new RwaNeutralAutomationService(connector, {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: false, staleAfterMs: 60_000_000_000 },
  });

  const status = await service.getStatus();

  assert.equal(status.state, "observing");
  assert.equal(status.execution.mode, "shadow");
  assert.equal(status.execution.automaticOrdersEnabled, false);
  assert.equal(status.execution.providerWriteCallCount, 0);
  assert.equal(status.shadow.wouldSendProviderWrite, false);
  assert.equal(status.connector.permissions.trade, false);
  assert.equal(status.connector.permissions.withdraw, false);
});

test("returned connector messages and categories are sanitized before status and warnings", async () => {
  const connector = new RwaBybitReadOnlyConnector(fixtureClient({
    async checkConnectivity() {
      return {
        connected: false,
        accountMode: "uta",
        checkedAt: 1_800_000_000_000,
        stale: true,
        errorCategory: "Authorization: Bearer category-secret apiKey category-key" as any,
        message: "Bybit timeout Authorization: Bearer msg-secret apiKey msg-key token raw-token privateKey=pk https://example.test/a file:///tmp/a.json /tmp/b.json",
      };
    },
  }));
  const service = new RwaNeutralAutomationService(connector, {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: false, staleAfterMs: 60_000_000_000 },
  });

  const status = await service.getStatus();
  const serialized = JSON.stringify(status);

  assert.equal(status.state, "fault");
  assert.equal(status.connector.errorCategory, "provider_stale");
  assert.match(status.connector.message ?? "", /Bybit timeout/);
  assert.doesNotMatch(serialized, /msg-secret|msg-key|raw-token|category-secret|category-key|example\.test|\/tmp\/a\.json|\/tmp\/b\.json|privateKey=pk/i);
  assert.match(serialized, /\[secret\]|\[path\]|\[url\]/);
});

test("normal returned connector messages are preserved when they contain no sensitive material", async () => {
  const connector = new RwaBybitReadOnlyConnector(fixtureClient({
    async checkConnectivity() {
      return {
        connected: true,
        accountMode: "uta",
        checkedAt: 1_800_000_000_000,
        stale: false,
        message: "Bybit read-only connector is healthy.",
      };
    },
  }));
  const service = new RwaNeutralAutomationService(connector, {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: false, staleAfterMs: 60_000_000_000 },
  });

  const status = await service.getStatus();

  assert.equal(status.state, "observing");
  assert.equal(status.connector.message, "Bybit read-only connector is healthy.");
});

test("kill switch is fail-closed and keeps provider write call count at zero", async () => {
  const connector = new RwaBybitReadOnlyConnector(fixtureClient());
  const service = new RwaNeutralAutomationService(connector, {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: true, staleAfterMs: 60_000_000_000 },
  });

  const status = await service.getStatus();

  assert.equal(status.state, "disabled");
  assert.equal(status.execution.providerWriteCallCount, 0);
  assert.match(status.warnings.join(" "), /Kill switch/);
});

test("stale provider snapshots and API failures become fault without leaking secrets", async () => {
  const connector = new RwaBybitReadOnlyConnector({
    ...fixtureClient(),
    async checkConnectivity() {
      throw new Error("ECONNRESET /tmp/a.json Authorization: Bearer top-secret apiKey short secret=abc");
    },
  });
  const service = new RwaNeutralAutomationService(connector, {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: false, staleAfterMs: 60_000_000_000 },
  });

  const status = await service.getStatus();
  const serialized = JSON.stringify(status);

  assert.equal(status.state, "fault");
  assert.equal(status.connector.connected, false);
  assert.equal(status.execution.providerWriteCallCount, 0);
  assert.doesNotMatch(serialized, /top-secret|abc|\/tmp\/a\.json|apiKey short/i);
  assert.match(serialized, /\[secret\]|\[path\]/);
});

test("duplicate provider read events are idempotent and restart recovery uses authoritative snapshot", () => {
  const service = new RwaNeutralAutomationService(new RwaBybitReadOnlyConnector(fixtureClient()), {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: false, staleAfterMs: 60_000_000_000_000 },
  });
  const snapshot = fixtureSnapshot();

  assert.equal(service.applyEventOnce({ eventId: "evt-1", type: "order_snapshot", snapshot }), true);
  assert.equal(service.applyEventOnce({ eventId: "evt-1", type: "order_snapshot", snapshot }), false);
  service.restoreFromAuthoritativeSnapshot(snapshot);

  const audit = service.getLatestAudit();
  assert.ok(audit.some((event) => event.eventType === "restart_recovery"));
  assert.equal(audit.filter((event) => event.eventType === "order_snapshot").length, 1);
});

test("out-of-order and same-timestamp provider snapshots are rejected without state rollback audit", () => {
  const service = new RwaNeutralAutomationService(new RwaBybitReadOnlyConnector(fixtureClient()), {
    now: () => 1_800_000_000_500,
    config: { strategyEnabled: true, killSwitchActive: false, staleAfterMs: 60_000_000_000_000 },
  });
  const newer = fixtureSnapshot({ fetchedAt: 2_000, connected: true, stale: false });
  const olderFault = fixtureSnapshot({ fetchedAt: 1_000, connected: false, stale: true, errorCategory: "provider_stale" });
  const sameTimeFault = fixtureSnapshot({ fetchedAt: 2_000, connected: false, stale: true, errorCategory: "provider_stale" });

  assert.equal(service.applyEventOnce({ eventId: "evt-new", type: "new_snapshot", snapshot: newer }), true);
  const auditAfterNew = service.getLatestAudit();
  assert.ok(auditAfterNew.some((event) => event.eventType === "new_snapshot" && event.state === "observing"));

  assert.equal(service.applyEventOnce({ eventId: "evt-old", type: "old_snapshot", snapshot: olderFault }), false);
  assert.equal(service.applyEventOnce({ eventId: "evt-same", type: "same_timestamp_snapshot", snapshot: sameTimeFault }), false);
  assert.equal(service.applyEventOnce({ eventId: "evt-new", type: "duplicate_snapshot", snapshot: newer }), false);
  const audit = service.getLatestAudit();
  assert.equal(audit.some((event) => event.eventType === "old_snapshot"), false);
  assert.equal(audit.some((event) => event.eventType === "same_timestamp_snapshot"), false);
  assert.equal(audit.some((event) => event.eventType === "duplicate_snapshot"), false);
  assert.equal(audit.filter((event) => event.eventType === "new_snapshot").length, 1);
});

test("standalone sanitizer redacts provider unknown errors without erasing useful category text", () => {
  const sanitized = sanitizeRwaAutomationError(new Error("timeout ./local.json file:///tmp/provider.json token abc privateKey=pk"));
  assert.match(sanitized, /timeout/);
  assert.doesNotMatch(sanitized, /local\.json|provider\.json| abc|pk/);
  assert.match(sanitized, /\[path\]|\[secret\]/);
});

function fixtureClient(overrides: Partial<RwaBybitReadOnlyClient> = {}): RwaBybitReadOnlyClient {
  return {
    async checkConnectivity() {
      return {
        connected: true,
        accountMode: "uta",
        checkedAt: 1_800_000_000_000,
        stale: false,
        message: null,
      };
    },
    async getBalances() {
      return [
        { asset: "USDT", available: 0, walletBalance: 0 },
        { asset: "XAUT", available: 0, walletBalance: 0 },
      ];
    },
    async getFees() {
      return [{ symbol: "XAUTUSDT", spotTakerBps: 10, perpTakerBps: 5.5 }];
    },
    async getInstrumentSpecs() {
      return [
        { symbol: "XAUTUSDT", kind: "spot", status: "trading", minOrderQty: 0.001, qtyStep: 0.001, minNotionalUsd: 5 },
        { symbol: "XAUTUSDT", kind: "perpetual", status: "trading", minOrderQty: 0.001, qtyStep: 0.001, minNotionalUsd: 5 },
      ];
    },
    async getOrders() {
      return [];
    },
    async getFills() {
      return [];
    },
    async getPositions() {
      return [];
    },
    ...overrides,
  };
}

function fixtureSnapshot(input: {
  fetchedAt?: number;
  connected?: boolean;
  stale?: boolean;
  errorCategory?: string | null;
} = {}): RwaReadOnlySnapshot {
  return {
    connector: {
      venue: "bybit",
      connected: input.connected ?? true,
      accountMode: "uta",
      readonly: true,
      permissions: { read: input.connected === false ? false : true, trade: false, withdraw: false },
      capabilities: ["connectivity", "account_mode", "balances", "fees", "instrument_specs", "orders", "fills", "positions"],
      checkedAt: input.fetchedAt ?? 1_800_000_000_000,
      stale: input.stale ?? false,
      errorCategory: input.errorCategory ?? null,
      message: null,
    },
    balances: [],
    fees: [],
    instruments: [],
    orders: [],
    fills: [],
    positions: [],
    fetchedAt: input.fetchedAt ?? 1_800_000_000_000,
  };
}
