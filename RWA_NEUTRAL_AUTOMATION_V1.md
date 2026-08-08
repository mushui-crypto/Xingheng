# RWA 中性自动套利 V1 执行契约

更新时间：2026-07-26

当前状态：Phase A 私有只读/Shadow 已部署；用户已明确授权普通登录用户进入 Mainnet 真实资金执行开发。当前后端采用按用户隔离的统一 venue registry，Bybit 保留既有执行 adapter，Binance 已完成受控执行闭环并进入 `execution_capable`，Bitget/OKX 仍默认 disabled 且未实现。Binance 默认执行开关关闭、用户 kill switch 激活、服务端全局 kill switch 激活；生产 Compose 的 X.509 WIF/ADC 只读挂载契约已实现，但尚未在服务器注入真实身份材料或配置真实交易所凭证，因此当前不会发生 provider 写调用。自动策略继续严格要求 `automationEligible=true`，用户主动入场则使用独立 `manual_entry` 风险预检，两者都不能绕过安全、私有账户或急停门禁。

安全整改第 3 项已完成前后端实现并通过固定安全复验：敏感操作新增 RFC 6238 TOTP 二次身份验证和一次性 step-up authorization。二维码作为后续体验优化延期，当前通过手动设置值完成 enrollment；本项已由 `b02e367` 提交但尚未部署，生产服务端总急停继续保持激活。

本文档是 RWA 自动套利 V1 的执行事实基线。公开行情、后台评定与只读看板口径继续以 `RWA_GOLD_ARBITRAGE_DASHBOARD.md` 为准；本文只定义私有账户、Shadow、状态机、风控和执行门禁，不表示真实交易已经上线。

## 0. 通用资产 profile

自动执行的资产差异统一由服务端 `RwaAutomationAssetProfile` 提供，客户端不得提交或覆盖：

- 基础/报价资产、venue、现货/永续 symbol 和 strategy ID。
- 数量步长、价格步长、最小数量、最小金额、线性合约基础资产乘数和 taker fee 上限。
- 现货/永续持仓变化语义、必须完整覆盖的账户活动来源、允许方向和对冲容差。
- 当前阶段的单笔、单资产、单账户和全部自动策略总额上限。

XAUT 是当前唯一 `enabled` profile。BTC、ETH、SOL 仅为 `reserved`，用于冻结数据结构和隔离测试；
`executionRequired` 解析必须拒绝它们，不包含 provider 写实现。现有 XAUT API 字段继续兼容，
执行记录内部追加 `asset`、canonical `profileId` 与 `reservedCapitalUsd`；旧记录缺少这些字段时
按 state 文件 venue additive migration，旧备份仍可恢复，新状态必须通过 exact schema。

2000 USDT 是 XAUT profile 的当前阶段配置；单笔、单资产、单账户和全部自动策略四层当前均为
2000 USDT，不再另设 25 USDT 的正式单次请求上限。提高额度必须修改受控
profile、经过代码审查/固定安全验收并由 release revision 留下审计证据，不能由客户端参数、
运行时 symbol 或交易引擎分支绕过。既有 `maxStrategyCapitalUsd` 只允许在 profile 单资产上限内
进一步收紧。

新增风险在 preflight 与 provider 写前二次核对四层额度。执行请求先持久化资本预留，再汇总当前
持久状态；未知资产、profile 错配、状态不可读、资本值非法或旧持仓无法估值时拒绝新增风险。
退出、减仓、异常补偿和急停不受入场额度阻止。

## 0.1 账户资产全量管理授权

当前第二阶段只建立授权，不执行接管、撤单、下单或退出。授权按认证用户、venue、服务端核对的
account ID/fingerprint、enabled asset 和 canonical profile 隔离；XAUT 是唯一可授权资产，
BTC/ETH/SOL 继续拒绝。授权前通过私有只读接口重读 XAUT 现货总量、可用/锁定数量、永续方向与
数量、全部 XAUT 活动订单，生成 120 秒 exact-schema 预览和摘要。公开 SHA 摘要只用于完整性
核对，不作为发行证明；ControlService 同时保存有界、仅服务端可用的短期 opaque 发行记录，绑定
用户域、登录会话、venue、服务端 account ID/fingerprint、asset/profile/policy、状态与订单摘要，
并要求 `expiresAt = generatedAt + 120000`。进程重启、记录缺失、过期、状态变化或已消费均
fail-closed。

服务端冻结提示明确说明：未来启用资产接管时，系统可能撤销该账户全部 XAUT 活动订单，并买入、
卖出或平掉该账户全部 XAUT 现货与永续仓位，包括手工买入、转入或手工开仓部分；其他资产不在
授权范围。本次确认本身不会立即触发上述动作。用户必须用现有 TOTP step-up 对预览 digest 单独
确认；step-up intent 和最终创建必须核对同一服务端发行记录，最终创建会一次性消费记录。创建授权
的 token 不能用于撤销，撤销需要新的 TOTP step-up。

授权记录保存 policy version/digest、账户绑定、预览数量、订单摘要、名义金额上界和创建/撤销
时间，进入原有状态容量门禁和加密灾备。旧状态默认无授权；凭证轮换或删除使授权失效。以下 API
均为 additive 且返回 `Cache-Control: no-store`，响应不包含 raw account ID 或 provider payload：

- `GET /api/arbitrage/automation/venues/:venue/assets/:assetId/authorization`
- `POST /api/arbitrage/automation/venues/:venue/assets/:assetId/authorization/preview`
- `PUT /api/arbitrage/automation/venues/:venue/assets/:assetId/authorization`
- `DELETE /api/arbitrage/automation/venues/:venue/assets/:assetId/authorization`

本阶段四个操作全部为 provider mutation 0；授权成功不表示资产已接管、自动退出可用或真实资金
窗口已开放。后续接管行为尚未冻结，本文件不预留其动作语义。

该 profile 层继续复用现有 execution engine、venue clients、KMS/credential、TOTP、kill switch、
rate limit、lease/idempotency、persistent store、backup/restore 和错误映射，不建立第二套执行
状态机。真实 Binance/Bybit 活动连续性目前仍为 `incomplete`，所以本节不表示自动退出已可用。

## 1. V1 范围

- 开放给普通登录用户使用，每个用户只管理自己的交易所 API 与策略状态；不做统一资金池、Vault、申购赎回或代客资产管理。
- 首发只做同交易所、同底层资产的“现货多头 + 永续空头”中性组合；跨交易所真实执行后置。
- 默认验证方向为 Bybit `XAUT/USDT` 现货多头 + `XAUTUSDT` 线性永续空头。
- Binance 执行白名单固定为 `XAUTUSDT` 现货侧买入 + `XAUTUSDT` USD-M 永续侧卖出；不接受客户端自传 symbol、side、quantity 或 price。
- 其他黄金或股票 RWA 只进入公开候选池，不自动进入真实执行白名单。
- `/app/demo`、`/app/trade`、Hyperliquid Testnet、钱包和现有账户体系不属于本模块，不得被改写。
- 开发前必须核对交易所私有 API、账户模式、产品状态、精度、最小订单和可用环境。若 Testnet 缺少等价现货或永续，不得伪装完整对冲组合测试覆盖。

## 2. 分阶段门禁

### Phase A：私有只读 + Shadow

- 接入当前登录用户专用 Bybit 子账户的连通性、余额、账户模式、手续费、产品精度、Funding、订单、成交和仓位只读数据。
- 建立纯逻辑状态机、幂等键、Shadow 决策和审计，不向交易所发送下单、撤单或改仓请求。
- 前端只允许展示 `Shadow / 真实交易关闭`，不能出现可绕过服务端门禁的执行入口。

### Phase B：连续观察与故障演练

- Shadow 连续运行至少 14 天，并覆盖至少 30 个完整 Funding 结算周期。
- 至少完成行情 stale、API 超时/限频、部分成交模拟、永续侧失败、重启恢复、重复事件和人工急停 3 类故障演练。
- 晋级要求：零重复订单、零未处理单侧暴露、重启恢复一致、审计记录完整；不满足时继续观察，不进入下单验证。

### Phase C：最小受控连通性验证

- 优先使用具有等价现货与永续产品的测试环境；若不存在，明确记录环境缺口。
- 任何 Mainnet 连通性烟测仍属于真实资金操作；只有用户明确选择 `connectivity_smoke` 才能执行，且不能记录为套利仓位或收益。
- 当前首次 Capital Test 使用一次性 `single_connectivity_smoke`，总计划资本硬上限为 `40 USDT`，
  不是必须用满的固定预算。实际 XAUT 数量由服务端根据 Binance Spot 与 USD-M Futures 的实时交易
  规则和实际订单限价，取满足两端共同约束的最小可交易数量，不得为接近上限而放大；若该数量对应
  的总计划资本超过 Permit 上限，必须 fail-closed，不得执行。历史 `25 USDT / 0.002 XAUT` 仅为
  历史计划口径，不是当前执行常量。

### Phase D：用户 Mainnet 小额试运行

- 当前四层 profile 上限为 2000 USDT，不是默认投入额，也不表示删除风险上限。
- 进入 Phase D 前必须再次确认交易所、子账户、标的、API 权限、资金上限、启用窗口、告警和退出方案，并通过固定测试任务的独立安全验收。
- 默认全局执行开关、策略开关和每个交易所开关均为关闭；服务重启后不得自动提升为 armed。

## 3. 账户与凭证

- 每个用户使用自己的交易所专用子账户；Bybit 优先使用 UTA 统一账户。永续侧不与其他交易共享保证金。
- Phase A/B 使用独立只读 Key；受控下单阶段使用另一组仅含读取、现货交易和合约交易权限的 Key。
- API Key 必须禁止提现。Binance 真实执行还必须启用固定 IP 白名单，且 Binance 返回的 `ipList` 必须与服务端 `RWA_BINANCE_ALLOWED_EGRESS_IPS` 完全一致；配置缺失、无限制、通配、CIDR、无法确认或集合不匹配时均不得 active/preflight/execute。Bybit 既有 IP 口径本轮不变。需要密钥轮换、权限核对和安全解绑流程。
- 交易所凭证正文只允许写入 Envelope V2 密文文件；包裹 DEK 的 KMS 身份材料必须放在宿主 tmpfs，由固定专用 UID/GID `20001:20001` 持有，目录 `0700`、文件 `0400`，并以整个目录只读 bind mount 提供给同 UID 的非 root API。明文凭证、DEK、WIF 证书私钥不得进入 Git、SQLite、环境变量、镜像、日志、接口响应、浏览器、localStorage 或 IndexedDB。
- 前端不得获取 secret，不得直接访问交易所私有 API，也不得绕过后端 execution gate。

