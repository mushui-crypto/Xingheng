import { randomUUID } from "node:crypto";
import { applyExecutionCancelObservation, type ExecutionCancelCapability, type ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import type { ExecutionCapability } from "../cex/ExecutionCapability";
import { ExecutionCapabilityRegistry, executionCapability } from "../cex/ExecutionCapabilityRegistry";
import { ExecutionCoordinator, type CoordinatedExecutionResult } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import { applyExecutionQueryObservation, type ExecutionQueryObservation } from "../cex/ExecutionQueryCapability";
import {
  applyExecutionReconciliationObservation,
  createExecutionReconciliationObservation,
  type ExecutionReconciliationObservation,
} from "../cex/ExecutionReconciliationCapability";
import { attachExecutionAttempt, createExecutionRecordFromIntent, type ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import type { ExecutionMutationContext, ExecutionMutationEffect } from "../cex/ExecutionMutationSafetyGuard";
import { RegistryBackedExecutionCapability } from "../cex/RegistryBackedExecutionCapability";
import {
  createBybitExecutionOrderRecoveryReference,
  createBybitExecutionOrderReference,
  type BybitExecutionOrderRecoveryReference,
  type BybitExecutionOrderReference,
  type BybitExecutionOrderReferenceStore,
} from "./BybitExecutionOrderReferenceStore";
import { BybitIntentCancellationCapability } from "./BybitIntentCancellationCapability";
import { BybitIntentExecutionCapability } from "./BybitIntentExecutionCapability";
import {
  BybitIntentExecutionService,
  type BybitExecutionQueryResult,
  type BybitIntentExecutionClient,
  type BybitIntentExecutionResult,
  type BybitIntentExecutionServiceOptions,
} from "./BybitIntentExecutionService";

export type BybitIntentRuntimeService = BybitIntentExecutionClient & Readonly<{
  executionAccountIdentity(): Promise<{ accountId: string }> | { accountId: string };
  validateExecutionProviderIdentity(context: ExecutionMutationContext): Promise<void> | void;
}>;

export type BybitIntentExecutionRuntimeRegistry = Readonly<{
  run<T>(userId: string, operation: (service: BybitIntentRuntimeService) => Promise<T> | T): Promise<T>;
}>;

export type BybitIntentExecutionRuntimeOptions = Readonly<
  Omit<BybitIntentExecutionServiceOptions, "validateProviderIdentity" | "persistRecoveryReference"> & {
    createExecutionId?: (intent: ExecutionIntent) => string;
    createCapability?: (service: BybitIntentExecutionService) => BybitIntentExecutionCapability<BybitIntentExecutionResult>;
    createCancelCapability?: (
      service: import("./BybitIntentCancellationCapability").BoundBybitIntentCancellationService,
      reference: BybitExecutionOrderReference,
    ) => ExecutionCancelCapability;
  }
>;

export type BybitIntentExecutionRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  execution: CoordinatedExecutionResult<BybitIntentExecutionResult>;
  orderReference: BybitExecutionOrderReference | null;
}>;
export type BybitIntentExecutionQueryRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionQueryObservation;
  orderReference: BybitExecutionOrderReference;
  fee: string;
  feeCurrency: string | null;
  statusReason: string | null;
}>;
export type BybitIntentExecutionReconciliationRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionReconciliationObservation | null;
  orderReference: BybitExecutionOrderReference | null;
  statusReason: string | null;
  terminalShortCircuit: boolean;
}>;
export type BybitIntentExecutionCancelRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionCancelObservation;
  orderReference: BybitExecutionOrderReference;
}>;

export class BybitIntentExecutionRuntime {
  constructor(
    private readonly registry: BybitIntentExecutionRuntimeRegistry,
    private readonly recordStore: ExecutionRecordStore,
    private readonly orderReferences: BybitExecutionOrderReferenceStore,
    private readonly options: BybitIntentExecutionRuntimeOptions = {},
  ) {}

