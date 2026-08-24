# StellaX 当前版本交接报告

- 更新日期：2026-08-24
- 当前主线提交：`1281472`
- 当前生产 revision：`1281472`
- 部署方式：Docker Compose production-only，项目 `xingheng`
- 生产健康：API healthy，Web running，API/Web RestartCount=0

本报告按当前代码、测试、生产部署记录和已完成真实资金验收整理。它是当前版本交接入口，不替代用户对真实资金操作的逐次授权。

## 1. 版本定位与进度

当前版本已经从单一 Binance 正式执行链扩展为四 venue 共存的统一套利执行架构：统一业务层创建 `ArbitrageInstance` 和 `ExecutionIntent`，由 `FormalExecutionRuntimeRegistry` 选择交易所 Formal Runtime，再进入交易所 Intent Runtime、`ExecutionCoordinator`、Capability、Safety Guard 和 Provider。

当前进度：

| 能力 | 进度 | 证据/边界 |
| --- | --- | --- |
| Demo 模拟交易 | 已实现 | 独立模拟账户、订单、持仓和资金流水 |
| Hyperliquid Testnet | 已实现 | 用户钱包签名边界；不等同 CEX 真实资金执行 |
| 套利 Draft/Preview/Confirm | 已实现 | authenticated `/api/arbitrage-execution/confirm` 创建 `ArbitrageInstance` |
| 双腿开仓与第二腿规划 | 已实现 | 第一腿确认后按真实成交/归因数量规划第二腿 |
| ExecutionRecord/ExecutionReference | 已实现 | SQLite 持久化、身份绑定、恢复和重启后核验 |
| Position Verification | 已实现 | provider read -> venue reader -> canonical `PositionSnapshot` -> 通用 verifier |
| 实例级退出 | 已实现 | Perp SHORT/其他永续优先，仓位核验后 Spot close，最后 reconciliation |
| Binance Spot/Perp | 生产闭环 PASS | 已完成真实开仓、对冲、退出、CLOSED 验收 |
| OKX Spot/Perp | 生产闭环已有 PASS 记录 | 既有 Test C 四笔订单全部 CONFIRMED，当前事实需重新 fresh read |
| Bitget Spot/Perp | 生产闭环 PASS | DOGE Spot BUY、Perp SHORT、Perp CLOSE、Spot SELL，最终 `CLOSED` |
| Bybit | 代码/测试能力已接入，生产闭环未验收 | 不得把 capability tests 当作真实资金 PASS |
| 四 venue 持续 gate | 当前已开启 | 见第 5 节；这是全局真实 mutation 资格，不是单实例开关 |

## 2. 已实现功能

### 统一执行与生命周期

正式调用链：

```text
authenticated API
-> ArbitrageExecutionCommandService / ArbitrageInstanceExitService
-> ExecutionIntent
-> FormalExecutionRuntimeRegistry
-> Venue Formal Runtime
-> Venue Intent Runtime
-> ExecutionRecord + recovery reference
-> ExecutionCoordinator
-> Venue Capability
-> ExecutionMutationSafetyGuard
-> Provider
-> Provider GET / reconciliation
```

已实现的生命周期能力包括：

- 机会 Draft、数量和交易规则 fresh preview。
- Final Confirm 创建或复用确定性的 `ArbitrageInstance`。
- 第一腿执行、成交确认和 Spot opening attribution。
- 第二腿按第一腿实际 base exposure 规划合法数量。
- `ExecutionRecord`、`ExecutionReference`、Provider order identity 和 recovery anchor 持久化。
- `PENDING_CONFIRMATION`/`UNKNOWN` 的 query-first reconciliation；不自动换 request-id 重试。
- 实例级 close 顺序和部分平仓数量上限。
- 已知订单 cancel/recovery 边界。
- 四个 venue 的独立 credential、account-read、position read 和交易规则适配。

### Venue 实现

- Binance：Spot 与 USDT Linear Perpetual，canonical base quantity，`reduceOnly` close，PositionReader，Spot `myTrades` 归因。
- OKX：Spot/Swap contract quantity 与 base quantity 转换，order reference recovery，formal close/reconcile。
- Bybit：Spot/linear perpetual client、PositionReader、quantity rules、formal runtime、cancel/reconcile 和测试覆盖已接入。
- Bitget：Unified account read、HEDGE/ONE_WAY position read、Spot/USDT futures mapping、HEDGE `posSide` 处理、order reference recovery、formal close/reconcile。

### 近期修复