## 4. 资金方案

以下金额只用于容量门禁，不构成收益承诺：

| 阶段 | 资金 | 建议分配 |
| --- | ---: | --- |
| Shadow/Paper | 0 USDT | 不发送订单，不占用真实资金 |
| Mainnet 连通性烟测 | 动态最小值 | 按现货/永续实时共同步长、最小数量、最小名义和价格计算 |
| 小额试运行 | 50 USDT | `0.005 XAUT` 现货约 20.7U + 等量永续 1x 保证金约 20.7U + 约 8.6U 备用金 |
| 当前 profile 四层上限 | 2000 USDT | 不是默认投入额；客户端不能覆盖，用户配置可进一步收紧 |

2026-07-23 的公开规格核对仅作为计划参考：现货最小订单金额 5 USDT；永续 `minOrderQty=0.001 XAUT`、`qtyStep=0.001`、最小名义 5 USDT。按当时约 4,131 USDT/XAUT 估算，等量对冲组合的实际起点约为 `0.002 XAUT`。每次真实下单前必须实时重新读取价格、产品状态、最小数量、数量步长、手续费、保证金和风险限额，静态数值不得直接驱动订单。

## 5. 状态机与执行语义

状态至少包括：

- `disabled`：全局或策略未启用，禁止真实动作。
- `observing`：读取公开/私有数据并生成 Shadow 决策。
- `armed`：门禁满足且已人工启用，允许等待入场条件。
- `opening`：正在建立现货与永续对冲组合。
- `hedged`：现货侧与永续侧已达到允许的净 Delta。
- `rebalancing`：对精度、成交或价格变化造成的偏差进行受限修正。
- `closing`：按实际仓位逐批退出。
- `fault`：检测到数据、交易所、成交或恢复异常，禁止新增风险。
- `manual_intervention`：自动安全动作不能闭环，需要当前用户在对应交易所人工处理。

每个策略周期、批次和交易所请求必须有稳定幂等键。重启后先读取交易所权威订单、成交和仓位再恢复状态；不得只根据本地内存推断已成交或重新发送订单。

## 6. 下单、部分成交与对冲补齐

- 正式单次请求没有低于 profile 的固定 25 USDT 上限；当前仍受单笔、单资产、单账户和全局四层
  2000 USDT 上限及用户 `maxStrategyCapitalUsd` 共同约束。
- 先以可成交限价/IOC 买入现货，再按现货实际成交数量建立永续空头；不按计划数量盲目补齐永续侧。
- 现货侧未成交部分立即撤销；只按现货侧已成交数量建立永续侧。
- 单侧暴露最长 10 秒。永续侧失败时停止新批次、撤销剩余委托，并按风控权限退出现货侧或进入 `manual_intervention`。
- Phase A/B 只模拟上述动作。Phase C/D 才可在再次确认后允许受限自动补齐对冲、自动撤单、自动减仓和紧急退出。
- 紧急市价退出只允许在 kill switch、单侧暴露超时或强平风险触发时使用，并继续受最大滑点和实际持仓上限约束。

## 7. V1 风控阈值

| 风控项 | 冻结值 |
| --- | --- |
| 公开市场候选 | 90 天等效净 APR `>= 6%`，入场基差绝对值 `<= 50 bps` |
| 真实执行入场 | 等效净 APR `>= 8%`，入场基差绝对值 `<= 30 bps` |
| 对冲组合预估总滑点 | `<= 20 bps` |
| 最大净 Delta | `<= 5 USDT` |
| 最大单侧暴露 | `<= 10 秒`；新增风险金额受四层 profile 与用户收紧配置约束 |
| Funding 退出 | Funding 方向反转，或等效净 APR 连续两个结算周期低于 `2%` |
| 基差风险 | 绝对值超过 `80 bps` 时停止加仓并进入退出评估 |
| 日内最大损失 | `6 USDT` |
| 策略累计最大损失 | `15 USDT` |
| 最低强平距离 | `30%` |
| 运行门禁 | 行情 stale、产品暂停、公司行动、API 故障、精度/余额/手续费无法核对时禁止新增风险 |

阈值必须由后端以交易所权威账户、仓位和产品数据重新计算；前端显示值不能成为放行依据。触发日损、总损、强平距离、未知仓位或凭证异常时进入 fail-closed。

## 8. Kill switch、通知与审计

- 两层急停：每个用户/venue 的运行时 kill switch，以及服务端全局急停；任一激活都不得发送新增风险动作。
- 全局开关默认关闭；单交易所和单策略也必须独立启用，不允许一次启用自动扩展到新标的或新交易所。
- 告警先使用站内状态 + 邮件 `levoneqq@gmail.com`；Telegram 后置。
- 审计至少记录决策输入摘要、状态转换、门禁结果、幂等键、请求类型、交易所订单标识、成交与人工动作；不得记录 secret、签名材料或未经脱敏的底层响应。

## 9. Phase A 私有接口契约

所有接口均要求登录与 owner/admin 权限，并返回 `Cache-Control: no-store`。Phase A 已实现的后端接口：

### `GET /api/admin/arbitrage/neutral-automation`

用途：读取 owner-only RWA 中性自动套利 V1 Phase A 运维状态。该兼容接口不提供启停、下单、撤单、对冲补齐、调仓或资金操作。

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
3. 登录用户在统一授权窗口手工提交自己的 API Key/Secret；浏览器不得持久化，后端用 AES-GCM 加密保存，前端只显示脱敏 Key、连通性和权限核对结果。
4. 先对单个 connector 完成只读账户核对，再单独运行 Shadow 和故障演练。
5. 为每个“交易所 + 标的 + 策略”设置独立白名单、资金上限、阈值和 kill switch；新增交易所默认 disabled。
6. 多所同时运行时，由统一控制面展示余额、现货侧与永续侧状态、净 Delta、告警和审计，但订单仍由各 connector 独立幂等执行。
7. 跨所套利要求两边提前备资；V1/V2 不自动跨交易所划转资金。余额不足时停止新开仓，由用户人工补充或再平衡。
8. 启用顺序固定为：只读连通性 → Shadow → 故障演练 → 最小受控订单 → 小额运行；每家交易所分别验收，不能因 Bybit 已通过而自动放行其他交易所。
9. 日常用户在私有控制台查看自己的状态、处理告警、逐策略 armed/disabled 和使用用户级急停；不需要逐笔手动下单。
10. 任何新交易所 Mainnet、资金增加或权限扩大，都重新回到项目管理确认。

## 11. Owner 与验收顺序

1. 项目管理维护本文档、确认范围和 Mainnet 门禁。
2. 后端先实现 Phase A 私有只读适配器、状态机纯逻辑与 Shadow；禁止真实订单。
3. 后端接口契约冻结后，前端实现登录用户私有控制台，并始终明确 Shadow/真实执行状态。
4. 固定测试任务验证权限、凭证泄露、状态机、幂等、故障恢复、kill switch，以及 `/app/demo`、`/app/trade` 回归。
5. Shadow 达到观察门槛后回项目管理申请 Phase C；不得自动进入 Mainnet。

## 12. 当前未决的运行前置

- Bybit 私有 API 对 XAUT 现货和永续的实际账户模式、权限、精度及 Testnet 覆盖需要 Phase A 实时核对。
- 生产主加密密钥挂载、轮换操作和服务端全局急停解除仍需由运维验证。Binance 固定出口 IPv4 集合必须由服务端配置并与 API Key 白名单完全一致，是新增风险动作的硬门禁。
- 用户已授权本功能开发，但生产实际 Key、首次启用窗口、实时产品规格和最终资金数额仍未配置。

## 13. Mainnet 登录用户自动执行 API（后端可测契约）

私有接口均位于 `/api/arbitrage/automation`，复用现有用户 session/Bearer、跨源写请求拦截与 64kb JSON 上限；匿名返回 401、禁用用户返回 403，所有响应均设置 `Cache-Control: no-store`。`userId` 只从认证上下文取得，任何 body `userId` 都不被接受。Secret 仅允许写入，不返回、不记录日志、不进入 SQLite/localStorage/审计或 raw error。现有 `/api/admin/arbitrage/neutral-automation` 只读运维兼容接口保持不变。

### Venue registry

- `GET /api/arbitrage/automation/venues`
- `GET /api/arbitrage/automation/venues/:venue/credentials`
- `PUT /api/arbitrage/automation/venues/:venue/credentials`
- `DELETE /api/arbitrage/automation/venues/:venue/credentials`
- `GET /api/arbitrage/automation/venues/:venue/config`
- `PUT /api/arbitrage/automation/venues/:venue/config`
- `POST /api/arbitrage/automation/venues/:venue/kill-switch`
- `GET /api/arbitrage/automation/venues/:venue/account`

当前 venue 顺序固定为 `bybit -> bitget -> binance -> okx`。Bybit 与 Binance 为已实现的执行 adapter；Binance 返回 `phase=execution_capable`、`providerWritesEnabled=true`，但 `enabled` 仍由有效凭证、用户双开关、用户 kill switch 和服务端全局 kill switch 共同决定，默认不可写。Bitget/OKX 返回 `501 venue_not_implemented`。各 venue 不得继承其他交易所的凭证、账户、开关或缓存。

Bybit 凭证写入请求：

```json
{ "apiKey": "write-only", "apiSecret": "write-only" }
```

返回只包含 `accountId/accountFingerprint`、`maskedApiKey`、`stored`、`lifecycleStatus`、`connectionStatus`、受控权限布尔值、IP warning 和校验时间。状态机为 `unconfigured/validating/active/invalid/expired/revoked/rotation_required`。校验必须同时满足：`readOnly=0`、`ContractTrade` 包含 `Order/Position`、`Spot` 包含 `SpotTrade`、Wallet 不含 `Withdraw`、`uta=1`、专用子账户身份可核对；IP 白名单只生成风险 warning。

Binance 凭证请求保持同一字段：

```json
{ "apiKey": "write-only", "apiSecret": "write-only" }
```

