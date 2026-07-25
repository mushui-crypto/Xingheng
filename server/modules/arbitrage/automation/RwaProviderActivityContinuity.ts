import { createHash } from "node:crypto";
import type {
  RwaPositionAttributionSnapshot,
  RwaProviderActivitySource,
  RwaProviderActivitySourceSnapshot,
  RwaProviderActivityWatermark,
  RwaStrategyActivityContinuity,
  RwaStrategyActivityLegState,
} from "./RwaNeutralExecutionTypes";

export const RWA_ACTIVITY_POLL_INTERVAL_MS = 15 * 60_000;
export const RWA_ACTIVITY_MAX_GAP_MS = 24 * 60 * 60_000;
export const RWA_ACTIVITY_OVERLAP_MS = 5 * 60_000;
export const RWA_ACTIVITY_MAX_RECENT_EVENT_IDS = 32;
export const RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS = 64;
export const RWA_ACTIVITY_MAX_PAGES_PER_SOURCE = 20;
export const RWA_ACTIVITY_MAX_SCAN_CONCURRENCY = 4;
export const RWA_ACTIVITY_RETRY_DELAYS_MS = [100, 500] as const;

export const RWA_SPOT_ACTIVITY_SOURCES: readonly RwaProviderActivitySource[] = [
  "spot_orders",
  "spot_trades",
  "account_transactions",
  "internal_transfers",
  "universal_transfers",
  "deposits",
  "internal_deposits",
  "withdrawals",
  "convert",
  "dust",
  "balance_adjustments",
] as const;

export const RWA_PERPETUAL_ACTIVITY_SOURCES: readonly RwaProviderActivitySource[] = [
  "perpetual_orders",
  "perpetual_trades",
  "account_transactions",
  "internal_transfers",
  "universal_transfers",
  "balance_adjustments",
] as const;

export function createUnmonitoredActivityContinuity(now: number): RwaStrategyActivityContinuity {
  return {
    version: 1,
    maxGapMs: RWA_ACTIVITY_MAX_GAP_MS,
    pollIntervalMs: RWA_ACTIVITY_POLL_INTERVAL_MS,
    spot: createLeg("unmonitored", now, RWA_SPOT_ACTIVITY_SOURCES),
    perpetual: createLeg("unmonitored", now, RWA_PERPETUAL_ACTIVITY_SOURCES),
  };
}

export function createMonitoredActivityContinuity(
  startedAt: number,
  strategyOrderPrefix: string,
): RwaStrategyActivityContinuity {
  const value = createUnmonitoredActivityContinuity(startedAt);
  for (const leg of [value.spot, value.perpetual]) {
    leg.coverage = "monitored";
    leg.clientOrderPrefixes = [strategyOrderPrefix];
  }
  return value;
}

export function normalizeActivityContinuity(
  value: unknown,
  fallbackAt: number,
): RwaStrategyActivityContinuity {
  if (!isRecord(value) || value.version !== 1) return createUnmonitoredActivityContinuity(fallbackAt);
  const maxGapMs = finiteNonNegative(value.maxGapMs);
  const pollIntervalMs = finiteNonNegative(value.pollIntervalMs);
  if (maxGapMs !== RWA_ACTIVITY_MAX_GAP_MS || pollIntervalMs !== RWA_ACTIVITY_POLL_INTERVAL_MS) {
    return createUnmonitoredActivityContinuity(fallbackAt);
  }
  const spot = normalizeLeg(value.spot, RWA_SPOT_ACTIVITY_SOURCES, fallbackAt);
  const perpetual = normalizeLeg(value.perpetual, RWA_PERPETUAL_ACTIVITY_SOURCES, fallbackAt);
  return { version: 1, maxGapMs, pollIntervalMs, spot, perpetual };
}

export function mergeActivitySnapshot(
  continuity: RwaStrategyActivityContinuity,
  snapshot: RwaPositionAttributionSnapshot,
  strategyOrderPrefixes: string[],
  now: number,
) {
  const next = structuredClone(continuity);
  mergeLeg(next.spot, snapshot, "spot", strategyOrderPrefixes, now);
  mergeLeg(next.perpetual, snapshot, "perpetual", strategyOrderPrefixes, now);
  return next;
}

