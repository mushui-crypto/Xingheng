# Minimal Provider request evidence

Scope: formal Start/Exit commands and their nested safety, execution, online reconcile and dust reads.
This is best-effort diagnostic evidence, **not** a mutation authority, fill ledger, retry gate or execution permit.
No deployment or real-funds test is implied by this implementation.

## Collection and storage

- A Node AsyncLocalStorage context carries the authenticated user, instance, root command and persisted venue/account bindings.
- Each venue client/public execution reader wraps its existing fetch function. No global fetch patch, new Provider request,
  response clone, request reordering, payload/mapping change or retry is introduced.
- Request fields: venue, accountId, instanceId, commandId, phase, endpoint-derived substage, method, normalized endpoint,
  startedAt, durationMs, numeric providerCode, mutationDisposition and reconcileAttempt. Exact order identity and
  mutation target are hashed for correlation. No credentials, signatures, headers, query strings or raw bodies are stored.
- `accountId` is the persisted command binding, not a new Provider identity assertion; ambiguous/unexpected venue bindings
  remain null. Existing mutation identity guards remain authoritative.
- `durationMs` is elapsed through the existing response parse where available, otherwise through fetch completion/failure.
  Provider code is null if unavailable; OKX item sCode is retained when present. No extra body read is done to obtain a code.
- Snapshot is deferred with setImmediate after command completion; errors (including async sink rejection) produce only a
  fixed sanitized warning. They cannot reject a command or trigger another dispatch/reconcile.
- SQLite `provider_command_traces` stores one JSON snapshot per invocation (`traceId` primary key), joined to existing
  outcome audit by userId + commandId. Replay observations may create another trace, but never another outcome or intent.
- Maximum 512 request details per invocation, 16 safety windows, 5000 snapshots globally and 30 days retention. Only this
  observational table is pruned. No execution/reference/ledger/release/outcome facts are changed.
- Crash before flush, store failure, missing scope and truncated collection mean evidence is incomplete; missing trace
  never means zero requests. This small collector deliberately does not log continuous unscoped market/account polling.

## Reading evidence

`ArbitrageInstanceStore.readProviderTraces(userId, instanceId, commandId?)` returns trace rows and counters. Omit commandId
to inspect repeat identity/target dispatch across separate commands for the same instance. For cross-instance acceptance,
query SQLite by the acceptance time window and compare each trace's expected bindings with its actual request venues.
No new frontend, metrics service or API is required. Example read-only queries:

```sql
SELECT commandId, traceJson FROM provider_command_traces
WHERE userId = :userId AND instanceId = :instanceId ORDER BY startedAt;

SELECT commandId, instanceId, traceJson FROM provider_command_traces
WHERE userId = :userId AND startedAt BETWEEN :fromTime AND :toTime ORDER BY startedAt;
```

Counts are **transport invocations**, not accepted/filled orders. PLACE_ORDER_COUNT includes ambiguous failures;
CANCEL_COUNT and AMEND_COUNT classify endpoint/method, not successful effects. A write entering fetch is conservatively
DISPATCHED_OR_POSSIBLE, including a synchronously thrown transport error. GET has no mutation and is NOT_DISPATCHED.
These values never override runtime authoritative mutationDisposition. Confirm duplicates using exact Provider identities;
repeated instance targets can also be legitimate separately authorized recovery/partial commands.

## Post-safety window

`PERP_CLOSE_SAFETY_PASS` is marked immediately after the real mutation-time CloseSafety assertion, before native context
construction. Window ends at that venue/account's PLACE_ORDER transport invocation, or at local close-attempt completion
without dispatch. All Provider GETs in that command window (including unexpected other venues) are counted. Reconcile
after dispatch and dust afterwards are excluded. Retry uses another fresh CloseSafety window, never reuses the old marker.
Null aggregate means no safety marker, not a proven zero. Inspect each window's placeOrderDispatchAt before interpreting
zero as a completed safety-to-dispatch trace.

## Acceptance boundaries

Compare COMMAND_VENUES / actual request venue and UNEXPECTED_VENUE_MUTATION_COUNT. All simultaneous formal Start/Exit
commands have isolated contexts. This is not an account-wide detector for external/manual exchange trading or unrelated
unscoped legacy jobs; those remain outside this command evidence model. No monitor or automatic remediation is added.
