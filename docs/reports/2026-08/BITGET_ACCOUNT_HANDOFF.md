# Bitget Account Handoff

- updated: `2026-08-22`
- scope: Bitget credential/account-read/execution-readiness handoff
- environment: dormant production
- production URL: `https://app.stellaxtrade.com`
- production revision: `522e0d71b753e442f82b7dc796be68ae9d551af9`

## Safety Boundary

The following gates remain unchanged:

```text
LIVE_TRADING_ENABLED=false
BITGET_LIVE_TRADING_ENABLED=false
BITGET_KILL_SWITCH=true
Provider order mutation=0
place/cancel calls=0
```

No Bitget order endpoint was called. No account funds were moved, no position was closed,
and no live execution gate was enabled.

## Code and Deployment

- Release commit: `522e0d71b753e442f82b7dc796be68ae9d551af9`
- Release tree: `2c9686c3c345e369bb34c82f40b908dd1c7c2a1c`
- Previous Bitget dormant release: `96ae382531e7c257a835ad4577c3664631b24142`
- API and Web images use the same release revision.
- API health: PASS.
- Web and deployment smoke: PASS.
- API/Web `RestartCount`: `0`.
- DB, KMS/WIF read-only mount, and named volumes: PASS.
- Formal execution registry contains `bitget`.
- AccountRead and Credential composition register Bitget.

`EXECUTION_ARCHITECTURE_HANDOFF.md` was intentionally excluded from the release commit and
remains an unrelated local modification.

## Credential Identity

- Application user: `USR-MRDQ6DT1`
- Stored legacy account ID: `bitget:credential-only:8c60344c6acc3bd0c95d`
- Provider-derived account ID: `bitget:5b8a4aa0c6772cf4`
- Provider UID: `4991589617`
- `account/info` UID and `account/settings` UID: matched
- Legacy rebind: NOT COMPLETED
- Identity match: `false`

Formal application path for the next authenticated operator:

```text
POST /api/exchange-credentials/bitget/rebind
```

The route requires the authenticated user session. Direct SQL updates, internal credential
reuse, and auth bypass are prohibited. The production API returned `401` without a valid
session. Rebind must be followed by a fresh `validateAccess` and strict stored/provider identity
comparison.

## Provider Readiness Snapshot

The latest GET-only validation returned:

| Check | Result |
| --- | --- |
| `validateAccess` | PASS |
| `permType` | `read_and_write` |
| `read` | `true` |
| `spotTrade` | `true` |
| `contractTrade` | `true` |
| `withdraw` | `false` |
| IP restriction | PASS |
| `providerVerified` | `true` |
| account mode | `unified` |
| asset mode | `multi_assets` |
| hold mode | `hedge_mode` |
| `positionModeSupported` | `false` |
| `executionEnabled` | `false` |

The release includes the compatibility fix that normalizes Bitget's production
`read_and_write` permission enum to the internal `read-and-write` form. Bitget AccountRead
tests: `52/52 PASS`; project build: PASS.

## Position-Mode Blocker

Bitget UTA documentation identifies the formal account setting operation:

```text
POST /api/v3/account/set-hold-mode
{"holdMode":"one_way_mode"}
Permission: UTA mgt. (read & write)
```

Before any setting call, an account-level GET-only precondition was checked:

- Spot active orders: `0`
- Perp active orders: `0`
- DOGEUSDT Perp: `FLAT`
- Other account positions: NOT FLAT

The account currently has non-zero BTCUSDT Perp positions:

- short: `total=0.4`
- long: `total=1`

Because the official hold-mode change requires no open positions and the task forbids closing
positions or adding a new StellaX account-setting mutation architecture, the setting POST was
not attempted. Hold mode remains `hedge_mode`.

## DOGE Read-Only Evidence

- Spot USDT total: `3606.19913258`
- Spot USDT available: approximately `2608.82143258` at the latest probe
- Spot DOGE non-zero balance: none observed
- DOGEUSDT Perp position: empty / `FLAT`
- DOGEUSDT Spot active orders: `0`
- DOGEUSDT Perp active orders: `0`
- Spot rules: quantity step `0.0001`, minQty `0.0001`, minNotional `1`, contractSize `1`
- Perp rules: quantity step `1`, minQty `1`, minNotional `5`, contractSize `1`

Local unresolved state:

```text
Bitget ExecutionRecord unresolved: 0
Bitget ExecutionOrderReference unresolved: 0
Bitget arbitrage execution reference unresolved: 0
```

## Current Gate

```text
GATE: READY_FOR_BITGET_EXECUTION_LEVEL_TEST_PREPARATION
NOT_REACHED
```

Current P1 blockers:

1. `BITGET_AUTHENTICATED_REBIND_SESSION_UNAVAILABLE`
2. `BITGET_ACCOUNT_NONZERO_BTC_PERP_POSITIONS_BLOCK_HOLD_MODE_SWITCH`
3. `BITGET_LEGACY_CREDENTIAL_REBIND_REQUIRED`
4. `FULL_TEST_LOCALHOST_ENVIRONMENT_UNAVAILABLE`

## Next Operator Runbook

1. Obtain a valid authenticated session for `USR-MRDQ6DT1`; do not use an admin session or
   direct database access.
2. Confirm account-level Perp positions are all zero and Spot/Perp active orders are zero.
3. Use the official Bitget account setting operation to request `one_way_mode`, only after the
   previous condition is true.
4. Re-read `account/info`, `account/settings`, balances, DOGE positions, and active orders.
5. Invoke the authenticated StellaX Bitget rebind route and validate the resulting stored account
   ID equals `bitget:5b8a4aa0c6772cf4`.
6. Re-run readiness. Do not enable any LIVE gate and do not call place/cancel.

Do not treat this report as authorization for live execution or account mutation beyond the
explicit read-only verification and the separately authorized official account setting step.