服务端使用 `X-MBX-APIKEY + HMAC-SHA256`，先读取 Binance 服务端时间并计算短 TTL 时间偏移；签名请求使用 `recvWindow=5000`，时间戳错误只允许重新同步后重试一次。保存前必须分别成功读取现货账户与 USD-M Futures 账户，并通过 `GET /sapi/v1/account/apiRestrictions` 验证：

- `enableReading=true`
- `enableSpotAndMarginTrading=true` 且现货账户 `canTrade=true`
- `enableFutures=true` 且 USD-M Futures 账户 `canTrade=true`
- `enableWithdrawals=false`，提现权限是绝对硬阻断
- 当前第一阶段只接受 one-way 持仓模式；hedge mode 返回权限/模式拒绝
- Binance `ipRestrict=true` 且返回非空、无通配/无限制的固定 IPv4 `ipList`
- `ipList` 必须与服务端 `RWA_BINANCE_ALLOWED_EGRESS_IPS` 完全一致；前端不得提交或覆盖该集合

Binance `accountId` 由服务端返回的账户 UID 做不可逆指纹生成；Secret 仍只写不回显。凭证验证成功只表示 lifecycle 可进入 `active`，不表示真实执行已启用。

每个用户/venue 的凭证、状态、challenge、执行、PnL 和审计独立存储。AES-256-GCM AAD 绑定 `userId + venue + accountId`；轮换先验证新 Key 再原子替换，失败保留旧密文。存在仓位或活动订单时禁止普通删除；凭证失效导致系统无法确认退出时返回 `credential_delete_manual_intervention` 和交易所人工撤单/平仓指引。

旧的单 owner 文件路径不自动迁移或归属给任何普通用户；生产当前无该模块真实凭证，因此新主线直接使用用户隔离目录。若未来发现旧密文，只允许在离线、明确绑定用户/账户并重新加密后导入，运行时保持 fail-closed。

非敏感配置使用白名单字段：`globalExecutionEnabled`、`strategyEnabled`、`maxStrategyCapitalUsd`、`maxEntryBasisBps`、`maxCombinedSlippageBps`、`minNetAprPercent`、`minLiquidationDistancePercent`、`maxUnhedgedMs`。默认两级执行开关关闭、kill switch 激活；服务重启清空内存 armed challenge，不自动恢复 armed。

除首次写入 Key 由交易所身份生成 `accountId` 外，配置写入、kill switch、preflight、execute、close、close-all 与凭证删除都必须回传服务端给出的 `accountId`；不匹配返回 `409 account_mismatch`。V1 每个用户/venue 只允许一个执行账户，契约保留未来同 venue 多 `accountId` 扩展。

### 候选、preflight 与 execute

- `GET /api/arbitrage/automation/opportunities`
- `POST /api/arbitrage/automation/preflight`
- `POST /api/arbitrage/automation/execute`

Preflight 请求按入场方式显式选择 mode：

```json
{ "accountId": "服务端验证后返回的账户 ID", "opportunityId": "公开面板同所中性机会 ID", "mode": "arbitrage_entry" }
```

```json
{ "accountId": "服务端验证后返回的账户 ID", "opportunityId": "公开面板同所中性机会 ID", "mode": "manual_entry" }
```

后端强制刷新/重新读取公开套利快照，并把候选拆成三个独立判断：

- 安全可执行：必须为同所、同资产、现货多头 + 永续空头，且公开机会 `disqualifiers=[]`。
- 机会推荐：后台评定只用于排序和风险提示，不直接阻止 `manual_entry`。
- 自动策略符合：`arbitrage_entry` 继续额外要求 `automationEligible=true`。

安全判断失败时返回 `409 safety_opportunity_blocked`；自动策略不符合时返回 `409 automation_opportunity_blocked`。对应 adapter 未实现或默认禁用时返回 `501 opportunity_adapter_unavailable`。以上拒绝都发生在私有 provider 调用前。

Bybit 首个 adapter 当前只支持安全可执行的 XAUT 现货多头 + XAUTUSDT 永续空头。预检数量按两侧
实时规则计算共同最小可执行数量，不再把 `0.002 XAUT / 25 USDT` 当作长期执行常量；当前四层
profile 上限均为 2000 USDT。

Binance 第一阶段只识别 Binance `XAUTUSDT` 同所精确组合。服务端实时读取 Spot/USDM `exchangeInfo`，不得假定 symbol、替换成 PAXG 或其他黄金标的。2026-07-23 owner 实时核对结果为：

- 现货 `XAUTUSDT`：`TRADING`，数量步长 `0.0001`，最小名义 `5 USDT`，价格步长 `0.01`
- USD-M `XAUTUSDT` 永续：`TRADING`，数量步长/最小数量 `0.001`，最小名义 `5 USDT`，价格步长 `0.01`

以上只记录核对时事实；每次 Shadow/preflight 仍必须重读缓存期内的产品目录、book ticker、盘口、mark、Funding 与下一结算时间。任一产品不存在时返回 `binance_product_unavailable` / `provider_product_unavailable`，不得伪造可执行的对冲组合。

两种模式都会重新读取私有权限、余额、账户模式、实时价格、产品状态、数量/价格步长、最小名义、手续费和强平距离，并硬性校验：

- API 权限、UTA 专用子账户、产品 Trading 状态。
- 数量与价格精度、最小订单、已有冲突仓位。
- 动态最小可执行预算、2000 USDT 四层 profile 上限、用户收紧配置与可用余额。
- 强平距离、数据新鲜度和下单滑点边界。

`arbitrage_entry` 还会硬性要求 Funding `>0`、净 APR `>=8%`、基差不超限。`manual_entry` 将 Funding 不利、净 APR 不足和基差超过自动门槛转为必须展示和确认的 warning，不把它们伪装成系统推荐，也不放宽上述安全校验。

Bybit 或 Binance preflight 通过后返回 60 秒一次性 `challengeId/challengeToken`；服务端只持久化 token 哈希。Execute 请求：

```json
{
  "challengeId": "...",
  "challengeToken": "...",
  "accountId": "服务端返回的 venue 账户 ID",
  "idempotencyKey": "owner-generated-stable-key"
}
```

Challenge 报告显式绑定 `arbitrage_entry` 或 `manual_entry`。执行前按 challenge 中的原 mode 再次实时 preflight；旧 challenge 若没有 mode，保守按严格自动模式处理。随后先固定永续 1x。现货侧使用带滑点边界的 IOC，按现货实际成交量建立永续侧；部分成交最多补齐永续侧两次，剩余现货立即退出。交易所 create-order 只视为异步接收，必须再查订单或成交的权威状态。幂等记录在任何 provider 写入前原子持久化；重启后 challenge 自动 disarm，未完成执行按策略 client order ID 从 provider 权威订单/成交恢复并撤单退出。

Binance preflight 会重读机会与私有账户，分别核对现货/期货可用 USDT、读取/现货/Futures 交易权限、提现关闭、one-way 持仓模式、产品状态、数量/价格精度、最小名义、活动订单、已有 XAUT 敞口、公开盘口深度、stale、Funding、基差、净 APR、动态最小共同数量和 2000 USDT 四层 profile 上限。检查失败返回 `409 preflight_rejected`；全部通过才签发 60 秒一次性 challenge。Execute 会再次执行实时 preflight，设置 USD-M Futures 1x 杠杆，并只允许固定 `XAUTUSDT` 的现货侧 IOC Limit Buy 与永续侧 IOC Limit Sell。现货侧实际成交后才按成交数量建立永续侧；永续侧失败、订单状态超时或对冲未完成时，系统只撤销带本策略 client order ID 前缀的活动订单，并尝试补齐对冲或退出本策略仓位。两次退出仍无法闭环时进入 `manual_intervention` 并激活该用户的 Binance kill switch。

`connectivity_smoke` 与两种套利入场 mode 明确分离；它不能借机绕过普通策略入口，也不能记为
套利仓位或收益。Production Capital Test Permit 唯一接受
`executionMode=single_connectivity_smoke`，该字段进入 Permit schema、digest、confirmation 和每次
新增风险 mutation 的 runtime verification，但不进入 Credential Binding digest。旧
`single_funding_rate_arbitrage_round` mode 一律 fail-closed。

生产 server kill switch 始终保持默认激活。仅 `executeConnectivitySmoke()` 可在专用 trusted
operation 创建的 receipt + lease 窗口中获得窄化例外；窗口默认 CLOSED，hard end 最长 30 分钟且
不可延长，controller 中断后 lease 自动失效，API 每次从只读挂载重读 receipt。Spot Buy、Futures
新增风险及 leverage mutation 前均重新校验 Permit、Binding、execution mode、receipt 与 lease；
窗口失效后禁止新增风险和自动补单，但 cancel、reduce-only、Spot Sell 与 flat reconciliation 保持可用。

### 独立 connectivity smoke 契约

Binance Mainnet `XAUTUSDT` 连通性烟测使用独立 `connectivity_smoke` mode、execution purpose、
`rwacs` client order ID 前缀、持久状态和只读 receipt；不依赖公开 opportunity、Funding、APR、
基差或 `automationEligible`，也不进入套利 execution、positions、PnL、Funding 或绩效。

新增 additive API：

- `GET /api/arbitrage/automation/connectivity-smoke/policy?accountId=<server-issued-account-id>`
- `POST /api/arbitrage/automation/connectivity-smoke/preflight`
- `POST /api/arbitrage/automation/connectivity-smoke/execute`
- `POST /api/arbitrage/automation/connectivity-smoke/lookup`
- `GET /api/arbitrage/automation/connectivity-smoke/status`
- `GET /api/arbitrage/automation/connectivity-smoke/:smokeId/receipt`

`lookup` 是 execute 响应未知时使用的 authenticated、`Cache-Control: no-store`、纯只读精确关联：

```json
{
  "accountId": "服务端已绑定的 Binance 账户 ID",
  "challengeId": "本次 execute 使用的 challenge ID",
  "idempotencyKey": "本次 execute 使用的幂等键"
}
```

响应为精确匹配的 public connectivity smoke status 或 `null`。服务端在当前用户持久域中以
幂等键唯一定位记录，再精确核对 `accountId`、`challengeId` 及已通过持久 exact schema 验证的
`requestDigest` 绑定事实；任一不匹配都返回 `null`，绝不回退到账户 latest status。该路径使用
automation `private_read` admission 和账户归属核验，不初始化 connector、不读取 KMS/provider、
不消费 challenge/step-up、不创建或更新 smoke/receipt/timeline，也不触发 execute 或任何
provider mutation；遇到合法 legacy migration 或 compaction 候选时只生成内存逻辑视图，
不得执行维护性持久回写。`null` 仅表示截至查询时不能确认服务端已受理，客户端不得据此自动重放
execute；只能保留未知状态提示，或由用户重新开始一轮明确授权。

