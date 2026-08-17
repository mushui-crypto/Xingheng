import type { ExecutionCapability } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { OkxIntentExecutionResult } from "./OkxIntentExecutionService";
import type { OkxSpotIntentExecutionService } from "./OkxSpotIntentExecutionService";

/** Capability boundary for canonical Spot intents; provider details remain in OKX services. */
export class OkxSpotExecutionCapability implements ExecutionCapability<OkxIntentExecutionResult> {
  constructor(private readonly service: Pick<OkxSpotIntentExecutionService, "execute">) {}

  async execute(intent: ExecutionIntent) {
    if (intent.venue !== "okx") throw new Error(`Unsupported execution venue: ${intent.venue}.`);
    return this.service.execute(intent);
  }
}
