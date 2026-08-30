import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  mapFormalCancelRuntimeResult,
  mapFormalExecutionRuntimeResult,
  mapFormalReconcileRuntimeResult,
  type FormalExecutionRuntime,
  type FormalManagedCloseExecutionContext,
  type FormalExecutionRuntimeResult,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";

type Runtime = Pick<OkxIntentExecutionRuntime, "execute" | "reconcile" | "cancel">
  & Partial<Pick<OkxIntentExecutionRuntime, "close" | "supportsOpeningExecutionMode">>;

/** Maps the OKX runtime to the venue-neutral formal execution contract. */
export class OkxFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  openingExecutionCapability(input: Readonly<{
    executionMode: ExecutionIntent["executionMode"];
    marketType: "spot" | "perpetual";
  }>) {
    const supported = "supportsOpeningExecutionMode" in this.runtime
      && typeof this.runtime.supportsOpeningExecutionMode === "function"
      && this.runtime.supportsOpeningExecutionMode(input);
    return Object.freeze({
      supported,
      reasonCode: supported ? "AVAILABLE" as const : "EXECUTION_MODE_NOT_SUPPORTED" as const,
    });
  }

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    return mapFormalExecutionRuntimeResult(await this.runtime.execute(intent));
  }

  async executeManagedClose(
    intent: ExecutionIntent,
    context?: FormalManagedCloseExecutionContext,
  ): Promise<FormalExecutionRuntimeResult> {
    if (!this.runtime.close) throw new Error("OKX managed-close runtime is unavailable.");
    return mapFormalExecutionRuntimeResult(await this.runtime.close(intent, context));
  }

  async reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult> {
    return mapFormalReconcileRuntimeResult(await this.runtime.reconcile(userId, executionId));
  }

  async cancel(userId: string, executionId: string) {
    return mapFormalCancelRuntimeResult(await this.runtime.cancel(userId, executionId));
  }
}
