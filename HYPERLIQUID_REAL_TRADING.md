# Hyperliquid 真实交易接入契约

更新时间：2026-07-17

本文件定义 `/app/trade` Hyperliquid testnet 真实交易接入的第一阶段工程契约。`/app/demo` 继续承接当前 demo 模拟交易能力，除兼容跳转与命名迁移外，不在真实交易任务中改写既有模拟交易逻辑。

## 1. 当前结论

- 真实交易网络：第一阶段只接 Hyperliquid testnet。
- 官方 testnet API base URL：`https://api.hyperliquid-testnet.xyz`。
- 官方 mainnet API base URL：`https://api.hyperliquid.xyz`，本阶段只作为后续预留，不默认启用。
- API wallet 在 Hyperliquid 文档中也称为 agent wallet；它只用于签名，不用于查询账户数据。
- 查询账户、持仓、订单、成交历史时必须传用户主账户地址或子账户地址，不能传 agent wallet 地址。
- 平台后端不得保存 API wallet 私钥、助记词或可直接代签的明文凭证。
- 本阶段优先使用用户浏览器侧钱包 / API wallet 本地签名；后端只做只读 REST 聚合、契约校验、脱敏审计和已签名 exchange 转发。
- 真实交易核心动作优先使用 Hyperliquid SDK 或官方签名范例实现；只读行情和账户接口可继续使用 REST 封装。
- 后端不得手写真实交易签名、nonce、exchange action 构造或 API wallet / agent wallet 授权流程；如果 SDK / 官方范例无法满足前端本地签名边界，必须回到项目管理确认。

参考来源：

- Hyperliquid API 文档：`https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api`
- Info endpoint：`https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint`
- Exchange endpoint：`https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint`
- Nonces and API wallets：`https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets`
- TypeScript SDK 候选：`https://github.com/nktkas/hyperliquid`

## 2. 路由与页面

| 路由 | 语义 | 数据源 | 下单能力 |
| --- | --- | --- | --- |
| `/app/trade` | 真实交易终端 | Hyperliquid testnet 真实账户 / 真实行情 | 真实签名下单 |
| `/app/demo` | demo 模拟交易终端 | 当前模拟交易服务与行情 | 内部模拟成交 |
| `/app/trading` | 旧兼容入口 | 跳转或兼容到 `/app/demo` | 不新增能力 |

前端要求：

- `/app/trade` 与 `/app/demo` 信息架构可以相似，但状态文案、账户、订单、持仓、成交语义必须隔离。
- `/app/trade` 必须明确展示 `Hyperliquid Testnet` 和 `用户本地签名` 语义。
- `/app/demo` 保留当前“内部模拟成交 / demo 模拟交易”语义。

## 3. 后端模块边界

建议新增模块，避免复用 demo 模拟交易接口造成语义混淆：

```text
server/modules/hyperliquid/
  HyperliquidInfoClient.ts       # testnet / info 只读请求
  HyperliquidExchangeProxy.ts    # 已签名 exchange 转发与响应标准化，不保存私钥
  hyperliquidTypes.ts            # 真实交易专用类型
  hyperliquidConfig.ts           # testnet/mainnet base URL 与环境开关

server/modules/api/realTradingRoutes.ts
```

禁止：

- 把真实交易 handler 塞回 `server/index.ts`。
- 让 `/api/trading/*` 同时承载 demo 和真实交易。
- 在数据库、日志、文档或错误信息中保存 / 打印用户 API wallet 私钥、助记词、签名材料。

## 4. 第一阶段 API 契约

鉴权边界：`/api/real-trading/market/*` 是公开 Testnet 行情；`account / positions / orders / exchange / realtime` 必须通过有效用户会话鉴权，禁用用户返回 `403`。不得用 query、`x-user-id` 或 WebSocket 地址参数绕过用户会话。

### 4.1 只读市场

`GET /api/real-trading/market/symbols`

