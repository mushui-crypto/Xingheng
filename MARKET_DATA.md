# 星衡 Binance 行情与 K 线模块

本模块采用“Binance 公开行情源 + 内部 K 线服务”的单体结构，当前只支持：

- `BTCUSDT`
- `ETHUSDT`
- `DOGEUSDT`

后端/交易系统工程 Agent 负责本模块的 Binance 接入、K 线引擎、数据存储和实时推送。详细职责见 `AGENTS.md`。

## 本地启动

```bash
npm install
npm run dev
```

前端：`http://localhost:5173`

API：`http://127.0.0.1:8787`

单独启动 API：

```bash
npm run start:api
```

## 模块结构

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| Binance REST | `server/binance/BinanceRestClient.ts` | 拉取历史 K 线 |
| Binance WebSocket | `server/binance/BinanceKlineEngine.ts` | 订阅 `kline_1m` 实时流 |
| 1m K 线生成器 | `server/binance/BinanceKlineEngine.ts` | 标准化 Binance kline 为内部 OHLCV |
| 内存存储 | `server/storage/InMemoryCandleStore.ts` | 保存历史 K 线和当前未完成 K 线 |
| 支持品种 | `server/config/supportedSymbols.ts` | 固定维护 BTC/ETH/DOGE |
| API 入口 | `server/index.ts` | REST API 与 WebSocket 推送 |

## Binance REST 历史 K 线

服务启动时会为每个支持品种拉取最近 500 根 `1m` K 线：

```http
GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500
```

外部数据会被转换为内部结构：

```ts
type Candle = {
  symbol: string;
  interval: "1m";
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
```

其中 `time` 使用秒级 Unix 时间戳。

## Binance WebSocket 实时 K 线

服务订阅 Binance combined stream：

```text
wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m/dogeusdt@kline_1m
```

每条 kline 消息会更新内存中的当前 1m K 线，并通过本地 WebSocket 推送给订阅客户端。Binance 标记当前 K 线已收盘时，会同时写入历史 K 线列表。

## 存储

当前只使用进程内存：

- 历史 K 线：按 `symbol + interval` 保存，单序列最多保留 5000 根。
- 当前 K 线：保存每个品种当前未完成的 `1m` K 线。
- 服务重启后数据会重新从 Binance REST 拉取。

后续如需持久化，可以在 `CandleStore` 接口下替换为 PostgreSQL/Redis 实现。

## REST API

### 健康检查

```http
GET /api/health
```

### 支持品种

```http
GET /api/market/symbols
```

### 最新 ticker

```http
GET /api/market/ticker?symbol=BTCUSDT
```

### 获取 K 线

```http
GET /api/market/candles?symbol=BTCUSDT&interval=1m&limit=500
```

参数：

| 参数 | 说明 |
| --- | --- |
| `symbol` | 仅支持 `BTCUSDT`、`ETHUSDT`、`DOGEUSDT` |
| `interval` | 仅支持 `1m` |
| `limit` | 1-1000，默认 500 |

## 时间字段与状态规则

时间字段统一说明：

- `ticker.timestamp`：毫秒级 Unix 时间戳，表示后端最后一次收到 Binance 实时行情的时间。
- `candle.time`：秒级 Unix 时间戳，表示这根 K 线的开始时间。
- `/klines` 的 `timestamp`：秒级 Unix 时间戳，和 `candle.time` 含义一致。
- 交易订单里的 `quoteTime`：毫秒级 Unix 时间戳，来自成交时使用的 ticker。

行情状态：

- `connected`：10 秒内收到过 Binance 实时行情。
- `stale`：超过 10 秒没有收到实时行情，行情已过期，禁止市价成交。
- `disconnected`：尚未收到行情，或 Binance WebSocket 已断开。

## WebSocket

连接：

```text
ws://127.0.0.1:8787/ws
```

当前建议前端优先使用 `/ws`，因为它同时支持旧前端需要的 ticker 和 candle 订阅。

兼容路径：

```text
ws://127.0.0.1:8787/ws/market
```

`/ws/market` 只推送新版 `kline` 格式，作为后续行情模块专用通道保留。

订阅实时 K 线：

```json
{
  "type": "subscribe",
  "channel": "candle",
  "symbol": "BTCUSDT",
  "interval": "1m"
}
```

推送格式：

```json
{
  "type": "candle",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "data": {
    "time": 1782060360,
    "open": 64116,
    "high": 64158,
    "low": 64116,
    "close": 64158,
    "volume": 1.25995
  }
}
```

也可以订阅 ticker：

```json
{
  "type": "subscribe",
  "channel": "ticker",
  "symbol": "BTCUSDT"
}
```
