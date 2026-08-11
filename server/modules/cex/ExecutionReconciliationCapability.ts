import {
  applyExecutionQueryObservation,
  createExecutionQueryObservation,
  type ExecutionQueryObservation,
} from "./ExecutionQueryCapability";
import type { ExecutionRecord } from "./ExecutionRecord";

export type ExecutionReconciliationObservation = ExecutionQueryObservation;

export interface ExecutionReconciliationCapability {
  reconcile(record: ExecutionRecord): Promise<ExecutionReconciliationObservation>;
}

export const createExecutionReconciliationObservation = createExecutionQueryObservation;
export const applyExecutionReconciliationObservation = applyExecutionQueryObservation;
