# PROJECT_CONTEXT.md

# 项目上下文

> 本文件用于向 AI Agent 提供当前项目事实。
>
> 本文件不是任务规则，不替代 AGENTS.md。 本文件不是历史记录，不替代
> CHANGELOG.md。
>
> 如当前任务与本文档冲突，以用户最新明确指令为准。历史归档不得覆盖本文档中的当前事实。

------------------------------------------------------------------------

# CURRENT AUTHORITATIVE SNAPSHOT（Round 1–6 已封板）

以下是当前代码语义的权威摘要；本文后续带日期的阶段记录和审查结论仅用于解释历史，如有冲突以本节为准。

- `SPOT_PERPETUAL` 使用服务端一键 Start：用户一次确认，Spot 必须第一腿；Spot 完整 `CONFIRMED` 后才自动执行 Perpetual 第二腿。`FAILED0`、partial、`PENDING_CONFIRMATION`、`UNKNOWN` 均不自动执行第二腿；terminal partial 只能由用户显式 partial continue，按已确认可归因 Spot exposure 规划且不重试第一腿。
- `PERPETUAL_PERPETUAL` 保留现有合法 first-leg 选择，不套用 Spot-first 规则。`/legs/confirm` 兼容入口仍然有效，不因当前编排语义而删除。
- trading halt 阻止 INCREASE；正式管理仓位的 DECREASE、已知订单 cancel、query、reconcile 和 recovery 继续允许，并各自保持既有安全 gate。
- Account Reality 是 Provider 账户事实；Active Managed Exposure 是实例管理责任账本；Instance Hedge Delta 是该实例可归因 signed exposure 之和，不是全账户 Delta。三者不得互相覆盖。
- `CLOSED` 表示实例 Active Managed Exposure 已归零；`closedAt` 是管理责任终结时间。归零可以来自正常 close、Management Release 或两者组合，不证明 Provider 账户仓位已由系统全部平仓。Management Release 无 Provider mutation，不伪造 confirmed close。
- restart 和 recovery 不自动恢复交易意图或自动派发第二腿；恢复始终 query-first。超时不等于 `FAILED0`，not found 不等于 `NOT_DISPATCHED`，`UNKNOWN` 必须 fail closed。
- `executionMode` 是 Draft 的显式服务端契约，并在 Confirm / Start 重验。当前 OKX `PRICE_PRIORITY` capability 不可用，Draft/Confirm/Start 均 fail closed；`EXECUTION_PRIORITY` 保持可用。
- `automationEligible`、entry status、disqualifiers、APR、funding、capacity 和 score 是分析、排序与人工决策信息，不是当前手动 Start 的硬门禁。
- Round 1–6 已完成封板审查与对应修复，当前确认的该范围资金安全 P0/P1 为零。旧 chronology 中的手动第二腿、旧 verification、旧 halt 或旧 recovery 表述均已被本节和当前产品/架构文档取代。

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

真实交易能力建设与稳定性验证阶段。

当前重点：

-   保留 demo 模拟交易能力。
-   推进真实交易接入。
-   完善账户体系。
-   完善交易、风险、安全和运维能力。

## 2.1 2026-08-18 当前执行基线

-   当前 production revision 为 `2bcea91e4e57096d34b63ef0098cf2811e56c547`，API healthy，
    `RestartCount=0`。
-   OKX Spot / Perpetual 已接入统一正式执行链：`ExecutionIntent -> FormalExecutionRuntime ->
    OKX Capability -> Mutation Safety Guard -> Provider`。Binance 既有正式执行语义未改变。
-   OKX DOGE Test C 已完成真实资金闭环：Spot BUY `110 DOGE`，扣除 base fee 后实际 exposure
    `109.89 DOGE`；Perpetual SHORT/close `100 DOGE`；Spot close `109.89 DOGE`。四个
    ExecutionRecord 和四个唯一 Provider `ordId` 均为 `CONFIRMED`，最终 Perpetual=`FLAT`、
    active orders=`0`、DOGE 仅保留测试前 dust `0.000000824`。
-   第二腿数量已按第一腿权威成交事实计算：`109.89 DOGE target -> 100 DOGE executable`，
    `9.89 DOGE` 为持有期间的 venue 粒度 residual；双腿退出后不存在残余敞口。
-   最终安全状态为 `OKX_LIVE_TRADING_ENABLED=false`、`OKX_KILL_SWITCH=true`、
    `LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true`。新的真实资金操作必须重新获得明确授权。
-   已知 P1：`NOTIONAL_USDT` 第一腿在实例创建与执行前重验之间可能因报价变化产生精确数量漂移，
    fail closed 为 `arbitrage_instance_mismatch`，Provider mutation=`0`，但会留下无执行引用、无敞口的
    空 `OPENING` 实例。该问题尚未修复。

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

`/app/arbitrage`

当前能力：

-   自动套利相关能力持续建设。
-   支持策略执行、状态管理和风险控制。

当前验证重点：

-   交易执行可靠性。
-   状态一致性。
-   异常恢复。
-   审计记录。

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
-   保存可直接代签敏感凭证。
-   绕过权限执行资金操作。

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
-   自动化部署和验证流程

