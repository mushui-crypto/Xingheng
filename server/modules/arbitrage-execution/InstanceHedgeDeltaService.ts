import {
  activeManagedQuantity,
  addUnsignedDecimals,
  compareUnsignedDecimals,
  subtractUnsignedDecimals,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
} from "../cex/arbitrage-instance/ArbitrageInstance";
import { canonicalInstrumentFromId } from "../cex/Instrument";
import { InstrumentCapability } from "../cex/InstrumentCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type {
  SpotOpeningAttributionEvidence,
} from "../cex/arbitrage-instance/ArbitrageInstanceStore";
import type { SpotOpeningAttributionSource } from "./BinanceSpotOpeningAttributionSource";

type InstanceSource = Readonly<{
  get(userId: string, arbitrageId: string): ArbitrageInstance | null;
  readSpotOpeningAttributionEvidence(
    userId: string,
    arbitrageId: string,
    legId: string,
  ): readonly SpotOpeningAttributionEvidence[];
  recordSpotOpeningAttributionEvidence(
    userId: string,
    evidence: SpotOpeningAttributionEvidence,
  ): SpotOpeningAttributionEvidence;
}>;

type SpotAttributionSources = Partial<Record<ExecutionIntent["venue"], SpotOpeningAttributionSource>>;

export type InstanceHedgeDeltaStatus = "KNOWN" | "UNKNOWN";

export type InstanceHedgeDeltaReason =
  | "EXECUTION_EVIDENCE_UNRESOLVED"
  | "EXECUTION_QUANTITY_INCOMPLETE"
  | "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE"
  | "LEG_IDENTITY_INVALID"
  | "ACTIVE_EXPOSURE_INVALID";

export type InstanceHedgeDeltaLegContribution = Readonly<{
  legId: string;
  role: ArbitrageInstanceLeg["role"];
  marketType: "SPOT" | "PERPETUAL";
  signedContribution: string | null;
  openingSignedContribution: string | null;
  activeManagedQuantity: string;
  source: "SPOT_OPENING_ATTRIBUTION" | "PERPETUAL_CONFIRMED_EXECUTION";
  openingStatus: InstanceHedgeDeltaStatus;
  openingReason: InstanceHedgeDeltaReason | null;
  activeStatus: InstanceHedgeDeltaStatus;
  activeReason: InstanceHedgeDeltaReason | null;
  /** Compatibility alias for activeStatus. */
  status: InstanceHedgeDeltaStatus;
  /** Compatibility alias for activeReason. */
  reason: InstanceHedgeDeltaReason | null;
}>;

export type InstanceHedgeDeltaView = Readonly<{
  status: InstanceHedgeDeltaStatus;
  signedDeltaBaseQuantity: string | null;
  absoluteDeltaBaseQuantity: string | null;
  reason: InstanceHedgeDeltaReason | null;
}>;

export type InstanceHedgeDeltaResult = Readonly<{
  arbitrageId: string;
  status: ArbitrageInstance["status"];
  openingDelta: InstanceHedgeDeltaView;
  activeManagedDelta: InstanceHedgeDeltaView;
  openingWorkflow: Readonly<{
    secondLegRequired: boolean;
    /** Delta derivation does not evaluate mutation-time execution eligibility. */
    secondLegExecutionEligible: null;
    requiredSecondLegSignedExposure: string | null;
  }>;
  /** Compatibility alias for activeManagedDelta.status. */
  deltaStatus: InstanceHedgeDeltaStatus;
  /** Compatibility alias for activeManagedDelta.signedDeltaBaseQuantity. */
  signedDeltaBaseQuantity: string | null;
  /** Compatibility alias for activeManagedDelta.absoluteDeltaBaseQuantity. */
  absoluteDeltaBaseQuantity: string | null;
  legContributions: readonly [InstanceHedgeDeltaLegContribution, InstanceHedgeDeltaLegContribution];
  currentOpeningDelta: string | null;
  openingDeltaStatus: InstanceHedgeDeltaStatus;
  requiredSecondLegSignedExposure: string | null;
  plannedResidualDelta: string;
  actualResidualDelta: string | null;
  deltaKnown: boolean;
  derivedAt: number;
  reason: InstanceHedgeDeltaReason | null;
}>;

