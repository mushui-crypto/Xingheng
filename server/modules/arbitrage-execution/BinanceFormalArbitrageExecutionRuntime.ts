import type { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type {
  FormalArbitrageExecutionRuntime,
  FormalArbitrageExecutionRuntimeResult,
} from "./ArbitrageExecutionCommandService";

type Runtime = Pick<BinanceIntentExecutionRuntime, "execute" | "reconcile">;

/** Production adapter preserving Binance's authoritative Decimal executedQty. */
export class BinanceFormalArbitrageExecutionRuntime implements FormalArbitrageExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalArbitrageExecutionRuntimeResult> {
    const result = await this.runtime.execute(intent);
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: result.execution.step.result?.confirmedQuantity ?? null,
    });
  }

  async reconcile(userId: string, executionId: string): Promise<FormalArbitrageExecutionRuntimeResult> {
    const result = await this.runtime.reconcile(userId, executionId);
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: result.observation?.state === "UNKNOWN"
        ? null
        : result.observation?.filledBaseQuantity ?? null,
    });
  }
}
