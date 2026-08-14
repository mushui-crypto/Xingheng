export class ManualReconciliationRequiredError extends Error {
  readonly manualReconciliationRequired = true as const;

  constructor(
    readonly idempotencyKey: string,
    readonly reason: string,
    message = "Stored execution state requires manual reconciliation.",
  ) {
    super(message);
  }
}
