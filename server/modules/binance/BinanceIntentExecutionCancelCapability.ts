import type {
  ExecutionCancelCapability,
  ExecutionCancelObservation,
} from "../cex/ExecutionCancelCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceIntentExecutionCancelService } from "./BinanceIntentExecutionCancelService";

export type BinanceExecutionCancelAccountBinding = Readonly<{
  userId: string;
  accountId: string;
}>;

export class BinanceIntentExecutionCancelCapability implements ExecutionCancelCapability {
  constructor(
    private readonly service: Pick<BinanceIntentExecutionCancelService, "cancel">,
    private readonly binding: BinanceExecutionCancelAccountBinding,
  ) {}

  async cancel(record: ExecutionRecord): Promise<ExecutionCancelObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    if (record.userId !== this.binding.userId) {
      throw new Error("ExecutionRecord userId does not match the Binance cancel binding.");
    }
    if (record.accountId !== this.binding.accountId) {
      throw new Error("ExecutionRecord accountId does not match the Binance cancel binding.");
    }
    if (record.status !== "PENDING_CONFIRMATION" && record.status !== "UNKNOWN") {
      throw new Error(`Execution record ${record.status} cannot be cancelled.`);
    }
    return this.service.cancel(record);
  }
}