当前唯一部署环境为 production：

-   Compose project 固定为 `xingheng`。
-   WIF 路径固定为 `/run/xingheng/gcp-wif`。
-   不保留独立真实测试部署环境、测试域名、测试 Compose、测试凭证域或测试数据卷。
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

# 11. 当前生产与资金测试门禁（2026-08-13）

## 当前唯一主线

最终业务目标仍是在 production 完成一次真实资金的自动开仓、对冲、退出和最终核账。
当前已完成套利系统前端收敛、四交易所账户只读边界、套利实例持久化与只读仓位核验，并完成
Binance、OKX、Bybit、Bitget 的真实网络 GET-only 前置复验。四所只读能力均达到后续“小额真实资金
测试设计/授权阶段”的技术前置条件，但尚未取得任何真实资金执行授权。

## Production 当前事实

-   当前 production revision：
    `03508fe624d612b1870a45075c9c890950bc8789`。
-   该 revision 为 Bitget Position 空仓响应兼容修复 checkpoint；API 为 `running/healthy`，Web
    为 `running`。
-   `USER_CREDENTIAL_ENVIRONMENT=production`。
-   `LIVE_TRADING_ENABLED=false`。
-   `BINANCE_KILL_SWITCH=true`。
-   `BINANCE_ALLOWED_EGRESS_IPS=207.148.64.33`。
-   Compose project：`xingheng`。
-   Global/server kill switch：`ENABLED`。
-   本轮真实网络复验仅执行 GET/read-only；Provider mutation、订单和资金操作次数均为 `0`。
-   Binance / OKX / Bybit / Bitget 只读 readiness：均为 `READY`。
-   Bitget 已确认 Unified 账户模式；BTCUSDT 空仓 `data.list=null` 可被正确识别为合法空仓，品种
    映射和 Trading Rules 均通过。

## 当前 Gate 状态

-   四交易所 GET-only 技术前置：`READY`。
-   小额真实资金测试设计/授权阶段：可以进入。
-   Capital Test Authorization：`REVALIDATION_REQUIRED`；不得沿用旧 release 或旧时间窗口授权。
-   Capital Test Execution：`BLOCKED_PENDING_AUTHORIZATION`。
-   Provider mutation / Trading Access：`NOT_AUTHORIZED`。
-   Real Funds：`NOT_AUTHORIZED`。
-   历史记录中的 P2#2 rollback readiness、STS restore verification 和 rollback evidence 尚无新的
    完成证据，不得因本轮 GET-only readiness 而标记为 `PASS`；正式授权材料必须重新核对其当前状态。

四所 `READY` 仅代表已验证凭证加载、账户读取、仓位读取、品种映射和 BTC/USDT 交易规则读取等
GET-only 前置，不代表订单、仓位或资金 mutation 已验证，也不构成 execution permit。

## 当前授权准备边界

本机私有 authorization package 保存在 `docs/private/authorization/`，不进入 Git。任何旧材料
不得自动用于当前 production revision。进入小额真实资金测试前，必须基于固定 production release
identity、逐所真实 Trading Rules、账户权限和安全开关重新生成并人工批准授权材料。未经该独立批准，
不得生成 Permit、打开 `LIVE_TRADING_ENABLED`、关闭 kill switch、下单或执行任何
position/order/funds mutation。

------------------------------------------------------------------------

# 12. 部署流程边界更新（2026-08-12）

-   此前文档中的标准 Release Workflow 属于未完整落地的草案；相关脚本和 trusted launcher
    不再作为当前部署前置。
-   当前部署流程以 [`RELEASE_PROCESS.md`](./RELEASE_PROCESS.md) 为准：固定 commit SHA、固定
    Docker image tag、`docker compose -p xingheng config`、`npm run build`、Docker build、
    `docker compose -p xingheng up -d api web`、health/smoke check、SQLite backup/restore。
-   部署可以在用户明确授权后执行，但部署不等于真实资金授权。
-   部署流程不得自动打开 `LIVE_TRADING_ENABLED`，不得自动关闭 `BINANCE_KILL_SWITCH`，不得执行
    provider mutation、funding cycle、repair、retry 或 residual close。
-   主机地址、账号、密钥、凭证和敏感访问方式不进入项目文档；实际连接与制品交付继续使用受控
    运维渠道。

------------------------------------------------------------------------

# 13. 当前交接快照（2026-08-14）

## Revision 边界

-   当前本地 `main` HEAD：
    `afb2af176d7c743b667b7038fe6a2af662484baf`（`fix(risk): gate spot sell execution`）。
-   当前本地分支相对 `origin/main` 为 `ahead 31`；这些本地 checkpoint 不等于已经 push、发布或部署。
-   最后有明确部署与健康验证证据的 production revision 仍为：
    `03508fe624d612b1870a45075c9c890950bc8789`。
-   本文档更新任务没有重新连接 production，因此 production revision、容器健康和运行时环境值仍应
    视为第 11 节记录的最后已验证快照，而不是 2026-08-14 的实时复验结果。
