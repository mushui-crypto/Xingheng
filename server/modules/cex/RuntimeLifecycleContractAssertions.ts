import assert from "node:assert/strict";
import type { ExecutionIntent } from "./ExecutionIntent";
import type { ExecutionRecord } from "./ExecutionRecord";

type RecordLoader = () => ExecutionRecord | null | undefined | Promise<ExecutionRecord | null | undefined>;

export async function assertPreflightFailureContract(input: Readonly<{
  record?: ExecutionRecord | null;
  loadRecord?: RecordLoader;
  mutationCount: number;
  error?: unknown;
  originalError?: unknown;
}>) {
  assert.equal(input.record ?? null, null, "preflight failure must not return an ExecutionRecord");
  assert.equal(input.mutationCount, 0, "preflight failure must not mutate a Provider");
  if (input.loadRecord) assert.equal(await input.loadRecord(), null, "preflight failure must not persist an ExecutionRecord");
  if (input.originalError !== undefined) assert.equal(input.error, input.originalError, "preflight error must be preserved");
}

export async function assertPreparationFailureContract(input: Readonly<{
  initialRecord: ExecutionRecord;
  finalRecord: ExecutionRecord | null | undefined;
  loadRecord?: RecordLoader;
  mutationCount: number;
  error?: unknown;
  originalError?: unknown;
}>) {
  assert.equal(input.initialRecord.status, "CREATED", "preparation must start from CREATED");
  assert.ok(input.finalRecord, "preparation failure must persist a final record");
  assert.equal(input.finalRecord?.status, "FAILED", "preparation failure must become FAILED");
  assert.equal(input.finalRecord?.executionAttemptId, undefined, "preparation failure must not have an execution attempt");
  assert.equal(input.finalRecord?.remoteOrderId, undefined, "preparation failure must not have a remote order identity");
  assert.equal(input.mutationCount, 0, "preparation failure must not mutate a Provider");
  if (input.loadRecord) {
    const persisted = await input.loadRecord();
    assert.equal(persisted?.status, "FAILED", "FAILED must be durable");
  }
  if (input.originalError !== undefined) assert.equal(input.error, input.originalError, "preparation error must be preserved");
}

export function assertCoordinatorBoundaryContract(input: Readonly<{
  executionRecord: ExecutionRecord;
  persistedRecords: readonly ExecutionRecord[];
  expectedStatus: ExecutionRecord["status"];
  mutationCount: number;
  expectedMutationCount: number;
}>) {
  assert.equal(input.executionRecord.status, input.expectedStatus, "Coordinator failure must retain its existing status semantics");
  assert.ok(
    input.persistedRecords.some((record) => record.status === input.expectedStatus),
    "Coordinator failure status must be persisted",
  );
  if (input.expectedStatus !== "FAILED") {
    assert.equal(
      input.persistedRecords.some((record) => record.status === "FAILED"),
      false,
      "unproven Coordinator failure must not be claimed by pre-mutation FAILED semantics",
    );
  }
  assert.equal(input.mutationCount, input.expectedMutationCount, "Coordinator failure must preserve its Provider mutation count");
}

export function assertExecutionIdentityContract(
  record: ExecutionRecord,
  intent: Pick<ExecutionIntent, "intentId" | "userId" | "venue" | "accountId" | "instrumentId">,
) {
  assert.deepEqual(
    {
      intentId: record.intentId,
      userId: record.userId,
      venue: record.venue,
      accountId: record.accountId,
      instrumentId: record.instrumentId,
    },
    {
      intentId: intent.intentId,
      userId: intent.userId,
      venue: intent.venue,
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
    },
    "ExecutionRecord identity must remain immutable",
  );
}

export function assertFormalResultContract(input: Readonly<{
  result: Readonly<{
    executionRecord: ExecutionRecord;
    confirmedQuantity: string | null;
    diagnostic?: unknown;
  }>;
  expectedQuantity: string | null;
  expectedDiagnostic?: unknown;
}>) {
  assert.equal(input.result.confirmedQuantity, input.expectedQuantity);
  if (input.expectedDiagnostic === undefined) {
    assert.equal(input.result.diagnostic, undefined, "successful results must not invent diagnostics");
  } else {
    assert.deepEqual(input.result.diagnostic, input.expectedDiagnostic);
  }
}

export function assertNoDuplicateMutationContract(input: Readonly<{
  mutationCountBeforeRecovery: number;
  mutationCountAfterRecovery: number;
}>) {
  assert.equal(input.mutationCountBeforeRecovery, 1, "the initial execution must perform exactly one Provider mutation");
  assert.equal(input.mutationCountAfterRecovery, input.mutationCountBeforeRecovery, "restart/recovery must not duplicate Provider mutation");
}
