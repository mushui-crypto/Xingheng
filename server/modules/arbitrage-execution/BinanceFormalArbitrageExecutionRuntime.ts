import type { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type {
  FormalArbitrageExecutionRuntime,
  FormalArbitrageExecutionRuntimeResult,
} from "./ArbitrageExecutionCommandService";

type Runtime = Pick<BinanceIntentExecutionRuntime, "execute">;

/**
 * Production adapter for the existing Binance execution stack. A fully-filled
 * provider result confirms the requested base quantity. Pending/unknown results
 * stay unresolved and deliberately do not claim a partial quantity because the
 * current Binance runtime does not yet expose a Decimal filled-base quantity.
 */
export class BinanceFormalArbitrageExecutionRuntime implements FormalArbitrageExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalArbitrageExecutionRuntimeResult> {
    const result = await this.runtime.execute(intent);
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: result.executionRecord.status === "CONFIRMED"
        ? intent.quantity.quantity
        : "0",
    });
  }
}