-   当前工作区业务代码 clean；`PROJECT_CONTEXT.md` 为独立未提交交接文档修改。

## 当前主线结论

Binance 正式套利执行的 application、持久化、恢复和退出链已经在本地 checkpoint 中基本闭合；
OKX、Bybit、Bitget 目前仍只有账户/仓位/余额等真实只读能力，没有正式 `ExecutionCapability`。
截至本文档更新时，尚未部署最新 Binance execution revisions，尚未重新完成基于最新 HEAD 的
`Production Readiness Audit V2`，也没有取得或执行任何真实资金授权。

------------------------------------------------------------------------

# 14. 已完成能力与 checkpoint

## ArbitrageInstance 与“我的套利”

-   `f74fcbc`：最小 `ArbitrageInstance`、两条腿、ExecutionReference、SQLite Store、生命周期、用户
    隔离与重启恢复。
-   `cb4b523`：`ExecutionIntent` 与 `arbitrageId/legId` 绑定，ExecutionReference 写回真实执行身份。
-   `6348634`：ArbitrageInstance Query/API 与“我的套利”当前/历史记录展示。
-   `129d27f`、`e095386`：已知套利实例的只读仓位核验边界及四交易所 production provider
    composition；Positions/Balance 仅用于核验，不用于发现或创建套利。
-   `a320e42`、`03508fe`：真实响应兼容修复，包括 Catalog 逐项容错与 Bitget UTA 空仓
    `data.list=null` 兼容。
-   `b666f2e`：“我的套利”实时核验 UI、交易所账户详情与 Binance 只读诊断整合。

权威归属继续是 `ArbitrageInstance`。外部手工仓位不自动识别、不归组、不管理，也不会因为
symbol、方向或数量相似而进入“我的套利”。

## 数量规划与 Binance generic execution

-   `981d87f`：`ExecutionQuantityPlanner`，支持 `NOTIONAL_USDT` 与 `ASSET_QUANTITY`，输出仍为 Decimal
    `AssetQuantity`；Planner 不读取余额、保证金、仓位、RiskGuard 或 execution gate。
-   `41d0b16`：Binance Generic Execution Read Context 与最小 canonical Asset source。
-   `f453978`：Binance provider symbol、quantity、OrderStore symbol persistence，以及
    query/cancel/reconciliation 的通用品种参数化。
-   `e09cc14`：generic IOC execution price 全链 Decimal string；MARKET 不伪造 limit price。
-   `18c81c2`：instrument-aware Generic RiskGuard，包含 Spot/Perpetual balance、margin、position、
    open-order、leverage、permission 和 gate 校验。
-   `afb2af1`：修正 Spot SELL gate；Spot SELL 不再被视为 reduceOnly 风险降低操作，继续受到
    `LIVE_TRADING_ENABLED` 与 `BINANCE_KILL_SWITCH` 约束。

当前 generic Binance 范围仅为：

-   USDT Spot；
-   USDT Linear Perpetual；
-   当前显式 canonical asset data：BTC、ETH、DOGE、XAUT；
-   Decimal quantity、Decimal price、真实 provider symbol、真实 Trading Rules。

不支持 inverse、coin-margined、非 USDT 产品，也不应通过字符串拼接或 provider symbol 猜
canonical asset/type。

## 正式套利执行入口

-   `458df28`：套利分析页正式 Draft/Preview 与数量规划 UI；Preview 不创建 Instance/Intent/Record。
-   `69f363b`：Final Confirm、创建 ArbitrageInstance、用户明确选择第一腿、ExecutionIntent、
    ExecutionReference、正式 Binance runtime、ExecutionRecord 与 `applyExecutionResult()` 闭环。
-   第二腿仍是当前安全阶段的人工再次确认；只有第一腿 `CONFIRMED` 且
    `confirmedQuantity === requestedQuantity` 才能解锁。
-   任一腿没有正式 execution capability 时，禁止开始第一腿 mutation；当前只有 Binance 可执行。

## 成交归因、恢复、退出与撤单

-   `d9ce064`：Spot/USD-M partial fill 的权威 Decimal `confirmedQuantity` 归因；UNKNOWN 不再伪造为
    `"0"`，`applyExecutionResult()` 使用 absolute cumulative quantity 幂等更新。
-   `13e85a4`：PENDING/UNKNOWN 用户主动 reconciliation recovery。
-   `203c90b`：正式 `/api/arbitrage-execution` 路由接入现有 authenticated user middleware。
-   `3371805`：CLAIMED ExecutionReference 通过唯一 `intentId` 恢复 ExecutionRecord link，之后继续
    reconciliation；记录缺失或多记录冲突均 fail closed。
-   `31b1f4b`：Binance USDT Linear Perpetual 正式 reduceOnly close。
-   `4883dcf`：Binance USDT Spot LONG 正式 SELL close；Spot close 不使用 reduceOnly，也不绕过 gate。
-   `60a8baf`：已知 StellaX active order 正式 cancel application 入口。
-   `db4170e`：cancel dispatch 持久化与重启恢复状态收口。

当前 Binance 正式产品能力状态：

