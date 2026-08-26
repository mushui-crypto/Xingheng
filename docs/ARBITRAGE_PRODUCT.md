# StellaX 套利系统产品文档

- 文档类型：当前产品说明
- 整理日期：2026-08-26
- 代码基线：`1281472`
- 文档基线：`09b8534`
- 适用范围：套利看板、套利分析、正式套利执行、套利实例管理与退出

本文基于当前代码、现有生产部署记录和真实资金验收证据整理。文档只描述已经存在的产品能力及其明确边界，不把代码接入、测试覆盖或行情展示等同于生产真实资金验收。

## 1. 产品定位

StellaX 套利系统面向使用自有中心化交易所账户的用户，提供从公开市场机会发现、风险分析、数量规划、人工确认开仓、仓位核验到实例级退出的完整工作流。

产品当前聚焦资金费率及基差相关的双腿对冲组合：

- 现货多头 + 永续空头；
- 跨交易所永续多头 + 永续空头；
- 同一交易所、同一资产的现货多头 + 永续空头。

产品不是收益承诺工具，也不是无人值守自动下单系统。公开行情、历史评分、APR/APY、容量与成本均用于比较和人工决策辅助，不是手动 Start 的硬门禁。正式交易由用户显式确认 Start 或异常处置命令，服务端在每个 mutation 边界重新校验。

## 2. 产品目标与非目标

### 2.1 当前目标

1. 汇总多交易所公开行情并生成可比较的双腿套利机会。
2. 将历史质量与当前入场条件分开呈现，避免仅凭瞬时费率作出判断。
3. 在下单前读取最新报价、交易规则、凭证和执行能力，生成合法数量计划。
4. 通过确定性的套利实例、执行意图、执行记录和远端订单引用保证交易可追踪、可恢复、可审计。
5. 对状态不确定、仓位不匹配、身份不一致或数据缺失的情况 fail closed。
6. 退出时优先降低永续风险，再处理现货，并以交易所权威状态完成核验。

### 2.2 当前非目标

- 不承诺套利机会一定盈利，也不承诺展示 APR/APY 可以实际获得。
- 不自动替用户选择机会、资金规模、持有周期或退出时机。
- 不在进程重启后自动恢复未完成的交易意图或盲目补偿下单。
- 不以旧版“自动执行条件”触发当前真实订单。
- 不托管用户交易所资金，不允许提现权限。
- 不把账户总余额、外部人工仓位或其他套利实例自动归属当前实例。
- 不把 Bybit 的代码和测试能力表述为生产真实资金闭环通过。
- 不恢复旧 `UnifiedRealTradingTest` 或 Funding legacy mutation 路径作为正式产品入口。

## 3. 用户与使用前提

### 3.1 目标用户

- 希望比较多个交易所资金费率、基差与交易成本的注册用户；
- 使用自有 Binance、OKX、Bybit 或 Bitget 账户进行双腿套利的用户；
- 需要查看系统管理仓位、真实交易所仓位和执行历史的用户；
- 负责验收、风控或运营排障的内部人员。

### 3.2 正式执行前提

公开行情与只读分析不代表账户已具备真实执行资格。进入正式执行还必须满足：

- 用户处于有效登录状态；
- 对应交易所凭证已加密保存并绑定当前用户与账户；
- 凭证身份能够通过交易所权威接口确认；
- 凭证具备交易权限且不具备提现权限；
- 两条腿的正式执行能力均已接入；
- 对增加风险的操作，对应 live gate 必须开启且 kill switch 关闭；正式管理仓位的减仓、已知订单取消、只读查询和恢复不因 halt 被阻止；
- 最新报价、交易规则、合约映射和数量计划有效；
- 当前操作获得单独的真实资金授权。

生产 gate 只代表进程具备执行资格，不代表某个用户、账户、套利实例或测试批次已经获得授权。

## 4. 信息架构

