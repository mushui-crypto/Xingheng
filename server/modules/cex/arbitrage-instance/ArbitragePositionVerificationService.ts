import { createHash } from "node:crypto";
import type { UserExchangeCredentialStore } from "../../credentials/UserExchangeCredentialStore";
import {
  compareUnsignedDecimals,
  activeManagedQuantity,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
} from "./ArbitrageInstance";
import type { ArbitrageInstanceQueryService } from "./ArbitrageInstanceQueryService";
import type {
  ArbitrageLegObservedState,
  ArbitrageLegReadProviderFactory,
  ArbitrageLegVerificationUnknownReason,
  ArbitrageLegVerificationResult,
  ArbitragePositionVerificationResult,
} from "./ArbitragePositionVerification";
import { ArbitrageLegReadError } from "./ArbitragePositionVerification";
import { reduceOnlyEligible, signedCurrentNet } from "../position/PositionVerification";

type VerificationCredentialStore = Pick<UserExchangeCredentialStore, "findSummary" | "loadForAccountRead">;
type VerificationQuery = Pick<ArbitrageInstanceQueryService, "getById" | "listActive">;

export class ArbitragePositionVerificationService {
  private readonly factories: ReadonlyMap<ArbitrageInstanceLeg["venue"], ArbitrageLegReadProviderFactory>;

  constructor(
    private readonly instances: VerificationQuery,
    private readonly credentials: VerificationCredentialStore,
    factories: readonly ArbitrageLegReadProviderFactory[],
    private readonly now: () => number = Date.now,
  ) {
    this.factories = new Map(factories.map((factory) => [factory.venue, factory]));
  }

  async verify(userId: string, arbitrageId: string): Promise<ArbitragePositionVerificationResult | null> {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const instance = this.instances.getById(normalizedUserId, normalizedArbitrageId);
    if (!instance) return null;
    const checkedAt = this.now();
    const groups = new Map<string, ArbitrageInstanceLeg[]>();
    for (const leg of instance.legs) {
      const key = `${leg.venue}\u0000${leg.accountId}`;
      groups.set(key, [...(groups.get(key) ?? []), leg]);
    }
    const verifiedGroups = await Promise.all([...groups.values()].map((legs) =>
      this.verifyGroup(instance, legs, checkedAt)));
    const byLegId = new Map(verifiedGroups.flat().map((leg) => [leg.legId, leg]));
    const legs = instance.legs.map((leg) => byLegId.get(leg.legId)!);
    return Object.freeze({
      arbitrageId: instance.arbitrageId,
      checkedAt,
      legs: Object.freeze(legs) as unknown as readonly [ArbitrageLegVerificationResult, ArbitrageLegVerificationResult],
    });
  }

  /** Reads one exact leg without coupling its safety result to the other leg's Provider reads. */
  async verifyLeg(userId: string, arbitrageId: string, legId: string): Promise<ArbitrageLegVerificationResult | null> {
    const normalizedUserId = identifier(userId, "userId");
    const normalizedArbitrageId = identifier(arbitrageId, "arbitrageId");
    const normalizedLegId = identifier(legId, "legId");
    const instance = this.instances.getById(normalizedUserId, normalizedArbitrageId);
    if (!instance) return null;
    const leg = instance.legs.find((candidate) => candidate.legId === normalizedLegId);
    if (!leg) return null;
    return (await this.verifyGroup(instance, [leg], this.now()))[0] ?? null;
  }

  private async verifyGroup(
    instance: ArbitrageInstance,
    legs: readonly ArbitrageInstanceLeg[],
    checkedAt: number,
  ): Promise<readonly ArbitrageLegVerificationResult[]> {
    const first = legs[0]!;
    const factory = this.factories.get(first.venue);
    const summary = this.credentials.findSummary(instance.userId, first.venue);
    if (!factory || !summary || summary.accountId !== first.accountId) {
      return legs.map((leg) => unknownFor(instance, leg, checkedAt, "credential_binding_unavailable"));
    }
    let provider;
    let failureReason: ArbitrageLegVerificationUnknownReason = "credential_load_failed";
    try {
      const secret = await this.credentials.loadForAccountRead(instance.userId, first.venue);
      if (legs.some((leg) => !credentialBindingMatches(leg, secret.apiKey))) {
        return legs.map((leg) => unknownFor(instance, leg, checkedAt, "credential_binding_mismatch"));
      }
      failureReason = "provider_initialization_failed";
      provider = factory.create(secret);
      return await Promise.all(legs.map(async (leg) => {
        try {
          const observed = await provider!.readLeg(leg);
          return result(instance, leg, activeManagedQuantity(instance, leg), observed, checkedAt);
        } catch (error) {
          return unknownFor(
            instance,
            leg,
            checkedAt,
            error instanceof ArbitrageLegReadError ? error.reason : "provider_read_failed",
          );
        }
      }));
    } catch (error) {
      const reason = error instanceof ArbitrageLegReadError ? error.reason : failureReason;
      return legs.map((leg) => unknownFor(instance, leg, checkedAt, reason));
    } finally {
      if (provider) await Promise.resolve(provider.dispose()).catch(() => undefined);
    }
  }
}