-   `BINANCE_PARTIAL_FILL_DECIMAL_ATTRIBUTION_GAP = CLOSED`
-   `PENDING_UNKNOWN_RECONCILIATION_RECOVERY_GAP = CLOSED`
-   `FORMAL_EXECUTION_AUTH_PREFIX_GAP = CLOSED`
-   `EXECUTION_REFERENCE_LINK_RECOVERY_GAP = CLOSED`
-   `FORMAL_PERPETUAL_CLOSE_COMMAND_MISSING = CLOSED`
-   `SPOT_CLOSE_NOT_YET_WIRED = CLOSED`
-   `FORMAL_ARBITRAGE_CLOSE_COMMAND_MISSING = CLOSED`（仅限当前 Binance 支持范围）
-   `FORMAL_KNOWN_ORDER_CANCEL_ENTRY_MISSING = CLOSED`
-   `CANCEL_CLAIM_BEFORE_MUTATION_RECOVERY_GAP = CLOSED`

------------------------------------------------------------------------

# 15. Cancel dispatch 最终语义与残余风险

`binance_personal_orders` 继续保留 `cancelRequestedAt` 作为审计时间，并新增最小
`cancelDispatchState`：

-   `CLAIMED_NOT_DISPATCHED`
-   `DISPATCHED_UNKNOWN`
-   `TERMINAL_CONFIRMED`
-   `LEGACY_UNKNOWN`

恢复规则：

-   `CLAIMED_NOT_DISPATCHED` 且 Provider 明确 active：允许补发一次 cancel；
-   `DISPATCHED_UNKNOWN`：只 query/reconcile，不盲目重复 cancel；
-   Provider 已 terminal：不再次 cancel，进入 `TERMINAL_CONFIRMED`；
-   Provider unknown 或 query failure：fail closed；
-   旧 `cancelRequestedAt` 数据统一解释为 `LEGACY_UNKNOWN`，不猜测是否已 dispatch；
-   canceled-with-partial 继续保存权威 Decimal `confirmedQuantity`，并经现有 reconciliation 与
    `applyExecutionResult()` 更新实例。

风险状态必须保持准确：

-   `CANCEL_CLAIM_BEFORE_MUTATION_RECOVERY_GAP = CLOSED`
-   `CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK = RESIDUAL`

残余风险指：Provider HTTP transport 已开始，但 SQLite 尚未成功写入 `DISPATCHED_UNKNOWN` 时进程被
强制终止。HTTP transport 与 SQLite 无法组成真正原子事务。当前不应为消灭该物理窗口引入复杂事务
协调系统；下一轮 Production Readiness Audit 必须评估它在“小额、人工可接管”的首测条件下是否可接受。

------------------------------------------------------------------------

# 16. 当前测试与安全证据

-   `db4170e` checkpoint 聚焦测试：`53 PASS / 0 FAIL`。
-   完整回归超集：`496 PASS / 0 FAIL`。
-   Server TypeScript、API bundle、Vite production build、完整 `npm run build`、`git diff --check`：
    均通过。
-   上述测试全部使用 fake/mock transport；真实 Provider mutation、订单和资金操作次数为 `0`。
-   `afb2af176d7c743b667b7038fe6a2af662484baf` 增加 Spot SELL 在 LIVE=false/Kill Switch active
    时 fail closed 的 RiskGuard 与 OrderManager 回归覆盖；提交范围为 3 个文件、`48 insertions / 4
    deletions`，定向回归 `58 PASS / 0 FAIL`，Server TypeScript、`npm run build` 与
    `git diff --check` 均通过，真实 Provider mutation 为 `0`。未 push、未部署、未真实下单。

这些测试证据证明本地代码边界，不代表 production 已部署或真实资金执行已经验证。

------------------------------------------------------------------------

# 17. 当前未完成事项与下一步

## 必须先做

1.  `Production Readiness Audit V2` 已在 `db4170e` 上完成，结论为 `NOT_READY`；不得进入真实资金测试。
2.  V2 初稿把 generic path 不执行 legacy `MAX_ORDER_USD / MAX_POSITION_USD` 错列为 blocker；后续
    context rebase 已纠正。Generic execution 不设置固定 25/100 平台上限，这是已确认产品规则。
3.  Context rebase 在 `db4170e` 发现 legacy XAUT Spot SELL 错误绕过 LIVE/Kill gate；该代码 blocker 已由
    `afb2af1` 最小修复。需要基于当前 HEAD 重新完成 readiness 审计确认。
4.  选择固定 deployment revision；当前本地 HEAD 已前进至 `afb2af1`，不能继续把
    `db4170e` 当作最新部署目标。
5.  备份后受控部署固定 revision，验证 `cancelDispatchState` migration、API/Web health、CredentialStore、
    KMS/WIF 与 runtime identity。
6.  通过正式 production CredentialStore 与 user-scoped Binance client 完成实时 GET-only 私有验证：
    账户身份、权限、余额、仓位、活动订单、账户/仓位模式与 leverage。
