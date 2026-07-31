import { randomBytes } from "node:crypto";

export const RWA_BINANCE_ACTIVITY_CERTIFICATE_TTL_MS = 2_000;
export const RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS = 10_000;

export type RwaBinanceActivityLeg = "spot" | "futures";
export type RwaBinanceProviderMutation =
  | "set_leverage"
  | "place_spot_order"
  | "place_futures_order"
  | "cancel_spot_order"
  | "cancel_futures_order";

export type RwaBinanceActivityCertificate = {
  id: string;
  epoch: number;
  mutation: RwaBinanceProviderMutation;
  issuedAt: number;
  expiresAt: number;
  orderLinkId?: string;
  providerOrderId?: string;
  expectedLeverage?: 1 | 2 | 3;
};

type RwaBinanceExpectedMutation = RwaBinanceActivityCertificate & {
  settlementDeadline: number;
};

export class RwaBinanceActivityUnsafeError extends Error {
  constructor(
    readonly reason:
      | "stream_not_continuous"
      | "external_activity"
      | "certificate_missing"
      | "certificate_expired"
      | "certificate_mismatch"
      | "certificate_reused",
    message: string,
  ) {
    super(message);
  }
}

export class RwaBinanceActivityGuard {
  private epoch = 1;
  private readonly connected = new Set<RwaBinanceActivityLeg>();
  private readonly strategyOrderPrefixes = new Set<string>();
  private unsafeReason: string | null = "activity_stream_not_started";
  private certificate: RwaBinanceActivityCertificate | null = null;
  private consumedCertificateIds = new Set<string>();
  private readonly expectedMutations: RwaBinanceExpectedMutation[] = [];
  private readonly expectedAccountUpdates = new Map<string, number>();
  private settlementTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onUnsafe: (reason: string) => void | Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  registerStrategyOrderPrefix(prefix: string) {
    this.expireSettlements();
    const normalized = prefix.trim();
    if (normalized) this.strategyOrderPrefixes.add(normalized);
  }

  markConnected(leg: RwaBinanceActivityLeg) {
    this.expireSettlements();
    this.connected.add(leg);
    if (this.connected.size === 2 && this.unsafeReason === "activity_stream_not_started") {
      this.unsafeReason = null;
    }
  }

  confirmAuthoritativeResync() {
    this.expireSettlements();
    if (this.connected.size !== 2) {
      throw new RwaBinanceActivityUnsafeError("stream_not_continuous", "Binance 双用户流尚未连接。");
    }
    if (this.unsafeReason?.startsWith("unknown_")) {
      throw new RwaBinanceActivityUnsafeError("external_activity", `Binance 已检测到需人工核对的活动：${this.unsafeReason}`);
    }
    this.unsafeReason = null;
  }

  markDisconnected(leg: RwaBinanceActivityLeg, reason = `${leg}_stream_disconnected`) {
    this.expireSettlements();
    this.connected.delete(leg);
    this.invalidate(reason);
  }

  observeOrder(input: {
    leg: RwaBinanceActivityLeg;
    clientOrderId?: string | null;
    providerOrderId?: string | null;
    eventTime?: number | null;
    terminal?: boolean;
    accountChangeExpected?: boolean;
  }) {
    this.expireSettlements();
    const clientOrderId = String(input.clientOrderId ?? "").trim();
    const providerOrderId = String(input.providerOrderId ?? "").trim();
    const expectedIndex = this.expectedMutations.findIndex((expected) => {
      const expectedLeg = expected.mutation.includes("spot") ? "spot"
        : expected.mutation.includes("futures") ? "futures"
        : null;
      return expectedLeg === input.leg && (
        (expected.orderLinkId && expected.orderLinkId === clientOrderId)
        || (expected.providerOrderId && expected.providerOrderId === providerOrderId)
      );
    });
    const matchesExpected = expectedIndex >= 0;
    const normalized = String(clientOrderId ?? "").trim();
    if (
      matchesExpected
      || (normalized && [...this.strategyOrderPrefixes].some((prefix) => normalized.startsWith(prefix)))
    ) {
      if (input.accountChangeExpected && Number.isFinite(input.eventTime)) {
        this.expectedAccountUpdates.set(
          `${input.leg}:${input.eventTime}`,
          matchesExpected
            ? this.expectedMutations[expectedIndex]!.settlementDeadline
            : this.now() + RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS,
        );
      }
      if (matchesExpected) this.expectedMutations.splice(expectedIndex, 1);
      this.scheduleSettlementCheck();
      return;
    }
    this.invalidate("unknown_provider_order_or_fill");
  }

  observeAccountChange(leg: RwaBinanceActivityLeg, kind: string, eventTime?: number | null) {
    this.expireSettlements();
    const key = `${leg}:${eventTime}`;
    if (Number.isFinite(eventTime) && this.expectedAccountUpdates.delete(key)) {
      this.scheduleSettlementCheck();
      return;
    }
    this.invalidate(`unknown_${kind}`);
  }

