import { randomUUID } from "node:crypto";
import {
  applyExecutionCancelObservation,
  type ExecutionCancelCapability,
  type ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import { ExecutionCoordinator, type CoordinatedExecutionResult } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import {
  applyExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import {
  applyExecutionReconciliationObservation,
  createExecutionReconciliationObservation,
  type ExecutionReconciliationObservation,
} from "../cex/ExecutionReconciliationCapability";
import {
  attachExecutionAttempt,
  createExecutionRecordFromIntent,
  type ExecutionRecord,
} from "../cex/ExecutionRecord";
import { ExecutionCapabilityRegistry, executionCapability } from "../cex/ExecutionCapabilityRegistry";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { RegistryBackedExecutionCapability } from "../cex/RegistryBackedExecutionCapability";
import {
  createOkxExecutionOrderRecoveryReference,
  createOkxExecutionOrderReference,
  type OkxExecutionOrderReference,
  type OkxExecutionOrderRecoveryReference,
  type OkxExecutionOrderReferenceStore,
} from "./OkxExecutionOrderReferenceStore";
import { OkxIntentCancellationCapability } from "./OkxIntentCancellationCapability";
import { OkxIntentExecutionCapability } from "./OkxIntentExecutionCapability";
import {
  OkxIntentExecutionService,
  type OkxExecutionQueryResult,
  type OkxIntentExecutionClient,
  type OkxIntentExecutionResult,
  type OkxIntentExecutionServiceOptions,
} from "./OkxIntentExecutionService";

export type OkxIntentRuntimeService =
  OkxIntentExecutionClient
  & Readonly<{
    executionAccountIdentity(): Promise<{ accountId: string }> | { accountId: string };
    validateExecutionProviderIdentity(context: ExecutionMutationContext): Promise<void> | void;
  }>;

export type OkxIntentExecutionRuntimeRegistry = Readonly<{
  run<T>(
    userId: string,
    operation: (service: OkxIntentRuntimeService) => Promise<T> | T,
  ): Promise<T>;
}>;

export type OkxIntentExecutionRuntimeOptions = Readonly<
  Omit<
    OkxIntentExecutionServiceOptions,
    "validateProviderIdentity" | "persistRecoveryReference"
  > & {
    createExecutionId?: () => string;
    createCapability?: (
      service: OkxIntentExecutionService,
    ) => OkxIntentExecutionCapability<OkxIntentExecutionResult>;
    createCancelCapability?: (
      service: OkxIntentExecutionService,
      reference: OkxExecutionOrderReference,
    ) => ExecutionCancelCapability;
  }
>;

export type OkxIntentExecutionRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  execution: CoordinatedExecutionResult<OkxIntentExecutionResult>;
  orderReference: OkxExecutionOrderReference | null;
}>;

export type OkxIntentExecutionQueryRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionQueryObservation;
  orderReference: OkxExecutionOrderReference;
  fee: string;
  statusReason: string | null;
}>;

export type OkxIntentExecutionReconciliationRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionReconciliationObservation | null;
  orderReference: OkxExecutionOrderReference | null;
  statusReason: string | null;
  terminalShortCircuit: boolean;
}>;

export type OkxIntentExecutionCancelRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionCancelObservation;
  orderReference: OkxExecutionOrderReference;
}>;

export class OkxIntentExecutionRuntime {
  constructor(
    private readonly registry: OkxIntentExecutionRuntimeRegistry,
    private readonly recordStore: ExecutionRecordStore,
    private readonly orderReferences: OkxExecutionOrderReferenceStore,
    private readonly options: OkxIntentExecutionRuntimeOptions = {},
  ) {}

  async execute(input: ExecutionIntent): Promise<OkxIntentExecutionRuntimeResult> {
    const intent = createExecutionIntent(input);
    if (intent.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }
    return this.executeIntent(intent);
  }

  async close(input: ExecutionIntent): Promise<OkxIntentExecutionRuntimeResult> {
    const intent = createExecutionIntent(input);
    if (!intent.orderConstraints.reduceOnly) {
      throw new Error("OKX perpetual close requires reduceOnly=true.");
    }
    return this.execute(intent);
  }

