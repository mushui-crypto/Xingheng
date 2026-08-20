import type { ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";

export type FormalExecutionDiagnostic = Readonly<{
  category: string;
  stage: "execution-capability";
  errorType: string;
  sanitizedMessage: string;
}>;

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
  diagnostic?: FormalExecutionDiagnostic;
}>;

export function diagnosticFromExecution(execution: {
  step: { status: string; error?: unknown };
}): FormalExecutionDiagnostic | undefined {
  if (execution.step.status !== "CALL_FAILED" || !("error" in execution.step)) return undefined;
  const error = execution.step.error;
  const rawCategory = error && typeof error === "object" && "category" in error
    ? (error as { category?: unknown }).category
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

export interface FormalExecutionRuntime {
  execute(intent: ExecutionIntent): Promise<FormalExecutionRuntimeResult>;
  reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult>;
  cancel(userId: string, executionId: string): Promise<FormalExecutionCancelRuntimeResult>;
}