  observeAccountConfigUpdate(symbol: string, leverage: number) {
    this.expireSettlements();
    const expectedIndex = this.expectedMutations.findIndex((expected) =>
      expected.mutation === "set_leverage"
      && symbol === "XAUTUSDT"
      && leverage === expected.expectedLeverage);
    if (expectedIndex >= 0) {
      this.expectedMutations.splice(expectedIndex, 1);
      this.scheduleSettlementCheck();
      return;
    }
    this.invalidate("unknown_futures_ACCOUNT_CONFIG_UPDATE");
  }

  observeUnknownEvent(eventType: string) {
    this.expireSettlements();
    this.invalidate(`unknown_event:${eventType || "missing_type"}`);
  }

  issueCertificate(input: {
    mutation: RwaBinanceProviderMutation;
    orderLinkId?: string;
    providerOrderId?: string;
    expectedLeverage?: 1 | 2 | 3;
  }) {
    this.expireSettlements();
    if (this.connected.size !== 2 || this.unsafeReason) {
      throw new RwaBinanceActivityUnsafeError(
        "stream_not_continuous",
        `Binance activity stream 不连续：${this.unsafeReason ?? "stream_disconnected"}`,
      );
    }
    if (
      (input.mutation.startsWith("place_") && !input.orderLinkId)
      || (input.mutation.startsWith("cancel_") && !input.providerOrderId)
      || (input.mutation === "set_leverage" && !input.expectedLeverage)
    ) {
      throw new RwaBinanceActivityUnsafeError(
        "certificate_mismatch",
        "Binance activity certificate 缺少可证明的 mutation identity。",
      );
    }
    const issuedAt = this.now();
    const certificate = {
      id: randomBytes(18).toString("base64url"),
      epoch: this.epoch,
      ...input,
      issuedAt,
      expiresAt: issuedAt + RWA_BINANCE_ACTIVITY_CERTIFICATE_TTL_MS,
    };
    this.certificate = certificate;
    return certificate;
  }

  consumeCertificate(mutation: RwaBinanceProviderMutation) {
    this.expireSettlements();
    const certificate = this.certificate;
    this.certificate = null;
    if (!certificate) {
      throw new RwaBinanceActivityUnsafeError("certificate_missing", "Binance provider mutation 缺少一次性活动证书。");
    }
    if (this.consumedCertificateIds.has(certificate.id)) {
      throw new RwaBinanceActivityUnsafeError("certificate_reused", "Binance 活动证书已使用。");
    }
    this.consumedCertificateIds.add(certificate.id);
    if (certificate.epoch !== this.epoch || this.connected.size !== 2 || this.unsafeReason) {
      throw new RwaBinanceActivityUnsafeError("certificate_mismatch", "Binance 活动证书已因事件或断流失效。");
    }
    if (certificate.mutation !== mutation) {
      throw new RwaBinanceActivityUnsafeError("certificate_mismatch", "Binance 活动证书与 provider mutation 不匹配。");
    }
    if (certificate.expiresAt < this.now()) {
      throw new RwaBinanceActivityUnsafeError("certificate_expired", "Binance 活动证书已过期。");
    }
    this.expectedMutations.push({
      ...certificate,
      settlementDeadline: this.now() + RWA_BINANCE_ACTIVITY_SETTLEMENT_TTL_MS,
    });
    this.scheduleSettlementCheck();
    return certificate;
  }

  revokeExpectedMutation(certificateId: string) {
    this.expireSettlements();
    const index = this.expectedMutations.findIndex((expected) => expected.id === certificateId);
    if (index >= 0) this.expectedMutations.splice(index, 1);
    this.scheduleSettlementCheck();
  }

  checkSettlementDeadlines() {
    this.expireSettlements();
  }

  resetForRestart() {
    this.connected.clear();
    this.invalidate("activity_guard_restarted");
  }

  private invalidate(reason: string) {
    this.epoch += 1;
    this.certificate = null;
    this.expectedMutations.length = 0;
    this.expectedAccountUpdates.clear();
    if (this.settlementTimer) clearTimeout(this.settlementTimer);
    this.settlementTimer = null;
    this.unsafeReason = reason;
    void this.onUnsafe(reason);
  }

  private expireSettlements() {
    if (this.unsafeReason) return;
    const now = this.now();
    if (this.expectedMutations.some((expected) => expected.settlementDeadline <= now)) {
      this.invalidate("unknown_expected_mutation_settlement_timeout");
      return;
    }
    if ([...this.expectedAccountUpdates.values()].some((deadline) => deadline <= now)) {
      this.invalidate("unknown_expected_account_settlement_timeout");
    }
  }

  private scheduleSettlementCheck() {
    if (this.settlementTimer) clearTimeout(this.settlementTimer);
    this.settlementTimer = null;
    if (this.unsafeReason) return;
    const deadlines = [
      ...this.expectedMutations.map((expected) => expected.settlementDeadline),
      ...this.expectedAccountUpdates.values(),
    ];
    if (!deadlines.length) return;
    const delayMs = Math.max(1, Math.min(...deadlines) - this.now());
    this.settlementTimer = setTimeout(() => {
      this.settlementTimer = null;
      this.expireSettlements();
      this.scheduleSettlementCheck();
    }, delayMs);
    this.settlementTimer.unref();
  }
}
