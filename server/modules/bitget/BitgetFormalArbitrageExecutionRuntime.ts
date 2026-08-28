import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  confirmedQuantityFromExecution,
  diagnosticFromExecution,
  mutationDispositionFromExecution,
  type FormalExecutionRuntime,
  type FormalExecutionRuntimeResult,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { BitgetIntentExecutionRuntime } from "./BitgetIntentExecutionRuntime";

type Runtime = Pick<BitgetIntentExecutionRuntime, "execute" | "reconcile" | "cancel">
  & Partial<Pick<BitgetIntentExecutionRuntime, "close">>;

export class BitgetFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    return this.executeWith(() => this.runtime.execute(intent));
  }

  async executeManagedClose(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    if (!this.runtime.close) throw new Error("Bitget managed-close runtime is unavailable.");
    return this.executeWith(() => this.runtime.close!(intent));
  }

  private async executeWith(run: () => ReturnType<Runtime["execute"]>): Promise<FormalExecutionRuntimeResult> {
    const result = await run();
    const diagnostic = diagnosticFromExecution(result.execution);
    const mutationDisposition = mutationDispositionFromExecution({
      executionRecord: result.executionRecord,
      capabilityStepStatus: result.execution.step.status,
      ...(result.execution.step.status === "CALL_FAILED" ? { capabilityError: result.execution.step.error } : {}),
    });
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: confirmedQuantityFromExecution({
        executionRecord: result.executionRecord,
        ...(result.execution.step.result?.confirmedQuantity === undefined ? {} : {
          capabilityConfirmedQuantity: result.execution.step.result.confirmedQuantity,
        }),
        ...(result.execution.step.status === "CALL_FAILED" ? { capabilityError: result.execution.step.error } : {}),
      }),
      mutationDisposition,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  }

  async reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult> {
    const result = await this.runtime.reconcile(userId, executionId);
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: result.observation?.state === "UNKNOWN" ? null : result.observation?.filledBaseQuantity ?? null,
    });
  }

  async cancel(userId: string, executionId: string) {
    const result = await this.runtime.cancel(userId, executionId);
    return Object.freeze({ executionRecord: result.executionRecord, observation: result.observation });
  }
}
