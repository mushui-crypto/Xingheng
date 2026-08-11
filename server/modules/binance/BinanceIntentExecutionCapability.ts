import type { ExecutionCapability } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { BinanceIntentExecutionResult } from "./BinanceIntentExecutionService";

export type BoundBinanceIntentExecutionService<TResult = BinanceIntentExecutionResult> = Pick<
  {
    execute(intent: ExecutionIntent): Promise<TResult>;
  },
  "execute"
>;

export class BinanceIntentExecutionCapability<TResult = BinanceIntentExecutionResult>
implements ExecutionCapability<TResult> {
  constructor(private readonly service: BoundBinanceIntentExecutionService<TResult>) {}

  async execute(intent: ExecutionIntent): Promise<TResult> {
    if (intent.venue !== "binance") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }
    return this.service.execute(intent);
  }
}
