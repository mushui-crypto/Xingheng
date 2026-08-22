import { createHash } from "node:crypto";
import type { UserExchangeCredentialStore } from "../../credentials/UserExchangeCredentialStore";
import {
  managedCurrentQuantity,
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
import { signedCurrentNet } from "../position/PositionVerification";

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
    const legs = await Promise.all(instance.legs.map((leg) => this.verifyLeg(instance, leg, checkedAt)));
    return Object.freeze({
      arbitrageId: instance.arbitrageId,
      checkedAt,
      legs: Object.freeze(legs) as unknown as readonly [ArbitrageLegVerificationResult, ArbitrageLegVerificationResult],
    });
  }

  private async verifyLeg(
    instance: ArbitrageInstance,
    leg: ArbitrageInstanceLeg,
    checkedAt: number,
  ): Promise<ArbitrageLegVerificationResult> {
    const expectedManagedQuantity = managedCurrentQuantity(leg);
    const factory = this.factories.get(leg.venue);
    const summary = this.credentials.findSummary(instance.userId, leg.venue);
    if (!factory || !summary || summary.accountId !== leg.accountId) {
      return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt, "credential_binding_unavailable");
    }
    let provider;
    let failureReason: ArbitrageLegVerificationUnknownReason = "credential_load_failed";
    try {
      const secret = await this.credentials.loadForAccountRead(instance.userId, leg.venue);
      if (!credentialBindingMatches(leg, secret.apiKey)) {
        return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt, "credential_binding_mismatch");
      }
      failureReason = "provider_initialization_failed";
      provider = factory.create(secret);
      failureReason = "provider_read_failed";
      const observed = await provider.readLeg(leg);
      return result(instance, leg, expectedManagedQuantity, observed, checkedAt);
    } catch (error) {
      return unknown(
        instance.arbitrageId,
        leg.legId,
        expectedManagedQuantity,
        checkedAt,
        error instanceof ArbitrageLegReadError ? error.reason : failureReason,
      );
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
  if (observed.snapshot.venue !== leg.venue
    || observed.snapshot.accountId !== leg.accountId
    || observed.snapshot.instrumentId !== leg.instrumentId) {
    return unknown(instance.arbitrageId, leg.legId, expectedManagedQuantity, checkedAt, "instrument_mapping_unavailable");
  }
  return Object.freeze({
    arbitrageId: instance.arbitrageId,
    legId: leg.legId,
    expectedManagedQuantity,
    actualQuantity: observed.snapshot.quantity,
    actualSignedNetQuantity: signedCurrentNet(observed.snapshot),
    positionMode: observed.snapshot.positionMode,
    actualLongQuantity: observed.snapshot.longQuantity,
    actualShortQuantity: observed.snapshot.shortQuantity,
    availableQuantity: observed.availableQuantity ?? null,
    verificationStatus: "MATCHED",
    reason: null,
    checkedAt,
  });
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
