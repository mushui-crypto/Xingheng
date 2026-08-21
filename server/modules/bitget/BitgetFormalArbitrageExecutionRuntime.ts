import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  confirmedQuantityFromExecution,
  diagnosticFromExecution,
  mutationDispositionFromExecution,
  type FormalExecutionRuntime,
  type FormalExecutionRuntimeResult,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { BitgetIntentExecutionRuntime } from "./BitgetIntentExecutionRuntime";

type Runtime = Pick<BitgetIntentExecutionRuntime, "execute" | "reconcile" | "cancel">;

export class BitgetFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    const result = await this.runtime.execute(intent);
    const diagnostic = diagnosticFromExecution(result.execution);
    const mutationDisposition = mutationDispositionFromExecution({
      executionRecord: result.executionRecord,
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
      ...(mutationDisposition === undefined ? {} : { mutationDisposition }),
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
