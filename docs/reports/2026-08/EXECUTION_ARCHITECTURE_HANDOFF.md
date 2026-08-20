# Execution Architecture Handoff

- updated: `2026-08-20`
- branch: `architecture-optimization`
- implementation commit: `7851223 feat(execution): unify CEX runtime lifecycle`
- draft PR: [Xingheng #32](https://github.com/mushui-crypto/Xingheng/pull/32)
- deployment: `NOT_DEPLOYED`
- real trading: `NOT_EXECUTED`

本文件是可通过 Git 同步的脱敏交接摘要。它不包含凭证、账号身份、任务 ID、主机信息或真实资金
授权材料。

## Current execution baseline

正式 CEX mutation 测试与执行链已经收敛为：

```text
UnifiedRealTradingTestCommand
-> FormalExecutionRuntimeRegistry
-> Venue Formal Runtime
-> Intent Runtime
-> ExecutionCoordinator
-> Capability
-> Provider
```

`ExecutionRecord` 是订单执行事实来源；`ArbitrageInstance` 维护本实例尚未撤销的 managed signed
delta。账户总仓位和总余额不作为 execution ownership 来源。

## Completed changes

- Binance 接入 Unified Real Trading CLI，包括 venue preparation、Formal Runtime registry wiring 和
  deterministic execution identity。
- Binance 与 OKX 对齐冻结的 Runtime lifecycle：Preflight、durable `CREATED` record、venue
  preparation、Coordinator mutation boundary、venue finalization 和 final persistence。
- 增加薄的 Runtime lifecycle contract assertions，并由 Binance/OKX 真实 Runtime fixture 消费。
- 完成 Net Position Delta 语义收敛：managed delta、managed slice reversal、partial close 和
  `reduceOnly` 边界；venue-specific position/order 字段仍留在 venue/provider 层。
- 删除旧 Binance Capital Test CLI/runtime/preflight，以及 Funding execution state、adapter、bridge、
  link store、coordinator 和对应旧模型测试。
- 修复 close-path 测试 fixture/type 遗留，完整 TypeScript 和 production build 已恢复。
- ADR-003 已记录 signed net position 的权威语义。

## Removed legacy paths

以下模块不得恢复为兼容层或第二套 mutation/recovery 路径：

- `run-binance-capital-test-once.ts`
- `BinanceCapitalTestRuntime`
- `BinanceCapitalTestPreflight`
- `FundingArbitrageExecutionState`
- `FundingArbitrageIntentAdapter`
- `FundingLegExecutionStateBridge`
- `FundingLegExecutionLinkStore`
- `FundingArbitrageExecutionCoordinator`

## Frozen boundaries

- 不修改 `ExecutionIntent`、`ExecutionRecord` 或 `ArbitrageInstance` schema。
- 不改变 `ExecutionCoordinator` lifecycle、Formal Runtime contract、quantity boundary 或 Provider
  contract。
- 不通过账户总仓位/余额推断 execution ownership。
- close 只撤销当前 instance 的 outstanding managed delta；`reduceOnly` 仅是 venue/provider 约束。
- recovery/reconcile 必须保持稳定 execution identity 且不得重复 Provider mutation。
- Spot attribution 继续来自当前订单 fill/fee，不从账户总余额推导。

## Verification

- full test suite: `1450 passed`, `0 failed`
- `npx tsc -b`: `PASS`
- `npm run build`: `PASS`
- `git diff --check`: `PASS`
- real Provider mutation: `0`

## Review and next steps

1. 审阅 Draft PR #32，确认本次改动范围与 ADR-003 一致。
2. 合并前保持全局/venue LIVE gate、kill switch 和 Provider Identity 门禁关闭或 fail-closed。
3. 不从该分支直接部署，不将测试通过解释为真实资金授权。
4. 空 `OPENING` ArbitrageInstance 的既有生命周期问题属于独立任务，不在本 PR 中顺带处理。
5. 后续 Bybit/Bitget mutation 接入必须复用同一 lifecycle contract，不得把 venue 字段加入公共模型。

## Handoff status

- code implementation: `COMPLETE`
- automated verification: `PASS`
- draft PR review: `PENDING`
- merge: `PENDING`
- deployment: `NOT_AUTHORIZED`
- real-funds execution: `NOT_AUTHORIZED`