7.  基于部署后的固定 revision 重新执行 readiness audit。只有结论为 `READY` 后，才可请求针对明确
    instrument/quantity/execution mode/安全开关窗口的单独人工真实资金授权。

## 仍然禁止默认推断

-   不得把当前本地 checkpoint 当作已部署。
-   不得把 GET-only readiness 当作 execution permit。
-   不得因 Binance generic execution 已完成而认为 OKX、Bybit、Bitget 可以执行。
-   不得自动打开 `LIVE_TRADING_ENABLED`、关闭 kill switch、创建真实订单或执行资金操作。
-   不得自动执行第二腿、自动 residual hedge、自动退出或自动修复。

## 后续范围

-   OKX、Bybit、Bitget 正式 ExecutionCapability 尚未实现，应分别进入独立阶段。
-   Legacy XAUT Capital Test、Funding manual execution、XAUT diagnostics/residual 仍保留；待 generic
    execution、single-venue smoke 和新套利 execution 稳定替代后，再进入独立 cleanup。
-   混合外部手工仓位与 StellaX managed exposure 的可靠归因仍是后续问题；当前只读 verification
    发现不一致时返回 `MISMATCH/UNKNOWN`，不得认领外部订单或修改实例数量。

------------------------------------------------------------------------

# 18. Binance Production Readiness Audit V2 结果

## 审计身份与结论

-   审计 revision：`db4170e3ac37b41f4d950072ccaf35d997a5c4e6`。
-   结论：`NOT_READY`，不满足小额真实资金测试条件。
-   审计只读完成；未修改代码、未部署、未调用真实 mutation。
-   当前本地 HEAD 后续已前进至 `afb2af1`，因此该审计不是当前 HEAD 的最终 readiness 结论，但其未解决
    blocker 继续有效。

## 正式执行链审计

代码层正式链路已经接通：

`Draft/Preview → Final Confirm → ArbitrageInstance → Leg Confirm → ExecutionIntent →`
`ExecutionReference → BinanceFormalArbitrageExecutionRuntime → BinanceIntentExecutionRuntime →`
`ExecutionCoordinator → BinanceIntentExecutionService → BinanceOrderManager → BinanceRiskGuard →`
`BinanceClient → ExecutionRecord → applyExecutionResult`

认证与 user/account isolation 代码边界通过；production composition 未接 fake/test runtime，也未发现
RiskGuard bypass。

## 恢复、退出与 crash window

-   Decimal partial attribution：`PASS`。
-   PENDING/UNKNOWN reconciliation：`PASS`。
-   ExecutionReference link recovery：`PASS`。
-   Perpetual reduceOnly close：代码层 `PASS`。
-   Spot LONG close：代码层已接通；`afb2af1` 后 Spot SELL 明确受 LIVE/Kill Switch 正常 gate 约束。
-   Known-order cancel：`PASS`。
-   Cancel dispatch recovery：`PASS`，但 atomicity risk 保持 `RESIDUAL`。
-   claim 后、创建 ExecutionRecord 前崩溃不会产生 Provider mutation，但可能留下无法自动完成的 CLAIMED
    reference：当前分类为 `DEBT`，不是已解决能力。

`CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK` 的最坏结果是 Provider 已收到 cancel，但本地尚未写入
`DISPATCHED_UNKNOWN`；重启后可能再次尝试一次 cancel。Provider query 正常时可识别终态；query 失败
或订单仍 active 时可能需要人工登录 Binance 接管。审计认为该风险可作为小额首测的人工兜底候选，
但不是零风险，且当前整体仍被其他 blocker 阻断。

## Production 实时状态

审计时 production 实际值：

-   `GIT_COMMIT=03508fe624d612b1870a45075c9c890950bc8789`
-   `LIVE_TRADING_ENABLED=false`
-   `BINANCE_KILL_SWITCH=true`
-   production 尚未运行 `db4170e` 或当前 `afb2af1`。
-   production SQLite 尚未执行 `cancelDispatchState` migration。
-   production 容器身份已确认 `uid=20001,gid=20001`；WIF 目录权限 `0700`、ADC 文件权限 `0400`。
-   代码层 CredentialStore/KMS/WIF 接线通过，但审计没有完成正式 CredentialStore → KMS/WIF →
    user-scoped Binance client 的实时私有 GET。
-   实时余额、仓位、活动订单、账户模式和当前 leverage 状态均未确认，不能用旧 credential 摘要替代。

## 首测候选的公开规则快照

审计只使用 Binance public GET，以下不是下单授权，也没有证明私有余额覆盖：

| 资产 | Spot+Perpetual 最低共同合法数量 | 两腿估算总名义金额 |
| --- | ---: | ---: |
| BTC | `0.001` | 约 `126.70 USDT` |
| ETH | `0.011` | 约 `41.44 USDT` |
| DOGE | `72` | 约 `10.07 USDT` |
| XAUT | `0.002` | 约 `17.24 USDT` |

首测应优先 generic asset，不优先 XAUT legacy；正式执行前必须重新读取实时价格和 Trading Rules。

## V2 初稿记录的未通过项（以第 19 节修正分类为准）

