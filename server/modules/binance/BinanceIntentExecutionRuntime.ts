import { randomUUID } from "node:crypto";
import type { ExecutionCapability } from "../cex/ExecutionCapability";
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
  syncExecutionRecordState,
  type ExecutionRecord,
} from "../cex/ExecutionRecord";
import type { ExecutionRecordStore } from "../cex/ExecutionRecordStore";
import { BinanceIntentExecutionCapability } from "./BinanceIntentExecutionCapability";
import { BinanceIntentExecutionCancelCapability } from "./BinanceIntentExecutionCancelCapability";
import { BinanceIntentExecutionCancelService } from "./BinanceIntentExecutionCancelService";
import { BinanceIntentExecutionQueryCapability } from "./BinanceIntentExecutionQueryCapability";
import { BinanceIntentExecutionQueryService } from "./BinanceIntentExecutionQueryService";
import { BinanceIntentExecutionReconciliationCapability } from "./BinanceIntentExecutionReconciliationCapability";
import { BinanceIntentExecutionReconciliationService } from "./BinanceIntentExecutionReconciliationService";
import {
  BinanceIntentExecutionService,
  binanceExecutionIdempotencyKeyFor,
  type BinanceIntentExecutionResult,
  type BinanceIntentExecutionServiceBinding,
} from "./BinanceIntentExecutionService";
import type { BinancePersonalTradingService } from "./BinancePersonalTradingService";
import type { BinanceTradingConfig } from "./BinanceTradingConfig";
import { BinanceStoredOrderManualReconciliationError } from "./BinanceOrderStore";

type BinanceIntentRuntimeService =
  BinanceIntentExecutionServiceBinding
  & Pick<
    BinancePersonalTradingService,
    "account" | "executionAccountIdentity" | "executionOrderState" | "findExecutionOrderByClientOrderId" | "cancelOrder"
  >;

export type BinanceIntentExecutionRuntimeRegistry = Readonly<{
  run<T>(
    userId: string,
    operation: (service: BinanceIntentRuntimeService) => Promise<T> | T,
  ): Promise<T>;
}>;

export type BinanceIntentExecutionRuntimeOptions = Readonly<{
  clock?: () => number;
  createExecutionId?: () => string;
  assertSubmitAllowed?: ConstructorParameters<typeof BinanceIntentExecutionService>[2];
  createCapability?: (
    service: BinanceIntentExecutionService,
  ) => ExecutionCapability<BinanceIntentExecutionResult>;
}>;

export type BinanceIntentExecutionRecordStore = ExecutionRecordStore;

export type BinanceIntentExecutionRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  execution: CoordinatedExecutionResult<BinanceIntentExecutionResult>;
}>;

export type BinanceIntentExecutionQueryRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionQueryObservation;
}>;

export type BinanceIntentExecutionReconciliationRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionReconciliationObservation | null;
  terminalShortCircuit: boolean;
}>;

export type BinanceIntentExecutionCancelRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionCancelObservation;
}>;

export class BinanceIntentExecutionRuntime {
  constructor(
    private readonly registry: BinanceIntentExecutionRuntimeRegistry,
    private readonly config: Pick<BinanceTradingConfig, "maxSlippageBps">,
    private readonly recordStore: BinanceIntentExecutionRecordStore,
    private readonly options: BinanceIntentExecutionRuntimeOptions = {},
  ) {}

  async execute(
    input: ExecutionIntent,
  ): Promise<BinanceIntentExecutionRuntimeResult> {
    const intent = createExecutionIntent(input);
    if (intent.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }

    return this.registry.run(intent.userId, async (service) => {
      const account = await service.executionAccountIdentity();
      if (account.accountId !== intent.accountId) {
        throw new Error("ExecutionIntent accountId does not match the Binance execution account.");
      }

      const intentService = new BinanceIntentExecutionService(
        service,
        this.config,
        this.options.assertSubmitAllowed,
      );
      const capability = this.options.createCapability?.(intentService)
        ?? new BinanceIntentExecutionCapability(intentService);
      const initialRecord = createExecutionRecordFromIntent(
        this.options.createExecutionId?.() ?? randomUUID(),
        intent,
      );
      await this.recordStore.create(initialRecord);

      const execution = await new ExecutionCoordinator(capability, this.options.clock).execute(intent);
      let executionRecord = syncExecutionRecordState(initialRecord, execution.executionState);
      if (execution.step.result) {
        executionRecord = attachExecutionAttempt(executionRecord, {
          executionAttemptId: execution.step.result.executionAttemptId,
          ...(execution.step.result.providerOrderId === undefined
            ? {}
            : { remoteOrderId: execution.step.result.providerOrderId }),
          status: execution.executionState.status,
          observedAt: execution.executionState.updatedAt,
        });
      }
      await this.recordStore.update(executionRecord);

      return Object.freeze({ executionRecord, execution });
    });
  }

