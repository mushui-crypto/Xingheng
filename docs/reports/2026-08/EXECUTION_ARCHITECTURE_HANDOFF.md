# Execution Architecture Closure

- updated: `2026-08-20`
- production baseline: `f57d053eb1c7b0fc89c917b5fd8558d67b316bac`
- deployment: `COMPLETE`
- post-deploy read-only validation: `PASS`

本文件是可通过 Git 同步的脱敏架构关闭记录。它不包含凭证、账号身份、任务 ID、主机信息或真实资金授权材料。

## Final execution architecture

正式业务执行与 Unified Real Trading Test 共用唯一主链：

```text
Business layer / Unified Real Trading Test
-> ExecutionIntent
-> FormalExecutionRuntimeRegistry
-> Venue Formal Runtime
-> Venue Intent Runtime
-> ExecutionRecord
-> ExecutionCoordinator
-> Venue Capability
-> Safety Guard / Provider Identity
-> Adapter / Provider
-> Provider API
-> Reconciliation
```

`ExecutionCoordinator` 位于 Venue Runtime 内部。业务服务、Close Service 与 Unified Real Trading Test 都通过
`FormalExecutionRuntimeRegistry` 解析 Venue Runtime，不得形成直达 Intent Runtime、Coordinator、Capability
或 Provider 的第二 mutation 路径。

## Frozen contracts

- `ExecutionRecord` 是单次 execution/provider fact：身份、状态、attempt、remote/provider identity、确认数量和
  recovery/reconciliation 事实。
- `ArbitrageInstance` 是业务实例事实：双腿、managed exposure、开仓/退出 lifecycle、partial close 与剩余 managed
  quantity。它不是 Provider order recovery 的替代来源。
- recovery 的唯一事实源为 `ExecutionRecord`、持久化 Provider/order identity 与 authoritative Provider GET /
  reconciliation。`UNKNOWN` 不自动重新 place，保留事实并 fail-closed 进入 reconcile。
- Unified Real Trading Test 对同一 `requestId` 和同一 execution semantics 产生稳定 `intentId` 与 `executionId`；
  restart 只 reconcile。side、quantity、`reduceOnly`、execution mode、instrument 或 account identity 改变时必须
  fail-closed。Binance production composition 已注入 `unifiedRealTradingTestExecutionId(intent)`。
- LONG managed delta 为 `+Q`，SHORT managed delta 为 `-Q`；允许 partial close。close quantity 来自 managed
  quantity/requested slice，账户总净仓只用于 safety 与 `reduceOnly` eligibility。关闭 intent 在 recovery 时不得重新规划。
- canonical quantity 是 base-asset Decimal；Provider quantity、contract conversion、position-mode 字段和其他 venue
  特有字段仅留在 Capability、Adapter 与 Provider 边界。

## Completed work

- Formal Runtime diagnostic 与 Binance/OKX runtime lifecycle contract 对齐。
- Net Position Delta 语义、partial close 与 `reduceOnly` 边界冻结。
- Unified Real Trading CLI Binance wiring 与 deterministic execution identity recovery 完成。
- Legacy test migration、Capital Test production cleanup 与 Funding execution legacy cleanup 完成。
- build/type 遗留修复、Final Architecture Audit、production deployment 与 post-deploy read-only acceptance 完成。

## Removed legacy paths

以下模块不得恢复为兼容层、第二 execution fact 或第二 mutation/recovery 路径：

- `run-binance-capital-test-once.ts`
- `BinanceCapitalTestRuntime`
- `BinanceCapitalTestPreflight`
- `FundingArbitrageExecutionState`
- `FundingArbitrageIntentAdapter`
- `FundingLegExecutionStateBridge`
- `FundingLegExecutionLinkStore`
- `FundingArbitrageExecutionCoordinator`

## Production baseline

- API revision: `f57d053eb1c7b0fc89c917b5fd8558d67b316bac`
- Web revision: `f57d053eb1c7b0fc89c917b5fd8558d67b316bac`
- health: `PASS`
- safety gates: `LIVE_TRADING_ENABLED=false`, `BINANCE_KILL_SWITCH=true`,
  `OKX_LIVE_TRADING_ENABLED=false`, `OKX_KILL_SWITCH=true`
- Provider real mutation during deployment and read-only acceptance: `0`
- P0: `NONE`
- P1: `NONE`

## Follow-up classification

Current blocker: `NONE`

P2 cleanup candidate: `BinanceSpotPerpetualCapitalTestIntentBuilder` 及其测试。它没有 production 或 Runtime caller，
也不包含 Provider mutation；仅可在单独 cleanup 阶段处理。

Future feature / venue work: Bybit/Bitget 的后续正式 mutation integration、后续真实资金验证及其他业务功能。这些不属于
本轮 architecture optimization 的未完成事项。

## Closure status

- architecture optimization: `COMPLETE`
- deployment: `COMPLETE`
- post-deploy read-only validation: `PASS`
- real-funds authorization: `NOT_GRANTED_BY_THIS_CLOSURE`