- 返回 Hyperliquid testnet 可交易 perpetual 列表。
- 字段包含内部 symbol、providerMarketId、provider coin、category、iconUrl、assetId、price/size 精度、maxLeverage、supportedMarginModes、marginModeConstraint、status。
- `providerMarketId` 为 Hyperliquid Testnet 原始 market id；主 DEX 示例为 `BTC`，XYZ / HIP-3 示例为 `xyz:GOLD`、`xyz:AAPL`。
- `category` 为 `"crypto"|"metals"|"us_equities"|"indices"|"other"`；来源优先使用 Hyperliquid Testnet `perpCategories` 与 `perpConciseAnnotations`，`stocks/equities` 映射为 `us_equities`，`indices` 映射为 `indices`，`commodities` 且 provider coin 为 `GOLD/SILVER/PLATINUM/PALLADIUM` 映射为 `metals`。分类接口不可用时不阻断 symbols：主 DEX 默认 `crypto`，可识别贵金属默认 `metals`，其余 HIP-3 / 特殊市场默认 `other`，不从 demo 主网借分类。
- `/app/trade` 的 `iconUrl` 由 `providerMarketId` 派生：`https://app.hyperliquid-testnet.xyz/coins/{providerMarketId}.svg`，其中冒号保留不转义；providerMarketId 异常时返回 `null`。通用 demo/market API 的图标域名按其主行情网络语义保持独立。
- `supportedMarginModes` 为 `("cross"|"isolated")[]`；`marginModeConstraint` 为 `"cross_and_isolated"|"isolated_only"`。
- 当 Hyperliquid meta item 的 `marginMode` 为 `strictIsolated` / `noCross`，或 legacy `onlyIsolated=true` 时，只返回 `supportedMarginModes=["isolated"]`、`marginModeConstraint="isolated_only"`；其他品种返回 `["cross","isolated"]`、`cross_and_isolated`。
- `maxLeverage` 继续使用 Hyperliquid `meta.universe[].maxLeverage`。

`GET /api/real-trading/market/summary?symbol=BTCUSDT`

- 返回 `markPrice / oraclePrice / midPrice / previousDayPrice / dayChange / dayChangePercent / dayNotionalVolume / openInterest / funding / nextFundingTime / status / timestamp`。
- `dayChange = markPrice - previousDayPrice`；`dayChangePercent = dayChange / previousDayPrice * 100`。任一输入无效或分母为 0 时返回 `null`。

`GET /api/real-trading/market/orderbook?symbol=BTCUSDT`

- 返回 Hyperliquid 公共 L2 深度，不叠加平台 spread。
- asks 升序、bids 降序。
- 每档返回 `price / size / cumulativeSize / total / orderCount`；`total` 是 `cumulativeSize` 的兼容别名。

`GET /api/real-trading/market/trades?symbol=BTCUSDT`

- 返回最新成交，字段至少包含 price、size、side、timestamp、tradeId/txHash 可选。

`GET /api/real-trading/market/candles?symbol=BTCUSDT&interval=1m&limit=500`

- 复用 Hyperliquid testnet candleSnapshot 口径。

### 4.2 用户只读账户

所有用户账户接口必须使用用户主账户地址：

`GET /api/real-trading/account/summary?address=0x...`

- 返回账户权益、可用保证金、已用保证金、总浮盈亏、cross 摘要、spot USDC 余额和 warning。
- 核心字段：`accountValue / withdrawable / usedMargin / availableMargin / totalUnrealizedPnl / crossAccountValue / crossMaintenanceMarginUsed / crossTotalMarginUsed / crossTotalNotionalPosition / crossMarginRatio / spotUsdcBalance / spotBalances / warnings`。
- `crossMarginRatio = crossMaintenanceMarginUsed / crossAccountValue`；分母无效或小于等于 0 时返回 `null`。
- `spotBalances` 标准化为 `{ coin, total, hold, available }`；`available = total - hold`，任一输入无效时返回 `null`。
- `spotClearinghouseState` 不可用时，不阻断 summary，`spotUsdcBalance=null`、`spotBalances=[]`，并在 `warnings` 返回原因。

`GET /api/real-trading/account/fees?address=0x...`

- 读取官方 `userFees`，只返回费率，不做服务端下单或代签。
- 最小字段：`makerRate / takerRate / spotMakerRate / spotTakerRate / activeReferralDiscount / activeStakingDiscount / timestamp / network / warnings`。
- `userFees` 不可用时费率返回 `null`，并在 `warnings` 返回原因。

`GET /api/real-trading/positions?address=0x...`