export class InstanceHedgeDeltaService {
  private readonly instruments = new InstrumentCapability();

  constructor(
    private readonly instances: InstanceSource,
    private readonly spotAttributions: SpotAttributionSources,
    private readonly now: () => number = Date.now,
  ) {}

  async derive(userId: string, arbitrageId: string): Promise<InstanceHedgeDeltaResult | null> {
    const instance = this.instances.get(identifier(userId), identifier(arbitrageId));
    if (!instance) return null;
    const identityInvalid = !sharedCanonicalBaseAsset(instance);
    const legs = identityInvalid
      ? instance.legs.map((leg) => unknownLeg(
          instance,
          leg,
          leg.instrumentId.endsWith("-SPOT") ? "SPOT" : "PERPETUAL",
          leg.instrumentId.endsWith("-SPOT") ? "SPOT_OPENING_ATTRIBUTION" : "PERPETUAL_CONFIRMED_EXECUTION",
          "LEG_IDENTITY_INVALID",
        ))
      : await Promise.all(instance.legs.map((leg) => this.deriveLeg(userId, instance, leg)));
    const contributions = legs as unknown as readonly [InstanceHedgeDeltaLegContribution, InstanceHedgeDeltaLegContribution];
    const activeUnknown = contributions.find((leg) => leg.activeStatus === "UNKNOWN");
    const openingUnknown = contributions.find((leg) => leg.openingStatus === "UNKNOWN");
    const signedDelta = activeUnknown ? null : sumSigned(contributions.map((leg) => leg.signedContribution!));
    const openingDelta = openingUnknown ? null : sumSigned(contributions.map((leg) => leg.openingSignedContribution!));
    const workflow = openingWorkflow(instance, contributions, openingDelta);
    const actualResidual = openingDelta !== null && openingComplete(instance, contributions) ? openingDelta : null;
    const plannedResidualDelta = sumSigned(instance.legs.map((leg) => signed(leg.role, leg.plannedQuantity)));
    const derivedAt = timestamp(this.now());
    const openingView = deltaView(openingDelta, openingUnknown?.openingReason ?? null);
    const activeView = deltaView(signedDelta, activeUnknown?.activeReason ?? null);
    return Object.freeze({
      arbitrageId: instance.arbitrageId,
      status: instance.status,
      openingDelta: openingView,
      activeManagedDelta: activeView,
      openingWorkflow: workflow,
      deltaStatus: activeView.status,
      signedDeltaBaseQuantity: signedDelta,
      absoluteDeltaBaseQuantity: signedDelta === null ? null : absolute(signedDelta),
      legContributions: Object.freeze(contributions),
      currentOpeningDelta: openingDelta,
      openingDeltaStatus: openingView.status,
      requiredSecondLegSignedExposure: workflow.requiredSecondLegSignedExposure,
      plannedResidualDelta,
      actualResidualDelta: actualResidual,
      deltaKnown: activeView.status === "KNOWN",
      derivedAt,
      reason: activeView.reason,
    });
  }

