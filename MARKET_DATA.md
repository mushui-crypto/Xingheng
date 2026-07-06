# 星衡 Hyperliquid 永续行情与 K 线模块

当前行情主线只使用 Hyperliquid 公开 API，不保留 Binance 行情 Adapter。

- 平台内部交易品种：`{COIN}USDT`
- Hyperliquid perpetual coin：`{COIN}`
- 模拟账户记账资产：`USDT`
- 行情只用于内部模拟成交，不向 Hyperliquid 提交真实订单

例如平台 `BTCUSDT` 映射 Hyperliquid `BTC` perpetual。平台 symbol 是内部模拟
标识，不表示系统接入同名 CEX 市场，也不表示用户持有 Hyperliquid 账户。

服务启动时调用 `metaAndAssetCtxs` 同步主 DEX 品种目录，排除
`isDelisted=true` 与带 DEX 前缀的 HIP-3 市场。全市场列表使用单个
`allMids` 订阅；BBO、成交和 K 线按前端实际访问动态订阅并在连接关闭时取消。

## 模块结构

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 行情服务 | `server/modules/market/HyperliquidMarketService.ts` | WebSocket 订阅、心跳、断线重连、状态更新 |
| REST 客户端 | `server/modules/market/HyperliquidRestClient.ts` | `candleSnapshot` 历史 K 线与分页 |
| K 线内存存储 | `server/modules/kline/KlineStore.ts` | 保存历史与当前 K 线 |
| 品种映射 | `server/modules/market/marketConfig.ts` | `{COIN}USDT -> {COIN}` |
| 行情 API | `server/modules/api/marketRoutes.ts` | 对前端输出内部标准化结构 |
| API/WebSocket 入口 | `server/index.ts` | REST、交易接口和本地 `/ws` 推送 |

## 外部接口

默认主网端点：

```text
REST:      https://api.hyperliquid.xyz/info
WebSocket: wss://api.hyperliquid.xyz/ws
```

可通过环境变量覆盖：

```env
HYPERLIQUID_REST_BASE_URL=https://api.hyperliquid.xyz
HYPERLIQUID_STREAM_URL=wss://api.hyperliquid.xyz/ws
```

公开行情不使用钱包、API Key、签名或私钥。

## 历史 K 线

服务通过 `POST /info` 请求 `candleSnapshot`：

```json
{
  "type": "candleSnapshot",
  "req": {
    "coin": "BTC",
    "interval": "15m",
    "startTime": 1780000000000,
    "endTime": 1780100000000
  }
}
```

支持 `1m`、`5m`、`15m`、`1h`。服务启动时每个周期回补最近 500
根；API 允许请求 1-1000 根并按 Hyperliquid 的单页限制自动分页。内部
`Candle.time` 统一为秒级 Unix 时间戳。

## 实时订阅

用户打开具体交易品种时按需订阅：

```json
{ "method": "subscribe", "subscription": { "type": "bbo", "coin": "BTC" } }
{ "method": "subscribe", "subscription": { "type": "trades", "coin": "BTC" } }
{ "method": "subscribe", "subscription": { "type": "candle", "coin": "BTC", "interval": "1m" } }
```

`candle` 会分别订阅 `1m`、`5m`、`15m`、`1h`。

内部原始 ticker 口径：

- `bid`：Hyperliquid BBO 最优买价
- `ask`：Hyperliquid BBO 最优卖价
- `last`：Hyperliquid 最新成交价
- `timestamp`：BBO 与最新成交时间的较新值
- `source`：`hyperliquid`

平台现有品种配置会在 API/模拟交易层基于 `last` 应用模拟 spread；因此最终
用户成交 Bid/Ask 是平台模拟报价，不等同于向 Hyperliquid 真实盘口成交。

连接每 30 秒发送 `{ "method": "ping" }` 心跳。断线后使用指数退避重连；
WebSocket 恢复前，行情状态为 `disconnected`。

## 状态与交易保护

- `connected`：10 秒内收到有效 ticker
- `stale`：最后有效 ticker 超过 10 秒
- `disconnected`：尚无有效 BBO/成交组合，或 WebSocket 已断开

`stale` 与 `disconnected` 禁止新开仓。已有仓位仍按交易引擎既有规则处理，
避免因品种 `close_only` / `disabled` 阻塞平仓。

## 内部 API

```http
GET /api/health
GET /api/market/symbols
GET /api/market/ticker?symbol=BTCUSDT
GET /api/market/candles?symbol=BTCUSDT&interval=1m&limit=500
```

前端 WebSocket：

```text
ws://127.0.0.1:8787/ws
```

订阅示例：

```json
{
  "type": "subscribe",
  "channel": "ticker",
  "symbol": "BTCUSDT"
}
```

```json
{
  "type": "subscribe",
  "channel": "candle",
  "symbol": "BTCUSDT",
  "interval": "1m"
}
```

## 存储边界

- K 线保存在进程内存，每个 `symbol + interval` 最多 5000 根。
- 服务重启后重新从 Hyperliquid `candleSnapshot` 回补。
- 用户、模拟账户、订单、持仓和资金记录继续使用 SQLite。
- 当前不接真实交易所下单、真实资金托管、清算或生产级风控。
