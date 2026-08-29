import { createHash } from "node:crypto";
import type { ExecutionCancelObservation } from "../cex/ExecutionCancelCapability";
import { isExecutionPreMutationFailure } from "../cex/ExecutionCapability";
import type { ExecutionIntent } from "../cex/ExecutionIntent";
import type { ExecutionRecord } from "../cex/ExecutionRecord";
import type { VerifiedExecutionProviderIdentity } from "../cex/ExecutionMutationSafetyGuard";

export type FormalExecutionDiagnostic = Readonly<{
  category: string;
  stage: "execution-capability";
  failureStage: "PRE_MUTATION" | "MUTATION_OR_RESPONSE";
  errorType: string;
  sanitizedMessage: string;
  providerCode?: string;
}>;

/**
 * Fresh, attempt-scoped facts produced by the managed-close safety boundary.
 * Runtimes may consume these facts while preparing the immediately following
 * close mutation, but must never retain them across attempts or requests.
 */
export type FormalManagedCloseExecutionContext = Readonly<{
  verifiedAt: number;
  positionMode: "ONE_WAY" | "HEDGE";
  side: ExecutionIntent["side"];
  positionDirection: NonNullable<ExecutionIntent["positionDirection"]>;
  actualSignedNetQuantity: string | null;
  actualLongQuantity: string | null;
  actualShortQuantity: string | null;
  safeClosableQuantity: string;
  managedQuantityCeiling: string;
  legalizedCloseQuantity: string;
  reduceOnly: true;
  verifiedProviderIdentity?: VerifiedExecutionProviderIdentity;
  verifiedNativeExecutionRules?: VerifiedManagedCloseNativeExecutionRules;
}>;

export type VerifiedManagedCloseNativeExecutionRules = Readonly<{
  userId: string;
  accountId: string;
  venue: string;
  canonicalInstrumentId: string;
  providerInstrumentId: string;
  executionIntentId: string;
  instrumentState: "live";
  contractType: "linear";
  contractValueCurrency: string;
  settlementAsset: string;
  contractValue: string;
  lotSize: string;
  minimumSize: string;
  canonicalSafeCloseQuantity: string;
  legalizedCanonicalCloseQuantity: string;
  providerNativeQuantity: string;
  verifiedAt: number;
  contextFingerprint: string;
  source: "MUTATION_TIME_AUTHORITATIVE_CLOSE_SAFETY";
}>;

const verifiedNativeExecutionRules = new WeakSet<VerifiedManagedCloseNativeExecutionRules>();

export function createVerifiedManagedCloseNativeExecutionRules(
  input: Omit<VerifiedManagedCloseNativeExecutionRules, "contextFingerprint" | "source">,
): VerifiedManagedCloseNativeExecutionRules {
  const facts = {
    userId: nativeText(input.userId, "native rules userId"),
    accountId: nativeText(input.accountId, "native rules accountId"),
    venue: nativeText(input.venue, "native rules venue"),
    canonicalInstrumentId: nativeText(input.canonicalInstrumentId, "native rules canonical instrument"),
    providerInstrumentId: nativeText(input.providerInstrumentId, "native rules provider instrument"),
    executionIntentId: nativeText(input.executionIntentId, "native rules execution intent"),
    instrumentState: input.instrumentState,
    contractType: input.contractType,
    contractValueCurrency: nativeText(input.contractValueCurrency, "native rules contract value currency"),
    settlementAsset: nativeText(input.settlementAsset, "native rules settlement asset"),
    contractValue: nativeDecimal(input.contractValue, "native rules contract value"),
    lotSize: nativeDecimal(input.lotSize, "native rules lot size"),
    minimumSize: nativeDecimal(input.minimumSize, "native rules minimum size"),
    canonicalSafeCloseQuantity: nativeDecimal(input.canonicalSafeCloseQuantity, "native rules safe close quantity"),
    legalizedCanonicalCloseQuantity: nativeDecimal(input.legalizedCanonicalCloseQuantity, "native rules legalized close quantity"),
    providerNativeQuantity: nativeDecimal(input.providerNativeQuantity, "native rules provider quantity"),
    verifiedAt: nativeTimestamp(input.verifiedAt),
    source: "MUTATION_TIME_AUTHORITATIVE_CLOSE_SAFETY" as const,
  };
  if (facts.instrumentState !== "live" || facts.contractType !== "linear") {
    throw new Error("Verified native execution rules are not tradeable linear contract facts.");
  }
  const value = Object.freeze({
    ...facts,
    contextFingerprint: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  });
  verifiedNativeExecutionRules.add(value);
  return value;
}

export function isTrustedVerifiedManagedCloseNativeExecutionRules(
  value: VerifiedManagedCloseNativeExecutionRules,
) {
  return verifiedNativeExecutionRules.has(value);
}

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
  "position_mode_unavailable",
  "identity_read_unavailable",
  "identity_auth_or_permission_failed",
  "identity_mismatch",
  "identity_context_invalid",
  "instrument_rules_unavailable",
  "instrument_not_tradable",
  "instrument_rules_invalid",
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
  const providerCode = safeProviderCode(
    diagnosticError && typeof diagnosticError === "object" && "providerCode" in diagnosticError
      ? (diagnosticError as { providerCode?: unknown }).providerCode
      : undefined,
  );
  return Object.freeze({
    category,
    stage: "execution-capability",
    failureStage: isExecutionPreMutationFailure(error) ? "PRE_MUTATION" : "MUTATION_OR_RESPONSE",
    errorType,
    sanitizedMessage: sanitizeDiagnosticMessage(error, isControlledProviderCategory(rawCategory)),
    ...(providerCode === undefined ? {} : { providerCode }),
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

function safeProviderCode(value: unknown) {
  const token = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/u.test(token) ? token : undefined;
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

function nativeText(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 300) throw new Error(`${label} is invalid.`);
  return text;
}

function nativeDecimal(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text) || /^0(?:\.0+)?$/u.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function nativeTimestamp(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("native rules verification timestamp is invalid.");
  }
  return Number(value);
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
  executeManagedClose?(
    intent: ExecutionIntent,
    context?: FormalManagedCloseExecutionContext,
  ): Promise<FormalExecutionRuntimeResult>;
  reconcile(userId: string, executionId: string): Promise<FormalExecutionRuntimeResult>;
  cancel(userId: string, executionId: string): Promise<FormalExecutionCancelRuntimeResult>;
}
