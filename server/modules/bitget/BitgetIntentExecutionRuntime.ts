import { randomUUID } from "node:crypto";
import { applyExecutionCancelObservation, type ExecutionCancelCapability, type ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import type { ExecutionCapability } from "../cex/ExecutionCapability";
import { ExecutionCapabilityRegistry, executionCapability } from "../cex/ExecutionCapabilityRegistry";
import { ExecutionCoordinator, type CoordinatedExecutionResult } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { applyExecutionQueryObservation, type ExecutionQueryObservation } from "../cex/ExecutionQueryCapability";
import { applyExecutionReconciliationObservation, createExecutionReconciliationObservation, type ExecutionReconciliationObservation } from "../cex/ExecutionReconciliationCapability";
import { attachExecutionAttempt, createExecutionRecordFromIntent, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import { RegistryBackedExecutionCapability } from "../cex/RegistryBackedExecutionCapability";
import {
  createBitgetExecutionOrderRecoveryReference,
  createBitgetExecutionOrderReference,
  type BitgetExecutionOrderRecoveryReference,
  type BitgetExecutionOrderReference,
  type BitgetExecutionOrderReferenceStore,
} from "./BitgetExecutionOrderReferenceStore";
import { BitgetIntentCancellationCapability } from "./BitgetIntentCancellationCapability";
import { BitgetIntentExecutionCapability } from "./BitgetIntentExecutionCapability";
import {
  BitgetIntentExecutionService,
  type BitgetExecutionQueryResult,
  type BitgetIntentExecutionClient,
  type BitgetIntentExecutionResult,
  type BitgetIntentExecutionServiceOptions,
} from "./BitgetIntentExecutionService";

export type BitgetIntentRuntimeService = BitgetIntentExecutionClient & Readonly<{
  executionAccountIdentity(): Promise<{ accountId: string }> | { accountId: string };
  validateExecutionProviderIdentity(context: ExecutionMutationContext): Promise<void> | void;
}>;
export type BitgetIntentExecutionRuntimeRegistry = Readonly<{
  run<T>(userId: string, operation: (service: BitgetIntentRuntimeService) => Promise<T> | T): Promise<T>;
}>;
export type BitgetIntentExecutionRuntimeOptions = Readonly<
  Omit<BitgetIntentExecutionServiceOptions, "validateProviderIdentity" | "persistRecoveryReference"> & {
    createExecutionId?: (intent: ExecutionIntent) => string;
    createCapability?: (service: BitgetIntentExecutionService) => BitgetIntentExecutionCapability<BitgetIntentExecutionResult>;
    createCancelCapability?: (service: import("./BitgetIntentCancellationCapability").BoundBitgetIntentCancellationService, reference: BitgetExecutionOrderReference) => ExecutionCancelCapability;
  }
>;
export type BitgetIntentExecutionRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  execution: CoordinatedExecutionResult<BitgetIntentExecutionResult>;
  orderReference: BitgetExecutionOrderReference | null;
}>;
export type BitgetIntentExecutionQueryRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord; observation: ExecutionQueryObservation; orderReference: BitgetExecutionOrderReference;
  fee: string; feeCurrency: string | null; statusReason: string | null;
}>;
export type BitgetIntentExecutionReconciliationRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord; observation: ExecutionReconciliationObservation | null;
  orderReference: BitgetExecutionOrderReference | null; statusReason: string | null; terminalShortCircuit: boolean;
}>;
export type BitgetIntentExecutionCancelRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord; observation: ExecutionCancelObservation; orderReference: BitgetExecutionOrderReference;
}>;

export class BitgetIntentExecutionRuntime {
  constructor(
    private readonly registry: BitgetIntentExecutionRuntimeRegistry,
    private readonly recordStore: ExecutionRecordStore,
    private readonly orderReferences: BitgetExecutionOrderReferenceStore,
    private readonly options: BitgetIntentExecutionRuntimeOptions = {},
  ) {}