- 返回真实持仓，包含 `coin / symbol / side / size / entryPrice / entryPx / markPrice / markPx / liquidationPrice / liqPx / positionValue / returnOnEquity / margin / marginMode / leverage / maxLeverage / unrealizedPnl / cumFunding / fundingAllTime / fundingSinceChange / fundingSinceOpen`。
- `entryPx / markPx / liqPx` 是前端契约字段；`entryPrice / markPrice / liquidationPrice` 继续保留兼容。
- `markPrice / markPx` 优先使用 `clearinghouseState.position.markPx`；该字段为空或非法时，按当前持仓自己的 Hyperliquid `coin` 从 `metaAndAssetCtxs` 对应 asset context 回退取 `markPx`，找不到可靠值时返回 `null`，不使用页面当前选中品种价格代替。
- 追加 `marginMode: "cross"|"isolated"|null`，取 `position.leverage.type`；`leverage` 继续取 `position.leverage.value`，`maxLeverage` 优先取 `position.maxLeverage`，缺失或非法时返回 `null`。
- `position.type` 不作为 margin mode 或 rawStatus 使用。
- 页面“资金费”优先使用 `fundingSinceOpen`。

`GET /api/real-trading/orders/open?address=0x...`

- 优先读取官方 `frontendOpenOrders`，不可用时回退 `openOrders` 并做等价标准化。
- 每条委托返回 `price / size / timestamp / status`，并保留原始兼容字段 `limitPx / sz`。
- TP/SL 与触发单元数据标准化为 `isPositionTpsl / isTrigger / orderType / origSz / reduceOnly / triggerCondition / triggerPx`。

`GET /api/real-trading/orders/history?address=0x...`

- 返回历史委托 / 成交分页；Hyperliquid info 接口有分页限制时必须显式返回 `nextCursor` 或提示前端继续分页。
- `orders` 标准化 `price / size / timestamp / status / statusTimestamp`，并保留 `limitPx / sz`。
- `fills` 标准化 `price / size / timestamp / fee / feeToken / hash / direction`；字段缺失时返回 `null`，不伪造。

### 4.3 签名动作提交

第一阶段采用“前端本地签名、后端转发”：

`POST /api/real-trading/exchange`

请求：

```json
{
  "masterAddress": "0x...",
  "network": "hyperliquid-testnet",
  "action": {},
  "nonce": 1710000000000,
  "signature": {},
  "vaultAddress": null,
  "expiresAfter": 1710000060000
}
```

响应：

```json
{
  "ok": true,
  "network": "hyperliquid-testnet",
  "result": {},
  "timestamp": 1710000001000,
  "requestId": "server-generated-uuid",
  "actionType": "order",
  "submittedAt": 1710000000000,
  "accepted": true,
  "rejected": false,
  "outcome": "accepted",
  "needsReconciliation": false,
  "orderStatuses": []
}
```

兼容规则：既有 `ok / network / result / message / status / timestamp` 保留；新增字段用于跟踪与对账。`outcome` 为 `accepted / rejected / partial / pending_reconciliation`：

- 上游明确整批成功：`accepted=true, rejected=false, outcome=accepted`。
- 上游明确整批拒绝：`accepted=false, rejected=true, outcome=rejected`。
- batch 部分成功：`accepted=true, rejected=true, outcome=partial`，`orderStatuses` 保留逐订单 `index / status / providerStatus / oid / message`，必须继续权威对账。
- 已可能转发但发生超时/网络中断：`accepted=false, rejected=false, outcome=pending_reconciliation`；这不是拒绝，禁止盲目重试。

校验：

- `network` 必须是 `hyperliquid-testnet`。
- `action.type` 第一阶段只允许：
  - `approveAgent`
  - `order`
  - `cancel`
  - `updateLeverage`
  - 必要的 close / reduce-only order 仍按 `order` 表达
