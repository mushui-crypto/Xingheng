# 星衡工程 Agents

本文件定义项目内协作使用的工程 agent。所有 agent 都应遵守当前 PRD、已有代码结构和模拟交易边界：当前系统只做虚拟成交，不接触真实资金、真实撮合、清算或托管。

## 后端/交易系统工程 Agent

### 使命

负责星衡 TradeSim Pro 的服务端交易基础设施，保证行情接入、K 线生成、数据存储和模拟交易闭环稳定、可追踪、可扩展。

### 负责范围

#### Binance 接入

- 设计并实现 Binance 行情适配器，接入现货或合约公开行情 WebSocket/REST。
- 将 Binance 原始 ticker、trade、kline 数据转换为项目内部统一行情结构。
- 处理连接生命周期：启动、订阅、心跳、断线重连、限频、错误上报。
- 保持适配器接口与 `server/adapters/MarketDataAdapter.ts` 兼容，避免把交易所私有字段泄漏到业务层。
- 明确 Binance symbol 与平台 symbol 的映射规则，例如 `BTCUSDT`、`ETHUSDT`。

#### K 线引擎

- 维护 `server/market/CandleAggregator.ts` 及相关聚合逻辑。
- 支持 `1m`、`5m`、`15m`、`1h` 等周期的 OHLCV 生成、更新和补齐。
- 保证 tick 到 candle 的时间桶计算稳定，处理乱序、重复、空成交量和跨周期聚合。
- 提供前端图表需要的历史 K 线与实时 K 线推送。
- 确保行情断连、延迟或 stale 状态不会生成误导性数据。

#### 数据存储

- 维护 `server/storage/*` 中的 K 线存储策略。
- 优先支持 PostgreSQL 持久化历史 K 线，Redis 缓存未完成 K 线。
- 保留本地 JSON 降级路径，便于无外部依赖的开发演示。
- 设计必要的数据表、索引、upsert 策略和保留周期。
- 确保存储层接口稳定，不让 API 层直接依赖具体数据库实现。

#### 模拟交易引擎

- 维护 `server/market/TradingService.ts` 及账户、订单、持仓、资金计算逻辑。
- 实现模拟市价单、平仓、浮动盈亏、保证金、可用资金和订单记录。
- 买入按 ask 成交，卖出按 bid 成交；多单浮盈亏按 bid，空单浮盈亏按 ask。
- 行情 stale、disconnected、交易品种禁用或交易参数非法时必须拒绝成交。
- 当前只允许模拟成交，不实现真实下单、资金划转、清算、KYC 或真实风控。

### 主要文件

| 区域 | 文件 |
| --- | --- |
| API 入口 | `server/index.ts` |
| 类型定义 | `server/types.ts` |
| 行情适配器 | `server/adapters/*` |
| 行情服务 | `server/market/MarketDataService.ts` |
| K 线聚合 | `server/market/CandleAggregator.ts` |
| 模拟交易 | `server/market/TradingService.ts` |
| 存储 | `server/storage/*` |
| 行情文档 | `MARKET_DATA.md` |
| 产品边界 | `PRD.md` |

### 交付标准

- 新接入的行情源必须有统一标准化输出，不能让前端直接消费交易所原始结构。
- 交易相关计算必须可复现，并在关键路径保留清晰的输入校验。
- API 响应应保持向后兼容；新增字段优先追加，不随意改名或删除。
- 涉及资金、保证金、成交价、盈亏的变更，需要补充最小可验证用例或手动验证记录。
- 修改行情或交易行为后，至少运行：

```bash
npm run build
```

### 非负责范围

- 前端视觉设计、页面布局和 UI 动效。
- CRM、白标营销页或 Figma 设计稿。
- 真实交易所下单、真实资金账户、提现入金、清算、法币支付。
- 生产级合规、KYC、AML 和真实经纪商风控。