| 路由 | 产品页面 | 主要用途 | 数据性质 |
| --- | --- | --- | --- |
| `/app/arbitrage` | 套利看板 | 查看市场、筛选机会、进入分析、继续已有实例 | 公开行情与估算指标 |
| `/app/funding-arbitrage` | 套利分析 | 查看单个机会的收益、成本、流动性、匹配质量和风险；进入创建套利 | 公开分析；执行区需账户能力 |
| `/app/my-arbitrage` | 我的套利 | 管理交易所连接、读取账户状态、查看当前/历史实例、核验和退出 | 用户私有只读数据及受控 mutation |

所有三个页面均位于登录后的用户区域。套利看板和分析页使用公开交易所行情，但这不代表页面允许匿名访问。

## 5. 核心用户旅程

### 5.1 发现机会

用户进入套利看板后，可在“套利机会”和“市场数据”两个视图之间切换。系统默认每 30 秒刷新一次，也允许用户手动刷新；服务端行情快照短时缓存，强制刷新受冷却限制。

主要筛选和排序维度：

- 持有测算情景：90 天或 365 天；
- 收益展示：APR 或 APY；
- 资产；
- 套利类型：现货-永续、永续-永续；
- 综合质量：高、中、低、无法评估；
- 当前条件：满足、部分满足、费率差未转正、无法评估；
- 做多交易所与做空交易所；
- 按历史综合质量或历史等效净 APR 排序。

机会列表只用于比较。出现行情断开、缺少报价、缺少费率历史或数据覆盖不足时，系统会降低可信度、增加警告或将机会标记为无法评估。

### 5.2 分析机会

用户选择机会后进入套利分析页。分析页与看板使用同一类公开市场快照，并持续刷新当前机会。

分析内容包括：

- 多头腿与空头腿的交易所、标的、产品类型和结算资产；
- 当前资金费率差与历史资金费率差；
- 历史等效净 APR；
- 往返手续费与按订单簿估算的滑点；
- 入场基差、容量、持续性和历史覆盖率；
- 匹配质量、机会驱动、综合质量与当前条件；
- 数据缺失、标的代理、交易所集中、结算币不同等风险提示。

“旧规则自动执行条件”仅保留为分析说明，不会触发当前真实交易。

### 5.3 生成执行草案

用户点击“创建套利”后，系统先生成只读执行草案，不创建实例，也不下单。

用户可选择：

- `USDT 名义金额`：系统根据买卖方向使用最新 ask/bid，按交易所步长向下规划，不自动提高预算；
- `资产数量`：用户直接输入基础资产数量，数量必须满足两条腿的交易规则。

用户还可以选择：

- `价格优先`；
- `成交优先`。

`executionMode` 是服务端 Draft 的显式契约，Confirm 与 Start 都会重新核验。当前 OKX `PRICE_PRIORITY` 缺少 production limit-price capability，因此在 Draft 即标记不可执行，并在 Confirm / Start fail closed；OKX `EXECUTION_PRIORITY` 不受影响。

每条腿的草案展示交易所、标的、方向、市场类型、报价、数量步长、最小数量、最小名义金额、合约大小、计划基础资产数量、交易所数量及估算 USDT 名义价值。

以下任一条件不满足时，用户只能查看草案，不能进入真实执行：

- 标的无法解析或当前不可交易；
- 不是当前支持的 USDT 现货或 USDT 线性永续；
- 报价缺失、非法或过期；
- 交易规则不可用；
- 数量不符合步长、最低数量或最低名义金额；
- 数量取整后为零或超过用户预算；
- 未配置交易所凭证；
- 任一腿正式执行能力不可用。

### 5.4 创建套利实例

当两条腿均可执行时，用户确认创建。服务端会重新读取并核验权威机会、source identity、报价、规则、凭证和执行能力，通过后创建或幂等复用确定性的 `ArbitrageInstance`。

创建实例不等于已经下单。新实例进入 `OPENING`，随后用户对整次 Start 做一次显式确认。`SPOT_PERPETUAL` 只能以 Spot 为第一腿、Perpetual 为第二腿；`PERPETUAL_PERPETUAL` 保留合法范围内由用户选择第一腿的能力。

### 5.5 一键 Start 与两腿编排

