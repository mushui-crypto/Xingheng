import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  mapFormalCancelRuntimeResult,
  mapFormalExecutionRuntimeResult,
  mapFormalReconcileRuntimeResult,
  type FormalExecutionRuntime,
  type FormalManagedCloseExecutionContext,
  type FormalExecutionRuntimeResult,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { BybitIntentExecutionRuntime } from "./BybitIntentExecutionRuntime";

type Runtime = Pick<BybitIntentExecutionRuntime, "execute" | "reconcile" | "cancel">
  & Partial<Pick<BybitIntentExecutionRuntime, "close">>;

export class BybitFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    return mapFormalExecutionRuntimeResult(await this.runtime.execute(intent));
  }

  async executeManagedClose(
    intent: ExecutionIntent,
    context?: FormalManagedCloseExecutionContext,
  ): Promise<FormalExecutionRuntimeResult> {
    if (!this.runtime.close) throw new Error("Bybit managed-close runtime is unavailable.");
    return mapFormalExecutionRuntimeResult(await this.runtime.close(intent, context));
  }

  async reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult> {
    return mapFormalReconcileRuntimeResult(await this.runtime.reconcile(userId, executionId));
  }

  async cancel(userId: string, executionId: string) {
    return mapFormalCancelRuntimeResult(await this.runtime.cancel(userId, executionId));
  }
}
