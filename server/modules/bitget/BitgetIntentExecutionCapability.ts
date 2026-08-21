import type { ExecutionCapability } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { BitgetIntentExecutionResult } from "./BitgetIntentExecutionService";

export class BitgetIntentExecutionCapability<TResult = BitgetIntentExecutionResult> implements ExecutionCapability<TResult> {
  constructor(private readonly service: Readonly<{ execute(intent: ExecutionIntent): Promise<TResult> }>) {}
  execute(intent: ExecutionIntent) {
    if (intent.venue !== "bitget") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    return this.service.execute(intent);
  }
}
