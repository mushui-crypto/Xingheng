# DECISION_LOG.md

记录重要技术决策。

格式：

## ADR-编号

日期：

问题：

候选方案：

最终决定：

原因：

影响：

## ADR-001

日期：2026-07-31

问题：独立真实测试部署环境增加了发布入口、凭证域、数据卷和恢复链路的维护成本，且当前不再继续使用。

候选方案：

1. 保留并修复独立测试部署。
2. 只停止测试虚拟机，继续保留源码能力。
3. 从源码和发布链路中移除独立测试部署，收敛为 production-only。

最终决定：采用方案 3。

原因：用户明确放弃独立测试部署；删除未使用的部署能力可减少发布和安全边界，同时保留 Demo、Hyperliquid Testnet 与普通自动化测试。

影响：删除测试 Compose、域名、环境模板、凭证域、卷、受信入口及相关运维脚本；生产发布、回滚、备份、WIF/KMS 与交易安全门禁保持不变。资金与交易开关不因该决策启用。

## ADR-002

日期：2026-08-17

问题：Binance、OKX、Bybit、Bitget 需要长期共存，但各 venue 的数量单位、订单身份、仓位字段和
交易规则不同；如果这些差异进入套利业务层或公共执行模型，后续扩展会污染已验证的 Binance 闭环。

候选方案：

1. 为每个交易所复制一套端到端业务流程。
2. 在公共 `ExecutionIntent`、`ExecutionRecord` 和仓位模型中增加各交易所专用字段。
3. 保持统一执行流程，在 `ExecutionCapability`、`FormalExecutionRuntime`、venue adapter 和
   Provider 边界隔离差异。

最终决定：采用方案 3。Binance 已验证执行闭环作为基准；OKX、Bybit、Bitget 通过独立能力和运行
适配接入，不能要求统一核心理解 `sz`、张数、`ctVal`、`lotSz`、`positionAmt` 或其他 venue 原始
字段。

原因：统一核心可以保持状态流转、审计、恢复和风险语义一致；venue adapter 可以独立处理数量、订单
引用、仓位和交易规则，避免特殊字段横向扩散。

影响：`ARCHITECTURE.md` 新增多交易所共存边界，明确 canonical base quantity、统一订单引用、
`PositionReader` 链、独立凭证和能力注册规则。该决策不代表任何 venue 已部署、已获 Provider mutation
授权或已获得真实资金测试许可；当前状态仍以 `PROJECT_CONTEXT.md` 和独立证据为准。

## ADR-003

日期：2026-08-20

问题：Binance 与 OKX 单向持仓模式下，交易所账户净仓可能同时包含账户原有仓位、多个套利实例及
其他手动交易。若把账户物理仓位或余额归属于某个 execution / ArbitrageInstance，会导致已有反向
仓位、同向仓位和套利退出的计算错误。

候选方案：

1. 要求账户在套利前必须 flat，并把成交量映射为 execution-owned physical position。
2. 用账户总仓位或总余额反推当前 execution / instance 的归属数量。
3. 统一使用净仓 signed delta，仅由 ArbitrageInstance 记录和撤销自己的未撤销策略增量。

最终决定：采用方案 3，冻结以下套利仓位计算方式：

### 1. 统一净仓增量模型

适用于 Binance、OKX 及其他单向持仓（net-mode）venue：

```text
Long = 正数
Short = 负数
Flat = 0

BUY confirmed q  -> +q
SELL confirmed q -> -q

afterNet = beforeNet + confirmedExecutionDelta
```

`net_mode`、`BOTH`、`positionSide`、`posSide`、`positionIdx`、`reduceOnly` 等交易所字段只属于
Venue / Adapter / Provider 层，不进入业务层的统一数学语义。

### 2. ArbitrageInstance 的 managed exposure

```text
managedExposure = 本套利已产生但尚未被反向执行撤销的 signed exposure delta
```

它不是交易所账户中独立存在的一块物理仓位。账户原有 `Long 100` 时，本套利执行 `SELL 20`：

```text
账户净仓：+100 -> +80
Instance managedExposure：-20
```

已有仓位不构成天然阻断；`SELL 20` 可使 `Long 100 -> Long 80`、`Short 100 -> Short 120`，或
`Long 10 -> Short 10`，均按上述净仓数学处理。

### 3. 关闭套利的仓位计算

关闭只撤销本 Instance 的未撤销增量：

```text
closeDelta = -outstandingManagedExposure
```

因此 `managedExposure = -20` 时退出必须执行 `BUY 20`；目标是撤销 `-20` contribution，而不是
让账户绝对仓位变小。即使账户此时为 `Long 100`，`BUY 20 -> Long 120` 仍是该 Instance 的正确退出。

### 4. reduceOnly 与关闭语义分离

`reduceOnly` 只是 Venue/Provider 下单约束，不等于“关闭套利”。关闭订单是否使用
`reduceOnly=true` 必须根据实际净仓关系判断，禁止固定套用“Perp close 永远 reduceOnly=true”。

### 5. 归属与验证边界

- `ExecutionRecord` 只拥有订单事实（request / intent / execution identity、side、confirmed quantity、
  recovery、reconcile、status、diagnostic），不拥有账户仓位或余额。
- 禁止通过账户总仓位、总余额或最近成交量推断当前 execution 的 ownership。
- Position Verification 不得要求 `actual account position == instance managed quantity`；只能验证
  当前 reversal 是否具备安全执行条件。
- Perpetual 可使用 signed delta；Spot 继续使用订单 attribution（fill - fee），不得用账户余额推导退出量。
- 多 execution / 多 Instance 可共存；每个 Instance 只撤销自己的 outstanding managed exposure。
- 订单查询、reconcile、recover、cancel 仍严格限定在当前 execution 的订单身份内；发现其他活动订单
 只能触发当前 mutation 风控，不得自动取消其他订单。

原因：signed delta 能在不要求账户物理隔离的前提下解释已有仓位、反向仓位和多实例共存，并使套利退出
成为可审计、可恢复的增量撤销操作；同时保留 venue-specific position 与 order constraints 的隔离。

影响：后续 `ArbitrageInstance`、正式执行链、退出逻辑和 Position Verification 必须以本 ADR 为目标
规则；Unified Real Trading Test 只验证单笔真实执行事实，不能据此声称获得独立物理仓位。Capital Test
不再需要以 flat、独立双腿或 execution-owned position 为前提，删除与其绑定的 legacy 能力须另行决策。

风险：本 ADR 记录的是冻结目标规则，不代表当前代码已全部实现；任何实现改动仍须单独审查交易状态、
订单恢复、净仓核验和 `reduceOnly` 计算，并以真实资金授权和现有安全门禁为前提。
