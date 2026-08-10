# PROJECT_CONTEXT.md

# 项目上下文

> 本文件用于向 AI Agent 提供当前项目事实。
>
> 本文件不是任务规则，不替代 AGENTS.md。 本文件不是历史记录，不替代
> CHANGELOG.md。
>
> 如当前任务与本文档冲突，以用户最新明确指令为准。历史归档不得覆盖本文档中的当前事实。

------------------------------------------------------------------------

# 1. 项目认知

本项目是一个已经持续开发中的自动交易系统。

AI Agent 必须理解：

-   当前不是新项目。
-   所有开发必须基于已有代码、已有架构和已有文档。
-   不允许因为不了解历史而重新设计系统。

当前核心方向：

建设自动交易、套利、账户管理和交易基础设施能力。

------------------------------------------------------------------------

# 2. 当前阶段

当前项目处于：

个人多用户 Binance 自动套利的真实运行与长期稳定性验证阶段。

当前重点：

-   保留 demo 模拟交易能力。
-   保持 Binance 真实交易闭环稳定。
-   保持多用户交易所凭证隔离和加密存储。
-   完善套利策略、订单对账和仓位同步。
-   保持真实交易默认关闭和风险上限不扩张。

------------------------------------------------------------------------

# 3. 当前核心模块

## 3.1 Demo 交易

路径：

`/app/demo`

定位：

内部模拟交易环境。

要求：

-   保持独立。
-   不被真实交易逻辑改造破坏。
-   用于功能验证和交易流程演示。

------------------------------------------------------------------------

## 3.2 真实交易

路径：

`/app/trade`

定位：

真实交易接入方向。

原则：

-   用户使用自己的授权方式。
-   平台不保存用户私钥。
-   交易权限和资产边界必须明确。

------------------------------------------------------------------------

## 3.3 套利能力

路径：

`/app/arbitrage`、`/app/my-arbitrage`

当前能力：

-   公共套利行情与机会展示继续保留。
-   用户端“我的自动套利”提供多交易所 API 配置和 Binance 个人套利操作界面。
-   Binance 支持 API 连接、行情、资金费率、余额、下单、撤单、成交查询、仓位同步和订单对账。
-   Binance 资金费率套利具备入场、退出、风险检查和订单状态管理。

当前验证重点：

-   交易执行可靠性。
-   状态一致性。
-   异常恢复。
-   多用户凭证隔离。

------------------------------------------------------------------------

# 4. 技术架构事实

## 前端

当前技术：

-   React
-   TypeScript
-   Vite
-   Tailwind CSS
-   React Router
-   Zustand
-   Lightweight Charts

前端职责：

-   页面展示
-   用户交互
-   状态管理
-   数据展示

禁止：

前端承担交易核心规则。

------------------------------------------------------------------------

## 后端

当前技术：

-   Node.js
-   TypeScript
-   Express
-   WebSocket

后端职责：

-   API
-   数据处理
-   交易逻辑
-   状态管理
-   服务端校验

------------------------------------------------------------------------

## 数据

当前：

SQLite。

SQLite 同时保存按用户隔离的加密交易所凭证和 Binance 订单状态；运行数据不进入 Git。

原则：

当前阶段保持轻量架构。

除非出现明确瓶颈，否则不主动替换数据库。

------------------------------------------------------------------------

# 5. 交易与安全边界

必须遵守：

## 用户资产边界

当前系统不应默认理解为平台托管用户资产。

禁止：

-   保存用户钱包私钥。
-   明文保存或回显交易所 Secret。
-   绕过权限执行资金操作。

交易所 API 凭证使用 `UserExchangeCredential` 按用户、venue、account 和 environment
隔离。Secret 采用每凭证 DEK 的 AES-256-GCM envelope encryption，DEK 由 GCP KMS
包装；解密仅在交易执行需要时发生。

------------------------------------------------------------------------

## 交易流程

交易链路：

行情

↓

策略判断

↓

风险检查

↓

订单执行

↓

交易所交互

↓

成交确认

↓

仓位管理

↓

收益统计

要求：

-   可追踪
-   可恢复
-   可审计

------------------------------------------------------------------------

# 6. 部署与环境认知

当前采用：

-   Docker
-   Docker Compose
-   production-only 部署配置
-   Git commit / deployment version 作为 revision 标识

当前唯一部署环境为 production：

-   Compose project 固定为 `xingheng`。
-   GCP KMS 使用普通 ADC / Workload Identity，不依赖 release identity 或固定 UID/GID。
-   不保留独立真实测试部署环境、测试域名、测试 Compose 或测试数据卷。
-   Demo、Hyperliquid Testnet 和普通自动化测试能力不属于部署环境，继续保留。

环境变更、发布、真实资金相关操作必须遵守项目沟通规则。

------------------------------------------------------------------------

# 7. 当前开发原则

## 优先级

资金安全

交易正确性

系统稳定

代码维护性

功能扩展

------------------------------------------------------------------------

## 不主动做的事情

除非明确需求：

不主动增加：

-   新业务模式
-   新资产体系
-   新交易方式
-   新基础设施

------------------------------------------------------------------------

# 8. 未来规划（非当前开发范围）

未来可能扩展：

-   更多交易所
-   更多套利策略
-   DeFi 能力
-   钱包能力
-   策略收益相关产品能力
-   AI 策略生成能力

注意：

未来规划不代表当前功能。

AI 不得提前实现。

------------------------------------------------------------------------

# 9. 文档关系

当前项目文档职责：

## AGENTS.md

定义：

AI 工作规则。

## PROJECT_CONTEXT.md

