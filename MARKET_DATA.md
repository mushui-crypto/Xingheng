# 星衡 Binance 永续合约行情与 K 线模块

本模块采用“Binance 原生 USDT-M 永续合约行情源 + 内部 K 线服务”的单体结构，当前只支持：

- `PERP BTC/USDT`，内部请求 Binance 时使用 `BTCUSDT`

`ETHUSDT`、`DOGEUSDT` 和其他 symbol 后续再增加，当前不属于 MVP 交易闭环。

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
| 行情服务 | `server/modules/market/BinanceMarketService.ts` | 启动 Binance REST 初始化、WebSocket 实时订阅、断线重连和状态更新 |
| Binance REST | `server/modules/market/BinanceRestClient.ts` | 按周期拉取历史 K 线 |
| K 线内存存储 | `server/modules/kline/KlineStore.ts` | 保存历史 K 线和当前未完成 K 线 |
| 支持品种 | `server/config/supportedSymbols.ts` | 固定维护 BTCUSDT |
| 行情 API | `server/modules/api/marketRoutes.ts` | 注册行情 REST API |
| API 与 WebSocket 入口 | `server/index.ts` | 启动 REST API、交易接口和 `/ws` 推送 |

## Binance REST 历史 K 线

服务启动时会为 `BTCUSDT` 的每个支持周期拉取最近 500 根 K 线：

```http
GET https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=500
```

外部数据会被转换为内部结构：

```ts
type Candle = {
  symbol: string;
  interval: "1m" | "5m" | "15m" | "1h";
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
wss://fstream.binance.com/stream?streams=btcusdt@kline_1m/btcusdt@kline_5m/btcusdt@kline_15m/btcusdt@kline_1h/...
```

每条 kline 消息会更新内存中的当前 K 线，并通过本地 WebSocket 推送给订阅客户端。Binance 标记当前 K 线已收盘时，会同时写入历史 K 线列表。

Ticker 报价当前由 Binance 永续合约 `1m` K 线的最新 close 生成，再根据品种配置加上模拟点差。也就是说：Binance 提供实时价格，系统内部再算出用于模拟成交的 Bid/Ask。

当前默认使用 Binance 原生 USDT-M futures 端点。需要切换端点时，可以通过 `.env` 配置 `BINANCE_REST_BASE_URL`、`BINANCE_KLINE_PATH` 和 `BINANCE_STREAM_BASE_URL`。

## 存储

当前只使用进程内存：

- 历史 K 线：按 `symbol + interval` 保存，单序列最多保留 5000 根。
- 当前 K 线：保存每个品种、每个周期当前未完成的 K 线。
- 服务重启后数据会重新从 Binance REST 拉取。

当前没有 Redis/PostgreSQL 行情存储链路。模拟账户、订单、持仓、资金账户、资金流水、转账记录、链上充值记录和出金申请使用 SQLite，入口是 `server/storage/TradingStore.ts`。

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
| `symbol` | 仅支持 `BTCUSDT` |
| `interval` | 支持 `1m`、`5m`、`15m`、`1h` |
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

当前前端统一使用 `/ws`，它支持 ticker 和 candle 订阅；旧兼容通道已移除。

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

## 当前实现边界

- 行情来自 Binance USDT-M 永续合约公开行情。
- Bid / Ask 不是 Binance 原样盘口，而是系统基于最新价和品种配置 spread 生成。
- 当前 MVP 只保留 `BTCUSDT`，后台品种管理只允许编辑 `BTCUSDT` 的展示名、点差、杠杆、合约单位、手数规则、交易状态和可见性。
- 不允许修改 `symbol` / `apiSymbol`，也不允许新增其他 symbol。
- `enabled` 表示允许开仓和平仓；`disabled` / `close_only` 在当前产品语义上统一为禁止新开仓但允许平仓。
- 行情超过 10 秒未更新时状态为 `stale`，禁止市价成交。
- 下单、持仓、盈亏、账户、资金账户、内部转账、链上充值记录、出金申请全部属于内部系统能力；当前不接真实交易所下单。
- 当前主资金资产固定为 `USDT`。