- `approveAgent` 仅允许 Hyperliquid Testnet：`action.hyperliquidChain` 必须为 `Testnet`，`action.agentAddress` 必须为合法 EVM 地址。
- `approveAgent.action.signatureChainId` 固定要求为 Arbitrum Sepolia `421614 / 0x66eee`。前端必须在钱包不处于该网络时先展示明确网络提示，并由用户点击后主动切链；后端 fail-closed 拒绝其他签名链。交易网络边界仍同时由 `hyperliquidChain=Testnet`、Testnet endpoint 与后端 allowlist 保证，签名链不等于 Mainnet 放行。
- `approveAgent` 转发前会只读查询 Hyperliquid Testnet `userRole(masterAddress)`；仅当上游明确返回 `role=missing` 时，本地拒绝且不转发，HTTP `409`、`errorCode=RT_ACCOUNT_NOT_ACTIVATED`、公开文案为“该钱包尚未激活 Hyperliquid Testnet 交易账户，请先完成 Testnet 账户激活后再授权 Agent。”。`userRole` 网络失败或不可读不得误判为未激活，继续走既有 provider fallback 与脱敏审计。
- `approveAgent` 转发前必须按 SDK 相同的 EIP-712 数据恢复签名地址，并确认签名者等于声明的 `masterAddress`；交易所明确接受后，SQLite 只记录 `(userId, masterAddress, agentAddress, approvedAt)` 的非敏感授权绑定。
- 后续 `order / cancel / updateLeverage` 转发前必须恢复 L1 action 签名地址，并确认它等于当前登录用户及 `masterAddress` 已绑定的 agent wallet；不存在绑定或签名不匹配时 fail closed，避免用未绑定地址绕过账户风险快照。
- `updateLeverage` 专项校验：`action.type` 必须为 `updateLeverage`，`asset` 必须是大于等于 0 的 safe integer，`isCross` 必须是 boolean，`leverage` 必须是正 safe integer。服务端不再设置平台自定义最高杠杆上限；品种实际最大杠杆、账户状态与交易所规则由 Hyperliquid Testnet 最终裁决，provider 拒绝不得被误报为成功。
- 禁止 withdraw、transfer、staking、builder fee 等资金转移类动作。
- 后端只做 allowlist、基础字段、签名账户绑定、风险门禁、请求限流、脱敏审计和响应标准化；不修改签名内容，不生成 nonce / signature / expiresAfter，也不保存可代签材料。
- 每笔 `order` 必须在浏览器签名前写入 `order.c`，格式固定为 `0x` + 32 位十六进制 `cloid`。服务端不会事后修改已签名 action。
- 服务端按 `(userId, masterAddress, network, cloid)` 建立 SQLite 唯一约束并在转发前原子占位。同一 cloid 已有终态时返回原回执，处理中或结果未知时返回 `409 / pending_reconciliation`，不得再次转发。

### 4.4 服务端最小可信度门禁

服务端不再设置平台自定义最高杠杆、单笔新增名义 / 权益、总敞口 / 权益或当前委托数量上限；这些约束交由 Hyperliquid Testnet 按品种、账户和交易所规则裁决。服务端只保留新增风险前的最小可信度门禁，不替代交易所风控。

| 规则 | 默认值 | 环境变量 |
| --- | ---: | --- |
| 账户 / 市场快照最大年龄 | `10s` | `REAL_TRADING_RISK_MAX_SNAPSHOT_AGE_MS` |

- 新增风险订单转发前必须读取账户摘要、品种目录和对应市场 summary；任一 REST 读取失败、账户 `status!=connected`、市场 `status!=connected` 或 timestamp 过期时 fail closed。
- 新增风险订单仍校验已签名 action 中价格、数量和 asset 为可解释的正数 / 有效编号，但不计算平台名义价值上限。
- `reduce-only` 平仓/保护单不因账户已超限而被阻断；`cancel` 始终不经过新增敞口门禁。
- `reduce-only` 仍读取权威持仓和品种目录，校验同品种、反方向、数量不超过可平持仓，避免越过零仓位反手。
- 服务端只校验已签名 action，不修改价格、数量、杠杆、cloid 或签名内容。

### 4.5 权威订单状态与用户实时流

降级 / 恢复接口：

`GET /api/real-trading/orders/state?address=0x...&afterSequence=123`

- 首次、sequence 不连续和断线恢复返回 `mode=snapshot`；正常连续轮询返回 `mode=incremental`。
- 每个响应包含 `sequence / timestamp / status / stale / reconnecting / authoritative=true`。
- 增量只比较 Hyperliquid `openOrders + historicalOrders + userFills` 两次权威快照；不会把 exchange 回执或“open order 消失”推测成成交。
- 上游失败且有缓存时返回 `stale=true, reconnecting=true` 的旧快照；首次失败返回 sequence `0` 的空快照，绝不伪造订单或成交。恢复后强制重新发完整 snapshot。