function unknownFor(
  instance: ArbitrageInstance,
  leg: ArbitrageInstanceLeg,
  checkedAt: number,
  reason: ArbitrageLegVerificationUnknownReason,
) {
  return unknown(instance.arbitrageId, leg.legId, activeManagedQuantity(instance, leg), checkedAt, reason);
}

function credentialBindingMatches(leg: ArbitrageInstanceLeg, apiKey: string) {
  const prefix = `${leg.venue}:credential-only:`;
  if (!leg.accountId.startsWith(prefix)) return true;
  const digest = createHash("sha256").update(`${prefix}${apiKey}`).digest("hex");
  return leg.accountId === `${prefix}${digest.slice(0, 20)}`;
}

function result(
  instance: ArbitrageInstance,
  leg: ArbitrageInstanceLeg,
  expectedManagedQuantity: string,
  observed: ArbitrageLegObservedState,
  checkedAt: number,
): ArbitrageLegVerificationResult {
  if (observed.snapshot.venue !== leg.venue
    || observed.snapshot.accountId !== leg.accountId
    || observed.snapshot.instrumentId !== leg.instrumentId) {
    return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt, "instrument_mapping_unavailable");
  }
  const actualQuantity = observed.snapshot.positionMode === "HEDGE"
    ? leg.role === "LONG" ? observed.snapshot.longQuantity : observed.snapshot.shortQuantity
    : observed.snapshot.quantity;
  const verificationStatus = relationshipStatus(leg, expectedManagedQuantity, observed);
  return Object.freeze({
    arbitrageId: instance.arbitrageId,
    legId: leg.legId,
    expectedManagedQuantity,
    actualQuantity,
    actualSignedNetQuantity: signedCurrentNet(observed.snapshot),
    positionMode: observed.snapshot.positionMode,
    actualLongQuantity: observed.snapshot.longQuantity,
    actualShortQuantity: observed.snapshot.shortQuantity,
    availableQuantity: observed.availableQuantity ?? null,
    ...(observed.verifiedAccountId === undefined ? {} : { verifiedAccountId: observed.verifiedAccountId }),
    verificationStatus,
    reason: null,
    checkedAt,
  });
}

function relationshipStatus(
  leg: ArbitrageInstanceLeg,
  expectedManagedQuantity: string,
  observed: ArbitrageLegObservedState,
): "MATCHED" | "MISMATCH" {
  // Spot account totals are Account Reality, not instance ownership. Reliable
  // reads therefore do not become mismatches merely because users hold more.
  if (leg.instrumentId.endsWith("-SPOT") || expectedManagedQuantity === "0") return "MATCHED";
  if (observed.snapshot.positionMode === "HEDGE") {
    const bucket = leg.role === "LONG" ? observed.snapshot.longQuantity : observed.snapshot.shortQuantity;
    return compareUnsignedDecimals(bucket, expectedManagedQuantity) >= 0 ? "MATCHED" : "MISMATCH";
  }
  const managedSignedQuantity = leg.role === "SHORT" ? `-${expectedManagedQuantity}` : expectedManagedQuantity;
  return reduceOnlyEligible(signedCurrentNet(observed.snapshot)!, managedSignedQuantity) ? "MATCHED" : "MISMATCH";
}

function unknown(
  arbitrageId: string,
  legId: string,
  expectedManagedQuantity: string,
  checkedAt: number,
  reason: ArbitrageLegVerificationUnknownReason,
): ArbitrageLegVerificationResult {
  return Object.freeze({
    arbitrageId,
    legId,
    expectedManagedQuantity,
    actualQuantity: null,
    actualSignedNetQuantity: null,
    positionMode: null,
    actualLongQuantity: null,
    actualShortQuantity: null,
    availableQuantity: null,
    verificationStatus: "UNKNOWN",
    reason,
    checkedAt,
  });
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
