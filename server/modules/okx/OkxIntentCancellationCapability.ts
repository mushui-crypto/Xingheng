import type {
  ExecutionCancelCapability,
  ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { OkxExecutionOrderReference } from "./OkxExecutionOrderReferenceStore";
import type { OkxIntentExecutionService } from "./OkxIntentExecutionService";

export type BoundOkxIntentCancellationService = Pick<OkxIntentExecutionService, "cancel">;

/** Keeps OKX order identity and cancellation transport behind the capability boundary. */
export class OkxIntentCancellationCapability implements ExecutionCancelCapability {
  constructor(
    private readonly service: BoundOkxIntentCancellationService,
    private readonly reference: OkxExecutionOrderReference,
  ) {}

  async cancel(record: ExecutionRecord): Promise<ExecutionCancelObservation> {
    if (record.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    assertReferenceIdentity(record, this.reference);
    return this.service.cancel(this.reference, {
      userId: record.userId,
      accountId: record.accountId,
      instrumentId: record.instrumentId,
      providerInstrumentId: this.reference.instId,
    });
  }
}

function assertReferenceIdentity(
  record: ExecutionRecord,
  reference: OkxExecutionOrderReference,
) {
  if (
    reference.executionId !== record.executionId
    || reference.intentId !== record.intentId
    || reference.userId !== record.userId
    || reference.accountId !== record.accountId
    || reference.instrumentId !== record.instrumentId
    || (record.remoteOrderId !== undefined && reference.ordId !== record.remoteOrderId)
  ) {
    throw new Error("OKX cancellation order reference does not match the ExecutionRecord.");
  }
}
