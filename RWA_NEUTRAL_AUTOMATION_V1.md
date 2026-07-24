# RWA 中性自动套利 V1 执行契约

更新时间：2026-07-24

当前状态：Phase A 私有只读/Shadow 已部署；用户已明确授权普通登录用户进入 Mainnet 真实资金执行开发。当前后端采用按用户隔离的统一 venue registry，Bybit 保留既有执行 adapter，Binance 已完成受控执行闭环并进入 `execution_capable`，Bitget/OKX 仍默认 disabled 且未实现。Binance 默认执行开关关闭、用户 kill switch 激活、服务端全局 kill switch 激活；生产 Compose 的 X.509 WIF/ADC 只读挂载契约已实现，但尚未在服务器注入真实身份材料或配置真实交易所凭证，因此当前不会发生 provider 写调用。自动策略继续严格要求 `automationEligible=true`，用户主动入场则使用独立 `manual_entry` 风险预检，两者都不能绕过安全、私有账户或急停门禁。

安全整改第 3 项已完成前后端实现并通过固定安全复验：敏感操作新增 RFC 6238 TOTP 二次身份验证和一次性 step-up authorization。二维码作为后续体验优化延期，当前通过手动设置值完成 enrollment；本项已由 `b02e367` 提交但尚未部署，生产服务端总急停继续保持激活。

本文档是 RWA 自动套利 V1 的执行事实基线。公开行情、后台评定与只读看板口径继续以 `RWA_GOLD_ARBITRAGE_DASHBOARD.md` 为准；本文只定义私有账户、Shadow、状态机、风控和执行门禁，不表示真实交易已经上线。

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
- 建议资金为 25 USDT，仅用于验证最小对冲组合订单、撤单、补齐对冲、平仓和审计闭环。

### Phase D：用户 Mainnet 小额试运行

- 建议先以 50 USDT 运行；V1 总资金硬上限为 300 USDT，不是最低资金要求。
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
| Mainnet 连通性烟测 | 25 USDT | `0.002 XAUT` 现货约 8.3U + 等量永续 1x 保证金约 8.3U + 约 8.4U 备用金 |
| 小额试运行 | 50 USDT | `0.005 XAUT` 现货约 20.7U + 等量永续 1x 保证金约 20.7U + 约 8.6U 备用金 |
| V1 硬上限 | 300 USDT | 不是默认投入额，也不得因余额更高自动扩大 |

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

- 默认每批名义金额不超过 25 USDT。
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
| 最大单侧暴露 | `<= 10 秒`，单批 `<= 25 USDT` |
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

Bybit 首个 adapter 当前只支持安全可执行的 XAUT 现货多头 + XAUTUSDT 永续空头。真实入场数量固定 `0.002 XAUT`，25 USDT 是现货与永续对冲组合的 1x 名义、手续费、滑点准备金合计总预算，不是每一侧各 25 USDT；V1 venue 资本硬上限为 300 USDT。

Binance 第一阶段只识别 Binance `XAUTUSDT` 同所精确组合。服务端实时读取 Spot/USDM `exchangeInfo`，不得假定 symbol、替换成 PAXG 或其他黄金标的。2026-07-23 owner 实时核对结果为：

- 现货 `XAUTUSDT`：`TRADING`，数量步长 `0.0001`，最小名义 `5 USDT`，价格步长 `0.01`
- USD-M `XAUTUSDT` 永续：`TRADING`，数量步长/最小数量 `0.001`，最小名义 `5 USDT`，价格步长 `0.01`

以上只记录核对时事实；每次 Shadow/preflight 仍必须重读缓存期内的产品目录、book ticker、盘口、mark、Funding 与下一结算时间。任一产品不存在时返回 `binance_product_unavailable` / `provider_product_unavailable`，不得伪造可执行的对冲组合。

两种模式都会重新读取私有权限、余额、账户模式、实时价格、产品状态、数量/价格步长、最小名义、手续费和强平距离，并硬性校验：

- API 权限、UTA 专用子账户、产品 Trading 状态。
- 数量与价格精度、最小订单、已有冲突仓位。
- 25 USDT 总预算、300 USDT 资本上限与可用余额。
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

Binance preflight 会重读机会与私有账户，分别核对现货/期货可用 USDT、读取/现货/Futures 交易权限、提现关闭、one-way 持仓模式、产品状态、数量/价格精度、最小名义、活动订单、已有 XAUT 敞口、公开盘口深度、stale、Funding、基差、净 APR、25 USDT 总预算和 300 USDT venue 硬上限。检查失败返回 `409 preflight_rejected`；全部通过才签发 60 秒一次性 challenge。Execute 会再次执行实时 preflight，设置 USD-M Futures 1x 杠杆，并只允许固定 `XAUTUSDT` 的现货侧 IOC Limit Buy 与永续侧 IOC Limit Sell。现货侧实际成交后才按成交数量建立永续侧；永续侧失败、订单状态超时或对冲未完成时，系统只撤销带本策略 client order ID 前缀的活动订单，并尝试补齐对冲或退出本策略仓位。两次退出仍无法闭环时进入 `manual_intervention` 并激活该用户的 Binance kill switch。

25U `connectivity_smoke` 与两种套利入场 mode 明确分离；当前没有开放 connectivity smoke 路由，不能借该 mode 绕过机会资格，也不能记为套利仓位或收益。

### 持仓、PnL 与退出

- `GET /api/arbitrage/automation/positions`
- `GET /api/arbitrage/automation/pnl`
- `GET /api/arbitrage/automation/audit`
- `POST /api/arbitrage/automation/positions/:positionId/close`
- `POST /api/arbitrage/automation/venues/:venue/close-all`

PnL 只按策略 client order ID、provider order ID、execution 与专用账户交易日志归因，返回现货侧与永续侧数量、均价、mark、名义、净 Delta、入场/当前基差、realized/unrealized、Funding、fees、slippage、net PnL、时间序列和执行历史；不得使用账户总 PnL。该归因依赖专用账户不混入同 symbol 的人工仓位。Kill switch 阻止新增风险，但 close/close-all 不受策略 enabled 开关阻止，且不得撤销或平掉非本策略订单和仓位。

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
通过固定安全复验，但尚未提交或部署。独立测试确认锁路径替换后旧 owner 立即失效，且首次 provider
写后租约失效时不再发生后续下单、撤单或恢复写入；两项安全 harness `2/2`、租约与执行专项
`47 passed + 1 Linux-only skipped`、自动套利全目录 `111 passed + 1 Linux-only skipped`、
完整套利 `33/33`，三套 TypeScript、完整 build、deploy/production safety `33+11`、Compose
静态展开与 diff check 均通过。真实 Linux 容器内 flock/volume、双容器竞争、崩溃恢复和旧锁卷
迁移现场项仍未覆盖，因此本结论不表示可部署、可录入真实凭证或可解除服务端总急停。