Policy discovery 必须在首次 preflight 前可调用。它要求已登录 active 用户及当前用户已绑定的
Binance `accountId`，使用 automation `private_read` 限流并返回 `Cache-Control: no-store`；
只读取本地非敏感账户 metadata 和服务端 canonical policy，不初始化 connector、不读取 KMS
明文或 provider 私有状态，也不产生 provider 写。响应 exact contract 为：

```json
{
  "mode": "connectivity_smoke",
  "venue": "binance",
  "accountId": "服务端已绑定账户 ID",
  "executionAuthorized": false,
  "message": "此响应仅用于展示并确认当前服务端 policy，不表示 preflight 通过、执行开关开启或真实窗口已授权。",
  "policy": {
    "version": "connectivity-smoke-non-atomic-v1",
    "venue": "binance",
    "symbol": "XAUTUSDT",
    "maxPlannedCapitalUsd": 25,
    "dedicatedBlankSubaccount": true,
    "singleExecution": true,
    "immediateExit": true,
    "challengeTtlMs": 60000,
    "continuity": "non_atomic_incomplete",
    "requiredConfirmations": ["exclusive_window", "manual_recovery", "non_atomic_risk"],
    "exclusiveWindowRules": [{ "code": "stable_code", "message": "服务端展示文案" }],
    "manualRecoveryRequirements": [{ "code": "stable_code", "message": "服务端展示文案" }],
    "residualRisks": [{ "code": "stable_code", "message": "服务端展示文案" }],
    "digest": "canonical policy 的 SHA-256 base64url"
  }
}
```

`policy`（不含 `digest`）是 version/digest/preflight validator 的唯一事实源。前端必须完整展示
服务端返回的 code/message，并将返回的 version/digest 原样用于 `policyAcceptance`；不得硬编码
digest。policy 内容更新会生成新 digest，旧 acceptance 继续由 preflight exact-match fail-closed。
Discovery 不表示凭证 active、preflight 已通过、执行开关开启或真实 Mainnet 窗口已授权。

Preflight 请求固定为（policy version/digest 是稳定契约，不保存 TOTP 或凭证）：

```json
{
  "accountId": "服务端返回的 Binance 账户 ID",
  "mode": "connectivity_smoke",
  "policyAcceptance": {
    "version": "connectivity-smoke-non-atomic-v1",
    "digest": "服务端公布的 policy SHA-256 base64url digest",
    "exclusiveWindowConfirmed": true,
    "manualRecoveryConfirmed": true,
    "nonAtomicRiskAccepted": true
  }
}
```

Execute 请求沿用 challenge、幂等和 step-up 字段；step-up operation 固定为
`connectivity_smoke_execute`，并携带与 preflight 相同的 `policyVersion`、`policyDigest`，绑定
user/account fingerprint、Binance XAUTUSDT、40U 上限、单 execution、立即退出、短 TTL、人工
恢复能力和非原子风险确认的完整复合动作。用户明确承诺该窗口内不使用 Binance UI、其他 API Key、
转账或其他系统操作 XAUT。首次 provider mutation 前必须
持久化 reservation、`noReopen=true` 和授权退出事实。单账户同时只允许一个 active smoke；同一
幂等键在 user/account/challenge/request digest 完全相同时只读返回原记录，不再次消费 step-up；
任一字段冲突均拒绝，不能重新开仓。

40 USDT 是 Spot 名义 + Futures 1x 保证金 + Spot 买卖两次 taker fee + Futures 开平两次 taker
fee + 四动作保守滑点 + 取整准备的总计划资本硬上限，不是必须用满的预算。实际资本可以低于该
上限；数量按实际开仓限价、两端实时 `LOT_SIZE` 步长、最小数量、最小名义和各端实际适用的数量
precision 约束计算共同最小值，不得为接近 40 USDT 而放大。若共同最小数量超过 Permit 上限、任一
侧余额不足或规则不满足，必须 fail-closed，provider 写调用为 0。

状态阶段固定为 `reserved / spot_opening / spot_open / futures_opening / hedged /
futures_closing / spot_closing / flat / failed / manual_intervention`。开始窗口要求 Spot
total/free/locked、Futures position 和两侧 open orders 全部为 0。每次 mutation 后以 provider
权威订单终态、成交、仓位、余额和 open orders 核对；任何外部 XAUT 活动、未知归属或数量超过
smoke 账本都进入 `manual_intervention`。每次 provider mutation 前后均复核执行租约、账户快照、
四个固定 `rwacs` client ID 的订单/成交，以及真实 provider scanner 可获得的订单、成交、
position/income、充值提现、内部及子账户划转来源；来源失败、分页不完整、非法值或 REST 可见的
非 `rwacs` XAUT 活动均停止后续自动写。scanner 证据始终标记 `nonAtomic/incomplete`：这只是
“用户承诺的独占运维窗口；截至扫描 cutoff 未发现 REST 可见外部活动”，不表示账户锁定、原子隔离
或完全排他，也不得用于套利或普通退出。退出顺序固定为 Futures reduce-only Buy 后 Spot Sell。

恢复只允许风险降低：零 mutation reservation 直接 `failed`；Spot 成交后仅撤余量/卖 Spot；
Futures 成交后不补仓，只先平 Futures 再卖 Spot；退出中先按固定 client order ID 查询既有退出
订单。provider 已 flat 但本地未完成时只补 `flat` 和 receipt。provider、租约或 KMS 无法确认时
进入 `manual_intervention` 并激活用户急停。Status 和 receipt 是 `no-store` 的用户/账户隔离只读
响应，只公开本次 smoke 的安全摘要，不返回 secret、token、IP、challenge/step-up token、凭证、
非 smoke 订单或 raw provider 数据。Status 在所有执行阶段返回持久化的 `policyVersion /
policyDigest`、四个固定订单槽位、最近一次 provider 核验状态和实际发生的阶段时间线：

```json
{
  "orders": {
    "spotOpen": null,
    "futuresOpen": null,
    "futuresClose": null,
    "spotClose": null
  },
  "providerState": {
    "verificationStatus": "verified|stale|unavailable|ambiguous",
    "observedAt": null,
    "residualSpotQuantityXaut": null,
    "residualFuturesQuantityXaut": null,
    "activeSpotOrderCount": null,
    "activeFuturesOrderCount": null,
    "activeTotalOrderCount": null,
    "providerFlatConfirmed": null,
    "reason": "stable_code"
  },
  "timeline": [{ "stage": "reserved", "at": 0, "code": "reserved" }]
}
```

非空订单槽位只包含 `orderId / orderLinkId / category / side / status /
requestedQuantityXaut / filledQuantityXaut / averagePriceUsd / feeUsd / reduceOnly /
updatedAt`；`orderLinkId` 必须是该 smoke 的固定 `s1/p1/c1/c2`。`providerState` 只表示
`observedAt` 时 REST 可见、仍为 non-atomic/incomplete 的核验结果；不可读、证据不完整或归属
不明确时数量可为 `null`，并以稳定 reason 告知前端人工登录 Binance，不允许前端自行推算。
所有 `verified` 及成功 flat receipt 使用同一私有快照 freshness 边界
`RWA_BINANCE_PRIVATE_SNAPSHOT_MAX_AGE_MS`：刚好等于阈值仍有效；超龄、future 或非法
`fetchedAt` 均不能作为 current 事实。超龄但合法且不晚于 record `updatedAt` 的时间持久化为
`stale / provider_snapshot_stale`，保留完整 snapshot facts；future、NaN、Infinity 或负时间
降级为 `unavailable / provider_snapshot_time_invalid`，`observedAt` 及所有 snapshot facts 均为
`null`，不能公开 future provider 时间。两者都要求 `providerFlatConfirmed=null`，不能继续依赖
current verified 证据的 mutation，也不能形成成功 receipt。

`providerState` 的状态事实为 exact 判别式：

- `verified`：observedAt 必须有效且不晚于 record updatedAt；Spot/Futures residual、两侧及 total
  active-order count 必须完整、有限、非负，count 为整数且 total 等于两侧之和；
  `providerFlatConfirmed` 必须为 boolean，并且仅在 residual 0/0、两侧 count 0/0 时为 true，
  其他 verified snapshot 必须为 false。reason 仅允许冻结的 verified 类别。
- `stale`：同样保留完整 snapshot facts，reason 固定 `provider_snapshot_stale`，
  `providerFlatConfirmed=null`。
- `ambiguous`：保留完整 snapshot facts，reason 仅允许 scanner/activity evidence incomplete 或
  provider-ledger mismatch 冻结类别，`providerFlatConfirmed=null`。
- `unavailable`：observedAt、所有 residual/count 和 providerFlatConfirmed 必须全部为 null，
  reason 仅允许 not-yet-observed、provider read unavailable、invalid provider time 或 legacy
  migration 冻结类别。

持久化与备份复用同一 smoke 事实校验。四个订单槽位严格绑定当前 `orderLinkPrefix` 的
`s1/p1/c1/c2`；槽位分别决定 Spot Buy、Futures Sell、Futures reduce-only Buy、Spot Sell 的
公开 metadata。非空订单必须具有合法 provider status、非负有限 requested/filled/position/fee、
`filled <= requested`、合法均价/时间，并与 opened ledger 一致。成功 receipt 只允许出现在
`stage=flat` 且两侧 exit confirmed、最近 providerState 为 fresh verified、Spot/Futures residual
和两侧 open-order count 全为 0、total count 等于两侧之和且为 0 时；receipt 的 smoke/account/
policy/budget/opened quantities/final quantities/completedAt 必须与持久记录及时间线一致。

时间线只追加实际持久化的 stage 变化，不补造未发生阶段，备份恢复保持一致。首事件固定
`reserved/reserved`，普通事件 code 固定为 `stage_<stage>`，时间非递减且位于 record 生命周期，
末事件必须等于当前 stage。合法图为：