  async query(
    authenticatedUserId: string,
    executionId: string,
  ): Promise<OkxIntentExecutionQueryRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.loadRecord(userId, executionId);
    if (record.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    return this.registry.run(userId, async (runtimeService) => {
      await this.assertAccount(record, runtimeService);
      const service = this.intentService(runtimeService);
      const reference = await this.resolveReference(record, service);
      const result = await service.query(reference);
      const executionRecord = applyExecutionQueryObservation(record, result.observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({
        executionRecord,
        observation: result.observation,
        orderReference: reference,
        fee: result.fee,
        statusReason: result.statusReason,
      });
    });
  }

  async reconcile(
    authenticatedUserId: string,
    executionId: string,
  ): Promise<OkxIntentExecutionReconciliationRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.loadRecord(userId, executionId);
    if (record.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    if (record.status === "CONFIRMED") {
      return Object.freeze({
        executionRecord: record,
        observation: null,
        orderReference: null,
        statusReason: null,
        terminalShortCircuit: true,
      });
    }
    return this.registry.run(userId, async (runtimeService) => {
      await this.assertAccount(record, runtimeService);
      const service = this.intentService(runtimeService);
      const recovery = await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId);
      if (recovery) return this.reconcileRecovery(record, recovery, service);
      const reference = await this.resolveReference(record, service);
      const result: OkxExecutionQueryResult = await service.query(reference);
      const executionRecord = applyExecutionReconciliationObservation(record, result.observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({
        executionRecord,
        observation: result.observation,
        orderReference: reference,
        statusReason: result.statusReason,
        terminalShortCircuit: false,
      });
    });
  }

  async cancel(
    authenticatedUserId: string,
    executionId: string,
  ): Promise<OkxIntentExecutionCancelRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.loadRecord(userId, executionId);
    if (record.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
      throw new Error(`Execution record ${record.status} cannot be cancelled.`);
    }
    return this.registry.run(userId, async (runtimeService) => {
      await this.assertAccount(record, runtimeService);
      const service = this.intentService(runtimeService);
      const reference = await this.loadCancelReference(record);
      const capability = this.options.createCancelCapability?.(service, reference)
        ?? new OkxIntentCancellationCapability(service, reference);
      const observation = await capability.cancel(record);
      const executionRecord = applyExecutionCancelObservation(record, observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation, orderReference: reference });
    });
  }

  private async executeIntent(intent: ExecutionIntent): Promise<OkxIntentExecutionRuntimeResult> {
    return this.registry.run(intent.userId, async (runtimeService) => {
      const account = await runtimeService.executionAccountIdentity();
      if (account.accountId !== intent.accountId) {
        throw new Error("ExecutionIntent accountId does not match the OKX execution account.");
      }
      const initialRecord = createExecutionRecordFromIntent(
        this.options.createExecutionId?.() ?? randomUUID(),
        intent,
      );
      await this.recordStore.create(initialRecord);
      const intentService = this.intentService(runtimeService, (reference) =>
        this.orderReferences.createRecovery(createOkxExecutionOrderRecoveryReference({
          executionId: initialRecord.executionId,
          intentId: initialRecord.intentId,
          userId: initialRecord.userId,
          accountId: initialRecord.accountId,
          instrumentId: initialRecord.instrumentId,
          instId: reference.instId,
          clOrdId: reference.clOrdId,
          createdAt: initialRecord.createdAt,
          updatedAt: initialRecord.updatedAt,
        })));
      const capability = this.options.createCapability?.(intentService)
        ?? new OkxIntentExecutionCapability(intentService);
      const capabilityRegistry = new ExecutionCapabilityRegistry<OkxIntentExecutionResult>()
        .register(executionCapability("okx", capability));

      const execution = await new ExecutionCoordinator(
        new RegistryBackedExecutionCapability(capabilityRegistry),
        this.options.clock,
      ).execute(intent);
      let executionRecord = initialRecord;
      let orderReference: OkxExecutionOrderReference | null = null;
      if (execution.step.result) {
        const acceptedRecord = attachExecutionAttempt(initialRecord, {
          executionAttemptId: execution.step.result.executionAttemptId,
          remoteOrderId: execution.step.result.providerOrderId,
          status: execution.executionState.status,
          observedAt: execution.executionState.updatedAt,
        });
        const completedReference = createOkxExecutionOrderReference({
          executionId: acceptedRecord.executionId,
          intentId: acceptedRecord.intentId,
          userId: acceptedRecord.userId,
          accountId: acceptedRecord.accountId,
          instrumentId: acceptedRecord.instrumentId,
          instId: execution.step.result.instId,
          ordId: execution.step.result.providerOrderId,
          clOrdId: execution.step.result.clientOrderId,
          createdAt: acceptedRecord.createdAt,
          updatedAt: acceptedRecord.updatedAt,
        });
        try {
          await this.orderReferences.create(completedReference);
          executionRecord = acceptedRecord;
          orderReference = completedReference;
        } catch {
          executionRecord = attachExecutionAttempt(initialRecord, {
            executionAttemptId: execution.step.result.executionAttemptId,
            remoteOrderId: execution.step.result.providerOrderId,
            status: "UNKNOWN",
            observedAt: execution.executionState.updatedAt,
          });
        }
      } else {
        executionRecord = {
          ...initialRecord,
          status: execution.executionState.status,
          updatedAt: execution.executionState.updatedAt,
        };
      }
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, execution, orderReference });
    });
  }

  private intentService(
    client: OkxIntentExecutionClient,
    persistRecoveryReference?: (
      reference: Readonly<{ instId: string; clOrdId: string }>,
    ) => Promise<void> | void,
  ) {
    const runtimeService = client as OkxIntentRuntimeService;
    return new OkxIntentExecutionService(client, {
      ...this.options,
      validateProviderIdentity: (context) =>
        runtimeService.validateExecutionProviderIdentity(context),
      ...(persistRecoveryReference === undefined ? {} : { persistRecoveryReference }),
    });
  }

  private async loadRecord(userId: string, executionId: string) {
    const record = await this.recordStore.loadForUser(userId, identifier(executionId, "executionId"));
    if (!record) throw new Error("ExecutionRecord was not found for the authenticated user.");
    if (record.userId !== userId) {
      throw new Error("ExecutionRecord userId does not match the authenticated user.");
    }
    return record;
  }

  private async assertAccount(record: ExecutionRecord, service: OkxIntentRuntimeService) {
    const account = await service.executionAccountIdentity();
    if (account.accountId !== record.accountId) {
      throw new Error("ExecutionRecord accountId does not match the OKX execution account.");
    }
  }

  private async resolveReference(record: ExecutionRecord, service: OkxIntentExecutionService) {
    const stored = await this.orderReferences.loadForUser(record.userId, record.executionId);
    if (stored) return stored;
    const recovery = await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId);
    if (recovery) {
      throw new Error("OKX execution order reference requires reconciliation before this operation.");
    }
    const lookup = service.resolveLookup(record);
    if (!lookup.ordId) {
      throw new Error("OKX execution order identity is missing ordId.");
    }
    return createOkxExecutionOrderReference({
      executionId: record.executionId,
      intentId: record.intentId,
      userId: record.userId,
      accountId: record.accountId,
      instrumentId: record.instrumentId,
      instId: lookup.instId,
      ordId: lookup.ordId,
      clOrdId: lookup.clOrdId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private async loadCancelReference(record: ExecutionRecord) {
    const reference = await this.orderReferences.loadForUser(record.userId, record.executionId);
    if (reference) return reference;
    const recovery = await this.orderReferences.loadRecoveryForUser(record.userId, record.executionId);
    if (recovery) {
      throw new Error("OKX execution order reference requires reconciliation before cancellation.");
    }
    throw new Error("OKX execution order reference is missing for cancellation.");
  }

  private async reconcileRecovery(
    record: ExecutionRecord,
    recovery: OkxExecutionOrderRecoveryReference,
    service: OkxIntentExecutionService,
  ): Promise<OkxIntentExecutionReconciliationRuntimeResult> {
    let result: OkxExecutionQueryResult;
    try {
      result = await service.query({
        instrumentId: recovery.instrumentId,
        instId: recovery.instId,
        clOrdId: recovery.clOrdId,
      });
    } catch {
      return this.failedRecovery(record);
    }

    let reference: OkxExecutionOrderReference;
    try {
      reference = createOkxExecutionOrderReference({
        executionId: recovery.executionId,
        intentId: recovery.intentId,
        userId: recovery.userId,
        accountId: recovery.accountId,
        instrumentId: recovery.instrumentId,
        instId: result.orderIdentity.instId,
        ordId: result.orderIdentity.ordId,
        clOrdId: result.orderIdentity.clOrdId,
        createdAt: recovery.createdAt,
        updatedAt: Math.max(recovery.updatedAt, result.observation.observedAt),
      });
      await this.orderReferences.create(reference);
    } catch {
      return this.failedRecovery(record);
    }

    const executionRecord = applyExecutionReconciliationObservation(record, result.observation);
    await this.recordStore.update(executionRecord);
    return Object.freeze({
      executionRecord,
      observation: result.observation,
      orderReference: reference,
      statusReason: result.statusReason,
      terminalShortCircuit: false,
    });
  }

  private async failedRecovery(
    record: ExecutionRecord,
  ): Promise<OkxIntentExecutionReconciliationRuntimeResult> {
    const observedAt = this.observedAt(record.updatedAt);
    const observation = createExecutionReconciliationObservation({
      state: "UNKNOWN",
      filledBaseQuantity: "0",
      observedAt,
    });
    const executionRecord = applyExecutionReconciliationObservation(record, observation);
    await this.recordStore.update(executionRecord);
    return Object.freeze({
      executionRecord,
      observation,
      orderReference: null,
      statusReason: "OKX order reference recovery could not be confirmed.",
      terminalShortCircuit: false,
    });
  }

  private observedAt(minimum: number) {
    const value = (this.options.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("OKX execution clock must return a non-negative integer timestamp.");
    }
    return Math.max(minimum, value);
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