export function markActivityContinuityAmbiguous(
  continuity: RwaStrategyActivityContinuity,
  now: number,
) {
  const next = structuredClone(continuity);
  for (const leg of [next.spot, next.perpetual]) {
    leg.coverage = "ambiguous";
    leg.updatedAt = now;
  }
  return next;
}

export function combineActivityContinuities(
  values: RwaStrategyActivityContinuity[],
  fallbackAt: number,
) {
  if (!values.length) return createUnmonitoredActivityContinuity(fallbackAt);
  const next = structuredClone(values[0]);
  for (const side of ["spot", "perpetual"] as const) {
    const legs = values.map((value) => value[side]);
    next[side].coverage = legs.every((leg) => leg.coverage === "monitored")
      ? "monitored"
      : "ambiguous";
    next[side].immutableStartAt = Math.min(...legs.map((leg) => leg.immutableStartAt));
    next[side].checkedThrough = Math.min(...legs.map((leg) => leg.checkedThrough));
    next[side].providerOrderIds = boundedUnique(
      legs.flatMap((leg) => leg.providerOrderIds),
      RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS,
    );
    next[side].clientOrderPrefixes = boundedUnique(
      legs.flatMap((leg) => leg.clientOrderPrefixes),
      256,
    );
    next[side].sources = next[side].sources.map((source) => {
      const matches = legs.map((leg) => leg.sources.find((item) => item.source === source.source));
      if (matches.some((item) => !item)) return { ...source, coverage: "incomplete" as const };
      const watermarks = matches as RwaProviderActivityWatermark[];
      const recentEventIds = boundedUnique(
        watermarks.flatMap((item) => item.recentEventIds),
        RWA_ACTIVITY_MAX_RECENT_EVENT_IDS,
      );
      return {
        ...source,
        coverage: watermarks.every((item) => item.coverage === "complete")
          ? "complete" as const
          : "incomplete" as const,
        immutableStartAt: Math.min(...watermarks.map((item) => item.immutableStartAt)),
        checkedThrough: Math.min(...watermarks.map((item) => item.checkedThrough)),
        cursor: null,
        recentEventIds,
        eventDigest: activityEventDigest(recentEventIds),
        updatedAt: Math.max(...watermarks.map((item) => item.updatedAt)),
      };
    });
    next[side].updatedAt = Math.max(...legs.map((leg) => leg.updatedAt));
  }
  return next;
}

export function recordStrategyProviderOrder(
  continuity: RwaStrategyActivityContinuity,
  category: "spot" | "linear",
  orderId: string,
  now: number,
) {
  if (!orderId) return continuity;
  const next = structuredClone(continuity);
  const leg = category === "spot" ? next.spot : next.perpetual;
  leg.providerOrderIds = boundedUnique([...leg.providerOrderIds, orderId], RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS);
  leg.updatedAt = now;
  return next;
}

export function attributionScanStart(
  continuity: RwaStrategyActivityContinuity,
  source: RwaProviderActivitySource,
  fallbackSince: number,
) {
  const watermarks = [...continuity.spot.sources, ...continuity.perpetual.sources]
    .filter((item) => item.source === source && item.coverage === "complete");
  if (!watermarks.length) return fallbackSince;
  return Math.max(fallbackSince, Math.min(...watermarks.map((item) => item.checkedThrough)) - RWA_ACTIVITY_OVERLAP_MS);
}

export function activityEventDigest(eventIds: string[]) {
  return createHash("sha256").update([...new Set(eventIds)].sort().join("\n")).digest("hex");
}

export function sourceSnapshot(input: {
  source: RwaProviderActivitySource;
  coverage: "complete" | "incomplete";
  checkedFrom: number;
  checkedThrough: number;
  cursor?: string | null;
  eventIds?: string[];
  externalActivity?: boolean;
}): RwaProviderActivitySourceSnapshot {
  return {
    source: input.source,
    coverage: input.coverage,
    checkedFrom: input.checkedFrom,
    checkedThrough: input.checkedThrough,
    cursor: input.cursor ?? null,
    eventIds: boundedUnique(input.eventIds ?? [], RWA_ACTIVITY_MAX_RECENT_EVENT_IDS),
    externalActivity: input.externalActivity ?? false,
  };
}

