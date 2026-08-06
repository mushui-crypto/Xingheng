# Smoke Leverage Compatibility Fix Report

> Historical change report. It records the pre-release review boundary and does
> not represent current Provider, funds, Permit, or deployment authorization.

## Scope

- Removed the Capital Test connectivity-smoke leverage configuration mutation.
- Added read-only validation that XAUTUSDT USD-M leverage is exactly 1x.
- Permit permission model changes: `0`.
- Provider permission changes: `0`.
- Action-scope expansion: `0`.
- Provider connections during this task: `0`.
- Permit generated: `NO`.
- Real trades: `0`.

## Changed Files

Implementation:

- `server/modules/arbitrage/automation/RwaBinanceAutomationTypes.ts`
- `server/modules/arbitrage/automation/RwaBinanceMainnetClient.ts`
- `server/modules/arbitrage/automation/RwaBinanceAutomationService.ts`
- `server/modules/arbitrage/automation/RwaConnectivitySmoke.ts`

Tests:

- `server/modules/arbitrage/automation/RwaBinanceMainnetClient.test.ts`
- `server/modules/arbitrage/automation/RwaBinanceAutomationService.test.ts`
- `server/modules/arbitrage/automation/RwaConnectivitySmoke.test.ts`

## Fix Result

1. Removed smoke-path preparation for `set_leverage`.
2. Removed the smoke-path `setPerpetualLeverage(1)` Provider write.
3. Reused the existing `/fapi/v2/positionRisk` read to expose
   `perpetual.leverage` in the preflight snapshot.
4. A missing XAUTUSDT position row produces `leverage=null`; an existing row
   with missing, non-numeric, non-positive, or non-integer leverage fails closed
   as `provider_snapshot_invalid`.
5. Smoke requires 1x at challenge preflight, execute revalidation, immediately
   before the first Spot order, and immediately before the Futures opening
   order.
6. If leverage changes after risk exists, no further new-risk leg is opened;
   attributable cancellation, recovery, reduce-only Futures close, Spot close,
   and flat verification remain available.
7. A zero-mutation leverage race in `reserved` or `spot_opening` terminates as
   `failed`, so it cannot leave an active smoke record blocking later review.
8. A successful smoke now contains four order-class Provider mutations and no
   leverage mutation.

`ACCOUNT_CONFIGURATION_CHANGE` was not added or inferred from `TRADE`.
Generic leverage capability outside the Capital Test smoke path was not
removed or modified.

## Policy Identity

- Policy version: `connectivity-smoke-gate2-capital-v4`.
- Policy digest: `KYmoAYTaw3R73Vwvo7fpfZ3er8yBaYfZkA-NWHaAs4o`.
- Policy rule: existing 1x leverage is read-verified; StellaX performs no
  leverage configuration mutation in this smoke path.
- Prior v3 challenge/acceptance identity is rejected.

## Verification

- Server TypeScript check: `PASS`.
- Targeted smoke/Mainnet tests: `118/118 PASS`.
- Arbitrage test suite: `33/33 PASS`.
- `git diff --check`: `PASS`.
- Architecture Review: `PASS`.
- Final Code Review: `PASS`; P0/P1/P2 findings: `0/0/0`.

The broader automation run recorded `348 PASS / 12 FAIL / 1 SKIP`; all 12
failures were caused by the local frozen WIF ADC/KMS environment path and were
outside the changed smoke files. The task-specific and arbitrage suites passed.

## Remaining Authorization Boundary

- Existing formal release revision `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
  does not include this uncommitted code change.
- A new reviewed release identity and rebuilt authorization-material binding
  are required before any later Permit review.
- Provider Access: `NOT_AUTHORIZED`.
- Real Funds: `NOT_AUTHORIZED`.
- Execution: `BLOCKED_PENDING_AUTHORIZATION`.
- Permit: `NO`.

No files were staged, committed, pushed, cleaned, or overwritten outside the
task scope.

## Result

`PASS`

This result applies only to removal of the smoke leverage mutation and the
read-only 1x compatibility guard. It does not authorize Provider access, real
funds, Permit generation, deployment, or Capital Test execution.
