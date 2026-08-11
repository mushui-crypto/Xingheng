import type {
  ExecutionQueryCapability,
  ExecutionQueryObservation,
} from "../cex/ExecutionQueryCapability";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { BinanceIntentExecutionQueryService } from "./BinanceIntentExecutionQueryService";

export type BinanceExecutionQueryAccountBinding = Readonly<{
  userId: string;
  accountId: string;
}>;

export class BinanceIntentExecutionQueryCapability implements ExecutionQueryCapability {
  constructor(
    private readonly service: Pick<BinanceIntentExecutionQueryService, "query">,
    private readonly binding: BinanceExecutionQueryAccountBinding,
  ) {}

  async query(record: ExecutionRecord): Promise<ExecutionQueryObservation> {
    if (record.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${record.venue}.`);
    }
    if (record.userId !== this.binding.userId) {
      throw new Error("ExecutionRecord userId does not match the Binance query binding.");
    }
    if (record.accountId !== this.binding.accountId) {
      throw new Error("ExecutionRecord accountId does not match the Binance query binding.");
    }
    return this.service.query(record);
  }
}
