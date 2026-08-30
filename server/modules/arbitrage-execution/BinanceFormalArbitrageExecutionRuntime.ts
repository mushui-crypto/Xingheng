import type { BinanceIntentExecutionRuntime } from "../binance/BinanceIntentExecutionRuntime";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  mapFormalCancelRuntimeResult,
  mapFormalExecutionRuntimeResult,
  mapFormalReconcileRuntimeResult,
  type FormalExecutionRuntime,
  type FormalManagedCloseExecutionContext,
  type FormalExecutionRuntimeResult,
} from "./FormalExecutionRuntime";

type Runtime = Pick<BinanceIntentExecutionRuntime, "execute" | "reconcile" | "cancel">
  & Partial<Pick<BinanceIntentExecutionRuntime, "close">>;

/** Production adapter preserving Binance's authoritative Decimal executedQty. */
export class BinanceFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    return mapFormalExecutionRuntimeResult(await this.runtime.execute(intent));
  }

  async executeManagedClose(
    intent: ExecutionIntent,
    context?: FormalManagedCloseExecutionContext,
  ): Promise<FormalExecutionRuntimeResult> {
    if (!this.runtime.close) throw new Error("Binance managed-close runtime is unavailable.");
    return mapFormalExecutionRuntimeResult(await this.runtime.close(intent, context));
  }

  async reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult> {
    return mapFormalReconcileRuntimeResult(await this.runtime.reconcile(userId, executionId));
  }

  async cancel(userId: string, executionId: string) {
    return mapFormalCancelRuntimeResult(await this.runtime.cancel(userId, executionId));
  }
}