```text
reserved -> spot_opening | failed | manual_intervention
spot_opening -> spot_open | spot_closing | flat | failed | manual_intervention
spot_open -> futures_opening | spot_closing | failed | manual_intervention
futures_opening -> hedged | futures_closing | spot_closing | flat | failed | manual_intervention
hedged -> futures_closing | spot_closing | flat | failed | manual_intervention
futures_closing -> spot_closing | flat | failed | manual_intervention
spot_closing -> flat | failed | manual_intervention
```

父版本迁移严格按“候选识别 → 完整父 schema 验证 → 降级转换 → 新 schema 验证”执行。只有恰好
缺少 `providerState` 与 `timeline`、顶层 key 完全匹配父版本，并且 authorization、budget/prices、
四个固定订单槽位、opened ledger、exit、stage、IDs、policy、数量、record/order timestamps 和
旧 receipt 的 exact keys/identity/budget/opened/final/completedAt 全部合法的记录，才会在 Store
读取或 Backup 验证/恢复时原子 additive 迁移。随后 providerState 降级为
`unavailable / legacy_provider_state_unavailable`，所有 residual/count 为 `null`；timeline 仅记录
`legacy_migration_reserved` 和当前持久 stage 的 `legacy_migration_current_stage`，不补造中间阶段。
旧成功 receipt 因未持久新契约要求的权威快照而清空为 unavailable，绝不迁成 verified 成功。
旧 receipt、订单、预算、退出或时间任一畸形都必须在清空旧 receipt 之前被拒绝，不能借迁移洗白。
只缺一个新字段、含 unknown 字段或其他畸形记录不适用迁移并 fail-closed。Active 旧记录在任何
provider mutation 前仍必须重新取得 fresh 权威证据；terminal 旧记录保持只读。

Flat receipt 复用四单摘要和时间线，并要求 `finalProviderState` 权威确认 Spot/Futures 残余及
两侧活动订单均为 0。它返回 policy 接受确认事实；只有历史 version/digest 与当前 canonical
policy 完全一致时才联结当前披露全文，否则返回
`disclosureAvailability="unavailable_for_historical_digest"`，不得用当前文案冒充历史 policy。
实际指标采用统一 `{ availability, value, reason }`：

- `actualFeesUsd` 仅在四单权威 fee 全部存在且有效时求和，否则
  `unavailable / authoritative_fee_inputs_incomplete`。
- 当前未持久化无歧义的逐动作 reference price，因此 `actualSlippageUsd` 返回
  `unavailable / authoritative_reference_prices_not_persisted`。
- 当前未持久化可完整证明 smoke 实际收益的全部权威输入，因此 `actualRealizedPnlUsd` 返回
  `unavailable / authoritative_pnl_inputs_not_persisted`。

预算和 fee/slippage reserve 始终是 `planned` 风险上界，不能填入上述 actual 指标；smoke 仍不
进入普通 positions/PnL/Funding/绩效。已接受残余风险包括 scan cutoff 到 mutation 的竞态、历史接口延迟、人工
同净额往返可能不可见、资产可替代导致经济归属无法数学证明，以及 40U 仅为计划资本上限而非最大
损失保证。

### 持仓、PnL 与退出

- `GET /api/arbitrage/automation/positions`
- `GET /api/arbitrage/automation/pnl`
- `GET /api/arbitrage/automation/audit`
- `POST /api/arbitrage/automation/positions/:positionId/close`
- `POST /api/arbitrage/automation/venues/:venue/close-all`

PnL 只按策略 client order ID、provider order ID、execution 与专用账户交易日志归因，返回现货侧与永续侧数量、均价、mark、名义、净 Delta、入场/当前基差、realized/unrealized、Funding、fees、slippage、net PnL、时间序列和执行历史；不得使用账户总 PnL。该归因依赖专用账户不混入同 symbol 的人工仓位。Kill switch 阻止新增风险，但 close/close-all 不受策略 enabled 开关阻止，且不得撤销或平掉非本策略订单和仓位。

`close-all` 的仓位所有权不得从 PnL 展示窗口或有限分页成交历史推断。每条 execution 持久化
`strategyPosition.coverage + spotRemainingXaut + perpetualRemainingXaut`，每次权威成交先更新
并原子写盘，之后才允许下一次 provider mutation。旧活动记录缺少该字段时只能迁移为
`ambiguous`；不得按 `hedgedQuantityXaut` 或近期成交补猜。自动退出前和确认时，provider 账户
总量必须与完整策略账本精确一致；同时必须从持久 execution 的最早 `createdAt` 覆盖点开始，
对策略订单前缀之外的全部持仓影响活动取得连续、完整且不晚于权威快照的 provider 证明，并在
首次撤单前及撤单后、首次平仓前各复核一次。额外库存、同额卖出后补入、额外永续仓位、人工成交、
转入转出、分页/游标不完整、非法数值或任何无法唯一归属的差异均进入 `manual_intervention`，
自动 provider 写为 0。低于交易所 `minQty/minNotional` 的残余仍保留在策略账本，不能静默
归零或标记 closed。

活动连续性候选方案只接受专用子账户。Binance 还要求服务端从账户 UID 生成的内部指纹精确位于
`RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS`；该 allowlist 默认空。Bybit 必须证明 UTA 子账户
且不是 master account。候选监控要求两侧 XAUT 仓位和活动订单从零开始，对冻结的全部活动来源
扫描，并以 15 分钟间隔、5 分钟重叠窗口、每来源独立水位补扫；起点不可后移，最大断档 24 小时。

离线 scanner 已实现 Binance 32 个来源请求加一次账户证明，其中 21 个请求覆盖官方要求显式
`type` 的资产划转类型；Bybit 为 13 个来源请求加一次账户证明。每来源最多 20 页、并发 4，瞬时
限流、超时和传输错误只按 100ms、500ms 重试两次；理论单轮上限分别为 1921 和 781 次 provider
尝试。每来源最多保存 32 个最近事件 ID，每侧最多保存 64 个 provider order ID 和 256 个策略
client order prefix；沿用每用户 100 条 active execution、状态文件 8/10 MiB soft/hard 上限
及 exact-schema 加密灾备。

但是 Binance/Bybit 这些 REST 端点没有跨全部活动来源的原子序列或可锁定后置水位。各端点按
扫描前 cutoff 查询时，扫描期间发生的活动会被 `endTime/createTimeTo` 正确排除；再补一轮只能
产生新的截止窗口，不能证明扫描结束到首次 provider mutation 之间没有人工活动。因此真实
Binance/Bybit adapter 会把即使协议扫描成功的结果强制降级为 `incomplete`，不推进可用于写入的
水位，建立仓位的首次 leverage/order 和退出的 cancel/place 均为 0。离线 scanner 的 complete
只表示给定冻结时间窗已遍历，不能作为真实 mutation 证书；测试 fake 的 complete 仅验证引擎在
未来获得原子 provider 水位后的行为。

服务启动或恢复时，provider/coverage 首轮失败会先原子把 exposure 置为
`manual_intervention`，关闭 global/strategy execution、激活用户急停并清除 challenge，然后
允许 HTTP 以只读、不可执行状态启动，便于用户查看和人工处置；这不表示监控成功。状态文件、
执行租约或 disarm 落盘失败属于无法证明安全状态，会向上抛出并阻止监听。本实现尚未连接真实
Binance/Bybit、未发布生产，也未授权新的 Mainnet 资金窗口；生产现有 release 仍按上一版
fail-closed 行为运行。

### 凭证文件与环境变量

- `RWA_CREDENTIAL_KEY_PROVIDER=gcp-kms`：生产唯一允许的凭证密钥 provider；测试 fake provider 只能由测试代码显式注入，生产环境不可选择。
- `RWA_GCP_KMS_KEY_NAME=projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials`：固定 Google Cloud KMS CryptoKey 完整资源名。生产身份只使用 X.509 Workload Identity Federation/ADC，不创建或接受长期 Service Account JSON Key。
- `RWA_GCP_WIF_AUDIENCE`：服务端配置的唯一受信 X.509 WIF provider 完整 audience，必须与 ADC 精确一致。
- `GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp-wif/adc.json`：只读挂载的 external-account ADC 配置。ADC 只接受冻结的 audience、mTLS subject token type、Google STS URL 与 certificate source 结构，不得内嵌 `private_key`；`adc.json`、certificate config、证书、对应私钥和 trust chain 必须全部是 `/run/secrets/gcp-wif` 内的 regular file，拒绝 symlink 和目录逃逸，并要求 UID `20001` owner、`0400`。根目录要求 UID `20001` owner、`0700`。
- 宿主 WIF 目录固定为 `/run/xingheng/gcp-wif`，不接受环境变量覆盖。Compose 将整个目录只读 bind 到 `/run/secrets/gcp-wif`，不自动创建目录。API 与共享 `strategy_data` 的策略工具固定以 `20001:20001` 非 root 身份运行；rootless Docker、user namespace remap、非 tmpfs 来源、可写挂载或可写子挂载均 fail-closed。旧 UID `1000` 的现有数据卷必须在停机备份后执行一次受控 owner 迁移，不能用宽权限替代。
- `RWA_AUTOMATION_MASTER_KEY` 已停用。生产若发现该变量、非 GCP provider、错误 CryptoKey 或不安全 ADC 路径，启动配置校验直接失败，不允许本地主密钥或明文降级。
- `RWA_AUTOMATION_DATA_DIR=/app/rwa-automation-data`：生产固定为独立 named volume 根目录。`current.json` 以原子指针选择只读冻结的 generation，generation 内按不可逆用户域 + venue 分隔凭证/状态。Envelope V2 为每个 `userId + venue + accountId` 生成独立随机 32-byte DEK，本地使用 AES-256-GCM 加密凭证正文，再由 GCP KMS 包裹 DEK；文件保存 `version/algorithm/provider/keyName/wrapReference/wrappedDek/wrapBindingTag/ciphertext/nonce/tag/aadSchema/createdAt/updatedAt`，原子替换并强制 `0600`，不保存明文凭证或 DEK。
- `RWA_AUTOMATION_SERVER_KILL_SWITCH`：服务端全局急停，只有显式设为 `false` 才允许新增风险；用户级开关不能覆盖它。
- `RWA_BINANCE_ALLOWED_EGRESS_IPS`：Binance 真实执行允许的服务端固定出口 IPv4，逗号分隔；必须与 Binance 返回的 API Key `ipList` 完全一致。缺失、非法、通配、CIDR 或集合不匹配均 fail-closed，具体 IP 不进入接口响应或凭证元数据。
- `RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS`：允许建立活动连续性的 Binance 专用子账户内部指纹，逗号分隔，格式严格为 `binance:` 加 16 位小写十六进制。默认空并保持 `incomplete`；不得填写 provider UID、API Key 或其他凭证。

