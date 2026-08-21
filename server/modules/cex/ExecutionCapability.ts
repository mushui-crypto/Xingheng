import type { ExecutionIntent } from "./ExecutionIntent";
import type { ExecutionStatus } from "./ExecutionState";

export interface ExecutionCapability<TResult = unknown> {
  execute(intent: ExecutionIntent): Promise<TResult>;
}

/**
 * Explicit proof that an execution attempt failed before the Provider mutation
 * call began. Only failures carrying this contract may be persisted as FAILED;
 * unclassified capability errors remain UNKNOWN.
 */
export class ExecutionPreMutationFailure extends Error {
  readonly mutationDisposition = "NOT_DISPATCHED" as const;

  constructor(message: string, readonly originalError?: unknown) {
    super(message);
    this.name = "ExecutionPreMutationFailure";
  }
}

export function executionPreMutationFailure(error: unknown): ExecutionPreMutationFailure {
  if (error instanceof ExecutionPreMutationFailure) return error;
  return new ExecutionPreMutationFailure(
    error instanceof Error ? error.message : "Execution failed before Provider mutation.",
    error,
  );
}

export function isExecutionPreMutationFailure(error: unknown): error is ExecutionPreMutationFailure {
  return error instanceof ExecutionPreMutationFailure
    && error.mutationDisposition === "NOT_DISPATCHED";
}

export async function runExecutionPreMutationPhase<TResult>(
  operation: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    throw executionPreMutationFailure(error);
  }
}

export type ExecutionCapabilityResult = Readonly<{
  state?: ExecutionStatus;
}>;