  private async deriveLeg(
    userId: string,
    instance: ArbitrageInstance,
    leg: ArbitrageInstanceLeg,
  ): Promise<InstanceHedgeDeltaLegContribution> {
    let canonical;
    try {
      canonical = canonicalInstrumentFromId(leg.instrumentId);
    } catch {
      return unknownLeg(instance, leg, "PERPETUAL", "PERPETUAL_CONFIRMED_EXECUTION", "LEG_IDENTITY_INVALID");
    }
    const marketType = canonical.contractType === "spot" ? "SPOT" as const : "PERPETUAL" as const;
    const source = marketType === "SPOT"
      ? "SPOT_OPENING_ATTRIBUTION" as const
      : "PERPETUAL_CONFIRMED_EXECUTION" as const;
    if (marketType === "SPOT" && leg.role !== "LONG") {
      return unknownLeg(instance, leg, marketType, source, "LEG_IDENTITY_INVALID");
    }
    const references = instance.executionReferences.filter((reference) => reference.legId === leg.legId);
    const released = instance.managementReleases?.some((release) => release.legId === leg.legId) ?? false;
    const unresolved = references.some((reference) => unresolvedReference(reference.status));
    const openings = references.filter((reference) => reference.phase === "OPENING"
      && reference.quantityEffect === "INCREASE"
      && terminalExecutionFact(reference.status));
    const closings = references.filter((reference) => reference.quantityEffect === "DECREASE"
      && terminalExecutionFact(reference.status));
    let openingQuantity: string | null = leg.confirmedOpenedQuantity;
    let openingReason: InstanceHedgeDeltaReason | null = null;
    const unresolvedOpening = references.some((reference) => reference.phase === "OPENING"
      && reference.quantityEffect === "INCREASE" && unresolvedReference(reference.status));
    if (unresolvedOpening) {
      openingQuantity = null;
      openingReason = "EXECUTION_EVIDENCE_UNRESOLVED";
    } else if (marketType === "PERPETUAL"
      && sumUnsigned(openings.map((reference) => reference.confirmedQuantity)) !== leg.confirmedOpenedQuantity) {
      openingQuantity = null;
      openingReason = "EXECUTION_QUANTITY_INCOMPLETE";
    } else if (marketType === "SPOT" && leg.confirmedOpenedQuantity !== "0") {
      try {
        openingQuantity = await this.readOrRecoverSpotOpeningQuantity(
          userId,
          instance,
          leg,
          canonical.baseAsset,
          openings,
        );
      } catch {
        openingQuantity = null;
        openingReason = "SPOT_OPENING_ATTRIBUTION_UNAVAILABLE";
      }
    }

    let activeQuantity: string | null = null;
    let activeReason: InstanceHedgeDeltaReason | null = null;
    if (released) {
      activeQuantity = "0";
    } else if (unresolved) {
      activeReason = "EXECUTION_EVIDENCE_UNRESOLVED";
    } else if (sumUnsigned(closings.map((reference) => reference.confirmedQuantity))
      !== leg.confirmedClosedQuantity) {
      activeReason = "EXECUTION_QUANTITY_INCOMPLETE";
    } else if (activeManagedQuantity(instance, leg) === "0") {
      activeQuantity = "0";
    } else if (openingQuantity === null) {
      activeReason = openingReason;
    } else if (compareUnsignedDecimals(leg.confirmedClosedQuantity, openingQuantity) > 0) {
      activeReason = "ACTIVE_EXPOSURE_INVALID";
    } else {
      activeQuantity = subtractUnsignedDecimals(openingQuantity, leg.confirmedClosedQuantity);
    }
    return contribution(instance, leg, marketType, source, openingQuantity, openingReason, activeQuantity, activeReason);
  }

