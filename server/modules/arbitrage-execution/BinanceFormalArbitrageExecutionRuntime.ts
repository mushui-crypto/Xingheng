import type { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type {
  FormalArbitrageExecutionRuntime,
  FormalArbitrageExecutionRuntimeResult,
} from "./ArbitrageExecutionCommandService";

type Runtime = Pick<BinanceIntentExecutionRuntime, "execute">;

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
}