1. 用户对套利实例执行一次 Start 确认；
2. 服务端在 mutation 前重新核验 Draft、执行能力、身份、开仓安全与命令指纹；
3. `SPOT_PERPETUAL` 先执行 Spot，并持久化执行意图、记录和恢复引用；
4. Provider 权威查询确认 Spot 为完整 `CONFIRMED` 后，服务端以可归因的 Spot base exposure 规划并自动执行 Perpetual 第二腿；
5. 第二腿再次经过 venue 合法化、opening safety 和 Provider 权威确认。

第一腿为 `FAILED0`、partial、`PENDING_CONFIRMATION` 或 `UNKNOWN` 时，自动第二腿 mutation 必须为零。terminal partial 只允许用户显式执行 partial continue；其数量来自已确认、可归因的 Spot exposure，并且不会重试第一腿。重启和 recovery 只恢复事实，不自动恢复第二腿交易意图。

两腿编排不是 Provider 原子事务。第一腿完整成交后，若第二腿失败、部分成交或未知，可能留下单腿或残余 exposure；工作流会停止并要求人工处理，不会盲目补单。

### 5.6 状态不确定时重新核验

当执行状态为 `PENDING_CONFIRMATION` 或 `UNKNOWN` 时，用户可以点击“重新核验”。核验只查询既有 client order identity / remote order identity，不提交新订单，也不会更换 request identity 自动重试。

如果无法可靠确认远端终态，系统保持 fail closed，并要求人工处理。用户不应重复点击创建或使用新命令绕过原执行记录。

### 5.7 继续已有实例

处于 `OPENING` 且保留 source plan 的实例可从“我的套利”进入“继续开仓”。系统会重新匹配原机会、策略、交易所、标的、数量与执行模式；不匹配时停止继续执行，不创建替代实例。

### 5.8 查看和核验持仓

“我的套利”只展示由 StellaX 创建并绑定套利 ID 的组合。当前实例会展示：

- 实例状态与策略类型；
- 两条腿的交易所、标的和脱敏账户；
- 计划数量、已确认开仓数量、已确认关闭数量；
- 系统管理数量与交易所当前真实数量；
- `MATCHED`、`MISMATCH` 或 `UNKNOWN` 核验结果；
- 开仓、退出和恢复引用；
- 可用时展示累计 Funding、已实现交易损益、费用和净损益；缺失数据保持为空，不推算为真实收益。

仓位核验遵循：Provider read → Venue PositionReader → canonical `PositionSnapshot` → 通用 verifier。账户总余额是账户事实，实例 managed quantity 是系统所有权事实，两者不能相互替代。

必须区分：Account Reality 是 Provider 当前账户事实；Active Managed Exposure 是本实例确认开仓、确认关闭与 Management Release 后仍由系统承担管理责任的数量；Instance Hedge Delta 是本实例各腿可归因 signed canonical base exposure 的合计，不是整个账户 Delta。Management Release 终止管理责任，不伪造成交，也不增加 `confirmedClosedQuantity`。

### 5.9 退出对冲

实例级“退出对冲”是当前主要退出入口。是否允许 close 以 Active Managed Exposure、最新 Account Reality 和统一 Close Safety 为准，`MATCHED` 不是唯一安全条件。Reality 不足、方向冲突、bucket 冲突、身份不可靠或未解决 mutation 时均 fail closed。

退出顺序：

1. 永续空头腿；
2. 其他永续腿；
3. 现货腿；
4. 最终 reconciliation。

永续退出必须使用 CLOSE_ONLY 语义；ONE_WAY 不得穿零，HEDGE 只操作目标 bucket。现货退出受 Active Managed、opening attribution 和 available balance 的联合上限约束，账户总余额不能成为实例 close quantity。任一腿状态不确定时，整个退出流程停止，不自动重试，用户需要执行实例级“重新核验”。

只有正常完整 close 已不可安全完成时，用户才可显式执行 Management Release。Release 的 Provider mutation 为零，不修改 confirmed close 事实。实例可由正常 close、Management Release 或两者组合消除 Active Managed Exposure。