Envelope V2 的本地 AAD canonical 绑定 `userId + venue + accountId + environment + schemaVersion`；发送给 GCP KMS 的 additional authenticated data 只包含不可逆用户域和账户域，不发送邮箱或明文用户标识。读取、轮换、开启执行、解除急停、preflight 与 execute 均需重新解密或验证 provider，KMS 超时、权限撤销、key disabled、位置错误、ADC/证书失效或 AAD 不一致时全部 fail-closed。凭证正文与 DEK 只在单次调用内存中使用并尽力清零，不跨请求缓存。

GCP KMS Encrypt 必须提交 plaintext 与 additional authenticated data 的 CRC32C，并验证两个服务端 verification flag、返回 ciphertext CRC32C 和合法 CryptoKeyVersion；Decrypt 必须提交 ciphertext 与 additional authenticated data 的 CRC32C，并验证返回 plaintext CRC32C。任一字段缺失、为 false 或不匹配均返回受控错误并拒绝使用结果。

凭证轮换必须先验证候选凭证，再以新随机 DEK 原子替换旧 envelope；失败保留旧有效 envelope。KMS key version 迁移使用 DEK rewrap，只替换 `wrappedDek/wrapReference/wrapBindingTag`，不重新加密凭证正文。`wrapReference` 必须严格属于冻结 CryptoKey 的合法 version，并与 `wrappedDek` 一起受 DEK-HMAC 完整性绑定；篡改必须 fail-closed。旧 V1 本地主密钥文件只能被识别为 `rotation_required`，在线服务不解密、不迁移、不覆盖；当前无生产真实凭证，后续如发现 V1 只能走冻结的离线处置流程。

WIF 叶证书轮换采用版本化 cert/key 文件与同目录原子替换 `certificate_config.json`：先完整写入并同步新文件，再一次性切换配置，旧文件至少保留两个 token 生命周期。ADC audience/provider 或 trust chain 变化需要受控重启。宿主重启后 tmpfs 内容消失，部署流程必须重新注入身份材料；Google Auth 在 token 刷新时会持续读取文件，运行期间不得撤掉挂载。WIF 身份材料明确排除在项目备份和恢复之外。

安全整改第 4 项 owner 实现已增加互相隔离的 `rwa_automation_data`、`rwa_automation_backups` 与 `rwa_automation_lock` volumes。API 只挂载数据卷和锁卷；备份 one-shot 以只读方式挂载数据卷，恢复 one-shot 以只读方式挂载备份卷。API 与运维工具使用同一 `flock`，脚本默认先停止 API，保证所有原子单文件写停止后再枚举一致快照。SQLite、策略报告与 WIF mount 不与上述 volumes 或脚本混用。

自动套利备份使用 provider-neutral `CredentialKeyProvider` 的独立 `automation-backup` purpose、`rwa-automation-backup:v1:backupId:environment` AAD 和 `rwa-automation-disaster-recovery` domain。每份归档使用新随机 DEK 整体 AES-256-GCM 加密 manifest 和文件正文，KMS 只包裹 DEK。manifest 严格记录 schema、时间、环境、allowlist 路径、大小和 SHA-256；只允许当前 credential envelope、automation state 与 `step-up-security` envelope。三类文件在备份发布前均按冻结 schema 递归校验精确字段和类型，未知字段、嵌套授权 token、cache/armed 或 provider raw response 均 fail-closed，不能因外层归档已加密而原样保留。WIF、SQLite、策略报告、临时文件、lock、challenge、一次性 step-up token、内存 cache/armed 状态与 provider raw response明确排除。

恢复只接受严格 UTC 文件名，并在读取/JSON 解析/KMS 前基于同一文件描述符执行 `O_NOFOLLOW`、owner/mode、密文归档上界和备份卷总容量校验；超限返回稳定容量错误且不改变当前 pointer。随后在新 generation 中完成 KMS unwrap、AAD/tag/wrap binding、manifest、hash、schema、路径、symlink/hard link、owner/mode 与全文件语义校验后原子切换 `current.json`；同一个 pointer 同时保存 current 与 rollback generation。失败或切换前中断不改变原数据，切换后原 generation 仍可回滚。恢复出的 automation state 固定清空 challenge、关闭 global/strategy execution并激活用户 kill switch；服务端总急停不受备份控制，重启不恢复 armed，也不重放建立对冲组合，未完成执行只进入既有 recovery/manual_intervention 或退出流程。

保留期默认 30 天、总容量默认 1 GiB、单快照默认 100 MiB；删除只匹配严格自动套利备份名。密文归档需另行复制到独立主机或对象存储并定期在隔离卷演练恢复，WIF 不得随备份复制。第 4 项代码、离线 harness 与静态部署契约已通过固定安全复验；尚未在真实 Docker daemon 验证 named volume owner/mount、flock、容器重建、旧数据迁移、异机副本或恢复回滚，这些现场项完成前不得宣称可部署或录入真实凭证。

生产或本地均不得在聊天、测试 fixture、日志或接口响应中填入真实 Secret。专项测试只允许假 provider，禁止触发 Mainnet 订单。

## 14. Binance 执行状态与错误契约

`GET /api/arbitrage/automation/venues` 中 Binance 项追加：

```json
{
  "venue": "binance",
  "implemented": true,
  "enabled": false,
  "phase": "execution_capable",
  "providerWritesEnabled": true,
  "productAvailability": {
    "available": true,
    "status": "available",
    "spotSymbol": "XAUTUSDT",
    "perpetualSymbol": "XAUTUSDT",
    "checkedAt": 0,
    "message": null
  }
}
```

`productAvailability.status` 只允许 `available / spot_unavailable / perpetual_unavailable / both_unavailable`。产品目录或网络不可核对时按 unavailable 返回，不延用旧成功值伪装当前可用。

Binance 稳定错误类别：

- `permission_rejected`：读取/现货/Futures 权限不足、提现开启或持仓模式不支持
- `provider_credential_invalid` / `provider_permission_error`：Binance 签名或私有权限拒绝
- `provider_timestamp_error`：重新同步一次后仍无法通过时间戳校验
- `provider_rate_limited` / `provider_unavailable`：限频或上游不可用
- `binance_egress_ip_config_missing`：服务端未配置有效的 Binance 固定出口 IPv4 集合
- `binance_ip_whitelist_unconfirmed`：Binance 未启用固定白名单、返回通配/非法列表，或无法返回可核对的 `ipList`
- `binance_ip_whitelist_mismatch`：Binance 返回的固定 IP 集合与服务端配置不完全一致
- `provider_product_unavailable` / `binance_product_unavailable`：真实产品目录无法组成 XAUT 同所对冲组合
- `preflight_rejected`：产品、精度、最小名义、余额、模式、stale、盘口或风险检查失败
- `execution_disabled` / `server_kill_switch_active` / `kill_switch_active`：执行开关或急停仍在阻止新增风险
- `challenge_invalid` / `restart_disarmed`：一次性 challenge 无效、过期、已使用，或服务重启后已解除 armed
- `provider_order_timeout` / `hedge_incomplete`：权威订单状态未在时限内确认，或对冲未完成
- `credential_delete_blocked`：账户存在 XAUT 余额、永续仓位或活动订单
- `credential_delete_manual_intervention`：凭证失效，系统无法确认账户敞口，必须在 Binance 人工处理

Binance connector 已实现严格白名单 provider 方法：设置 `XAUTUSDT` USD-M 1x 杠杆、现货侧/永续侧 IOC Limit 下单、按策略 client order ID 查询与撤单、策略成交归因和受控退出。所有写路径默认被配置与两层急停阻断；当前只使用 fake provider 完成 owner 自检，未配置真实凭证、未连接真实私有账户、未发送真实订单。进入生产启用前仍需独立安全验收和明确的运维放行。

## 15. 敏感操作二次身份验证契约

当前实现方法为 RFC 6238 TOTP（SHA-1、6 位、30 秒、允许前后各一个时间窗口）。服务类型保留未来 `webauthn` 方法枚举，但本轮不实现 WebAuthn、短信或邮件二次验证。未设置 TOTP 的普通用户可继续使用公开和私有只读接口，也可执行 preflight，但不得增加真实资金风险。

TOTP secret 使用现有 provider-neutral `CredentialKeyProvider`，每次写入使用独立随机 32-byte DEK 和 AES-256-GCM；GCP KMS 只包裹 DEK。安全状态使用独立 purpose `step-up-security`、security domain `rwa-sensitive-operations` 和 AAD schema `step-up-security:v1:userId:purpose:environment`，不与交易所 credential envelope 混用。文件位于自动套利数据目录下的独立 `step-up-security` 子目录，目录 `0700`、文件 `0600`；生产 owner 固定为 `20001:20001`。TOTP secret、恢复码明文、step-up token 和 enrollment token 不进入 SQLite 明文字段、日志或审计。

普通用户私有接口均要求现有 user session，并返回 `Cache-Control: no-store`：

- `GET /api/auth/security/step-up/status`：返回 `enrolled`、`pendingEnrollment`、`method`、剩余恢复码数量和启用时间，不返回 secret、URI 或恢复码。
- `POST /api/auth/security/step-up/enrollment/begin`：请求 `{ currentPassword, currentFactor? }`。首次设置只要求当前密码；重新设置还要求当前 TOTP 或恢复码。成功仅在本次响应返回 `{ enrollmentId, otpauthUri, expiresAt }`，pending 最长 10 分钟且每用户仅保留一个。
- `POST /api/auth/security/step-up/enrollment/confirm`：请求 `{ enrollmentId, code }`。成功仅在本次响应返回 8 个恢复码；服务端只保存每个恢复码的独立 salt + scrypt 哈希。
- `POST /api/auth/security/step-up/authorize`：请求 `{ code, intent }`，成功返回 `{ authorizationToken, expiresAt }`。token 为 opaque 随机值，服务端仅保存 SHA-256 哈希，TTL 120 秒，单进程内一次消费，服务重启自动失效。
- `POST /api/auth/security/step-up/recovery-codes/regenerate`：请求 `{ currentPassword, factor: { method, code } }`，factor 允许当前 TOTP 或一个未使用恢复码；成功仅本次返回新恢复码并使旧恢复码全部失效。
- `POST /api/auth/security/step-up/disable`：请求同上；成功删除 active/pending 状态并撤销当前用户所有未消费授权。

