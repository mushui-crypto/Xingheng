# RWA 中性自动套利 V1 执行契约

更新时间：2026-07-23

当前状态：阶段 0 产品与安全契约已由用户确认；Phase A 后端已落地私有只读账户 connector 契约、纯逻辑状态机、Shadow engine 与 admin-only no-store 状态接口。真实下单全局开关默认关闭，Mainnet 真实资金启用必须再次取得用户明确确认。

本文档是 RWA 自动套利 V1 的执行事实基线。公开行情、评分与只读看板口径继续以 `RWA_GOLD_ARBITRAGE_DASHBOARD.md` 为准；本文只定义私有账户、Shadow、状态机、风控和未来执行门禁，不表示真实交易已经上线。

## 1. V1 范围

- 仅供 owner 自测，不开放普通用户，不做统一资金池、Vault、申购赎回或代客资产管理。
- 首发只做同交易所、同底层资产的“现货多头 + 永续空头”中性组合；跨交易所真实执行后置。
- 默认验证方向为 Bybit `XAUT/USDT` 现货多头 + `XAUTUSDT` 线性永续空头。
- 其他黄金或股票 RWA 只进入公开候选池，不自动进入真实执行白名单。
- `/app/demo`、`/app/trade`、Hyperliquid Testnet、钱包和现有账户体系不属于本模块，不得被改写。
- 开发前必须核对 Bybit 私有 API、账户模式、产品状态、精度、最小订单和可用环境。若 Testnet 缺少等价现货或永续，不得伪装完整双腿测试覆盖。

## 2. 分阶段门禁

### Phase A：私有只读 + Shadow

- 接入 owner 专用 Bybit 子账户的连通性、余额、账户模式、手续费、产品精度、Funding、订单、成交和仓位只读数据。
- 建立纯逻辑状态机、幂等键、Shadow 决策和审计，不向交易所发送下单、撤单或改仓请求。
- 前端只允许展示 `Shadow / 真实交易关闭`，不能出现可绕过服务端门禁的执行入口。

### Phase B：连续观察与故障演练

- Shadow 连续运行至少 14 天，并覆盖至少 30 个完整 Funding 结算周期。
- 至少完成行情 stale、API 超时/限频、部分成交模拟、第二腿失败、重启恢复、重复事件和人工急停 3 类故障演练。
- 晋级要求：零重复订单、零未处理单腿暴露、重启恢复一致、审计记录完整；不满足时继续观察，不进入下单验证。

### Phase C：最小受控连通性验证

- 优先使用具有等价现货与永续产品的测试环境；若不存在，明确记录环境缺口。
- 任何 Mainnet 最小订单烟测仍属于真实资金操作，执行前必须回到项目管理取得一次明确确认。
- 建议资金为 25 USDT，仅用于验证最小双腿订单、撤单、补腿、平仓和审计闭环。

### Phase D：owner Mainnet 小额试运行

- 建议先以 50 USDT 运行；V1 总资金硬上限为 300 USDT，不是最低资金要求。
- 进入 Phase D 前必须再次确认交易所、子账户、标的、API 权限、资金上限、启用窗口、告警和退出方案，并通过固定测试任务的独立安全验收。
- 默认全局执行开关、策略开关和每个交易所开关均为关闭；服务重启后不得自动提升为 armed。

## 3. 账户与凭证

- 使用 owner 专用 Bybit 子账户，优先使用 UTA 统一账户；永续腿优先逐仓，不与其他交易共享保证金。
- Phase A/B 使用独立只读 Key；受控下单阶段使用另一组仅含读取、现货交易和合约交易权限的 Key。
- API Key 必须禁止提现并启用 IP 白名单；需要密钥轮换、权限核对和撤销流程。
- 凭证仅放生产专用 secret store，或 root-only、只读挂载的生产 Secret 文件；不得进入 Git、SQLite、普通环境导出、日志、接口响应、浏览器、localStorage 或 IndexedDB。
- 前端不得获取 secret，不得直接访问交易所私有 API，也不得绕过后端 execution gate。

## 4. 资金方案

以下金额只用于容量门禁，不构成收益承诺：

| 阶段 | 资金 | 建议分配 |
| --- | ---: | --- |
| Shadow/Paper | 0 USDT | 不发送订单，不占用真实资金 |
| Mainnet 连通性烟测 | 25 USDT | `0.002 XAUT` 现货约 8.3U + 等量永续 1x 保证金约 8.3U + 约 8.4U 备用金 |
| 小额试运行 | 50 USDT | `0.005 XAUT` 现货约 20.7U + 等量永续 1x 保证金约 20.7U + 约 8.6U 备用金 |
| V1 硬上限 | 300 USDT | 不是默认投入额，也不得因余额更高自动扩大 |

2026-07-23 的公开规格核对仅作为计划参考：现货最小订单金额 5 USDT；永续 `minOrderQty=0.001 XAUT`、`qtyStep=0.001`、最小名义 5 USDT。按当时约 4,131 USDT/XAUT 估算，等量双腿的实际起点约为 `0.002 XAUT`。每次真实下单前必须实时重新读取价格、产品状态、最小数量、数量步长、手续费、保证金和风险限额，静态数值不得直接驱动订单。

