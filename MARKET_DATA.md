# 星衡行情与 K 线模块

本模块采用“第三方真实行情源 + 内部模拟交易”的结构。

## 本地启动

```bash
npm install
npm run dev
```

前端：`http://localhost:5173`

API：`http://127.0.0.1:8787`

交易页面：`/app/trading`

行情列表：`/app/markets`

后台品种管理：`/admin/symbols`

## 品种与报价配置

前端本地模拟存储新增两个 localStorage key：

```text
trade_symbols
market_quotes
```

`trade_symbols` 保存可交易品种配置，包括展示 symbol、公开行情 API symbol、点差、杠杆、合约单位、最小/最大手数、手数步进、报价小数位、交易状态和可见状态。

`market_quotes` 保存最近一次标准化后的报价缓存。若公开行情源只返回 last，本地报价层会按品种点差生成：

```text
bid = last - spread / 2
ask = last + spread / 2
```

并按品种 `digits` 四舍五入。

## 真实行情源

默认没有 `TRADERMADE_API_KEY` 时会使用本地 mock XAUUSD 行情，方便开发和演示。

接入 TraderMade：

```bash
cp .env.example .env
```

然后填写：

```bash
TRADERMADE_API_KEY=你的 TraderMade Streaming API Key
```

TraderMade 适配器使用官方 v2 WebSocket 流程：

1. 连接 `wss://stream.tradermade.com/feedAdv`
2. 发送 `{"action":"login","key":"...","fmt":"JSON"}`
3. 收到 `login_ok` 后订阅 `["XAUUSD:QUOTE"]`
4. 外部 tick 转换为内部统一格式

## 存储

当前未完成 K 线：

- 优先 Redis：配置 `REDIS_URL`
- 未配置时降级到 `server/data/candles.json`

已完成历史 K 线：

- 优先 PostgreSQL：配置 `DATABASE_URL`
- 未配置时降级到 `server/data/candles.json`

PostgreSQL 表会自动创建：

```sql
create table if not exists candles (
  symbol text not null,
  interval text not null,
  time integer not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume double precision not null,
  primary key(symbol, interval, time)
);
```

## API

```http
GET /api/market/symbols
GET /api/market/ticker?symbol=XAUUSD
GET /api/market/candles?symbol=XAUUSD&interval=1m&limit=500
GET /api/trading/positions
POST /api/trading/order
```

市价单规则：

- 买入按 ask 成交
- 卖出按 bid 成交
- 多单浮盈亏按当前 bid
- 空单浮盈亏按当前 ask
- 行情 stale 或 disconnected 时拒绝成交

## WebSocket

连接：

```text
ws://127.0.0.1:8787/ws
```

订阅 ticker：

```json
{
  "type": "subscribe",
  "channel": "ticker",
  "symbol": "XAUUSD"
}
```

订阅 K 线：

```json
{
  "type": "subscribe",
  "channel": "candle",
  "symbol": "XAUUSD",
  "interval": "1m"
}
```

支持周期：`1m`、`5m`、`15m`、`1h`。