`intent` 字段固定为 `{ operation, venue, accountId, resourceId, requestDigest }`。服务端从 session 获取 userId，重新核对当前用户的 venue/account ownership；首次新增凭证使用服务端认可的 `new-account` intent，凭证验证成功后再把实际 accountId 的不可逆 domain 写入加密审计。`requestDigest` 是对不含 `stepUpToken` 的实际敏感请求执行“对象键名按字典序递归排序、数组保序、JSON 原子值不变”后的 SHA-256 base64url（43 字符）。execute 的 intent 还由服务端绑定 preflight challenge 和预估名义金额，前端不能自报金额或 eligibility。

以下操作必须提供独立 `stepUpToken`，且服务端在调用 connector/provider 前原子消费：

- 新增或轮换交易所凭证：`credential_put`
- 删除交易所凭证：`credential_delete`
- 开启 global 或 strategy execution：`execution_enable`
- 解除用户 kill switch：`kill_switch_disable`
- 建立现货与永续对冲组合：`hedge_execute`，并继续要求原有 60 秒 preflight challenge 同时有效
- 单个持仓退出：`position_close`
- 当前 venue 全部退出：`close_all`

激活 kill switch、关闭 global/strategy execution、只读查询和 preflight 不要求 step-up，且不能被本机制阻止。授权严格绑定 user、当前 session 的不可逆 domain、venue、account、operation、resource、请求摘要与名义金额；过期、重放、并发双消费、跨 session/用户/账户/操作/资源/金额均拒绝。稳定错误类别包括 `step_up_not_enrolled`、`step_up_required`、`step_up_invalid`、`step_up_expired`、`step_up_replayed`、`step_up_scope_mismatch`、`step_up_rate_limited`、`step_up_recovery_required`、`step_up_key_unavailable` 和 `step_up_storage_*`。

密码重置会在 SQLite 写入非敏感 enrollment invalidation epoch，撤销所有内存授权和 pending enrollment，但保留已启用 TOTP；用户恢复登录后仍需重新验证 TOTP。logout 撤销当前 session 授权；用户 disabled、凭证删除/轮换、账户或执行开关、kill switch 变化撤销对应范围授权。验证码/恢复操作按 user + session 实施基础 5 次/5 分钟限制；自动套利入口还必须通过下述专用限流。

本项前后端实现已通过固定安全复验：security `11/11`、auth/automation routes `6/6`、Modal + step-up + automation 前端 `40/40`、automation `66/66`、arbitrage `32/32`，合计 `155/155`；App/Server/Node TypeScript、完整构建、部署静态校验、production safety `18+5`、Compose 结构和 `git diff --check` 均通过。固定测试的独立浏览器 fixture 被客户端策略阻止，因此本轮未独立取得真实 DOM/响应式数据；owner 已完成 1440/430/390 运行态验证，该限制按既定口径记录为未覆盖项，不构成代码阻塞。本项已由 `b02e367` 提交但尚未部署。真实 Docker mount/UID/GID 集成和 multi-instance 原子授权存储仍是后续阻塞；当前单 Node 拓扑下授权只存内存，禁止横向扩容。

## 自动套利专用限流与状态容量

第 5 项 owner 实现把普通用户私有 automation API 分为 credential、risk control、preflight、execute、单仓退出、close-all 和 private read 七类策略。每个窗口同时使用不可逆 IP domain、认证 user domain、venue 与服务端确认的 accountId；首次凭证使用固定 `new-account` intent，未知账户使用固定共享域，绝不按 body/query 的 userId 或任意 accountId 拆桶。credential 首次验证/轮换/删除共享 `4/10min`；preflight 为 `4/10s + 30/10min`；execute 为 `2/60s + 6/1h` 且同账户并发 1；单仓退出与 close-all 各有 `8/60s`、共享 `12/60s`，另有 `3/1h` 的受控退出 reserve 且同账户退出并发 1；private read 为 `120/60s`。429 固定 `Cache-Control: no-store`、稳定 category 和 `Retry-After`，不返回 IP、内部 domain、bucket key 或 provider raw response。

限流采用两阶段同步原子门禁：第一阶段只使用不可逆 IP/user domain 与服务端路由 venue，在任何 request-driven registry factory、账户元数据读取、KMS 或 provider 动作前 admission；step-up authorize 的自动套利 intent 解析也必须先通过该门禁。通过后才读取非敏感 credential envelope 元数据，并以服务端确认 accountId 进入第二阶段账户桶和并发门禁。Registry 的恢复初始化只在两阶段均通过后执行，被限流请求不得触发 KMS、provider 私有读取/写入或恢复动作。激活用户急停、关闭 global/strategy execution 和服务端总急停不进入新增风险桶，也不等待恢复初始化；退出使用独立预算，entry/credential/preflight 桶耗尽不会阻断退出。退出预算耗尽只允许使用有界 reserve，并返回人工交易所处理提示，不会静默放开。认证前 401、禁用用户 403 和公开 dashboard 缓存语义不变。

内存安全状态有全局及每用户硬上限：固定窗口 bucket `20000/200`、in-flight `1000/10`、challenge `5000/20` 且 TTL 60 秒、用户 registry 1000、step-up authorization `10000/20`、factor attempt `20000/100`、step-up store 1000；step-up authorization 在任何加密状态读取前原子预留全局及用户容量，成功写入或失败退出都会释放 reservation，跨用户并发不能超发。过期 bucket、challenge、authorization 和空闲 store 定期清理，重启继续清空 challenge、一次性 token、armed 与 in-flight。治理 audit 只保存操作、venue、稳定结果类别和时间，默认全局 5000、每用户 100。

持久状态保留已完成执行/幂等 tombstone 至少 30 天；`hedged`、未完成补偿、recovery/manual_intervention 与开放仓位关联执行不参与 GC。完成执行 soft/hard 为 `2000/2200`，活动执行上限 100，PnL 点 1000，credential audit 500，状态文件 soft/hard 为 `8/10 MiB`。过期 challenge、超过保留期的完成执行、旧 PnL 和 audit 按时间与 ID 确定性清理并原子写回；soft 上限阻断新增风险，hard reserve 保留给急停、退出和恢复。无法安全清理时 fail-closed，不缩短 30 天幂等重试窗口。

全部参数使用有上下界的整数配置；0、负数、无限/超大值、持续窗口短于 burst 窗口、hard 小于 soft 或幂等保留短于 30 天均拒绝生产启动。测试所需短周期只能通过显式依赖注入，不能来自生产 env。本项代码与静态契约已通过固定安全复验，但尚未部署，不表示可以录入真实凭证或解除服务端总急停。

## 单执行实例与跨进程租约

当前冻结能力是单主机、单 Node 执行实例，不宣称支持多主机或横向扩容。生产固定
`RWA_AUTOMATION_EXECUTION_MODE=single-host`、`RWA_AUTOMATION_INSTANCE_COUNT=1`、
`WEB_CONCURRENCY=1`，锁目录和文件固定为 `/app/rwa-automation-lock` 与
`/app/rwa-automation-lock/operation.lock`；其他值拒绝启动。Compose 不配置 replicas，
并使用仅当前主机可见的 `rwa_automation_lock` local named volume。NFS、CIFS、9p、Ceph、
GlusterFS 与 FUSE 等网络或用户态文件系统不具备本契约要求的锁语义，运行时一律拒绝。

API 在构造 KMS provider、step-up store、自动套利 registry 或执行 connector 之前取得租约。
锁目录由镜像预置为 `root:root 0555`，锁文件为 `20001:20001 0600`；生产不创建缺失锁文件。
启动执行 `lstat + realpath + stat`，要求锁目录为独立可写本地 mount，并用
`O_RDWR|O_NOFOLLOW` 打开锁文件，再以同一 FD 执行 non-blocking exclusive `flock`。`fstat`
固定 regular file、`nlink=1`、owner/mode 与 inode；目录不可由 API UID 改写，避免删除锁文件后
以新 inode 绕过。锁内容不保存 PID、token 或 Secret，旧锁文件不会形成 stale owner；进程退出或
崩溃关闭 FD 后由内核释放租约。

第二实例在租约竞争失败时直接拒绝启动，不创建 registry，不读取账户元数据，不执行 KMS 解密、
provider 私有读取、恢复、撤单或下单。租约 guard 同时注入 ControlService、Bybit 与 Binance
执行服务，在 request-driven registry 创建、凭证操作、preflight、execute、close-all、恢复及
provider 写前复核 FD；周期监控发现 FD/inode 失效后立即退出。持锁实例的激活急停、关闭执行开关
和受控退出仍沿用既有独立安全路径，不受新增风险限流阻断；无租约实例不得以“安全退出”为由并发
写 provider。

execute 在任何 provider 写前已原子持久化 challenge 消费和 execution reservation；close-all
同样先持久化 compensating execution。崩溃发生在 reservation 后、provider 写前时，重启只恢复
该记录，不重新建立对冲组合；发生在 provider 写后、最终状态持久化前时，新 owner 按策略
client order ID/order ID 查询权威状态，仅撤销策略订单并退出策略两侧仓位。无法证明闭环时进入
`manual_intervention`、激活用户急停并要求人工核对。60 秒 challenge、step-up authorization、
armed 与 in-flight 状态均不跨重启恢复；持久幂等 tombstone 继续至少保留 30 天。

该租约只对同一主机、同一 local named volume 的进程提供互斥。把同一 Compose 栈复制到第二台
主机无法由本地 `flock` 协调，因此属于明确禁止的部署拓扑；若未来需要多主机，必须另立任务引入
共享原子存储、事务唯一约束和 fencing token，不能复用当前实现声称支持。本项代码与静态契约已
通过固定安全复验并由 `a486f74` 提交，但尚未部署。独立测试确认锁路径替换后旧 owner 立即失效，且首次 provider
写后租约失效时不再发生后续下单、撤单或恢复写入；两项安全 harness `2/2`、租约与执行专项
`47 passed + 1 Linux-only skipped`、自动套利全目录 `111 passed + 1 Linux-only skipped`、
完整套利 `33/33`，三套 TypeScript、完整 build、deploy/production safety `33+11`、Compose
静态展开与 diff check 均通过。真实 Linux 容器内 flock/volume、双容器竞争、崩溃恢复和旧锁卷
迁移现场项仍未覆盖，因此本结论不表示可部署、可录入真实凭证或可解除服务端总急停。