- `91db5ba`：修复 Bitget HEDGE close 同时传 `posSide` 与 `reduceOnly` 导致 Provider 拒绝的问题。
- `1281472`：共享 Spot 验证层使用 Provider reported total balance 作为真实 `actualQuantity`，不再用本地 managed quantity 冒充真实余额；四个 venue 复用该规则。

## 3. 未实现或待实现

以下项目不能从现有代码或测试推断为已完成：

1. Bybit 真实资金 Spot/Perp 完整生命周期尚未完成生产验收。
2. 四个 venue 的持续多轮资金自测尚未形成独立的批次编排、预算审计和自动化报告流程。
3. 生产 gate 当前是全局进程级环境变量，没有按 user、account、ArbitrageInstance 或测试批次隔离。
4. 生产 UI 尚未完整展示多次 close attempt 的 `executionId`、`intentId`、clientOid、remoteOrderId 和 Provider 原始原因。
5. Spot active-order、perpetual active-order、leverage、margin mode 等读能力不应被当前生命周期版本默认假设；缺失时必须明确 `NOT_AVAILABLE`。
6. `NOTIONAL_USDT` 第一腿在创建实例与执行前重验之间可能因报价变化产生 quantity drift，当前 fail-closed 但可能留下空 `OPENING` 实例。
7. Provider HTTP mutation 与 SQLite dispatch/recovery 持久化不是物理原子事务，仍保留 query-first、fail-closed 和人工接管边界。
8. 正式 consumer 仍以 `Draft -> ArbitrageExecutionCommandService -> Formal Runtime` 为准；没有授权时不得恢复旧的 UnifiedRealTradingTest 或 Funding legacy mutation 路径。

## 4. 已发现问题与运行注意事项

### 已知可观测性问题

同一实例可以存在多条历史 close `ExecutionRecord`。前端当前按腿汇总显示“退出失败/确认中”，容易让用户把早期失败和后续独立成功混为同一次尝试。该问题不改变已确认的真实资金结果，但会降低诊断准确性。

规则应保持：

- Provider 明确 rejected/cancelled 且零成交：`FAILED`。
- 超时、断连、响应缺失、解析失败或远端状态不可确认：`UNKNOWN`/`PENDING_CONFIRMATION`。
- 有匹配 clientOid/orderId 且 Provider 终态完整成交：`CONFIRMED`。
- 不得仅凭当前仓位归零把旧 `FAILED` 记录改写为成功。

### 生产配置风险

四个 gate 当前持久开启，含义是所有经过正式 Runtime、权限和 Safety Guard 的对应 venue mutation 都具备资格：

```text
LIVE_TRADING_ENABLED=true
BINANCE_KILL_SWITCH=false
OKX_LIVE_TRADING_ENABLED=true
OKX_KILL_SWITCH=false
BYBIT_LIVE_TRADING_ENABLED=true
BYBIT_KILL_SWITCH=false
BITGET_LIVE_TRADING_ENABLED=true
BITGET_KILL_SWITCH=false
```

这不是单实例授权。任何维护、部署、浏览器误操作或其他用户请求都必须按真实 mutation 处理。紧急停机应恢复各 venue kill switch 为 `true`，并将 live flags 设为 `false`。

### 身份与数据边界

- Credential 必须经 authenticated route 和 Provider identity validation；禁止 SQL 手改、绕过 auth 或直调 Provider。
- `ArbitrageInstance.managed quantity` 是 StellaX 所有权事实，不是账户总余额。
- 外部人工仓位、其他实例余额和同 symbol 仓位不得自动归属当前实例。
- Spot total、Spot available 和 perpetual LONG/SHORT bucket 必须按各自权威 Provider read 来源解释。

## 5. 当前部署与 Git 状态

- Production revision：`1281472`
- API/Web：revision image `1281472`
- API health：HTTP 200
- Provider mutation during this documentation/release operation：`0`
- `placeOrder`：`0`
- `cancelOrder`：`0`
- 本地 Git：`main` 与 `origin/main` 已同步（文档提交后应再次核对）。

## 6. 后续操作原则

1. 任何真实资金 mutation 前先做 fresh authenticated readiness、identity、position bucket 和数量规则检查。
2. 一次只操作一个明确的实例和 request identity；`UNKNOWN`、`PENDING_CONFIRMATION`、verification mismatch 或 recovery identity conflict 立即停止。
3. 完成一轮测试后立即记录每条 ExecutionRecord、Provider order identity、成交数量、费用、managed quantity、仓位核验和 reconciliation。
4. 四 venue 连续自测完成前，不把 Bybit 代码接入状态写成生产闭环 PASS。
5. 生产部署成功不等于真实资金授权；gate 开启状态必须在交接和每次操作前显式核对。