系统内部仍保留单腿退出 API 和组件能力，但当前“我的套利”主界面以实例级退出为主，避免用户绕过对冲顺序。

## 6. 产品指标与评分口径

### 6.1 历史综合质量

产品将长期质量与当前是否适合入场分开：

- 历史综合质量分达到 80：高；
- 达到 65、低于 80：中；
- 低于 65：低；
- 核心数据缺失：无法评估。

历史质量综合考虑历史净收益、费率差持续性、历史覆盖、匹配质量、流动性、往返成本和数据可信度。

### 6.2 当前条件

当前条件基于最新资金费率、保守净收益、入场基差、容量和数据可用性单独判断。历史质量高不表示当前一定满足入场条件；当前费率差转负时可以显示“未转正”。

### 6.3 收益与成本

- 当前总 APR：当前空头腿资金费率 APR 减去多头腿资金费率 APR；现货腿资金费率按零处理。
- 历史总 APR：对齐后的历史日度费率差年化。
- 往返成本：两条腿开仓和平仓的 taker fee，加上按 1 万美元订单簿深度估算的双向滑点。
- 历史等效净 APR：历史总 APR 减去按所选持有天数年化的往返成本。
- 容量：两条腿可用订单簿深度中的较小值。

上述指标未覆盖所有真实损益因素，例如实际滑点、maker/taker 差异、资金费率变化、基差变化、税务、网络和资金调拨成本。

## 7. 支持矩阵

### 7.1 行情与分析覆盖

| Venue | 公开行情/分析 | 当前执行边界 |
| --- | --- | --- |
| Binance | 支持 | Spot 与 USDT Linear Perpetual |
| OKX | 支持 | Spot 与 USDT Swap |
| Bybit | 支持 | Spot 与 USDT Linear Perpetual；尚无生产真实资金闭环 PASS |
| Bitget | 支持 | Spot 与 USDT Futures |
| tradeXYZ | 支持部分公开永续行情 | 不在正式执行 venue 中 |

看板当前覆盖黄金/RWA 类资产与 BTC、ETH、SOL、XRP、DOGE 等主流加密资产。某资产出现在看板中，不代表对应两条腿当下具备凭证、交易规则和正式执行能力。

### 7.2 生产验收状态

| Venue | 代码/Runtime | 生产真实资金闭环 |
| --- | --- | --- |
| Binance | 已接入 | `PASS` |
| OKX | 已接入 | 已有 `PASS` 记录；操作前需 fresh read |
| Bitget | 已接入 | `PASS` |
| Bybit | 已接入并有测试覆盖 | 未验收，不得写成 `PASS` |

生产 revision 记录为 `1281472`。部署成功、gate 开启、代码测试通过和真实资金闭环验收是四种不同事实，不能互相替代。

## 8. 状态口径

### 8.1 套利实例状态

| 状态 | 用户含义 |
| --- | --- |
| `OPENING` | 建仓中；至少一条腿尚未完整确认 |
| `HOLDING` | 两条腿已形成系统管理的持有组合 |
| `RESIDUAL` | 存在未完全处理的合法粒度残余或部分敞口 |
| `CLOSING` | 退出处理中 |
| `CLOSED` | 实例 Active Managed Exposure 已归零，管理责任终结；可来自正常 close、Management Release 或两者组合，不表示账户 Provider 仓位必然为零 |
| `FAILED` | 实例进入失败终态，需要人工检查记录 |

### 8.2 执行状态

| 状态 | 产品处理 |
| --- | --- |
| `CREATED` | 已创建执行记录，尚未开始提交 |
| `SUBMITTED` | 已开始提交，等待 Provider 结果 |
| `PENDING_CONFIRMATION` | 已有远端接受或部分成交事实，需继续查询 |
| `CONFIRMED` | Provider 权威终态确认完成 |
| `FAILED` | Provider 明确拒绝、取消或零成交终止 |
| `UNKNOWN` | 断连、超时或响应不完整，远端事实无法确认 |

不得仅根据“当前仓位已经归零”把历史 `FAILED` 执行记录改写成成功。多次 close attempt 是独立执行事实，应通过不同 execution identity 区分。

