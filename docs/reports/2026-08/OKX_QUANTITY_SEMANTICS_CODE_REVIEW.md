# OKX Quantity Semantics Code Review

## Review Result

Status: `FAIL`

Reviewed commit:

```text
4ff55a30917a3af01d87370a9820ed2cde5d28a7
```

The OKX execution quantity boundary does not yet satisfy:

```text
Canonical base quantity
-> venue adapter conversion
-> OKX provider contract quantity
```

OKX Position Verification and real-provider execution remain blocked until the
adapter converts quantities in both directions without exposing provider
contract units to the canonical execution layer.

## Blocking Findings

### Order submission

`ExecutionIntent.quantity` is a canonical base-asset quantity. The current OKX
execution service passes that value directly to OKX `sz`, whose unit is the
venue contract count.

Example:

```text
canonical quantity: 73 DOGE
OKX ctVal:          0.1 DOGE per contract
required OKX sz:    730 contracts
current OKX sz:     73 contracts
```

This can create an incorrect provider exposure.

### Filled quantity

OKX `accFillSz` is a provider contract quantity. The current query path places
it directly into `ExecutionQueryObservation.filledBaseQuantity`, incorrectly
labelling contracts as canonical base quantity.

### Position verification

OKX `pos` is a provider contract quantity. The current position verification
path compares it directly with `ExecutionIntent.quantity`, so any instrument
with `ctVal != 1` can produce an incorrect verification result.

### Common CEX quantity semantics

The existing common CEX models still expose provider contract semantics through
fields such as `quantityUnit`, `contractSize`, and `plannedVenueQuantity`. This
is a separate architecture-level cleanup and must not be folded into the
minimal OKX adapter correction without explicit approval.

## Required Correction Boundary

The next implementation must remain in the OKX adapter boundary and provide:

1. Decimal-string `base quantity -> OKX contract sz` conversion before order
   mutation.
2. Decimal-string `accFillSz -> canonical filled base quantity` conversion
   before returning an execution query observation.
3. Decimal-string `OKX pos -> canonical base quantity` conversion before
   position verification.
4. Fail-closed handling for missing, invalid, stale, or identity-mismatched
   `lotSz`, `minSz`, `ctVal`, and instrument rules.
5. Tests with `ctVal = 0.1` or another non-unit contract value.

The correction must not modify Binance execution, `ExecutionIntent`,
`ExecutionCoordinator`, or `ExecutionRecord` schema.

## Required Tests

- base quantity converts to the exact provider contract quantity;
- provider fill converts back to canonical base quantity;
- provider position converts back to canonical base quantity;
- incorrect direction and quantity remain fail closed;
- close verification confirms canonical zero quantity;
- missing or invalid `ctVal` fails closed;
- provider mutation remains zero outside fake-provider tests.

## Current Decision

The reviewed OKX implementation may remain committed as development progress,
but it must not pass the Position Verification checkpoint or enter a real-funds
execution flow until the quantity conversion boundary is corrected and the
review is repeated.