export function buildPositionAttributionSnapshot(input: {
  since: number;
  checkedThrough: number;
  sources: RwaProviderActivitySourceSnapshot[];
  providerOrderIds?: { spot: string[]; perpetual: string[] };
}): RwaPositionAttributionSnapshot {
  const uniqueSources = new Set(input.sources.map((item) => item.source));
  const required = new Set([...RWA_SPOT_ACTIVITY_SOURCES, ...RWA_PERPETUAL_ACTIVITY_SOURCES]);
  const complete = input.sources.every((item) => item.coverage === "complete")
    && [...required].every((source) => uniqueSources.has(source));
  return {
    coverage: complete ? "complete" : "incomplete",
    externalPositionActivity: input.sources.some((item) => item.externalActivity),
    checkedFrom: input.sources.length
      ? Math.min(...input.sources.map((item) => item.checkedFrom))
      : input.since,
    checkedThrough: input.sources.length
      ? Math.min(...input.sources.map((item) => item.checkedThrough))
      : input.since,
    sources: input.sources,
    providerOrderIds: {
      spot: boundedUnique(input.providerOrderIds?.spot ?? [], RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS),
      perpetual: boundedUnique(input.providerOrderIds?.perpetual ?? [], RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS),
    },
  };
}

export function rejectNonAtomicAttribution(
  snapshot: RwaPositionAttributionSnapshot,
): RwaPositionAttributionSnapshot {
  return {
    ...snapshot,
    coverage: "incomplete",
    checkedThrough: snapshot.checkedFrom,
    sources: snapshot.sources.map((source) => ({
      ...source,
      coverage: "incomplete",
      checkedThrough: source.checkedFrom,
    })),
  };
}

function createLeg(
  coverage: RwaStrategyActivityLegState["coverage"],
  now: number,
  sources: readonly RwaProviderActivitySource[],
): RwaStrategyActivityLegState {
  return {
    coverage,
    immutableStartAt: now,
    checkedThrough: now,
    providerOrderIds: [],
    clientOrderPrefixes: [],
    sources: sources.map((source) => ({
      source,
      coverage: "incomplete",
      immutableStartAt: now,
      checkedThrough: now,
      cursor: null,
      recentEventIds: [],
      eventDigest: activityEventDigest([]),
      updatedAt: now,
    })),
    updatedAt: now,
  };
}

function normalizeLeg(
  value: unknown,
  requiredSources: readonly RwaProviderActivitySource[],
  fallbackAt: number,
): RwaStrategyActivityLegState {
  if (!isRecord(value)) return createLeg("unmonitored", fallbackAt, requiredSources);
  const coverage = ["unmonitored", "monitored", "ambiguous"].includes(String(value.coverage))
    ? value.coverage as RwaStrategyActivityLegState["coverage"]
    : "ambiguous";
  const immutableStartAt = finiteNonNegative(value.immutableStartAt);
  const checkedThrough = finiteNonNegative(value.checkedThrough);
  const updatedAt = finiteNonNegative(value.updatedAt);
  const providerOrderIds = stringArray(value.providerOrderIds, RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS);
  const clientOrderPrefixes = stringArray(value.clientOrderPrefixes, 256);
  if (
    immutableStartAt === null || checkedThrough === null || updatedAt === null
    || !providerOrderIds || !clientOrderPrefixes || !Array.isArray(value.sources)
  ) return createLeg("unmonitored", fallbackAt, requiredSources);
  const parsed = value.sources.map(normalizeWatermark);
  if (parsed.some((item) => !item)) return createLeg("unmonitored", fallbackAt, requiredSources);
  const sources = parsed as RwaProviderActivityWatermark[];
  if (
    sources.length !== requiredSources.length
    || requiredSources.some((source) => sources.filter((item) => item.source === source).length !== 1)
  ) return createLeg("unmonitored", fallbackAt, requiredSources);
  return {
    coverage,
    immutableStartAt,
    checkedThrough,
    providerOrderIds,
    clientOrderPrefixes,
    sources,
    updatedAt,
  };
}

