import { randomUUID } from "node:crypto";
import {
  applyExecutionCancelObservation,
  type ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import { ExecutionCoordinator, type CoordinatedExecutionResult } from "../cex/ExecutionCoordinator";
import { createExecutionIntent, type ExecutionIntent } from "../cex/ExecutionIntent";
import {
  applyExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import {
  applyExecutionReconciliationObservation,
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
  createOkxExecutionOrderReference,
  type OkxExecutionOrderReference,
  type OkxExecutionOrderReferenceStore,
} from "./OkxExecutionOrderReferenceStore";
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
  }>;

export type OkxIntentExecutionRuntimeRegistry = Readonly<{
  run<T>(
    userId: string,
    operation: (service: OkxIntentRuntimeService) => Promise<T> | T,
  ): Promise<T>;
}>;

export type OkxIntentExecutionRuntimeOptions = Readonly<
  OkxIntentExecutionServiceOptions & {
    createExecutionId?: () => string;
    createCapability?: (
      service: OkxIntentExecutionService,
    ) => OkxIntentExecutionCapability<OkxIntentExecutionResult>;
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
      const reference = await this.resolveReference(record, service);
      const observation = await service.cancel(reference, {
        userId: record.userId,
        accountId: record.accountId,
        instrumentId: record.instrumentId,
      });
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
      const intentService = this.intentService(runtimeService);
      const capability = this.options.createCapability?.(intentService)
        ?? new OkxIntentExecutionCapability(intentService);
      const capabilityRegistry = new ExecutionCapabilityRegistry<OkxIntentExecutionResult>()
        .register(executionCapability("okx", capability));
      const initialRecord = createExecutionRecordFromIntent(
        this.options.createExecutionId?.() ?? randomUUID(),
        intent,
      );
      await this.recordStore.create(initialRecord);

      const execution = await new ExecutionCoordinator(
        new RegistryBackedExecutionCapability(capabilityRegistry),
        this.options.clock,
      ).execute(intent);
      let executionRecord = initialRecord;
      let orderReference: OkxExecutionOrderReference | null = null;
      if (execution.step.result) {
        executionRecord = attachExecutionAttempt(initialRecord, {
          executionAttemptId: execution.step.result.executionAttemptId,
          remoteOrderId: execution.step.result.providerOrderId,
          status: execution.executionState.status,
          observedAt: execution.executionState.updatedAt,
        });
        orderReference = createOkxExecutionOrderReference({
          executionId: executionRecord.executionId,
          intentId: executionRecord.intentId,
          userId: executionRecord.userId,
          accountId: executionRecord.accountId,
          instrumentId: executionRecord.instrumentId,
          instId: execution.step.result.instId,
          ordId: execution.step.result.providerOrderId,
          clOrdId: execution.step.result.clientOrderId,
          createdAt: executionRecord.createdAt,
          updatedAt: executionRecord.updatedAt,
        });
        await this.orderReferences.create(orderReference);
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

  private intentService(client: OkxIntentExecutionClient) {
    return new OkxIntentExecutionService(client, this.options);
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
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
