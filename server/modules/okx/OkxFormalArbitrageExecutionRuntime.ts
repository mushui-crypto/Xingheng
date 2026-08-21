import type { ExecutionIntent } from "../cex/ExecutionIntent";
import {
  confirmedQuantityFromExecution,
  diagnosticFromExecution,
  mutationDispositionFromExecution,
  type FormalExecutionRuntime,
  type FormalExecutionRuntimeResult,
} from "../arbitrage-execution/FormalExecutionRuntime";
import type { OkxIntentExecutionRuntime } from "./OkxIntentExecutionRuntime";

type Runtime = Pick<OkxIntentExecutionRuntime, "execute" | "reconcile" | "cancel">;

/** Maps the OKX runtime to the venue-neutral formal execution contract. */
export class OkxFormalArbitrageExecutionRuntime implements FormalExecutionRuntime {
  constructor(private readonly runtime: Runtime) {}

  async execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult> {
    const result = await this.runtime.execute(intent);
    const diagnostic = diagnosticFromExecution(result.execution);
    const mutationDisposition = mutationDispositionFromExecution({
      executionRecord: result.executionRecord,
      ...(result.execution.step.status === "CALL_FAILED"
        ? { capabilityError: result.execution.step.error }
        : {}),
    });
    return Object.freeze({
      executionRecord: result.executionRecord,
      confirmedQuantity: confirmedQuantityFromExecution({
        executionRecord: result.executionRecord,
        ...(result.execution.step.result?.confirmedQuantity === undefined
          ? {}
          : { capabilityConfirmedQuantity: result.execution.step.result.confirmedQuantity }),
        ...(result.execution.step.status === "CALL_FAILED"
          ? { capabilityError: result.execution.step.error }
          : {}),
      }),
      ...(mutationDisposition === undefined ? {} : { mutationDisposition }),
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