`GET /api/real-trading/orders/status?address=0x...&cloid=0x...`

- 使用 Hyperliquid 官方 `orderStatus` 按 128-bit cloid 查询权威状态。
- `unknownOid` 标准化为 `status=unknown, order=null`，只表示当前未找到，不得推断成拒绝或允许盲目重下。
- 页面遇到 `pending_reconciliation` 时保留该状态并周期查询同一 cloid；查到订单后才用权威状态替换。等待期间暂停新的开仓，但保留 reduce-only 退出能力。
- 服务端同时运行受控 pending reconciliation worker：启动后立即检查一次，之后按 `REAL_TRADING_RECONCILIATION_INTERVAL_MS`（默认 `60000ms`，范围 `30000..300000`）限频查询；每轮按 `REAL_TRADING_RECONCILIATION_BATCH_SIZE`（默认 `50` 个 request，范围 `1..500`）读取待恢复 request；只调用 Hyperliquid `orderStatus`，绝不重放原 order、cancel 或签名 payload。
- worker 只在同一 request 的全部 cloid 都查到权威 `order` 时，将本地 `pending_reconciliation / processing` 转为 `accepted` 并写入脱敏标准回执；`unknownOid`、上游失败或部分不可确认时继续保持 pending，并暴露给运营核对。
- worker 从 SQLite 按完整 request 分组读取 pending；即使设置 batch limit，也不得截断同一 request 的 cloid 集合后判定整请求成功。

`GET /api/real-trading/orders/reconciliation`

- 登录用户保护，禁用用户返回 `403`，`Cache-Control: no-store`。
- 只返回当前登录用户仍需对账的本地 pending 记录；HTTP 请求本身不访问 Hyperliquid、不触发恢复、不重放订单。
- 响应：`{ network:"hyperliquid-testnet", records:[{ requestId, actionType, submittedAt, clientOrderIds, autoRecoverable, manualReview, lastReconcileAttemptAt, errorCategory, blockingScope }] }`。
- `autoRecoverable=true` 仅用于 order 且存在对应 cloid 幂等记录，后台 worker 会继续用 `orderStatus` 权威恢复；cancel / updateLeverage / approveAgent 等非 order pending 标记为 `manualReview=true`。
- `blockingScope` 当前为 `"new_risk"` 或 `"manual_review"`，用于前端硬刷新后恢复页面锁、提示和审计轮询；空态固定返回 `records=[]`。
- 不返回 master address、vault address、signature、nonce、私钥、助记词、原始 payload、provider 原文或内部堆栈。

主实时链路使用 Hyperliquid Testnet user WebSocket，不把短轮询包装成完整实时：

1. 已登录用户调用 `POST /api/real-trading/realtime/token`，body 为 `{ "address": "0x..." }`，取得默认 60 秒、一次性、绑定 userId/address 的 token。
2. 客户端连接星衡现有 `/ws` 后发送 `{ "type":"subscribe", "channel":"real-trading-user", "token":"..." }`。
3. 服务端按 master address 复用 Hyperliquid SDK `orderUpdates / userFills / openOrders / clearinghouseState` 订阅并引用计数释放；同一用户同时只允许一个 master address。
4. 下游事件统一带 `mode / sequence / timestamp / status / stale / reconnecting / authoritative / source / address / channel / data`。
5. 首次连接和每次重连后先拉 REST 权威 snapshot，再继续 WS incremental；断线时立即推送 `status=reconnecting, stale=true`。REST `orders/state` 继续作为恢复和降级路径。

### 4.6 SQLite 审计与保留