  async execute(input: ExecutionIntent): Promise<BitgetIntentExecutionRuntimeResult> {
    const intent = createExecutionIntent(input);
    if (intent.venue !== "bitget") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    return this.registry.run(intent.userId, async (runtimeService) => {
      const account = await runtimeService.executionAccountIdentity();
      if (account.accountId !== intent.accountId) throw new Error("ExecutionIntent accountId does not match the Bitget execution account.");
      const initial = createExecutionRecordFromIntent(this.options.createExecutionId?.(intent) ?? randomUUID(), intent);
      await this.recordStore.create(initial);
      let coordinatedCapability: ExecutionCapability<BitgetIntentExecutionResult>;
      try {
        const service = this.service(runtimeService, (reference) => this.orderReferences.createRecovery(
          createBitgetExecutionOrderRecoveryReference({
            executionId: initial.executionId, intentId: initial.intentId, userId: initial.userId,
            accountId: initial.accountId, instrumentId: initial.instrumentId, ...reference,
            createdAt: initial.createdAt, updatedAt: initial.updatedAt,
          }),
        ));
        const capability = this.options.createCapability?.(service) ?? new BitgetIntentExecutionCapability(service);
        coordinatedCapability = new RegistryBackedExecutionCapability(
          new ExecutionCapabilityRegistry<BitgetIntentExecutionResult>().register(executionCapability("bitget", capability)),
        );
      } catch (error) {
        await this.failPreMutationRecordIfSafe(initial);
        throw error;
      }
      const execution = await new ExecutionCoordinator(coordinatedCapability, this.options.clock).execute(intent);
      let executionRecord = initial;
      let orderReference: BitgetExecutionOrderReference | null = null;
      if (execution.step.result) {
        const result = execution.step.result;
        const accepted = attachExecutionAttempt(initial, {
          executionAttemptId: result.executionAttemptId, remoteOrderId: result.providerOrderId,
          status: execution.executionState.status, observedAt: execution.executionState.updatedAt,
        });
        const complete = createBitgetExecutionOrderReference({
          executionId: accepted.executionId, intentId: accepted.intentId, userId: accepted.userId,
          accountId: accepted.accountId, instrumentId: accepted.instrumentId, category: result.category,
          symbol: result.symbol, orderId: result.providerOrderId, clientOid: result.clientOrderId,
          expectedProviderQuantity: result.expectedProviderQuantity, expectedSide: result.expectedSide,
          createdAt: accepted.createdAt, updatedAt: accepted.updatedAt,
        });
        try {
          await this.orderReferences.create(complete);
          executionRecord = accepted;
          orderReference = complete;
        } catch {
          executionRecord = attachExecutionAttempt(initial, {
            executionAttemptId: result.executionAttemptId, remoteOrderId: result.providerOrderId,
            status: "UNKNOWN", observedAt: execution.executionState.updatedAt,
          });
        }
      } else {
        executionRecord = { ...initial, status: execution.executionState.status, updatedAt: execution.executionState.updatedAt };
      }
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, execution, orderReference });
    });
  }

  close(input: ExecutionIntent) { return this.execute(input); }

  async query(authenticatedUserId: string, executionId: string): Promise<BitgetIntentExecutionQueryRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.loadRecord(userId, executionId);
    return this.registry.run(userId, async (runtimeService) => {
      await this.assertAccount(record, runtimeService);
      const reference = await this.loadCompleteReference(record);
      const result = await this.service(runtimeService).query(reference);
      const executionRecord = applyExecutionQueryObservation(record, result.observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation: result.observation, orderReference: reference,
        fee: result.fee, feeCurrency: result.feeCurrency, statusReason: result.statusReason });
    });
  }

  async reconcile(authenticatedUserId: string, executionId: string): Promise<BitgetIntentExecutionReconciliationRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.loadRecord(userId, executionId);
    return this.registry.run(userId, async (runtimeService) => {
      await this.assertAccount(record, runtimeService);
      const service = this.service(runtimeService);
      const recovery = await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId);
      if (recovery) return this.reconcileRecovery(record, recovery, service);
      const reference = await this.loadCompleteReference(record);
      const result = await service.query(reference);
      const executionRecord = applyExecutionReconciliationObservation(record, result.observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation: result.observation, orderReference: reference,
        statusReason: result.statusReason, terminalShortCircuit: false });
    });
  }

  async cancel(authenticatedUserId: string, executionId: string): Promise<BitgetIntentExecutionCancelRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.loadRecord(userId, executionId);
    if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
      throw new Error(`Execution record ${record.status} cannot be cancelled.`);
    }
    return this.registry.run(userId, async (runtimeService) => {
      await this.assertAccount(record, runtimeService);
      const reference = await this.loadCancelReference(record);
      const service = this.service(runtimeService);
      const capability = this.options.createCancelCapability?.(service, reference)
        ?? new BitgetIntentCancellationCapability(service, reference);
      const observation = await capability.cancel(record);
      const executionRecord = applyExecutionCancelObservation(record, observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation, orderReference: reference });
    });
  }

  private service(runtimeService: BitgetIntentRuntimeService, persistRecoveryReference?: BitgetIntentExecutionServiceOptions["persistRecoveryReference"]) {
    return new BitgetIntentExecutionService(runtimeService, {
      ...this.options,
      validateProviderIdentity: (context) => runtimeService.validateExecutionProviderIdentity(context),
      ...(persistRecoveryReference === undefined ? {} : { persistRecoveryReference }),
    });
  }

  private async reconcileRecovery(record: ExecutionRecord, recovery: BitgetExecutionOrderRecoveryReference, service: BitgetIntentExecutionService) {
    let result: BitgetExecutionQueryResult;
    try { result = await service.query(recovery); } catch { return this.failedRecovery(record); }
    let reference: BitgetExecutionOrderReference;
    try {
      reference = createBitgetExecutionOrderReference({ ...recovery, orderId: result.orderIdentity.orderId,
        updatedAt: Math.max(recovery.updatedAt, result.observation.observedAt) });
      await this.orderReferences.create(reference);
    } catch { return this.failedRecovery(record); }
    const reconciled = applyExecutionReconciliationObservation(record, result.observation);
    const executionRecord = reconciled.remoteOrderId === undefined
      ? attachExecutionAttempt(reconciled, { executionAttemptId: record.intentId, remoteOrderId: result.orderIdentity.orderId,
        status: reconciled.status, observedAt: reconciled.updatedAt })
      : reconciled;
    await this.recordStore.update(executionRecord);
    return Object.freeze({ executionRecord, observation: result.observation, orderReference: reference,
      statusReason: result.statusReason, terminalShortCircuit: false });
  }

  private async failedRecovery(record: ExecutionRecord): Promise<BitgetIntentExecutionReconciliationRuntimeResult> {
    const observedAt = Math.max(record.updatedAt, this.now());
    const observation = createExecutionReconciliationObservation({ state: "UNKNOWN", filledBaseQuantity: "0", observedAt });
    const executionRecord = applyExecutionReconciliationObservation(record, observation);
    await this.recordStore.update(executionRecord);
    return Object.freeze({ executionRecord, observation, orderReference: null,
      statusReason: "Bitget order reference recovery could not be confirmed.", terminalShortCircuit: false });
  }

  private async failPreMutationRecordIfSafe(record: ExecutionRecord) {
    try {
      const [current, reference, recovery] = await Promise.all([
        this.recordStore.loadForUser(record.userId, record.executionId),
        this.orderReferences.loadForUser(record.userId, record.executionId),
        this.orderReferences.loadRecoveryForUser(record.userId, record.executionId),
      ]);
      if (!current || current.status !== "CREATED" || current.executionAttemptId !== undefined
        || current.remoteOrderId !== undefined || reference || recovery) return;
      await this.recordStore.update({ ...current, status: "FAILED" });
    } catch (error) {
      console.error("[bitget] pre-mutation ExecutionRecord cleanup failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  private async loadRecord(userId: string, executionId: string) {
    const record = await this.recordStore.loadForUser(userId, identifier(executionId, "executionId"));
    if (!record) throw new Error("ExecutionRecord was not found for the authenticated user.");
    if (record.userId !== userId || record.venue !== "bitget") throw new Error("ExecutionRecord does not match the authenticated Bitget user.");
    return record;
  }
  private async assertAccount(record: ExecutionRecord, service: BitgetIntentRuntimeService) {
    if ((await service.executionAccountIdentity()).accountId !== record.accountId) {
      throw new Error("ExecutionRecord accountId does not match the Bitget execution account.");
    }
  }
  private async loadCompleteReference(record: ExecutionRecord) {
    const reference = await this.orderReferences.loadForUser(record.userId, record.executionId);
    if (reference) return reference;
    if (await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId)) {
      throw new Error("Bitget execution order reference requires reconciliation before this operation.");
    }
    throw new Error("Bitget execution order reference is missing.");
  }
  private async loadCancelReference(record: ExecutionRecord) {
    const reference = await this.orderReferences.loadForUser(record.userId, record.executionId);
    if (reference) return reference;
    if (await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId)) {
      throw new Error("Bitget execution order reference requires reconciliation before cancellation.");
    }
    throw new Error("Bitget execution order reference is missing for cancellation.");
  }
  private now() {
    const value = (this.options.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bitget execution clock is invalid.");
    return value;
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${name} is invalid.`);
  return value.trim();
}