  private async readOrRecoverSpotOpeningQuantity(
    userId: string,
    instance: ArbitrageInstance,
    leg: ArbitrageInstanceLeg,
    baseAsset: string,
    openings: readonly ArbitrageInstance["executionReferences"][number][],
  ) {
    if (openings.length === 0 || openings.some((reference) => reference.executionRecordId === null)) {
      throw new Error("Spot opening reference identity is unavailable.");
    }
    const persisted = this.instances.readSpotOpeningAttributionEvidence(userId, instance.arbitrageId, leg.legId);
    const venueInstrument = this.instruments.resolveVenueInstrument(canonicalInstrumentFromId(leg.instrumentId), leg.venue);
    const quantities: string[] = [];
    for (const reference of openings) {
      const existing = persisted.find((evidence) => evidence.executionIntentId === reference.executionIntentId);
      if (existing) {
        assertEvidenceIdentity(existing, instance, leg, reference.executionRecordId!);
        quantities.push(existing.attributableBaseQuantity);
        continue;
      }
      const attribution = this.spotAttributions[leg.venue];
      if (!attribution) throw new Error("Spot opening attribution source is unavailable.");
      const attributableBaseQuantity = await attribution.readAttributableBaseQuantity(userId, {
        accountId: leg.accountId,
        instrumentId: leg.instrumentId,
        providerSymbol: venueInstrument.symbol,
        baseAsset,
        executionIntentId: reference.executionIntentId,
        executionRecordId: reference.executionRecordId!,
        grossConfirmedQuantity: reference.confirmedQuantity,
      });
      const evidence = this.instances.recordSpotOpeningAttributionEvidence(userId, {
        arbitrageId: instance.arbitrageId,
        legId: leg.legId,
        executionIntentId: reference.executionIntentId,
        executionRecordId: reference.executionRecordId!,
        attributableBaseQuantity,
        source: "PROVIDER_ORDER_FILLS",
        confirmedAt: Math.max(reference.updatedAt, timestamp(this.now())),
        venue: leg.venue,
        accountId: leg.accountId,
        instrumentId: leg.instrumentId,
      });
      quantities.push(evidence.attributableBaseQuantity);
    }
    if (persisted.some((evidence) => !openings.some((reference) =>
      reference.executionIntentId === evidence.executionIntentId))) {
      throw new Error("Spot opening attribution evidence does not match the instance references.");
    }
    return sumUnsigned(quantities);
  }
}

function unknownLeg(
  instance: ArbitrageInstance,
  leg: ArbitrageInstanceLeg,
  marketType: "SPOT" | "PERPETUAL",
  source: InstanceHedgeDeltaLegContribution["source"],
  reason: InstanceHedgeDeltaReason,
): InstanceHedgeDeltaLegContribution {
  return Object.freeze({
    legId: leg.legId,
    role: leg.role,
    marketType,
    signedContribution: activeManagedQuantity(instance, leg) === "0" ? "0" : null,
    openingSignedContribution: null,
    activeManagedQuantity: activeManagedQuantity(instance, leg),
    source,
    openingStatus: "UNKNOWN",
    openingReason: reason,
    activeStatus: "UNKNOWN",
    activeReason: reason,
    status: "UNKNOWN",
    reason,
  });
}

function contribution(
  instance: ArbitrageInstance,
  leg: ArbitrageInstanceLeg,
  marketType: "SPOT" | "PERPETUAL",
  source: InstanceHedgeDeltaLegContribution["source"],
  openingQuantity: string | null,
  openingReason: InstanceHedgeDeltaReason | null,
  activeQuantity: string | null,
  activeReason: InstanceHedgeDeltaReason | null,
): InstanceHedgeDeltaLegContribution {
  const openingStatus = openingQuantity === null ? "UNKNOWN" as const : "KNOWN" as const;
  const activeStatus = activeQuantity === null ? "UNKNOWN" as const : "KNOWN" as const;
  return Object.freeze({
    legId: leg.legId,
    role: leg.role,
    marketType,
    signedContribution: activeQuantity === null ? null : signed(leg.role, activeQuantity),
    openingSignedContribution: openingQuantity === null ? null : signed(leg.role, openingQuantity),
    activeManagedQuantity: activeManagedQuantity(instance, leg),
    source,
    openingStatus,
    openingReason,
    activeStatus,
    activeReason,
    status: activeStatus,
    reason: activeReason,
  });
}

function openingComplete(
  instance: ArbitrageInstance,
  contributions: readonly InstanceHedgeDeltaLegContribution[],
) {
  return instance.legs.every((leg) => leg.confirmedOpenedQuantity !== "0")
    && contributions.every((leg) => leg.openingStatus === "KNOWN")
    && !instance.executionReferences.some((reference) => reference.phase === "OPENING"
      && unresolvedReference(reference.status));
}