function normalizeWatermark(value: unknown): RwaProviderActivityWatermark | null {
  if (!isRecord(value) || !isProviderActivitySource(value.source)) return null;
  const coverage = value.coverage === "complete" ? "complete" : value.coverage === "incomplete" ? "incomplete" : null;
  const immutableStartAt = finiteNonNegative(value.immutableStartAt);
  const checkedThrough = finiteNonNegative(value.checkedThrough);
  const updatedAt = finiteNonNegative(value.updatedAt);
  const recentEventIds = stringArray(value.recentEventIds, RWA_ACTIVITY_MAX_RECENT_EVENT_IDS);
  if (
    !coverage || immutableStartAt === null || checkedThrough === null || updatedAt === null || !recentEventIds
    || !(value.cursor === null || typeof value.cursor === "string")
    || typeof value.eventDigest !== "string" || value.eventDigest !== activityEventDigest(recentEventIds)
  ) return null;
  return {
    source: value.source,
    coverage,
    immutableStartAt,
    checkedThrough,
    cursor: value.cursor,
    recentEventIds,
    eventDigest: value.eventDigest,
    updatedAt,
  };
}

function mergeLeg(
  leg: RwaStrategyActivityLegState,
  snapshot: RwaPositionAttributionSnapshot,
  side: "spot" | "perpetual",
  strategyOrderPrefixes: string[],
  now: number,
) {
  if (leg.coverage === "ambiguous") return;
  const required = side === "spot" ? RWA_SPOT_ACTIVITY_SOURCES : RWA_PERPETUAL_ACTIVITY_SOURCES;
  const sourceMap = new Map(snapshot.sources.map((item) => [item.source, item]));
  const gapExceeded = snapshot.checkedThrough - leg.checkedThrough > RWA_ACTIVITY_MAX_GAP_MS;
  const complete = snapshot.coverage === "complete"
    && !snapshot.externalPositionActivity
    && !gapExceeded
    && required.every((source) => sourceMap.get(source)?.coverage === "complete");
  if (!complete) leg.coverage = "ambiguous";
  else if (leg.coverage === "unmonitored") leg.coverage = "monitored";
  leg.clientOrderPrefixes = boundedUnique(
    [...leg.clientOrderPrefixes, ...strategyOrderPrefixes],
    256,
  );
  leg.providerOrderIds = boundedUnique(
    [...leg.providerOrderIds, ...(side === "spot" ? snapshot.providerOrderIds.spot : snapshot.providerOrderIds.perpetual)],
    RWA_ACTIVITY_MAX_PROVIDER_ORDER_IDS,
  );
  leg.sources = required.map((source) => {
    const previous = leg.sources.find((item) => item.source === source)
      ?? createLeg("unmonitored", leg.immutableStartAt, [source]).sources[0];
    const scanned = sourceMap.get(source);
    if (!scanned) return { ...previous, coverage: "incomplete" as const, updatedAt: now };
    const recentEventIds = boundedUnique(
      [...previous.recentEventIds, ...scanned.eventIds],
      RWA_ACTIVITY_MAX_RECENT_EVENT_IDS,
    );
    return {
      source,
      coverage: scanned.coverage,
      immutableStartAt: previous.immutableStartAt,
      checkedThrough: Math.max(previous.checkedThrough, scanned.checkedThrough),
      cursor: scanned.cursor,
      recentEventIds,
      eventDigest: activityEventDigest(recentEventIds),
      updatedAt: now,
    };
  });
  leg.checkedThrough = Math.max(leg.checkedThrough, snapshot.checkedThrough);
  leg.updatedAt = now;
}

function boundedUnique(values: string[], max: number) {
  return [...new Set(values.filter(Boolean))].slice(-max);
}

function stringArray(value: unknown, max: number) {
  if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === "string" && item.length > 0)) {
    return null;
  }
  return boundedUnique(value, max);
}

function finiteNonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProviderActivitySource(value: unknown): value is RwaProviderActivitySource {
  return [...RWA_SPOT_ACTIVITY_SOURCES, ...RWA_PERPETUAL_ACTIVITY_SOURCES].includes(value as RwaProviderActivitySource);
}