## 第 7 项：25 USDT Mainnet 验证零资金准备

本阶段只冻结未来受控窗口的前置条件、证据和停止规则，不授权真实连接或资金动作。完整操作口径见
`deploy/RWA_BINANCE_25_USDT_MAINNET_RUNBOOK.md`。真实范围固定为 Binance Mainnet
`XAUTUSDT` 现货买入与 USD-M 永续卖出、永续 1x、专用子账户，不允许替换品种、方向、数量或
使用客户端自报 symbol。

25 USDT 是一次组合的总资本预算：现货估算名义、永续 1x 估算名义、实时 taker fee 与滑点准备金
合计必须 `<= 25`，不是两侧分别 25。数量由 `25 * 0.95 / (spotAsk + perpetualBid)` 按两产品共同
步长向下取整；实时最小名义或精度无法满足时直接取消验证。300 USDT 服务端硬上限保持不变，但
不构成本次提高预算的授权。25 USDT 也不是保证亏损上限，provider 不可用、跳空、部分成交和退出
失败仍须按人工处理边界应对。

受控窗口前必须完成 Vultr 单主机/单实例和真实 Docker volume/mount/owner/flock 现场验证、固定
出口 IPv4 与 Binance 白名单精确匹配、专用子账户 read + Spot + Futures 且 withdraw=false、
one-way/single-asset、XAUTUSDT 两产品实时 TRADING、两账户余额/仓位/活动订单核对、GCP KMS
X.509 WIF、独立数据/备份/锁卷、TOTP、两层执行开关和两级急停核对。任一事实未知即停止。

现有私有 API 已能分别提供 credential/config/account、preflight 预算、execution 订单、positions、
策略归因 PnL 和脱敏 audit 证据。原始 preflight 含一次性 challenge token，不得直接落盘；证据只
保留 account fingerprint、预算/数量/状态、策略 order ID/client order ID、成交/PnL 和稳定错误
类别，不保存 Secret、IP、token、TOTP、WIF 或 provider raw response。

新增 `npm run test:rwa-mainnet-readiness` 零资金 rehearsal：入口在发现 production、关闭服务端
总急停、真实 ADC、本地主密钥、固定出口 IP 或常见 Binance credential 环境变量时拒绝启动，只
运行 fake provider/KMS、临时目录和公开测试值。覆盖正向预算、首次 provider mutation 失败、
永续侧失败补偿、部分成交、权威订单超时、退出失败、重启恢复、租约失效、KMS/IP/TOTP 失败、
凭证隔离和灾备。该结果不得描述为 Mainnet 已验证。

当前仍需项目管理在未来单独确认真实窗口，并由用户/运维在服务器和 Binance 私有 UI 提供或操作
真实 WIF、固定出口 IP、专用子账户凭证、TOTP 和人工退出能力；任何 Secret 都不得通过聊天交付。
本项零资金准备已通过固定安全复验并由 `78c277c` 提交，但真实 25 USDT Mainnet 验证尚未执行；
当前未部署，服务端总急停未解除。独立验证为危险环境入口负向门禁 `7/7`、Binance service `12/12`、完整
readiness rehearsal `125 passed + 1 Linux-only skipped`、security/auth/routes `21/21`、完整
套利 `33/33`；三套 TypeScript、完整 build、deploy validation、production safety `33+11`、
含 ops profile 的 Compose 静态展开和 `git diff --check` 均通过。该结论不表示 Mainnet、Vultr、
真实 WIF/KMS、固定出口 IP、真实账户/产品/余额或 25 USDT 订单已经验证。

### 步骤 0 发布 revision 阻塞整改

首次真实窗口步骤 0 因生产无法独立证明已验收 commit 而按 fail-closed 停止，步骤 1–4 未执行。
首轮整改仍保留生产 Compose 直接 `build:`，且 tag、label、内置文件与 runtime env 都由同一
revision 参数派生，固定安全复验因此继续阻塞。当前修复把生产构建完全移出 `compose.yaml`；
可信构建脚本从干净 Git checkout 对指定 commit 执行 `git archive`，构建三类镜像后输出严格
release manifest，将完整 revision 与实际 API、Web、strategy tools 不可变 digest 绑定。
automation backup/restore 复用同一 API digest。

生产只接受清单中的 digest；清单要求严格 schema、单硬链接、非 symlink、只读普通文件。发布前
核对实际 image ID、清单 digest、OCI label 和内置 revision，发布后再核对运行容器 image ID 与
runtime env。`.env.production` revision 只作交叉核对，不能以 env、tag、容器 ID、健康状态、
生产 `.git` 或人工口述单独证明版本。缺失、短 SHA、非法 digest、清单/组件错配、运行时 env 篡改
或无唯一运行容器均 fail-closed。第四轮固定安全测试已确认本轮代码与离线门禁通过；当前尚未部署，
也未重新进入真实窗口步骤 0。步骤 1–4、真实 WIF/KMS、Binance 私有读取、凭证录入、急停/执行
开关变更、provider 写、订单和资金动作均未执行。

本轮 owner 自检：release manifest/revision 专项 `20/20`，Mainnet readiness
`125 passed + 1 Linux-only skipped`，automation 全目录 `113 passed + 1 Linux-only skipped`，
完整套利 `33/33`；App/Server/Node TypeScript、完整 build、deploy validation、production safety
`33+11`、五组件 Compose 静态展开、Shell/Node 语法和 `git diff --check` 均通过。Docker daemon
不可用，因此可信构建的真实镜像 digest、镜像转移、运行容器 image ID 与生产清单安装仍未现场
验证；该未覆盖项不允许描述为已部署或步骤 0 已通过。

固定安全第二轮复验确认默认 Compose digest 映射正确，但定位到 `COMPOSE_FILE` 可重新引入
`compose.build.yaml` 的 P1 旁路。当前修复新增唯一生产 wrapper，固定 `compose.yaml` 与项目名，
拒绝 Compose 文件/项目 override；每个生产 `up/run/exec/stop` 前均解析最终 Compose JSON，严格
检查五个服务无 `build`、image digest、`pull_policy` 和 revision 与同一 manifest 匹配。activation
和恢复后的容器证据若失败，会立即停止 API/Web。相关负向用例覆盖 `COMPOSE_FILE` 在第一条 Docker
调用前拒绝、错 image/build schema 拒绝，以及 post-start runtime mismatch 后执行 stop。第二轮
指出的 Compose 文件选择旁路已在后续复验关闭，但不表示步骤 0 已通过。

固定安全第三轮复验进一步定位连接式 Compose 全局短选项 `-fFILE`/`-pNAME` 未拒绝，同时原全局
扫描会误伤 `logs -f`。wrapper 现只解析子命令前的全局参数：连接式与分离式 file/project override
全部 fail-closed，进入 `logs` 等允许子命令后不再把其参数解释为拓扑覆盖。专项新增真实 CLI 语义
回归，确认两种连接式覆盖在 Docker 调用前拒绝且 `logs -f api` 到达固定项目日志命令。revision/
manifest/final Compose 专项现为 `20/20`。第四轮固定安全复验确认第三轮 P1/P2 均已关闭，代码与
离线门禁通过、无新增代码阻塞。Docker daemon 真实镜像构建与转移、image ID/label/内置 revision
检查、生产 manifest 安装、运行容器唯一性、activation 及 volume/mount/flock 仍未覆盖，因此本
结论不表示已部署、步骤 0 现场已通过或可进入步骤 1–4。

### 首次 legacy 到 verified release 桥接

当前旧生产没有标准 release manifest/revision，不能直接作为正常 rollback baseline。新增一次性
bridge 工具，冻结旧 API/Web 精确 image ID、各自 `docker save` 归档/hash、只引用旧 image ID
与既有卷的恢复 Compose、SQLite `.backup` integrity/hash/size，以及五个原地保留卷的
owner/mode/mount 映射。bridge manifest 采用精确 schema，拒绝未知字段、symlink/hardlink、可写
产物和任何 env 值、WIF、Secret、token、IP 或 provider raw response。

首次切换在任何 stop 或数据动作前必须复核 bridge 文件、仍运行的旧 runtime、SQLite recovery
point、新 release 卷边界、release manifest/镜像/Compose 与 WIF/KMS preflight。新 activation
或最终容器证据失败时，停止新 API/Web 后按冻结 image ID 恢复旧版；即使 stop 失败也继续尝试
恢复。恢复前以旧 API 镜像在无网络、只读根和只读备份卷中复核 SQLite，恢复后核对 image ID、
唯一容器、health、卷映射和 recovery point。首次桥接不删除、不恢复、不迁移 SQLite、strategy、
Caddy 或既有卷。

新 release 最终证据全部通过后才以安全 FD 写 `0444` 一次性 marker；从此 bridge 永久禁用，
正常 activation/rollback 只接受标准 verified manifest。首次激活会先隔离初始化 automation
data/backup/lock 新卷并验证 WIF/KMS；随后停止旧 API，对 owner 一致且无 symlink/hardlinked file
的三个旧 API 数据卷事务式迁移到 `20001:20001`，失败时先恢复冻结 owner 再恢复旧镜像。当前实现
仍待本轮重新固定安全复验；尚未执行生产 bridge、Docker restore、UID/卷迁移或 activation，
不表示步骤 0 已通过。

WIF 安装工具只接受服务器本地、仓库外、root-only 的完整五文件 source 和独立 audience 文件，
固定 mTLS STS `https://sts.mtls.googleapis.com/v1/token`，在新 tmpfs staging 完整复制和校验后
才 `mount --move` 到 `/run/xingheng/gcp-wif`。目录/文件固定 `20001:20001`、`0700/0400`；
部分/额外文件、symlink/hardlink、越界路径、错误 mount/owner/mode 均 fail-closed。真实 leaf
私钥只能在 Vultr 本机生成，离线 CA 私钥一次签发后销毁；provider 完成并返回完整 audience 前
不得生成 ADC、发布五文件 bundle 或运行 KMS health。真实 WIF 当前仍待受控创建/注入。
