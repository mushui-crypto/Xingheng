# Hyperliquid 真实交易接入契约

更新时间：2026-07-13

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

### 4.1 只读市场

`GET /api/real-trading/market/symbols`

- 返回 Hyperliquid testnet 可交易 perpetual 列表。
- 字段包含内部 symbol、provider coin、iconUrl、assetId、price/size 精度、maxLeverage、status。
- `iconUrl` 由 `providerCoin` 派生：`https://app.hyperliquid.xyz/coins/{providerCoin}.svg`，providerCoin 异常时返回 `null`。

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

- 返回真实持仓，包含 `coin / symbol / side / size / entryPrice / entryPx / markPrice / markPx / liquidationPrice / liqPx / positionValue / returnOnEquity / margin / leverage / unrealizedPnl / cumFunding / fundingAllTime / fundingSinceChange / fundingSinceOpen`。
- `entryPx / markPx / liqPx` 是前端契约字段；`entryPrice / markPrice / liquidationPrice` 继续保留兼容。
- `markPrice / markPx` 优先使用 `clearinghouseState.position.markPx`；该字段为空或非法时，按当前持仓自己的 Hyperliquid `coin` 从 `metaAndAssetCtxs` 对应 asset context 回退取 `markPx`，找不到可靠值时返回 `null`，不使用页面当前选中品种价格代替。
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
  "timestamp": 1710000001000
}
```

校验：

- `network` 必须是 `hyperliquid-testnet`。
- `action.type` 第一阶段只允许：
  - `approveAgent`
  - `order`
  - `cancel`
  - `updateLeverage`
  - 必要的 close / reduce-only order 仍按 `order` 表达
- `approveAgent` 仅允许 Hyperliquid Testnet：`action.hyperliquidChain` 必须为 `Testnet`，`action.agentAddress` 必须为合法 EVM 地址。
- 禁止 withdraw、transfer、staking、builder fee 等资金转移类动作。
- 后端只做 allowlist 校验、基础字段校验、请求限流、脱敏审计和响应标准化，不修改签名内容，不生成 nonce / signature / expiresAfter。

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
