import type { ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";

export type FormalExecutionRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  confirmedQuantity: string | null;
}>;

export type FormalExecutionCancelRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionCancelObservation;
}>;

export interface FormalExecutionRuntime {
  execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult>;
  reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult>;
  cancel(userId: string, executionId: string): Promise<FormalExecutionCancelRuntimeResult>;
}
