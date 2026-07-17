# Binance 合约马丁网格自动 Paper V1

本路线用于验证趋势过滤后的有限层数马丁网格，不构成收益承诺，也不具备交易所下单能力。它与冻结 ICT V5、Route B 100x 全仓 Paper、`/app/demo` 和 `/app/trade` 完全隔离。

## 身份与边界

- Route ID：`binance-usdm-martingale-grid-paper-v1`
- 市场数据：Binance USD-M `BTCUSDT`、`ETHUSDT` 永续公开已收盘 5 分钟 K 线
- 信号周期：5 分钟；趋势周期：由 5 分钟确定性聚合的 15 分钟
- 执行：Paper only；API key / 私钥不需要、不读取、不保存；自动订单固定关闭
- 资金费率、Mark Price、动态杠杆档位和真实清算：首版忽略，因此结果不能解释为实盘可复制

## 冻结首版规则

### 方向与入场

- 15 分钟 EMA50 高于 EMA200，且已完成 15 分钟收盘位于 EMA50 上方：只寻找多单。
- 15 分钟 EMA50 低于 EMA200，且已完成 15 分钟收盘位于 EMA50 下方：只寻找空单。
- 多单信号：5 分钟 RSI(14) 从 30 上方下穿至不高于 30；空单信号相反，从 70 下方上穿至不低于 70。
- 信号只在 K 线收盘后成立，下一根 5 分钟 K 线开盘建立第一层。
- 每个标的同一时间最多一个网格组；BTC 与 ETH 可以各持有一组。

### 仓位与网格

- 组合初始 Paper 权益 10,000 USDT；BTC、ETH 各自独立分配 5,000 USDT。
- 5x 隔离风险模型；第一层保证金为对应标的权益的 0.5%，名义价值约为权益的 2.5%。
- 每层名义价值倍率 1.35；最多 5 层，不允许无限加仓。
- 网格距离：`max(0.75 × ATR(14), 首次成交价 × 0.35%)`，首次入场时冻结。
- 五层全部成交时，计划保证金约占对应标的权益的 4.98%，名义敞口约占 24.88%。

### 整组退出

- 所有层按加权平均成本统一管理，不做单层独立止盈。
- 目标距离：`max(0.5 × 入场ATR, 首次成交价 × 0.25%)`；每次加仓后基于新的加权均价重算目标价。
- 结构硬止损位于最后一层之外 2 个网格距离。
- 若结构止损的计划损失超过开组权益的 1.5%，自动收紧到 1.5%现金风险边界；计算包含计划全部层、双边手续费和退出滑点。
- 最大持仓 24 小时；某标的整组亏损退出后，当个 UTC 自然日不再为该标的开新组。

### 成本和同 K 线规则

- Taker 手续费每边 0.045%，每次成交计入 1 bps 不利滑点。
- 同一根 K 线同时触及多层与目标时，按更保守的顺序处理：先逐层加仓，再检查整组止损，最后检查止盈。
- 跳空穿越止损时使用开盘价与止损价中更不利的一侧，再计入退出滑点。

## 自动运行

服务端启动后默认立即检查一次，之后每 5 分钟检查公开已收盘 K 线。只有 BTC 或 ETH 的 closed candle 推进时才重新下载前向窗口、确定性复算并原子写入报告。Worker 使用 single-flight；任何标的出现 5 分钟缺口均拒绝覆盖旧报告；上游或写入失败不会退出主服务。

- 默认报告：`server/data/strategy/research-martingale-grid-paper.json`
- `MARTINGALE_GRID_PAPER_WORKER_ENABLED=false`：显式关闭
- `MARTINGALE_GRID_PAPER_WORKER_POLL_MS`：5,000–300,000ms，默认 300,000ms
- `MARTINGALE_GRID_PAPER_REPORT_PATH`：指向生产持久化卷

用户登录后可读取：

```http
GET /api/strategy/martingale/forward
```

接口只读报告，不在 HTTP 请求内抓行情、复算或下单。无报告返回 `200 + status=unavailable + warnings=["no_report"]`；损坏报告返回安全的 `503`；未登录返回 `401`。

前端K线与分层成交标记使用独立只读接口：

```http
GET /api/strategy/martingale/candles?symbol=BTCUSDT&interval=5m&from=...&to=...&limit=500
```

`symbol` 只接受 `BTCUSDT / ETHUSDT`，周期支持 `5m / 15m / 1h / 4h`，单次最多1,000根。接口只返回已收盘K线；交易标记由报告中的 `fills[].time/price` 与 `exitTime/exitPrice` 叠加，不产生任何交易动作。

## 观察门槛

从 `2026-07-16T19:20:00Z`（北京时间 `2026-07-17 03:20`）开始，累计 60 天或 100 个已完成网格组任一先达到后进入人工复核。复核前不得把该路线包装成正收益候选，也不得接入 Testnet 或实盘订单。

历史复算已按 `STRATEGY_MARTINGALE_GRID_HISTORY_V1.md` 完成，结论见 `STRATEGY_MARTINGALE_GRID_HISTORY_V1_RESULT.md`：基础成本下组合PF `1.304`，但平均仅 `0.0049R`，双倍成本PF降至 `0.378`并转为亏损，状态为历史资格不通过。前向Worker继续运行只代表保留实验记录，不代表候选资格。
