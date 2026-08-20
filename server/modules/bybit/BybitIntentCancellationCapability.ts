import type { ExecutionCancelCapability, ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import type { BybitExecutionOrderReference } from "./BybitExecutionOrderReferenceStore";
import type { BybitExecutionOrderLookup } from "./BybitIntentExecutionService";

export type BoundBybitIntentCancellationService = Readonly<{
  cancel(
    lookup: BybitExecutionOrderLookup,
    context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & { providerInstrumentId?: string },
  ): Promise<ExecutionCancelObservation>;
}>;

export class BybitIntentCancellationCapability implements ExecutionCancelCapability {
  constructor(
    private readonly service: BoundBybitIntentCancellationService,
    private readonly reference: BybitExecutionOrderReference,
  ) {}

  cancel(record: ExecutionRecord) {
    if (record.venue !== "bybit") throw new Error(`Unsupported execution venue: ${record.venue}.`);
    assertIdentity(record, this.reference);
    return this.service.cancel(this.reference, {
      userId: record.userId,
      accountId: record.accountId,
      instrumentId: record.instrumentId,
      providerInstrumentId: this.reference.symbol,
    });
  }
}

function assertIdentity(record: ExecutionRecord, reference: BybitExecutionOrderReference) {
  if (reference.executionId !== record.executionId || reference.intentId !== record.intentId
    || reference.userId !== record.userId || reference.accountId !== record.accountId
    || reference.instrumentId !== record.instrumentId
    || (record.remoteOrderId !== undefined && reference.orderId !== record.remoteOrderId)) {
    throw new Error("Bybit cancellation order reference does not match the ExecutionRecord.");
  }
}
