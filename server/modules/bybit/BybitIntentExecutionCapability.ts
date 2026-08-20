import type { ExecutionCapability } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { BybitIntentExecutionResult } from "./BybitIntentExecutionService";

export class BybitIntentExecutionCapability<TResult = BybitIntentExecutionResult>
implements ExecutionCapability<TResult> {
  constructor(private readonly service: Readonly<{ execute(intent: ExecutionIntent): Promise<TResult> }>) {}

  execute(intent: ExecutionIntent) {
    if (intent.venue !== "bybit") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    return this.service.execute(intent);
  }
}