- `real_trading_exchange_audit` 默认保留 180 天（`REAL_TRADING_AUDIT_RETENTION_DAYS`），启动及最多每 6 小时做一次有界清理，不在每次请求执行全表 purge。
- 只保存 `requestId / userId / network / masterAddress / actionType / cloid[] / outcome / errorCategory / providerStatus / HTTP status / 时间` 等不可重放元数据。
- 禁止保存或记录 signature、nonce、私钥、助记词、seed、原始已签名 payload；审计 message 使用固定分类文案，不保存上游或请求原文。
- `real_trading_order_idempotency` 只保存 cloid 唯一键、处理状态和脱敏标准回执，不保存签名请求；结果未知固定为 `pending_reconciliation`，等待权威订单/成交状态决定。
- `real_trading_order_idempotency` 追加 `reconcileAttemptCount / lastReconcileAttemptAt / lastReconcileError`，用于运营核对恢复尝试；迁移只追加列，兼容旧 SQLite。

### 4.7 后台运营健康状态

`GET /api/admin/real-trading/operations`

- 管理员登录保护，只读，`Cache-Control: no-store`。
- 固定返回 `network=hyperliquid-testnet`；本接口不提供 Mainnet 切换开关。
- 返回字段包括：
  - `reconciliation`：enabled / running / lastAttemptAt / lastSuccessAt / lastCompletedAt / consecutiveFailures / lastError / lastScannedPending / lastRecoveredRequests / nextCheckAt。
  - `userStreams`：活跃 stream 数、活跃用户数、maxStreamCount，以及每个脱敏地址的 status / reconnecting / stale / sequence / lastSnapshotAt / lastEventAt。
  - `risk`：当前最小可信度门禁配置、已移除的平台自定义上限标记，以及兼容的 in-flight 空聚合。
  - `operations`：pending 数量、最老 pending 时间与年龄、近 24 小时 accepted / rejected / partial / pending 计数、审计清理状态。
  - `mainnetReadinessGaps`：Mainnet 准入前置缺口清单。
- 顶层 `status` 为 `ok / degraded / unavailable`：无 active stream 属于 idle，不降级；reconciliation 连续失败或 stale、存在 manualReview pending、存在无审计的 idempotency pending、或 active stream stale/reconnecting 时返回 `degraded`；组件不可用时返回 `unavailable`。
- pending 汇总以 `real_trading_exchange_audit.outcome=pending_reconciliation` 为准，不只看 order idempotency；同时拆分 `autoRecoverablePendingCount` 与 `manualReviewPendingCount`，避免 cancel / updateLeverage / approveAgent 的未知结果被误报为 0。
- 字段无法可靠取得时返回 `unavailable` 或 `null`，不编造数据；不得返回 signature、nonce、私钥、助记词、原始已签名 payload、SMTP/环境变量 secret 或内部堆栈。

## 5. 前端签名边界

前端第一阶段目标：

- 连接用户钱包，取得主账户地址。
- 引导用户在 Hyperliquid testnet 完成 API wallet / agent wallet 授权。
- 本地生成或读取 API wallet 签名器，但不得把私钥发给后端。
- 订单、撤单、杠杆、平仓动作应优先通过 TypeScript SDK 或官方签名范例在浏览器本地构造和签名，再提交给 `/api/real-trading/exchange` 转发。

如果 TypeScript SDK 需要私钥对象才能签名，必须保证该私钥只在浏览器会话内存中使用，不进入后端、localStorage、IndexedDB 或日志。若 SDK 无法满足该边界，必须回到项目管理确认后再换方案。

## 5.1 SDK 使用原则

第一批验证结论：

- 采用 `@nktkas/hyperliquid@0.33.1`。SDK 支持 ethers v6 browser signer，并允许注入自定义 `IRequestTransport`。
- SDK 在调用 transport 前完成 action、nonce 与 signature 构造；星衡自定义 transport 只把已签名 payload 转发到 `POST /api/real-trading/exchange`，不让 SDK 从浏览器直连 Hyperliquid exchange endpoint。
- 主账户通过浏览器钱包 provider 签署 `approveAgent`；会话 agent wallet 使用 `ethers.Wallet.createRandom()` 在页面运行内存生成，只保存在组件持有的会话对象中，刷新 / 卸载后销毁，不进入任何持久化存储。
- 当前后端 exchange allowlist 接受 `approveAgent / order / cancel / updateLeverage`。`approveAgent` 只允许 testnet，且必须携带合法 `agentAddress`；后端继续只转发已签名 payload，不生成或保存 agent 私钥。