1.  Production 未运行当前目标 revision，相关 migration 与启动健康状态未验证。
2.  尚未通过正式 CredentialStore/KMS/WIF 路径完成 Binance 实时私有 GET-only 验证。
3.  实时余额、仓位、活动订单、账户模式与 leverage 未确认。
4.  `CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK = RESIDUAL` 必须在下一轮审计中明确接受或阻断，
    不能标记为已消失。

V2 初稿中的 `GENERIC_RISK_CAP_MISSING = BLOCKER` 已撤销。Generic execution 不使用固定 25/100 cap
是既定产品规则；legacy XAUT/Capital Test 继续保留旧 cap 与 1x 约束。不得把这条旧规则重新带回
generic execution。

OKX、Bybit、Bitget 仍没有正式 ExecutionCapability；上述结论仅针对 Binance Spot + USDT Linear
Perpetual，不能解释为整个多交易所套利系统 production-ready。

------------------------------------------------------------------------

# 19. Context Rebase 与 Readiness 修正

在 `db4170e` 上重新核对代码和既定产品规则后，V2 初稿得到以下纠正：

## 不可重新推翻的规则

-   Generic Binance execution 不使用固定 `MAX_ORDER_USD=25` / `MAX_POSITION_USD=100` 平台上限。
-   25/100 与固定 1x 只属于 legacy XAUT / Capital Test。
-   Generic perpetual leverage 接受交易所返回的任意合法正 Decimal；系统读取并校验，但不主动修改，
    也不设置本地固定最大 leverage。
-   Spot SELL/Spot close 不是 risk-reducing bypass：LIVE=false 或 Kill Switch active 时必须拒绝。
-   只有 Perpetual `reduceOnly=true` 和 known StellaX active order cancel 可以在风险增加 gate 关闭时继续。
-   第二腿继续要求人工再次确认；不得自动第二腿、补单、residual hedge 或资金分配。
-   当前 readiness 只评价 Binance；OKX/Bybit/Bitget 未实现不能列为 Binance-only 首测 blocker。

## 修正后的真实代码结论

-   Generic `assertGenericOrderAllowed()` 不读取 `maxOrderUsd/maxPositionUsd`，不存在隐藏的固定 generic cap。
-   Legacy `XAUTUSDT` 继续进入 legacy RiskGuard，保留固定 cap 和 1x 校验。
-   `db4170e` 的 legacy `isRiskReducing()` 曾把 Spot SELL 错误归为风险降低操作，形成
    `SPOT_CLOSE_GATE_REGRESSION = BLOCKER`。
-   `afb2af1` 已将风险降低语义收紧为仅 `category=linear && reduceOnly=true`，并增加 legacy XAUT Spot
    SELL 在 LIVE=false/Kill Switch active 时阻止 Provider write 的测试。
-   因此当前 HEAD：`SPOT_CLOSE_GATE_REGRESSION = CLOSED`。

## 当前 Readiness 分类

### CODE BLOCKER

-   `db4170e` 审计发现的 Spot close gate regression 已在 `afb2af1` 修复。
-   当前尚未基于 `afb2af1` 完成最终安全审计，因此不能据此直接宣布 `READY`。

### DEPLOYMENT_PREREQUISITE

-   Production 仍运行 `03508fe...`，尚未部署当前固定 revision。
-   Production Binance order DB 尚未实际执行 `cancelDispatchState` migration。
-   部署后必须验证容器启动、schema、API/Web health、CredentialStore、KMS/WIF 与 runtime identity。
-   必须重新执行正式 authenticated GET-only 私有账户核验。

### RESIDUAL_RISK

-   `CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK`。
-   Provider query 暂不可用时可能需要人工登录 Binance。
-   第一腿成功、第二腿尚未人工确认期间存在短时裸露敞口；这是当前人工确认流程的已知边界。

### DEBT

-   Legacy XAUT 与 generic execution 共存。
-   Claim 已持久化、ExecutionRecord 尚未创建时崩溃，会留下无 Provider mutation 的孤儿 reference。
-   Legacy OrderStore reconcile 与正式按 ExecutionRecord reconcile 存在职责重叠，但未形成第二套
    Provider mutation runtime。
-   多层 identity 校验存在重复，目前属于纵深校验，不是正确性 blocker。

### CLEANUP

-   后续可改善 RiskGuard status 中 legacy 25/100 的展示语义，避免被误读为 generic cap。
-   Legacy runtime/harness 和测试只在 generic execution 与正式 smoke 稳定替代后进入独立 cleanup。
-   当前没有为了代码美观立即拆分 Command/Close/Cancel service 的必要。

### NOT_REVERIFIED

-   CredentialStore 实时解密；
-   KMS/WIF 实际 unwrap；
-   Binance account identity；
-   trading permissions / IP restriction；
-   Spot/Futures balances；
-   positions / active orders；
-   account mode / leverage / margin mode。

当前准确结论仍为 `NOT_READY`：不是因为 generic 缺少固定 25/100 cap，而是最新安全修复尚未部署、
production migration 与私有 GET 未复核，且尚未在当前 `afb2af1` 上完成最终 Readiness Audit。