## 5. 状态机与执行语义

状态至少包括：

- `disabled`：全局或策略未启用，禁止真实动作。
- `observing`：读取公开/私有数据并生成 Shadow 决策。
- `armed`：门禁满足且已人工启用，允许等待入场条件。
- `opening`：双腿分批建仓。
- `hedged`：两腿已达到允许的净 Delta。
- `rebalancing`：对精度、成交或价格变化造成的偏差进行受限修正。
- `closing`：按实际仓位逐批退出。
- `fault`：检测到数据、交易所、成交或恢复异常，禁止新增风险。
- `manual_intervention`：自动安全动作不能闭环，需要 owner 处理。

每个策略周期、批次和交易所请求必须有稳定幂等键。重启后先读取交易所权威订单、成交和仓位再恢复状态；不得只根据本地内存推断已成交或重新发送订单。

## 6. 下单、部分成交与补腿

- 默认每批名义金额不超过 25 USDT。
- 先以可成交限价/IOC 买入现货，再按现货实际成交数量建立永续空头；不按计划数量盲目补腿。
- 第一腿未成交部分立即撤销；只对已成交数量执行第二腿。
- 单腿暴露最长 10 秒。第二腿失败时停止新批次、撤销剩余委托，并按风控权限关闭第一腿或进入 `manual_intervention`。
- Phase A/B 只模拟上述动作。Phase C/D 才可在再次确认后允许受限自动补腿、自动撤单、自动减仓和紧急退出。
- 紧急市价退出只允许在 kill switch、单腿超时或强平风险触发时使用，并继续受最大滑点和实际持仓上限约束。

## 7. V1 风控阈值

| 风控项 | 冻结值 |
| --- | --- |
| 公开市场候选 | 90 天等效净 APR `>= 6%`，入场基差绝对值 `<= 50 bps` |
| 真实执行入场 | 等效净 APR `>= 8%`，入场基差绝对值 `<= 30 bps` |
| 双腿预估总滑点 | `<= 20 bps` |
| 最大净 Delta | `<= 5 USDT` |
| 最大单腿暴露 | `<= 10 秒`，单批 `<= 25 USDT` |
| Funding 退出 | Funding 方向反转，或等效净 APR 连续两个结算周期低于 `2%` |
| 基差风险 | 绝对值超过 `80 bps` 时停止加仓并进入退出评估 |
| 日内最大损失 | `6 USDT` |
| 策略累计最大损失 | `15 USDT` |
| 最低强平距离 | `30%` |
| 运行门禁 | 行情 stale、产品暂停、公司行动、API 故障、精度/余额/手续费无法核对时禁止新增风险 |

阈值必须由后端以交易所权威账户、仓位和产品数据重新计算；前端显示值不能成为放行依据。触发日损、总损、强平距离、未知仓位或凭证异常时进入 fail-closed。

## 8. Kill switch、通知与审计

- 两层急停：owner-only 运行时 kill switch，以及生产全局执行配置；任一为关闭都不得发送新增风险动作。
- 全局开关默认关闭；单交易所和单策略也必须独立启用，不允许一次启用自动扩展到新标的或新交易所。
- 告警先使用站内状态 + 邮件 `levoneqq@gmail.com`；Telegram 后置。
- 审计至少记录决策输入摘要、状态转换、门禁结果、幂等键、请求类型、交易所订单标识、成交与人工动作；不得记录 secret、签名材料或未经脱敏的底层响应。

## 9. Phase A 私有接口契约

所有接口均要求登录与 owner/admin 权限，并返回 `Cache-Control: no-store`。Phase A 已实现的后端接口：

### `GET /api/admin/arbitrage/neutral-automation`

用途：读取 owner-only RWA 中性自动套利 V1 Phase A 状态。当前只返回 Bybit XAUT 同所现货/永续的只读/Shadow 状态，不提供启停、下单、撤单、补腿、调仓或资金操作。

鉴权：

- 未登录管理员：`401 { "message": "管理员未登录或登录已失效。" }`
- 普通用户 session / bearer：仍按管理员接口拒绝，不提升权限。
- 管理员登录成功：`200`，并设置 `Cache-Control: no-store`。

最小响应字段：

