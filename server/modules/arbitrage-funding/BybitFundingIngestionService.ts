import type { ArbitrageMarket } from "../arbitrage/arbitrageTypes";
import type { BybitFundingTransaction } from "../bybit/BybitClient";
import { BybitClient } from "../bybit/BybitClient";
import type { UserExchangeCredentialStore } from "../credentials/UserExchangeCredentialStore";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import type { ArbitrageInstanceStore } from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { ArbitrageFundingStore } from "../cex/arbitrage-instance/ArbitrageFundingStore";
import { managedExposureTimeline, type ArbitrageFundingFact } from "../cex/arbitrage-instance/FundingAccounting";

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_INSTANCE_MS = 30 * 24 * 60 * 60 * 1000;
const SETTLEMENT_FIRST_READ_DELAY_MS = 5 * 60_000;
const COVERAGE_OVERLAP_MS = 60_000;
const MARKET_MAX_AGE_MS = 20_000;
const SCHEDULE_REFRESH_RETRY_MS = 60_000;
const FAILURE_RECOVERY_MS = 5 * 60_000;

type FundingMarketSource = Readonly<{
  getCurrentMarketSnapshot(): Promise<Readonly<{ generatedAt: number; markets: readonly ArbitrageMarket[] }>>;
}>;
type FundingReader = Readonly<{
  read(userId: string, input: Readonly<{ symbol: string; startTime: number; endTime: number }>): Promise<readonly BybitFundingTransaction[]>;
}>;

