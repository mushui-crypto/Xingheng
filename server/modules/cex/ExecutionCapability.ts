import type { ExecutionIntent } from "./ExecutionIntent";
import type { ExecutionStatus } from "./ExecutionState";

export interface ExecutionCapability<TResult = unknown> {
  execute(intent: ExecutionIntent): Promise<TResult>;
}

export type ExecutionCapabilityResult = Readonly<{
  state?: ExecutionStatus;
}>;
