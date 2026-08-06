# Changelog

本文档记录星衡项目的阶段版本。

## Unreleased - Production-only 部署收敛

日期：2026-07-31

状态：待发布

### 已完成

- Capital Test 授权时间规则改为自 `approvedAt` 起 24 小时有效，不再要求预填固定执行开始/结束时间；单次 Maximum execution duration、Permit expiry、过期重新确认及 fail-closed 状态保持不变。
- 删除独立真实测试部署环境的 Compose、Caddy、环境模板、运行入口、清理、备份、恢复与验证能力。
- 部署环境、WIF、KMS、受信操作、运行身份、拓扑和卷边界收敛为 production-only。
- 保留 Demo、Hyperliquid Testnet、普通单元/集成测试及生产发布、回滚、备份能力。
- 不改变生产 Compose project `xingheng`、WIF 路径 `/run/xingheng/gcp-wif` 或生产 KMS key。
- 本次变更不启用资金、凭证或交易开关。

## 0.3.0 - Hyperliquid 行情源切换

日期：2026-07-06

状态：已实现

### 已完成

- 从 BTC 单品种升级为 Hyperliquid 主 DEX 全量活跃 perpetual 自动目录。
- 排除已下架与 HIP-3 市场；下架历史配置软禁用并保留记录。
- 行情列表使用 `allMids`，BBO、成交与 K 线改为按需订阅和释放。
- 删除 Binance REST/WebSocket 行情 Adapter 与对应环境变量。
- 接入 Hyperliquid `candleSnapshot` 历史 K 线。
- 接入 Hyperliquid `bbo`、`trades`、`candle` WebSocket 订阅。
- 平台内部 `BTCUSDT` 固定映射到 Hyperliquid perpetual coin `BTC`。
- 增加 WebSocket 心跳、指数退避重连、行情 stale/disconnected 保护。
- 保持模拟交易边界，不接 Hyperliquid 真实下单、钱包或签名能力。

## 0.1.0 - Binance 行情 + 模拟交易 MVP

日期：2026-06-22

状态：准备封版

### 已完成

- 接入 Binance 加密行情，当前支持 `BTCUSDT / ETHUSDT / DOGEUSDT`。
- 支持 `1m / 5m / 15m / 1h` K 线。
- 支持 REST 历史 K 线查询。
- 支持 WebSocket 实时行情和实时 K 线推送。
- 前端交易终端已切换到 Binance 三个加密品种。
- 支持模拟账户资金展示。
- 支持市价开仓、持仓、平仓。
- 支持订单记录生成。
- 买入按 Ask，卖出按 Bid。
- 多单平仓按 Bid，空单平仓按 Ask。
- DOGEUSDT 图表价格精度调整为 6 位小数。

### 已知问题

- `/api/trading/orders` 默认查询和带 `userId=demo-user` 查询存在差异，V0.2 需要统一用户身份规则。
- `DOGEUSDT` 曾出现 `stale` 状态，V0.2 封版复测需要确认实时行情是否稳定。
- 当前账户、订单、持仓仍以轻量存储为主，服务重启后的数据保存能力需要在 V0.2 完善。

### 暂不包含

- 不接真实交易。
- 不处理真实资金。
- 不扩展 A 股、美股、ETF、基金、黄金、外汇。
- 不做复杂风控。
- 不做止盈止损。
- 不做强制平仓。

## 0.2.0 - 交易系统稳定化

日期：2026-06-22

状态：已完成本轮实现

### 已完成

- 不扩充资产，集中完善模拟交易系统。
- 使用 SQLite 持久化模拟账户、订单、持仓和资金调整日志。
- 后台支持模拟充值、扣减、重置余额。
- 统一账户、订单、持仓的用户身份规则。
- 完善订单记录、持仓记录、平仓记录和拒单记录。
- 新增后台资金流水查询。
- 账户页新增最近订单摘要。
- 服务重启后，模拟账户、订单、资金流水可恢复。

### 技术说明

- 数据库文件默认写入 `server/data/trading.sqlite`。
- SQLite 使用 Node 内置 `node:sqlite`，没有新增 npm 依赖。
- `server/data/trading.sqlite*` 已加入 `.gitignore`，运行数据不会提交到 GitHub。
- Node 当前会提示 `node:sqlite` 是 experimental，这是 Node 官方实验功能提示，不影响本地稳定演示。

### 已验证

- `npm run build` 通过。
- 后台给 `demo-user` 模拟充值 1000 后，资金流水出现记录。
- `demo-user` 买入 BTCUSDT 后，生成持仓和开仓订单。
- 平仓后，余额按盈亏变化，生成平仓订单。
- 非法手数会拒单，并生成带原因的拒单订单。
- 重启临时 API 服务后，账户、订单、资金流水仍可查询。

### 暂不包含

- 不新增资产。
- 不接真实交易。
- 不接真实资金。
- 不做复杂风控。
- 不做 UI 大改。