定义：

当前项目事实。

## ARCHITECTURE.md

定义：

系统架构。

## 项目沟通规则.md

定义：

任务分发、协作和验收流程。

## CHANGELOG.md

定义：

历史版本记录。

## PROJECT_ONBOARDING.md

定义：

新成员和新 AI 的快速入口与当前状态摘要。

## PROJECT_HISTORY.md

定义：

月份归档与专题历史索引，不作为当前状态来源。

------------------------------------------------------------------------

# 10. AI 使用要求

读取本文件后：

AI 应该理解：

这是一个已有项目。

目标：

在现有基础上稳定演进。

不是：

重新设计一个交易平台。

------------------------------------------------------------------------

# 11. 当前 Binance Personal Trading 基线（2026-08-09）

## 唯一主线与部署

-   唯一代码主线为 `main`。
-   PR #26 merge commit `433cce9ceaa23390e98e5eddee43c57018269a58` 是 Personal
    Trading Mode 主线切换的历史基线；当前代码主线已前进到
    `70a22062425115e5c7fa696ec28ffaa01335a6a5`。
-   最后确认的 Production revision 为 `5f95f27c96f0ebbdf6b0bc6a269d6a945623b11d`，入口为
    `https://app.stellaxtrade.com`。不得用代码主线 commit 推断生产已升级。
-   本地和远端多余分支已清理，仅保留 `main`。

## Binance 调用链

`API -> Strategy -> RiskGuard -> OrderManager -> BinanceClient -> Binance API`

-   策略不直接调用交易所。
-   `position refresh -> risk check -> submit order` 在同一串行锁内完成。
-   `FILLED` 才进入 `complete`；`CANCELED/REJECTED/EXPIRED` 进入 `failed`；
    `NEW/PARTIALLY_FILLED` 保持 `processing` 并进入 reconciliation。
-   reconciliation 只扫描全部非终态订单，并处理 processing timeout。
-   生产套利保持 IOC；独立测试订单支持 GTC LIMIT 的
    `create -> NEW -> cancel -> CANCELED`。
-   启动时校验 XAUTUSDT perpetual 杠杆必须为 1x，不自动修改杠杆。

## 安全默认值

-   `LIVE_TRADING_ENABLED=false`
-   `BINANCE_KILL_SWITCH=true`
-   `MAX_ORDER_USD=25`
-   `MAX_POSITION_USD=100`

系统不得自动开启真实交易、关闭 kill switch 或扩大风险上限。历史 Permit、Capital Test
Window、Execution Lease、Promotion、Release、Lifecycle、Trusted Build、proof chain、Admin
Approval 和 Recovery workflow 已退出当前架构，不得作为兼容层恢复。

## 当前验证事实

-   Binance Personal Trading 自动化测试：46/46 通过。
-   TypeScript、API bundle、前端 production build 和 `git diff --check` 通过。
-   GCP KMS encrypt/decrypt roundtrip 通过。
-   Binance 公共行情与 symbol 查询通过。
-   最小资金真实交易闭环已由用户确认测试通过；完成后安全默认值保持关闭。
-   Hyperliquid 未纳入本次裁剪和改造范围。

------------------------------------------------------------------------

# 12. Codex 账号交接快照（2026-08-10）

## 当前唯一主线

当前主线是完成 Phase 8B-0 的生产只读 Capital Test Revalidation，在取得新鲜、已认证的
Binance GET 证据后，再由用户决定是否进入任何真实资金步骤。只读复核本身不授权下单、撤单、
调杠杆、开关切换或运行 Capital Test Harness。

## 已部署事实

-   Production revision 仍记录为 `5f95f27c96f0ebbdf6b0bc6a269d6a945623b11d`。
-   Phase 8A 已完成冻结、部署和部署后只读验证。
-   上一次已确认的安全默认值为 `LIVE_TRADING_ENABLED=false`、
    `BINANCE_KILL_SWITCH=true`；Phase 8B-0 必须重新取得运行态证据，不能仅沿用该历史结论。

## Phase 8B-0 当前状态

-   来源 Codex 任务：`019fea5b-dbe9-78b2-a601-d5099aee7d42`。
-   已确认 Chrome Profile `Stellar` 即目标 `chrome-stellar`。
-   浏览器控制通道连续超时，未取得新的认证 GET 响应体，因此当前结论为 `NOT_READY`。
-   未调用 POST、connection-check、reconciliation 或 Harness；provider/order/position/funds
    mutation 均为 `0`。
-   最小解除动作是恢复或人工确认 `chrome-stellar` 浏览器连接，再执行白名单 GET 只读复核。

## Phase 8B-1 代码状态

Phase 8B-1 Harness 改动已由 commit `70a22062425115e5c7fa696ec28ffaa01335a6a5` 进入
`main`/`origin/main`，涉及：

-   `scripts/run-binance-capital-test-once.ts`
-   `scripts/run-binance-capital-test-once.test.ts`
-   `server/modules/binance/BinanceCapitalTestPreflight.ts`
-   `server/modules/binance/BinanceExecutionCapability.test.ts`

该实现为同一 one-shot Harness 增加 `PRICE_PRIORITY -> IOC_LIMIT` 与
`EXECUTION_PRIORITY -> MARKET` 两种模式、稳定且互斥的 run identity/receipt、权限 fail-closed
检查和 processing order 门禁。来源任务报告本地 Binance/Harness 回归 `133/133` 通过及 production
build 通过。该 commit 尚未被记录为已部署 production revision，也不构成真实资金授权；继续
Phase 8B 前仍须完成生产只读 Gate。
