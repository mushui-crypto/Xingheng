import type {
  ExecutionReconciliationCapability,
  ExecutionReconciliationObservation,
} from "../cex/ExecutionReconciliationCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceIntentExecutionReconciliationService } from "./BinanceIntentExecutionReconciliationService";

export type BinanceExecutionReconciliationAccountBinding = Readonly<{
  userId: string;
  accountId: string;
}>;

export class BinanceIntentExecutionReconciliationCapability implements ExecutionReconciliationCapability {
  constructor(
    private readonly service: Pick<BinanceIntentExecutionReconciliationService, "reconcile">,
    private readonly binding: BinanceExecutionReconciliationAccountBinding,
  ) {}

  async reconcile(record: ExecutionRecord): Promise<ExecutionReconciliationObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    if (record.userId !== this.binding.userId) {
      throw new Error("ExecutionRecord userId does not match the Binance reconciliation binding.");
    }
    if (record.accountId !== this.binding.accountId) {
      throw new Error("ExecutionRecord accountId does not match the Binance reconciliation binding.");
    }
    return this.service.reconcile(record);
  }
}