export class BybitFundingIngestionService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running: Promise<void> | null = null;
  private readonly instruments = new InstrumentCapability();

  constructor(
    private readonly instances: Pick<ArbitrageInstanceStore,
      "listFundingManagedPerpContexts" | "listFundingAttributionCandidates" | "listExecutionAccountingFacts">,
    private readonly funding: Pick<ArbitrageFundingStore, "recordFact" | "listFacts" | "readCoverage" | "recordCoverage">,
    private readonly markets: FundingMarketSource,
    private readonly reader: FundingReader,
    private readonly options: Readonly<{
      now?: () => number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
      logger?: (message: string) => void;
    }> = {},
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.runSafely();
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  runOnce() {
    if (this.running) return this.running;
    const task = this.syncAndSchedule().finally(() => {
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  private async syncAndSchedule() {
    const now = this.now();
    const snapshot = await this.markets.getCurrentMarketSnapshot();
    const contexts = this.instances.listFundingManagedPerpContexts(now - RECENT_INSTANCE_MS)
      .filter((context) => context.venue === "bybit");
    let nextRunAt: number | null = snapshot.markets
      .flatMap((market) => market.venue === "bybit" && authoritativeSchedule(market, now) ? [market] : [])
      .reduce<number | null>((earliest, market) => {
        const scheduled = market.nextFundingTime + SETTLEMENT_FIRST_READ_DELAY_MS;
        const candidate = scheduled > now ? scheduled : now + SCHEDULE_REFRESH_RETRY_MS;
        return earliest === null || candidate < earliest ? candidate : earliest;
      }, null);
    for (const context of contexts) {
      this.reattributeStoredFacts(context, now);
      const market = this.marketFor(context.instrumentId, snapshot.markets);
      if (!authoritativeSchedule(market, now)) continue;
      const scheduledRunAt = market.nextFundingTime + SETTLEMENT_FIRST_READ_DELAY_MS;
      if (scheduledRunAt > now && (nextRunAt === null || scheduledRunAt < nextRunAt)) nextRunAt = scheduledRunAt;
      const latestSettled = market.nextFundingTime - market.fundingIntervalHours * 3_600_000;
      const checkpointThrough = Math.min(now - SETTLEMENT_FIRST_READ_DELAY_MS, latestSettled);
      const candidates = this.instances.listFundingAttributionCandidates(
        context.venue, context.accountId, context.instrumentId,
      );
      const starts = candidates.flatMap((instance) => {
        const leg = instance.legs.find((candidate) => candidate.venue === context.venue
          && candidate.accountId === context.accountId && candidate.instrumentId === context.instrumentId);
        if (!leg) return [];
        const timeline = managedExposureTimeline(
          instance, this.instances.listExecutionAccountingFacts(instance.userId, instance.arbitrageId), leg, now,
        );
        return timeline.complete && timeline.startedAt !== null ? [timeline.startedAt] : [];
      });
      if (starts.length === 0) continue;
      const earliestStart = Math.min(...starts);
      if (checkpointThrough < earliestStart) continue;
      await this.syncContext(context, this.symbolFor(context.instrumentId), earliestStart, checkpointThrough, now);
    }
    if (!this.stopped && nextRunAt !== null) {
      const delay = Math.max(1, nextRunAt - this.now());
      this.timer = (this.options.setTimer ?? setTimeout)(() => {
        this.timer = null;
        this.runSafely();
      }, delay);
    }
  }

  private runSafely() {
    void this.runOnce().catch((error) => {
      this.log(error);
      if (this.stopped || this.timer !== null) return;
      this.timer = (this.options.setTimer ?? setTimeout)(() => {
        this.timer = null;
        this.runSafely();
      }, FAILURE_RECOVERY_MS);
    });
  }

  private async syncContext(
    context: Readonly<{ userId: string; venue: string; accountId: string; instrumentId: string }>,
    symbol: string,
    earliestStart: number,
    safeThrough: number,
    observedAt: number,
  ) {
    const existing = this.funding.readCoverage(context.venue, context.accountId, context.instrumentId);
    const requestedFrom = existing
      ? Math.max(earliestStart, existing.coveredThrough - COVERAGE_OVERLAP_MS)
      : earliestStart;
    let cursor = requestedFrom;
    while (cursor <= safeThrough) {
      const end = Math.min(safeThrough, cursor + MAX_WINDOW_MS);
      const rows = await this.reader.read(context.userId, { symbol, startTime: cursor, endTime: end });
      for (const row of rows) this.funding.recordFact(this.attribute(context, row, observedAt));
      cursor = end + 1;
    }
    this.funding.recordCoverage(Object.freeze({
      venue: context.venue, accountId: context.accountId, instrumentId: context.instrumentId,
      coveredFrom: requestedFrom, coveredThrough: safeThrough,
      lastSuccessfulReadAt: observedAt, paginationComplete: true,
    }));
  }

  private reattributeStoredFacts(
    context: Readonly<{ venue: string; accountId: string; instrumentId: string }>,
    observedAt: number,
  ) {
    for (const fact of this.funding.listFacts(context.venue, context.accountId, context.instrumentId)) {
      if (fact.integrityStatus !== "VERIFIED" || fact.providerPositionSize === null
        || (fact.positionSideOrBucket !== "LONG" && fact.positionSideOrBucket !== "SHORT")) continue;
      this.funding.recordFact(this.attribute(context, {
        id: fact.providerFundingId,
        symbol: this.symbolFor(fact.instrumentId),
        side: fact.positionSideOrBucket === "LONG" ? "Buy" : "Sell",
        transactionTime: fact.settlementTime,
        funding: fact.amount,
        currency: fact.asset,
        size: fact.providerPositionSize,
      }, observedAt));
    }
  }

  private attribute(
    context: Readonly<{ venue: string; accountId: string; instrumentId: string }>,
    row: BybitFundingTransaction,
    observedAt: number,
  ): ArbitrageFundingFact {
    const side = row.side === "Buy" ? "LONG" as const : "SHORT" as const;
    const expectedSignedSize = side === "LONG" ? absoluteDecimal(row.size) : negateDecimal(absoluteDecimal(row.size));
    const candidates = this.instances.listFundingAttributionCandidates(
      context.venue, context.accountId, context.instrumentId,
    ).flatMap((instance) => {
      const leg = instance.legs.find((candidate) => candidate.venue === context.venue
        && candidate.accountId === context.accountId && candidate.instrumentId === context.instrumentId
        && candidate.role === side);
      if (!leg) return [];
      const timeline = managedExposureTimeline(
        instance,
        this.instances.listExecutionAccountingFacts(instance.userId, instance.arbitrageId),
        leg,
        row.transactionTime,
      );
      return timeline.complete && timeline.quantity !== "0" ? [{ instance, quantity: timeline.quantity }] : [];
    });
    const totalManaged = sumDecimals(candidates.map((candidate) => candidate.quantity));
    const providerSizeMatches = decimalEqual(expectedSignedSize, row.size)
      && decimalEqual(totalManaged, absoluteDecimal(row.size));
    const completeAmount = row.currency === "USDT";
    const uniquelyAttributed = completeAmount && candidates.length === 1 && providerSizeMatches;
    const attributionStatus = !completeAmount || !decimalEqual(expectedSignedSize, row.size)
      ? "INCOMPLETE" as const
      : uniquelyAttributed ? "ATTRIBUTED" as const : "AMBIGUOUS" as const;
    return Object.freeze({
      providerFundingId: row.id,
      venue: context.venue,
      accountId: context.accountId,
      instrumentId: context.instrumentId,
      positionSideOrBucket: side,
      providerPositionSize: row.size,
      settlementTime: row.transactionTime,
      amount: row.funding,
      asset: row.currency,
      amountUsdt: completeAmount ? row.funding : null,
      arbitrageId: uniquelyAttributed ? candidates[0]!.instance.arbitrageId : null,
      attributionStatus,
      integrityStatus: "VERIFIED",
      createdAt: observedAt,
    });
  }

  private marketFor(instrumentId: string, markets: readonly ArbitrageMarket[]) {
    const canonical = canonicalInstrumentFromId(instrumentId);
    const symbol = this.symbolFor(instrumentId);
    return markets.find((market) => market.venue === "bybit" && market.symbol === symbol
      && market.kind === canonical.contractType);
  }

  private symbolFor(instrumentId: string) {
    return this.instruments.resolveVenueInstrument(canonicalInstrumentFromId(instrumentId), "bybit").symbol;
  }

  private now() { return (this.options.now ?? Date.now)(); }
  private log(error: unknown) {
    (this.options.logger ?? ((message) => console.warn(message)))(
      `[arbitrage-funding] Bybit catch-up failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export function createBybitFundingReader(
  credentials: Pick<UserExchangeCredentialStore, "findSummary" | "loadForAccountRead">,
  clientFactory: (credential: Readonly<{ apiKey: string; apiSecret: string }>) => Pick<BybitClient, "readFundingTransactions">
    = (credential) => new BybitClient(() => credential),
): FundingReader {
  return Object.freeze({
    async read(userId, input) {
      const summary = credentials.findSummary(userId, "bybit");
      if (!summary || summary.permissions.read !== true) throw new Error("Bybit read credential is unavailable.");
      const credential = await credentials.loadForAccountRead(userId, "bybit");
      return clientFactory({ apiKey: credential.apiKey, apiSecret: credential.apiSecret })
        .readFundingTransactions(input);
    },
  });
}

function authoritativeSchedule(market: ArbitrageMarket | undefined, now: number): market is ArbitrageMarket & {
  nextFundingTime: number; fundingIntervalHours: number; fundingScheduleCompleteness: "COMPLETE";
} {
  return Boolean(market && market.status !== "disconnected" && market.fundingScheduleCompleteness === "COMPLETE"
    && now - market.fetchedAt <= MARKET_MAX_AGE_MS
    && Number.isSafeInteger(market.nextFundingTime) && market.nextFundingTime! >= 0
    && Number.isFinite(market.fundingIntervalHours) && market.fundingIntervalHours! > 0);
}

function normalizeDecimal(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  const normalized = trimmed ? `${BigInt(integer)}.${trimmed}` : String(BigInt(integer));
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}
function absoluteDecimal(value: string) { return normalizeDecimal(value.startsWith("-") ? value.slice(1) : value); }
function negateDecimal(value: string) { const normalized = normalizeDecimal(value); return normalized === "0" ? "0" : `-${normalized}`; }
function decimalParts(value: string) {
  const negative = value.startsWith("-"); const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return { coefficient: BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n), scale: fraction.length };
}
function sumDecimals(values: readonly string[]) {
  const parsed = values.map(decimalParts); const scale = Math.max(0, ...parsed.map((value) => value.scale));
  const total = parsed.reduce((sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale), 0n);
  const negative = total < 0n; const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return normalizeDecimal(negative ? `-${value}` : value);
}
function decimalEqual(left: string, right: string) { return normalizeDecimal(left) === normalizeDecimal(right); }