------------------------------------------------------------------------

# 20. 当前权威交接基线（2026-08-16）

本节是截至 2026-08-16 的最新权威快照。第 11 至 19 节保留为阶段过程与审计历史；凡 revision、
production 状态、真实资金验证结论或下一步范围与本节冲突，均以本节为准。

## Revision、production 与工作区

-   当前主线代码 checkpoint：`030f50a4c8a841903097f511ed638c780275e3a8`
    （`feat(cex): checkpoint position verification foundation`）。
-   对应代码 Git tree：`45995916dcbe5f8cdc0e463d42df3bd97f390268`；后续主线提交只更新项目文档。
-   最后已知 production revision 仍为 `25588b2206ba4c39062f3e9d06ee315fed972ea6`；本轮没有部署、
    production 复验或真实资金授权，因此不能把 `030f50a` 写成 production revision。
-   当前安全开关已恢复并核验：`LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true`。
-   本地与 GitHub 统一使用 `main` 作为唯一工作线；仓库同步不会自动触发 production 部署。
-   当前 Unified Quantity Boundary checkpoint：`PASS / CLOSED`。OKX canonical base quantity 只在
    Venue 边界转换为 provider contract quantity；Binance 已验证执行链未修改。
-   当前 Position Verification foundation checkpoint：`ACCEPTED`；OKX 私有 production position
    verification 仍为 `NOT_REVERIFIED / BLOCKED`，真实 Provider mutation：`0`。
-   集成采用 `git merge --ff-only`，未生成额外 merge commit；旧 stash、额外 worktree 和过期实验分支已退出当前工作线。
-   交接时必须核对当前 branch/PR 与上述固定 revision，不得只依据分支名称判断代码身份。

## 仓库工作线

-   唯一工作区：`/Users/moss/Documents/StellaX`。
-   唯一本地开发分支与 GitHub 默认分支：`main`。
-   已被 `main` 包含的旧 checkpoint 分支已删除；旧 phase-11 execution 实验提交明确放弃，未合入主线。
-   过期 release 草稿、历史 RWA automation stash 和额外 worktree 不再作为开发或部署输入。
-   Git 分支整理只改变源码版本管理状态，不修改 production revision、运行配置、数据库、开关或 Provider 状态。

## Position Verification foundation

当前套利仓位验证基础链为：

`Provider Position -> Venue PositionReader -> canonical PositionSnapshot -> PositionVerification -> ArbitragePositionVerificationService`

-   `cex/position` 只接收 canonical instrument、`LONG / SHORT / FLAT`、unsigned Decimal base quantity、
    tolerance 和 account/venue identity，不接收 `pos`、`posSide`、`ctVal` 等交易所原始字段。
-   Binance 与 OKX perpetual reader 已接入该链；OKX contract quantity 只在 Venue reader 边界使用
    authoritative contract size 转换为 canonical base quantity。
-   `MATCHED / MISMATCH / UNKNOWN` 由通用 `PositionVerification` 产生；snapshot 缺失、非法或 instrument
    不匹配时 fail closed 为 `UNKNOWN`。
-   Bybit、Bitget 尚未实现独立 `PositionReader`，不能据此宣称四个 venue 已完成统一仓位验证。
-   legacy `OkxPositionVerification` 仍保留且没有 production wiring；后续 cleanup 不属于本 checkpoint。
-   本 checkpoint 不修改 Execution 模型、数据库 schema、Trading Rules、mutation gate 或正式执行能力。
-   本地 foundation 验收不能替代 production CredentialStore/KMS/WIF/private GET 的实时仓位复核。

## Binance 正式执行闭环

当前 Binance 正式产品链已覆盖：

-   套利分析 Draft/Preview、Final Confirm 与 Resume 已有 `OPENING` instance；
-   authenticated ArbitrageInstance 与 arbitrage-execution API；
-   `ExecutionQuantityPlanner`、generic instrument/rules/quote、Decimal quantity 与 Decimal price；
-   `ExecutionIntent → ExecutionReference → ExecutionCoordinator → Binance runtime → ExecutionRecord`；
-   provider order identity exact-key validation、lossless orderId、持久化 symbol 与 restart recovery；
-   partial fill Decimal attribution、PENDING/UNKNOWN reconciliation 与 unlinked record recovery；
-   Spot authoritative commission attribution，不使用账户总余额或 balance delta 猜实例归属；
-   USDT Linear Perpetual reduceOnly close、Spot LONG formal close、known-order cancel 与 cancel dispatch
    recovery；
-   `applyExecutionResult()` absolute cumulative 幂等更新、position verification、residual safety 与
    `ArbitrageInstance` lifecycle 收口。

旧 Funding manual production mutation route 已退出正式 mutation composition；正式 provider mutation
必须由 `ArbitrageExecutionCommandService` 及正式 close/cancel application boundary 编排。Legacy Capital
Test 代码仍保留，后续单独 cleanup，不得重新接管 generic production execution。

## 关键后续 checkpoint

