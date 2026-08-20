import type { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  diagnosticFromExecution,
  type FormalExecutionRuntime,
  type FormalExecutionRuntimeResult,
} from "./FormalExecutionRuntime";

type Runtime = Pick<BinanceIntentExecutionRuntime, "execute" | "reconcile" | "cancel">;

/** Production adapter preserving Binance's authoritative Decimal executedQty. */
export class BinanceFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    const result = await this.runtime.execute(intent);
    const diagnostic = diagnosticFromExecution(result.execution);
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: result.execution.step.result?.confirmedQuantity ?? null,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  }

  async reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult> {
    const result = await this.runtime.reconcile(userId, executionId);
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: result.observation?.state === "UNKNOWN"
        ? null
        : result.observation?.filledBaseQuantity ?? null,
    });
  }

  async cancel(userId: string, executionId: string) {
    const result = await this.runtime.cancel(userId, executionId);
    return Object.freeze({
      executionRecord: result.executionRecord,
      observation: result.observation,
    });
  }
}