```json
{
  "network": "mainnet",
  "phase": "phase_a_shadow",
  "strategyId": "bybit-xaut-spot-perp-v1",
  "ownerOnly": true,
  "state": "disabled",
  "status": "disabled",
  "execution": {
    "mode": "shadow",
    "automaticOrdersEnabled": false,
    "providerWriteCallCount": 0
  },
  "connector": {
    "venue": "bybit",
    "connected": false,
    "accountMode": "unknown",
    "readonly": true,
    "permissions": { "read": false, "trade": false, "withdraw": false },
    "capabilities": ["connectivity", "account_mode", "balances", "fees", "instrument_specs", "orders", "fills", "positions"],
    "checkedAt": 0,
    "stale": true,
    "errorCategory": null,
    "message": "Bybit read-only connector is not configured."
  },
  "account": {
    "mode": "unknown",
    "balances": [],
    "fees": [],
    "instruments": [],
    "orders": [],
    "fills": [],
    "positions": []
  },
  "shadow": {
    "decisionId": "rwa:decision:...",
    "idempotencyKey": "rwa:shadow:...",
    "action": "observe",
    "reason": "Strategy is disabled or kill switch is active; Phase A remains read-only.",
    "wouldSendProviderWrite": false,
    "target": {
      "venue": "bybit",
      "spotSymbol": "XAUTUSDT",
      "perpetualSymbol": "XAUTUSDT",
      "notionalUsd": 0
    },
    "gateChecks": [],
    "generatedAt": 0
  },
  "recovery": {
    "source": "provider_snapshot",
    "restoredFromSnapshot": true,
    "lastSnapshotAt": 0
  },
  "audit": { "latest": [] },
  "warnings": []
}
```

状态语义：

- `disabled`：策略开关关闭或 kill switch 激活。Phase A 默认状态。
- `observing`：只读快照新鲜，Shadow 可以评估，但 `automaticOrdersEnabled=false` 且 `providerWriteCallCount=0`。
- `fault`：只读 connector 失败、stale 或无法安全判断；fail-closed，不生成真实动作。

默认未配置真实只读凭证时，connector 返回 `connected=false`、`permissions.read=false` 和 `stale=true`；这表示能力尚未接通，不代表已验证 Bybit 私有账户。

安全规则：

- connector 统一只读能力包括 connectivity、account mode、balances、fees、instrument specs、orders、fills、positions。
- provider 写动作在 Phase A 不暴露给路由，测试断言写调用次数恒为 `0`。
- provider 未知错误在进入接口和审计前脱敏；不得输出 API key、secret、token、authorization、signature、private key、路径、URL 或 raw provider payload。
- connector 返回的 `message` 与 `errorCategory` 同样视为不可信输入：`message` 必须脱敏，`errorCategory` 只能使用受控枚举，不得透传底层错误文本。
- 重启恢复只能从 provider 权威只读 snapshot 恢复；重复事件按幂等键忽略。运行中不同事件的 snapshot 必须按 `fetchedAt` 单调推进，旧 snapshot 与同时间戳 snapshot 均不得覆盖当前权威状态或记录误导性应用审计。

公开 `GET /api/arbitrage/dashboard` 保持兼容；公开响应不得包含账户余额、子账户、API 权限、私有订单、仓位或审计数据。

## 10. 多交易所扩展时 owner 如何操作

V1 先验证单所中性。未来增加交易所时，每个交易所作为独立 connector 和风险域接入，不共用凭证或自动继承白名单：

1. 在目标交易所建立专用子账户，不与人工交易混用。
2. 分别创建只读 Key 与受控交易 Key；禁止提现并设置生产出口 IP 白名单。
3. 由生产运维把凭证写入对应交易所 Secret，前端只显示连通性和权限核对结果。
4. 先对单个 connector 完成只读账户核对，再单独运行 Shadow 和故障演练。
5. 为每个“交易所 + 标的 + 策略”设置独立白名单、资金上限、阈值和 kill switch；新增交易所默认 disabled。
6. 多所同时运行时，由统一控制面展示余额、两腿状态、净 Delta、告警和审计，但订单仍由各 connector 独立幂等执行。
7. 跨所套利要求两边提前备资；V1/V2 不自动跨交易所划转资金。余额不足时停止新开仓，由 owner 人工补充或再平衡。
8. 启用顺序固定为：只读连通性 → Shadow → 故障演练 → 最小受控订单 → 小额运行；每家交易所分别验收，不能因 Bybit 已通过而自动放行其他交易所。
9. 日常 owner 只需要在私有控制台查看状态、处理告警、逐策略 armed/disabled 和使用急停；不需要逐笔手动下单。
10. 任何新交易所 Mainnet、资金增加或权限扩大，都重新回到项目管理确认。

## 11. Owner 与验收顺序

1. 项目管理维护本文档、确认范围和 Mainnet 门禁。
2. 后端先实现 Phase A 私有只读适配器、状态机纯逻辑与 Shadow；禁止真实订单。
3. 后端接口契约冻结后，前端实现 owner-only 控制台，并始终明确 `Shadow / 真实交易关闭`。
4. 固定测试任务验证权限、凭证泄露、状态机、幂等、故障恢复、kill switch，以及 `/app/demo`、`/app/trade` 回归。
5. Shadow 达到观察门槛后回项目管理申请 Phase C；不得自动进入 Mainnet。

## 12. 当前未决的运行前置

- Bybit 私有 API 对 XAUT 现货和永续的实际账户模式、权限、精度及 Testnet 覆盖需要 Phase A 实时核对。
- 生产 Secret 挂载方式、固定出口 IP 和轮换操作需要在写入任何真实凭证前由运维验证。
- Phase C/D 的真实资金启用时间、实际 Key、实时产品规格和最终资金数额尚未授权。