- `/app/trade` 真实交易核心动作优先使用 Hyperliquid SDK 或官方签名范例，不再完全手写签名和 exchange action 构造。
- 只读接口可以继续使用 REST 封装，包括 symbols、summary、orderbook、trades、candles、account summary、positions、open orders、history。
- 真实交易动作包括 order、cancel、updateLeverage、reduce-only 平仓、API wallet / agent wallet 授权、nonce、signature、expiresAfter。
- 后端不得采用“用户把 API wallet 私钥交给服务器，再由服务器 SDK 代签”的方案。
- 后端 exchange proxy 只负责 allowlist 校验、限流、审计、转发和响应标准化，不负责保存私钥或生成用户交易签名。
- 如果当前 TypeScript SDK 不能满足“不保存私钥 + 前端本地签名”的边界，必须停止并回到项目管理确认，而不是改成后端保存私钥。

## 5.2 当前前端动作口径

- `/app/trade` 的开仓、单仓市价/限价平仓、全部市价平仓、反手、撤单、杠杆更新和 TP/SL 均由浏览器内 `@nktkas/hyperliquid` 会话签名器构造并签名，再经现有 `/api/real-trading/exchange` 转发；不新增后端动作接口。
- 真实 K 线首次按当前品种与周期加载 500 根历史数据，之后每 2 秒仅拉取最近 2 根并用 `series.update()` 增量更新最新蜡烛，不重置用户缩放或时间轴位置；页面处于后台时跳过轮询，重新可见后立即补拉一次。
- 下单面板以两个紧凑按钮展示当前品种的保证金模式与杠杆，点击任一按钮打开同一个“保证金与杠杆”弹窗；全仓对应 `updateLeverage.isCross=true`，逐仓对应 `false`。滑杆与数字输入只修改弹窗草稿，确认时才提交一次 SDK 动作，取消不提交。
- 杠杆范围按当前品种 `maxLeverage` 取 `1..maxLeverage` 整数；已有持仓优先使用持仓返回的 `marginMode / leverage / maxLeverage`，无持仓时仅复用当前浏览器会话内该 symbol 已成功提交的配置，切换品种不得串用。旧 symbols 响应缺少模式能力字段时兼容为全仓和逐仓均可选。
- `marginModeConstraint=isolated_only` 时全仓选项禁用，首次默认逐仓；当前阶段不提供 isolated margin add/remove，也不展示为可用能力。
- 下单确认显示 `{leverage}x · 全仓/逐仓`，所需保证金估算使用当前已确认杠杆。会话首次授权后的初始 `updateLeverage` 同样使用当前品种已选择的模式与杠杆。
- 限价平仓确认弹窗默认填入对手方最优一档：多仓平仓使用 best bid，空仓平仓使用 best ask；用户可在提交前编辑。
- 开仓前可勾选 TP/SL 并填写止盈价、止损价，入场单和固定数量的子触发单以 `normalTpsl` grouping 一起提交；该模式对应与父订单关联的 OCO TP/SL。
- 持仓形成后可从持仓表的止盈/止损列设置或替换触发单；替换时先撤销该品种现有 trigger orders，再提交新的 `positionTpsl`。
- TP/SL 使用 market trigger；触发后的保护价按官方默认容差口径设置为触发价上下 10%。
- 反手按“先 reduce-only 市价平掉原仓，再按同数量反向市价开仓”顺序执行。前一动作已成交而后一动作失败时不会自动回滚，验收需覆盖该部分完成状态。
- 会话 agent wallet 仍只保存在页面运行内存中；刷新、切换 provider 或钱包地址变化后必须重新授权。

## 6. 测试验收重点

- `npm run build` 通过。
- `/app/demo` 当前模拟下单、平仓、持仓、订单记录不回归。
- `/app/trade` 明确展示 Hyperliquid testnet 与真实交易风险，不误写为生产 mainnet。
- 后端不保存、不打印 API wallet 私钥、助记词、签名材料。
- 真实交易核心动作不得完全手写签名；应验证是否使用 SDK 或官方签名范例，若暂未完成则页面必须禁用真实下单并标明待接入。
- 真实交易接口拒绝资金转移类 exchange action。
- L2 深度、最新成交、账户、持仓、委托、历史记录的 empty/error/loading 状态完整。
- 网络断开、签名失败、testnet 余额不足、订单被拒绝、撤单失败需要有明确反馈。
