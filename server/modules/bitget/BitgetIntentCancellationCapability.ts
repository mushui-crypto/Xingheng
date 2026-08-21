import type { ExecutionCancelCapability, ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { ExecutionMutationContext } from "../cex/ExecutionMutationSafetyGuard";
import type { BitgetExecutionOrderReference } from "./BitgetExecutionOrderReferenceStore";
import type { BitgetExecutionOrderLookup } from "./BitgetIntentExecutionService";

export type BoundBitgetIntentCancellationService = Readonly<{
  cancel(lookup: BitgetExecutionOrderLookup, context: Omit<ExecutionMutationContext, "operation" | "providerInstrumentId" | "venue"> & { providerInstrumentId?: string }): Promise<ExecutionCancelObservation>;
}>;
type CancellationReference = Omit<BitgetExecutionOrderReference, "createdAt" | "updatedAt">;

export class BitgetIntentCancellationCapability implements ExecutionCancelCapability {
  constructor(private readonly service: BoundBitgetIntentCancellationService, private readonly reference: CancellationReference) {}
  cancel(record: ExecutionRecord) {
    if (record.venue !== "bitget") throw new Error(`Unsupported execution venue: ${record.venue}.`);
    if (this.reference.executionId !== record.executionId || this.reference.intentId !== record.intentId
      || this.reference.userId !== record.userId || this.reference.accountId !== record.accountId
      || this.reference.instrumentId !== record.instrumentId
      || (record.remoteOrderId !== undefined && this.reference.orderId !== record.remoteOrderId)) {
      throw new Error("Bitget cancellation order reference does not match the ExecutionRecord.");
    }
    return this.service.cancel(this.reference, {
      userId: record.userId, accountId: record.accountId, instrumentId: record.instrumentId,
      providerInstrumentId: this.reference.symbol,
    });
  }
}
