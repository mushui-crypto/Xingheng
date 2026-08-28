import type { ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import { isExecutionPreMutationFailure } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";

export type FormalExecutionDiagnostic = Readonly<{
  category: string;
  stage: "execution-capability";
  failureStage: "PRE_MUTATION" | "MUTATION_OR_RESPONSE";
  errorType: string;
  sanitizedMessage: string;
}>;

export type FormalExecutionMutationDisposition =
  | "NOT_DISPATCHED"
  | "DISPATCHED_OR_POSSIBLE"
  | "UNKNOWN";

const CONTROLLED_PROVIDER_CATEGORIES = new Set([
  "credential_validation_failed",
  "provider_credential_invalid",
  "provider_permission_error",
  "provider_rate_limited",
  "provider_region_restricted",
  "provider_rejected",
  "provider_request_invalid",
  "provider_request_rejected",
  "provider_response_invalid",
  "provider_snapshot_invalid",
  "provider_timeout",
  "provider_timestamp_error",
  "provider_transport_error",
  "provider_unavailable",
]);

export type FormalExecutionRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  confirmedQuantity: string | null;
  mutationDisposition?: FormalExecutionMutationDisposition;
  diagnostic?: FormalExecutionDiagnostic;
}>;

export function mutationDispositionFromExecution(input: Readonly<{
  executionRecord: ExecutionRecord;
  capabilityStepStatus?: "SUCCEEDED" | "CALL_FAILED" | "SKIPPED_EXPIRED";
  capabilityError?: unknown;
}>): FormalExecutionMutationDisposition {
  if (input.capabilityStepStatus === "SKIPPED_EXPIRED") return "NOT_DISPATCHED";
  if (input.executionRecord.status === "FAILED"
    && input.executionRecord.executionAttemptId === undefined
    && input.executionRecord.remoteOrderId === undefined
    && isExecutionPreMutationFailure(input.capabilityError)) return "NOT_DISPATCHED";
  if (input.capabilityStepStatus === "SUCCEEDED") return "DISPATCHED_OR_POSSIBLE";
  return "UNKNOWN";
}

export function hasPersistedNotDispatchedProof(record: ExecutionRecord) {
  return record.status === "FAILED"
    && record.executionAttemptId === undefined
    && record.remoteOrderId === undefined;
}

export function confirmedQuantityFromExecution(input: Readonly<{
  executionRecord: ExecutionRecord;
  capabilityConfirmedQuantity?: string;
  capabilityError?: unknown;
}>): string | null {
  if (input.capabilityConfirmedQuantity !== undefined) return input.capabilityConfirmedQuantity;
  return input.executionRecord.status === "FAILED"
    && isExecutionPreMutationFailure(input.capabilityError)
    ? "0"
    : null;
}

export function diagnosticFromExecution(execution: {
  step: { status: string; error?: unknown };
}): FormalExecutionDiagnostic | undefined {
  if (execution.step.status !== "CALL_FAILED" || !("error" in execution.step)) return undefined;
  const error = execution.step.error;
  const diagnosticError = isExecutionPreMutationFailure(error) && error.originalError !== undefined
    ? error.originalError
    : error;
  const rawCategory = diagnosticError && typeof diagnosticError === "object" && "category" in diagnosticError
    ? (diagnosticError as { category?: unknown }).category
    : undefined;
  const category = safeToken(
    rawCategory,
    "execution_failed",
  );
  const errorType = safeToken(
    error && typeof error === "object" && "constructor" in error
      ? (error as { constructor?: { name?: unknown } }).constructor?.name
      : undefined,
    "Error",
  );
  return Object.freeze({
    category,
    stage: "execution-capability",
    failureStage: isExecutionPreMutationFailure(error) ? "PRE_MUTATION" : "MUTATION_OR_RESPONSE",
    errorType,
    sanitizedMessage: sanitizeDiagnosticMessage(error, isControlledProviderCategory(rawCategory)),
  });
}

function isControlledProviderCategory(value: unknown): value is string {
  return typeof value === "string" && CONTROLLED_PROVIDER_CATEGORIES.has(value);
}

function safeToken(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const token = value.trim().slice(0, 80);
  return /^[a-zA-Z][a-zA-Z0-9_.:-]*$/u.test(token) ? token : fallback;
}

function sanitizeDiagnosticMessage(error: unknown, trustedCategory: boolean) {
  if (!trustedCategory) return "Execution capability failed.";
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Execution capability failed.";
  const sanitized = raw
    .replace(/(["']?(?:api[_ -]?key|api[_ -]?secret|secret|passphrase|password|authorization|signature|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,;}\]\n]+)/giu, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,;}\]]+/giu, "Bearer [redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/gu, "[redacted]")
    .trim()
    .slice(0, 240);
  return sanitized || "Execution capability failed.";
}

export type FormalExecutionCancelRuntimeResult = Readonly<{
  executionRecord: ExecutionRecord;
  observation: ExecutionCancelObservation;
}>;

export type FormalOpeningExecutionCapability = Readonly<{
  supported: boolean;
  reasonCode: "AVAILABLE" | "EXECUTION_MODE_NOT_SUPPORTED";
}>;

export type FormalOpeningExecutionCapabilityInput = Readonly<{
  executionMode: ExecutionIntent["executionMode"];
  marketType: "spot" | "perpetual";
}>;

export interface FormalExecutionRuntime {
  /** Read-only production capability used by Draft/Confirm/Start before any mutation. */
  openingExecutionCapability?(
    input: FormalOpeningExecutionCapabilityInput,
  ): FormalOpeningExecutionCapability;
  execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult>;
  /** Trusted managed-close entry point. Only CloseService may use this mutation path. */
  executeManagedClose?(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult>;
  reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult>;
  cancel(userId: string, executionId: string): Promise<FormalExecutionCancelRuntimeResult>;
}