function openingWorkflow(
  instance: ArbitrageInstance,
  contributions: readonly InstanceHedgeDeltaLegContribution[],
  openingDelta: string | null,
) {
  const completed = instance.legs.filter((leg) => {
    const contribution = contributions.find((candidate) => candidate.legId === leg.legId);
    return contribution?.openingStatus === "KNOWN"
      && contribution.openingSignedContribution !== "0"
      && instance.executionReferences.some((reference) => reference.legId === leg.legId
        && reference.phase === "OPENING" && reference.quantityEffect === "INCREASE"
        && reference.status === "CONFIRMED");
  });
  const untouched = instance.legs.filter((leg) => leg.confirmedOpenedQuantity === "0"
    && !instance.executionReferences.some((reference) => reference.legId === leg.legId));
  const secondLegRequired = openingDelta !== null && completed.length === 1 && untouched.length === 1;
  return Object.freeze({
    secondLegRequired,
    secondLegExecutionEligible: null,
    requiredSecondLegSignedExposure: secondLegRequired ? negate(openingDelta) : null,
  });
}

function deltaView(
  value: string | null,
  reason: InstanceHedgeDeltaReason | null,
): InstanceHedgeDeltaView {
  return Object.freeze({
    status: value === null ? "UNKNOWN" : "KNOWN",
    signedDeltaBaseQuantity: value,
    absoluteDeltaBaseQuantity: value === null ? null : absolute(value),
    reason: value === null ? reason : null,
  });
}

function unresolvedReference(status: ArbitrageInstance["executionReferences"][number]["status"]) {
  return status === "CLAIMED" || status === "LINKED" || status === "PENDING_CONFIRMATION" || status === "UNKNOWN";
}

function terminalExecutionFact(status: ArbitrageInstance["executionReferences"][number]["status"]) {
  return status === "CONFIRMED" || status === "FAILED";
}

function assertEvidenceIdentity(
  evidence: SpotOpeningAttributionEvidence,
  instance: ArbitrageInstance,
  leg: ArbitrageInstanceLeg,
  executionRecordId: string,
) {
  if (evidence.arbitrageId !== instance.arbitrageId || evidence.legId !== leg.legId
    || evidence.executionRecordId !== executionRecordId || evidence.venue !== leg.venue
    || evidence.accountId !== leg.accountId || evidence.instrumentId !== leg.instrumentId
    || evidence.source !== "PROVIDER_ORDER_FILLS") {
    throw new Error("Spot opening attribution evidence identity is invalid.");
  }
}

function sharedCanonicalBaseAsset(instance: ArbitrageInstance) {
  try {
    const assets = instance.legs.map((leg) => canonicalInstrumentFromId(leg.instrumentId).baseAsset);
    return assets[0] === assets[1];
  } catch {
    return false;
  }
}

function sumUnsigned(values: readonly string[]) {
  return values.reduce(addUnsignedDecimals, "0");
}

function signed(role: ArbitrageInstanceLeg["role"], quantity: string) {
  return quantity === "0" || role === "LONG" ? quantity : `-${quantity}`;
}

function sumSigned(values: readonly string[]) {
  const positive = sumUnsigned(values.filter((value) => !value.startsWith("-")));
  const negative = sumUnsigned(values.filter((value) => value.startsWith("-")).map((value) => value.slice(1)));
  const comparison = compareUnsignedDecimals(positive, negative);
  if (comparison === 0) return "0";
  return comparison > 0
    ? subtractUnsignedDecimals(positive, negative)
    : `-${subtractUnsignedDecimals(negative, positive)}`;
}

function absolute(value: string) {
  return value.startsWith("-") ? value.slice(1) : value;
}

function negate(value: string) {
  if (value === "0") return "0";
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

function identifier(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Identifier is invalid.");
  return value.trim();
}

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Delta derivation clock is invalid.");
  return value;
}
