import { createHash } from "node:crypto";
import type { UserExchangeCredentialStore } from "../../credentials/UserExchangeCredentialStore";
import {
  absoluteDifference,
  compareUnsignedDecimals,
  managedCurrentQuantity,
  type ArbitrageInstance,
  type ArbitrageInstanceLeg,
} from "./ArbitrageInstance";
import type { ArbitrageInstanceQueryStore } from "./ArbitrageInstanceQueryService";
import type {
  ArbitrageLegObservedState,
  ArbitrageLegReadProviderFactory,
  ArbitrageLegVerificationResult,
  ArbitragePositionVerificationResult,
} from "./ArbitragePositionVerification";

type VerificationCredentialStore = Pick<UserExchangeCredentialStore, "findSummary" | "loadForAccountRead">;
type VerificationQuery = Pick<ArbitrageInstanceQueryStore, "get" | "listActive">;

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
    const instance = this.instances.get(normalizedUserId, normalizedArbitrageId);
    if (!instance) return null;
    const checkedAt = this.now();
    const active = this.instances.listActive(normalizedUserId);
    const legs = await Promise.all(instance.legs.map((leg) => this.verifyLeg(instance, leg, active, checkedAt)));
    return Object.freeze({
      arbitrageId: instance.arbitrageId,
      checkedAt,
      legs: Object.freeze(legs) as unknown as readonly [ArbitrageLegVerificationResult, ArbitrageLegVerificationResult],
    });
  }

  private async verifyLeg(
    instance: ArbitrageInstance,
    leg: ArbitrageInstanceLeg,
    active: readonly ArbitrageInstance[],
    checkedAt: number,
  ): Promise<ArbitrageLegVerificationResult> {
    const expectedManagedQuantity = managedCurrentQuantity(leg);
    if (hasOverlappingManagedLeg(instance, leg, active)) {
      return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt);
    }
    const factory = this.factories.get(leg.venue);
    const summary = this.credentials.findSummary(instance.userId, leg.venue);
    if (!factory || !summary || summary.accountId !== leg.accountId) {
      return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt);
    }
    let provider;
    try {
      const secret = await this.credentials.loadForAccountRead(instance.userId, leg.venue);
      if (!credentialBindingMatches(leg, secret.apiKey)) {
        return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt);
      }
      provider = factory.create(secret);
      const observed = await provider.readLeg(leg);
      return result(instance, leg, expectedManagedQuantity, observed, checkedAt);
    } catch {
      return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt);
    } finally {
      if (provider) await Promise.resolve(provider.dispose()).catch(() => undefined);
    }
  }
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
  const directionMatches = expectedManagedQuantity === "0"
    ? observed.direction === "FLAT" || observed.actualQuantity === "0"
    : observed.direction === leg.role;
  const quantityMatches = compareUnsignedDecimals(
    absoluteDifference(expectedManagedQuantity, observed.actualQuantity),
    instance.maxResidualBaseQuantity,
  ) <= 0;
  return Object.freeze({
    arbitrageId: instance.arbitrageId,
    legId: leg.legId,
    expectedManagedQuantity,
    actualQuantity: observed.actualQuantity,
    verificationStatus: directionMatches && quantityMatches ? "MATCHED" : "MISMATCH",
    checkedAt,
  });
}

function unknown(
  arbitrageId: string,
  legId: string,
  expectedManagedQuantity: string,
  checkedAt: number,
): ArbitrageLegVerificationResult {
  return Object.freeze({
    arbitrageId,
    legId,
    expectedManagedQuantity,
    actualQuantity: null,
    verificationStatus: "UNKNOWN",
    checkedAt,
  });
}

function hasOverlappingManagedLeg(
  instance: ArbitrageInstance,
  leg: ArbitrageInstanceLeg,
  active: readonly ArbitrageInstance[],
) {
  return active.some((candidate) => candidate.arbitrageId !== instance.arbitrageId
    && candidate.legs.some((other) => other.venue === leg.venue
      && other.accountId === leg.accountId
      && other.instrumentId === leg.instrumentId
      && managedCurrentQuantity(other) !== "0"));
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