  async query(
    authenticatedUserId: string,
    executionId: string,
  ): Promise<BinanceIntentExecutionQueryRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.recordStore.loadForUser(userId, identifier(executionId, "executionId"));
    if (!record) throw new Error("ExecutionRecord was not found for the authenticated user.");
    if (record.userId !== userId) {
      throw new Error("ExecutionRecord userId does not match the authenticated user.");
    }
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }

    return this.registry.run(userId, async (service) => {
      const localState = service.executionOrderState(binanceExecutionIdempotencyKeyFor(record));
      if (localState.kind === "isolated") {
        throw new BinanceStoredOrderManualReconciliationError(localState.isolation);
      }
      const account = await service.account();
      if (account.accountId !== record.accountId) {
        throw new Error("ExecutionRecord accountId does not match the Binance execution account.");
      }
      const queryService = new BinanceIntentExecutionQueryService(service, this.options.clock);
      const capability = new BinanceIntentExecutionQueryCapability({
        query: (target) => queryService.query(target, localState),
      }, {
        userId,
        accountId: account.accountId,
      });
      const observation = await capability.query(record);
      const executionRecord = applyExecutionQueryObservation(record, observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation });
    });
  }

  async reconcile(
    authenticatedUserId: string,
    executionId: string,
  ): Promise<BinanceIntentExecutionReconciliationRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.recordStore.loadForUser(userId, identifier(executionId, "executionId"));
    if (!record) throw new Error("ExecutionRecord was not found for the authenticated user.");
    if (record.userId !== userId) {
      throw new Error("ExecutionRecord userId does not match the authenticated user.");
    }
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    return this.registry.run(userId, async (service) => {
      const localState = service.executionOrderState(binanceExecutionIdempotencyKeyFor(record));
      if (localState.kind === "isolated") {
        throw new BinanceStoredOrderManualReconciliationError(localState.isolation);
      }
      const account = await service.account();
      if (account.accountId !== record.accountId) {
        throw new Error("ExecutionRecord accountId does not match the Binance execution account.");
      }
      const reconciliationService = new BinanceIntentExecutionReconciliationService(
        service,
        this.options.clock,
      );
      const capability = new BinanceIntentExecutionReconciliationCapability({
        reconcile: (target) => reconciliationService.reconcile(target, localState),
      }, {
        userId,
        accountId: account.accountId,
      });
      const observation = await capability.reconcile(record);
      const executionRecord = applyExecutionReconciliationObservation(record, observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation, terminalShortCircuit: false });
    });
  }

  async cancel(
    authenticatedUserId: string,
    executionId: string,
  ): Promise<BinanceIntentExecutionCancelRuntimeResult> {
    const userId = identifier(authenticatedUserId, "authenticated userId");
    const record = await this.recordStore.loadForUser(userId, identifier(executionId, "executionId"));
    if (!record) throw new Error("ExecutionRecord was not found for the authenticated user.");
    if (record.userId !== userId) {
      throw new Error("ExecutionRecord userId does not match the authenticated user.");
    }
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
      throw new Error(`Execution record ${record.status} cannot be cancelled.`);
    }

    return this.registry.run(userId, async (service) => {
      const localState = service.executionOrderState(binanceExecutionIdempotencyKeyFor(record));
      if (localState.kind === "isolated") {
        throw new BinanceStoredOrderManualReconciliationError(localState.isolation);
      }
      const account = await service.account();
      if (account.accountId !== record.accountId) {
        throw new Error("ExecutionRecord accountId does not match the Binance execution account.");
      }
      const cancelService = new BinanceIntentExecutionCancelService(service, this.options.clock);
      const capability = new BinanceIntentExecutionCancelCapability(cancelService, {
        userId,
        accountId: account.accountId,
      });
      const observation = await capability.cancel(record);
      const executionRecord = applyExecutionCancelObservation(record, observation);
      await this.recordStore.update(executionRecord);
      return Object.freeze({ executionRecord, observation });
    });
  }
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}