-   `57afc0f`：关闭 legacy Funding manual production mutation routing gap。
-   `46ec31c`：Binance provider order identity validation。
-   `cea93bf`：all-symbol Account Read、lossless orderId、exact-key recovery、malformed historical order
    isolation、manual reconciliation/cancel isolation propagation。
-   `5fbc8d0`：已有 `OPENING` ArbitrageInstance Resume UI。
-   `fc6ec8f`：`/api/arbitrage-instances` 接入 authenticated user middleware。
-   `25588b2`：position verification、Spot commission attribution、close quantity 与 residual safety 收口。
-   `1824981`：Binance execution handoff 文档基线。
-   `4ff55a3`：OKX guarded execution 与 Position Verification 开发链。
-   `2f37e8e`：记录 OKX quantity semantics review，确认修复前 checkpoint 阻断。
-   `9f57c61`：OKX canonical quantity boundary 修复与双向数量转换验证。
-   `030f50a`：Position Core、Binance/OKX PositionReader 与套利仓位验证统一接线 checkpoint。

## DOGEUSDT 真实资金验证证据

已在 production 通过正式链完成 Binance DOGEUSDT Spot LONG + USD-M Perpetual SHORT 的真实资金开仓、
对冲、退出和最终核账。用于闭环的实例为：

`arbitrage-a2cd39cd1e3d27d6a8171feb0e3e594bf5b570576b32a21c97630967fa1773d0`

权威结果：

-   Spot BUY opening：gross confirmed `73 DOGE`。
-   Spot opening commission：`0.073 DOGE`，由 Binance `myTrades` 按真实 symbol/orderId/fills identity
    权威归因，不通过余额差推断。
-   Spot attributable quantity：`72.927 DOGE`；按实时 step/minNotional 可正式 SELL `72 DOGE`。
-   Perpetual SHORT opening：confirmed `73 DOGE`，leverage 为交易所既有 `5x`，系统未修改 leverage。
-   Perpetual reduceOnly BUY close：confirmed `73 DOGE`，最终 Futures position=`0`。
-   Spot SELL close：confirmed `72 DOGE`。
-   实例最终 Spot managed residual=`1 DOGE`；当前低于最小合法 SELL notional，按 residual safety 接受，
    未借用账户其他 DOGE 补足，也未自动扩大或补单。
-   实例 lifecycle=`CLOSED`；Spot/Futures active orders=`0`；unresolved ExecutionReference/ExecutionRecord
    =`0`；isolated/manual reconciliation=`0`。
-   最终 `REAL_CLOSE_VALIDATION_PASS`。

最后两笔正式退出的审计标识：

-   Perpetual close：provider orderId `101383444599`，ExecutionRecord
    `bc108f28-1f78-4b88-a6c1-f5c5896e3301`。
-   Spot close：provider orderId `14770109942`，ExecutionRecord
    `a274d8d5-3e98-4b9e-905e-dda7b787b271`。

Provider 最终权威状态：DOGEUSDT Futures position=`0`、Spot/Futures active orders=`0`。账户 Spot DOGE
总余额包含实例外历史余额，不能作为任何新实例的 managed quantity。旧实例
`arbitrage-f414886de10ad1033384b077a40324652c9b8a6322a0280eb2f503f5536a3615`
仍是独立历史 `RESIDUAL`，不得与上述已闭环实例合并或重新归因。

## 当前能力边界与残余风险

-   Binance：USDT Spot LONG 与 USDT Linear Perpetual LONG/SHORT 的正式 execution/close/recovery 能力已
    通过 DOGEUSDT 真实资金闭环验证。
-   OKX、Bybit、Bitget：真实 GET-only Account Read 已通过，但尚无正式 `ExecutionCapability`；不得在 UI
    或 application 层显示为可执行。
-   `CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK = RESIDUAL`：HTTP transport 与 SQLite dispatch 状态
    无法形成真正原子事务；保留 query-first、fail-closed 与人工 Binance 接管边界。
-   第一腿完成、第二腿尚未人工确认期间的短时裸露敞口仍是当前安全阶段的已知产品残余风险。
-   旧历史 `RESIDUAL` instance 和账户外部余额必须继续隔离；不得通过 symbol/方向/账户总余额自动
    归属于新实例。
-   单独的 Perpetual LONG B 验证未执行：当前正式 opportunity 的另一腿为尚无 execution capability 的
    OKX，因此 Final Confirm 正确 fail closed；未创建新 instance、未产生 provider mutation。

## 当前版本与下一阶段

-   建议阶段版本：`0.4.0`。
-   建议版本名称：`Binance Real Execution Closed Loop`。
-   建议 annotated tag：`v0.4.0`；当前尚未实际创建 tag。
-   下一阶段版本建议：`0.5.0 OKX Execution Capability`。
-   下一阶段只建设 OKX 正式 `ExecutionCapability`，随后验证 Binance + OKX Perpetual/Perpetual；Bybit
    与 Bitget 分别留待后续独立阶段。
-   不得因 Binance 闭环通过而自动开始 OKX 开发、部署、真实交易或多交易所资金测试；每阶段仍需
    独立设计、安全审查、checkpoint、部署 GET-only 复验与用户明确授权。