## 9. 风险控制与安全边界

- 所有正式 mutation 必须来自已登录用户并绑定其自身账户。
- API Secret 加密保存，不在浏览器持久化、不回显、不输出到日志。
- 策略和看板不直接调用交易所；正式执行必须经过 Runtime、Coordinator、Capability 和 Safety Guard。
- 增加风险的操作受 live gate、kill switch、凭证身份、数量规则、报价时效和执行能力共同限制。
- trading halt 阻止 INCREASE；正式管理仓位的 DECREASE、已知订单 cancel、query、reconcile 和 recovery 继续允许，但仍须满足各自身份与安全边界。
- 永续平仓必须明确 position direction，并使用只减仓语义。
- `UNKNOWN`、`PENDING_CONFIRMATION`、verification mismatch、identity conflict 或 recovery conflict 时立即停止扩展风险。
- Provider HTTP mutation 与 SQLite dispatch/recovery persistence 不是物理原子事务，因此恢复始终 query-first，不进行盲目重试。超时不等于 `FAILED0`，not found 不等于 `NOT_DISPATCHED`，`UNKNOWN` 始终 fail closed。
- 外部手工订单、外部余额、其他实例仓位和相同 symbol 仓位不自动计入当前实例。

## 10. 当前已知限制与待办

1. Bybit 尚未完成真实资金 Spot/Perp 完整生命周期验收。
2. `NOTIONAL_USDT` 在实例创建与执行前重验之间可能因报价变化产生数量漂移；当前会 fail closed，但可能留下无敞口的空 `OPENING` 实例。
3. 一键 Start 不是跨 Provider 原子事务；第一腿完整确认后，第二腿失败、部分或未知仍可能留下需人工处置的单腿 exposure。
4. 多次 close attempt 在 UI 中仍可能被按腿汇总，历史失败与后续成功的可观测性不够清晰。
5. 四 venue gate 是进程级全局配置，尚未按 user、account、instance 或测试批次隔离。
6. Provider HTTP mutation 与 SQLite persistence 仍有非原子残余风险。
7. Spot active orders、Perpetual active orders、leverage、margin mode 等只读能力并非所有 venue 都可可靠提供；缺失时必须显示不可用或无法确认。
8. 四 venue 多轮资金自测尚无独立批次编排、预算审计和自动化验收报告。
9. PnL 字段已存在于实例模型，但数据缺失时保持为空；当前不能据此宣称完整的实时收益统计产品已经验收。

## 11. 产品验收原则

一条套利链路只有同时满足以下条件，才可记为生产真实资金闭环通过：

1. 使用目标 venue 的生产真实账户和真实订单；
2. 两条腿开仓均有唯一 Provider 订单身份和完整成交事实；
3. 第二腿数量来源能够追溯到第一腿权威成交/归因数量；
4. 两条腿退出均有唯一 Provider 订单身份和完整成交事实；
5. 最终 perpetual bucket 为 FLAT 或明确的合法 residual；
6. Spot 实际余额、可用余额和实例 managed quantity 已分别核对；
7. active orders、ExecutionRecord、ExecutionReference 和实例状态完成 reconciliation；
8. 未解决订单、未知状态和身份冲突均为零；
9. 验收过程的真实资金授权、预算、订单、成交、费用和最终状态有审计记录。

代码存在、Runtime 注册、单元测试通过、GET-only account read、测试网或模拟测试均不能单独满足上述验收。

## 12. 当前产品结论

当前套利系统已经形成“公开机会发现 → 风险分析 → 数量计划 → 确定性实例 → 一次确认的一键 Start → 权威核验 → 实例级退出/管理责任终结”的产品闭环。

Binance、OKX 和 Bitget 已有生产真实资金闭环证据；Bybit 已完成代码和测试层接入，但仍处于生产验收缺口。当前阶段的产品重点不是扩大自动交易范围，而是修复数量漂移、提升多次执行的可观测性、细化授权隔离并完成 Bybit 与多轮自测验收。