  async execute(input: ExecutionIntent): Promise<BybitIntentExecutionRuntimeResult> {
    const intent = createExecutionIntent(input);
    if (intent.venue !== "bybit") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    return this.executeIntent(intent, "INCREASE");
  }

  close(input: ExecutionIntent) {
    const intent = createExecutionIntent(input);
    if (intent.venue !== "bybit") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    return this.executeIntent(intent, "DECREASE");
  }

  async query(authenticatedUserId: string, executionId: string): Promise<BybitIntentExecutionQueryRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    await this.loadRecord(userId, executionId);
    return this.registry.run(userId, async (runtimeService) => {
      const record = await this.loadRecord(userId, executionId);
      if (record.venue !== "bybit") throw new Error(`Unsupported execution venue: ${record.venue}.`);
      await this.assertAccount(record, runtimeService);
      const reference = await this.loadCompleteReference(record);
      const result = await this.service(runtimeService).query(reference);
      const executionRecord = applyExecutionQueryObservation(record, result.observation);
      await this.recordStore.update(executionRecord, record);
      return Object.freeze({
        executionRecord,
        observation: result.observation,
        orderReference: reference,
        fee: result.fee,
        feeCurrency: result.feeCurrency,
        statusReason: result.statusReason,
      });
    });
  }

  async reconcile(authenticatedUserId: string, executionId: string): Promise<BybitIntentExecutionReconciliationRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    await this.loadRecord(userId, executionId);
    return this.registry.run(userId, async (runtimeService) => {
      const record = await this.loadRecord(userId, executionId);
      if (record.venue !== "bybit") throw new Error(`Unsupported execution venue: ${record.venue}.`);
      await this.assertAccount(record, runtimeService);
      const service = this.service(runtimeService);
      const recovery = await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId);
      if (recovery) return this.reconcileRecovery(record, recovery, service);
      const reference = await this.loadCompleteReference(record);
      const result = await service.query(reference);
      const executionRecord = applyExecutionReconciliationObservation(record, result.observation);
      await this.recordStore.update(executionRecord, record);
      return Object.freeze({
        executionRecord,
        observation: result.observation,
        orderReference: reference,
        statusReason: result.statusReason,
        terminalShortCircuit: false,
      });
    });
  }

  async cancel(authenticatedUserId: string, executionId: string): Promise<BybitIntentExecutionCancelRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    await this.loadRecord(userId, executionId);
    return this.registry.run(userId, async (runtimeService) => {
      const record = await this.loadRecord(userId, executionId);
      if (record.venue !== "bybit") throw new Error(`Unsupported execution venue: ${record.venue}.`);
      if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
        throw new Error(`Execution record ${record.status} cannot be cancelled.`);
      }
      await this.assertAccount(record, runtimeService);
      const reference = await this.loadCancelReference(record);
      const service = this.service(runtimeService);
      const capability = this.options.createCancelCapability?.(service, reference)
        ?? new BybitIntentCancellationCapability(service, reference);
      const observation = await capability.cancel(record);
      const executionRecord = applyExecutionCancelObservation(record, observation);
      await this.recordStore.update(executionRecord, record);
      return Object.freeze({ executionRecord, observation, orderReference: reference });
    });
  }

  private async executeIntent(
    intent: ExecutionIntent,
    mutationEffect: ExecutionMutationEffect,
  ): Promise<BybitIntentExecutionRuntimeResult> {
    return this.registry.run(intent.userId, async (runtimeService) => {
      const account = await runtimeService.executionAccountIdentity();
      if (account.accountId !== intent.accountId) throw new Error("ExecutionIntent accountId does not match the Bybit execution account.");
      const initialRecord = createExecutionRecordFromIntent(this.options.createExecutionId?.(intent) ?? randomUUID(), intent);
      await this.recordStore.create(initialRecord);
      let coordinatedCapability: ExecutionCapability<BybitIntentExecutionResult>;
      try {
        const service = this.service(runtimeService, (reference) => this.orderReferences.createRecovery(
          createBybitExecutionOrderRecoveryReference({
            executionId: initialRecord.executionId,
            intentId: initialRecord.intentId,
            userId: initialRecord.userId,
            accountId: initialRecord.accountId,
            instrumentId: initialRecord.instrumentId,
            ...reference,
            createdAt: initialRecord.createdAt,
            updatedAt: initialRecord.updatedAt,
          }),
        ), mutationEffect);
        const capability = this.options.createCapability?.(service) ?? new BybitIntentExecutionCapability(service);
        const capabilities = new ExecutionCapabilityRegistry<BybitIntentExecutionResult>()
          .register(executionCapability("bybit", capability));
        coordinatedCapability = new RegistryBackedExecutionCapability(capabilities);
      } catch (error) {
        await this.failPreMutationRecordIfSafe(initialRecord);
        throw error;
      }
      const execution = await new ExecutionCoordinator(coordinatedCapability, this.options.clock).execute(intent);
      let executionRecord = initialRecord;
      let orderReference: BybitExecutionOrderReference | null = null;
      if (execution.step.result) {
        const accepted = attachExecutionAttempt(initialRecord, {
          executionAttemptId: execution.step.result.executionAttemptId,
          remoteOrderId: execution.step.result.providerOrderId,
          status: execution.executionState.status,
          observedAt: execution.executionState.updatedAt,
        });
        const complete = createBybitExecutionOrderReference({
          executionId: accepted.executionId,
          intentId: accepted.intentId,
          userId: accepted.userId,
          accountId: accepted.accountId,
          instrumentId: accepted.instrumentId,
          category: execution.step.result.category,
          symbol: execution.step.result.symbol,
          orderId: execution.step.result.providerOrderId,
          orderLinkId: execution.step.result.clientOrderId,
          expectedProviderQuantity: execution.step.result.expectedProviderQuantity,
          expectedSide: execution.step.result.expectedSide,
          ...(execution.step.result.marketUnit === undefined ? {} : { marketUnit: execution.step.result.marketUnit }),
          ...(execution.step.result.positionIdx === undefined ? {} : { positionIdx: execution.step.result.positionIdx }),
          ...(execution.step.result.positionMode === undefined ? {} : { positionMode: execution.step.result.positionMode }),
          ...(execution.step.result.positionDirection === undefined ? {} : { positionDirection: execution.step.result.positionDirection }),
          createdAt: accepted.createdAt,
          updatedAt: accepted.updatedAt,
        });
        try {
          await this.orderReferences.create(complete);
          executionRecord = accepted;
          orderReference = complete;
        } catch {
          executionRecord = attachExecutionAttempt(initialRecord, {
            executionAttemptId: execution.step.result.executionAttemptId,
            remoteOrderId: execution.step.result.providerOrderId,
            status: "UNKNOWN",
            observedAt: execution.executionState.updatedAt,
          });
        }
      } else {
        executionRecord = { ...initialRecord, status: execution.executionState.status, updatedAt: execution.executionState.updatedAt };
      }
      await this.recordStore.update(executionRecord, initialRecord);
      return Object.freeze({ executionRecord, execution, orderReference });
    });
  }

  private service(
    runtimeService: BybitIntentRuntimeService,
    persistRecoveryReference?: BybitIntentExecutionServiceOptions["persistRecoveryReference"],
    mutationEffect: ExecutionMutationEffect = "INCREASE",
  ) {
    return new BybitIntentExecutionService(runtimeService, {
      ...this.options,
      mutationEffect,
      validateProviderIdentity: (context) => runtimeService.validateExecutionProviderIdentity(context),
      ...(persistRecoveryReference === undefined ? {} : { persistRecoveryReference }),
    });
  }

  private async reconcileRecovery(
    record: ExecutionRecord,
    recovery: BybitExecutionOrderRecoveryReference,
    service: BybitIntentExecutionService,
  ): Promise<BybitIntentExecutionReconciliationRuntimeResult> {
    let result: BybitExecutionQueryResult;
    try { result = await service.query(recovery); } catch { return this.failedRecovery(record); }
    if (recovery.positionMode === "HEDGE" && result.observation.state === "UNKNOWN") {
      return this.failedRecovery(record);
    }
    let reference: BybitExecutionOrderReference;
    try {
      reference = createBybitExecutionOrderReference({
        ...recovery,
        orderId: result.orderIdentity.orderId,
        updatedAt: Math.max(recovery.updatedAt, result.observation.observedAt),
      });
      await this.orderReferences.create(reference);
    } catch { return this.failedRecovery(record); }
    const executionRecord = applyExecutionReconciliationObservation(record, result.observation);
    const withAttempt = executionRecord.remoteOrderId === undefined
      ? attachExecutionAttempt(executionRecord, {
        executionAttemptId: record.intentId,
        remoteOrderId: result.orderIdentity.orderId,
        status: executionRecord.status,
        observedAt: executionRecord.updatedAt,
      })
      : executionRecord;
    await this.recordStore.update(withAttempt, record);
    return Object.freeze({
      executionRecord: withAttempt,
      observation: result.observation,
      orderReference: reference,
      statusReason: result.statusReason,
      terminalShortCircuit: false,
    });
  }

  private async failedRecovery(record: ExecutionRecord): Promise<BybitIntentExecutionReconciliationRuntimeResult> {
    const observedAt = this.observedAt(record.updatedAt);
    const observation = createExecutionReconciliationObservation({ state: "UNKNOWN", filledBaseQuantity: "0", observedAt });
    const executionRecord = applyExecutionReconciliationObservation(record, observation);
    await this.recordStore.update(executionRecord, record);
    return Object.freeze({
      executionRecord,
      observation,
      orderReference: null,
      statusReason: "Bybit order reference recovery could not be confirmed.",
      terminalShortCircuit: false,
    });
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
      await this.recordStore.update({ ...current, status: "FAILED" }, current);
    } catch (error) {
      console.error("[bybit] pre-mutation ExecutionRecord cleanup failed", error instanceof Error ? error.message : "unknown error");
    }
  }

  private async loadRecord(userId: string, executionId: string) {
    const record = await this.recordStore.loadForUser(userId, identifier(executionId, "executionId"));
    if (!record) throw new Error("ExecutionRecord was not found for the authenticated user.");
    if (record.userId !== userId) throw new Error("ExecutionRecord userId does not match the authenticated user.");
    return record;
  }

  private async assertAccount(record: ExecutionRecord, service: BybitIntentRuntimeService) {
    const account = await service.executionAccountIdentity();
    if (account.accountId !== record.accountId) throw new Error("ExecutionRecord accountId does not match the Bybit execution account.");
  }

  private async loadCompleteReference(record: ExecutionRecord) {
    const reference = await this.orderReferences.loadForUser(record.userId, record.executionId);
    if (reference) return reference;
    if (await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId)) {
      throw new Error("Bybit execution order reference requires reconciliation before this operation.");
    }
    throw new Error("Bybit execution order reference is missing.");
  }

  private async loadCancelReference(record: ExecutionRecord) {
    const reference = await this.orderReferences.loadForUser(record.userId, record.executionId);
    if (reference) return reference;
    if (await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId)) {
      throw new Error("Bybit execution order reference requires reconciliation before cancellation.");
    }
    throw new Error("Bybit execution order reference is missing for cancellation.");
  }

  private observedAt(minimum: number) {
    const value = (this.options.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Bybit execution clock is invalid.");
    return Math.max(minimum, value);
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${name} is invalid.`);
  return value.trim();
}
