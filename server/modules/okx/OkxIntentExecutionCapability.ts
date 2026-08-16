import type { ExecutionCapability } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { OkxIntentExecutionResult } from "./OkxIntentExecutionService";

export type BoundOkxIntentExecutionService<TResult = OkxIntentExecutionResult> = Pick<
  {
    execute(intent: ExecutionIntent): Promise<TResult>;
  },
  "execute"
>;

export class OkxIntentExecutionCapability<TResult = OkxIntentExecutionResult>
implements ExecutionCapability<TResult> {
  constructor(private readonly service: BoundOkxIntentExecutionService<TResult>) {}

  async execute(intent: ExecutionIntent): Promise<TResult> {
    if (intent.venue !== "okx") {
      throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    }
    return this.service.execute(intent);
  }
}
