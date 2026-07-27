# 策略研究模块

BTC、ETH、Route B、自动Paper、数据源与主要否决路线的统一交接入口见 `STRATEGY_BTC_ETH_HANDOFF.md`；马丁网格专题见 `STRATEGY_MARTINGALE_GRID_HANDOFF.md`。

当前模块用于把 ICT 概念转化为可复现、可回测的客观规则。它是研究与验证工具，不构成收益承诺、投资建议或平台代客交易能力。

## 当前实现

- 策略：`ict-liquidity-reversal-v1`
- 首个市场：Hyperliquid Main DEX `BTCUSDT` perpetual
- 入场周期：`5m`
- 方向与结构周期：`15m`（由5分钟K线确定性聚合）
- 高周期方向：由输入数据聚合的 `15m` EMA 方向过滤
- 入场链路：流动性扫荡 → 位移 → MSS → FVG 确认
- 交易时间：北京时间 `18:00–次日08:00`，排除亚洲白盘与周末
- 市场状态：当前 ATR / 过去基准 ATR 不低于 `1.25`，状态仅使用当时及之前数据计算
- 入场执行：形态确认后的下一根 `5m` K 线开盘市价进入
- 出场：扫荡极值外硬止损（最大结构距离 `4.25 ATR`）和固定 `2.5R` 止盈；交易窗口只限制新入场，已有持仓允许跨入非交易时段，不在窗口结束时强制平仓
- 账户级风控：研究阶段暂时关闭每日亏损、每日笔数、连续亏损、杠杆上限和费用后盈亏比拦截；仍以单笔权益 `0.25%` 做研究归一化定仓，便于跨阶段比较，并保留结构止损
- 成本：市价入场与出场均按 Taker `0.045%`、每边 1 bps 不利滑点

## 使用

```bash
npm run test:strategy
npm run backtest:ict:btc -- 2026-07-12 2026-07-15
npm run research:ict:grid -- 2021-01 2021-12 v7
npm run research:ict:combine -- v7 2021 2022 2023
npm run research:ict:validate
npm run research:ict:forward
npm run research:ict:history
```

回测结果写入仓库根目录下的 `backtest-*.json`，行情缓存写入 `.cache/strategy/hyperliquid`；两者均已忽略，不进入 Git。

路线 B 前向 Paper 报告由 `npm run research:ict:forward` 生成，默认写入
`server/data/strategy/research-ict-route-b-forward.json`；生产或部署环境可通过
`STRATEGY_FORWARD_REPORT_PATH` 指向持久化卷上的同名 JSON。该报告是只读展示源，
不应提交 Git，不应放入会随镜像重建丢失的临时仓库根目录文件。

服务端默认启动自动 Paper Worker：启动后立即检查一次 Binance USD-M `BTCUSDT`
公开 `5m` 已收盘K线，之后按默认 5 分钟轮询；轮询先轻量读取最新 closed candle，
只有最新已收盘K线推进时才下载完整前向区间、重新计算并原子写入前向报告。
Worker 不读取 Binance API key，不接交易 API，不产生真实订单；
失败时保留上一份有效报告，并在只读接口返回 `worker` 状态。可配置项：

- `STRATEGY_FORWARD_WORKER_ENABLED=false`：运维显式关闭自动 Paper Worker。
- `STRATEGY_FORWARD_WORKER_POLL_MS`：轮询间隔，默认 `300000`，最小 `5000`，最大 `300000`。
- `STRATEGY_FORWARD_REPORT_PATH`：前向 Paper 报告持久化路径。
- `STRATEGY_EMAIL_ALERTS_ENABLED=false`：策略邮件告警默认关闭。
- `STRATEGY_ALERT_EMAIL_TO`：策略告警收件邮箱，生产由项目管理配置，业务代码不硬编码个人邮箱。

历史回测只读报告由 `npm run research:ict:history` 预生成，默认写入
`server/data/strategy/research-ict-route-b-history.json`；生产可通过
`STRATEGY_HISTORY_REPORT_PATH` 指向持久化卷。用户端接口只读取该报告，不在请求中
下载 Binance Vision 或重跑 2024 至今的回测。

生产 Compose 固定使用独立 `strategy_data` named volume，默认路径为：

```bash
STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json
STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json
```

历史报告生产生成使用一次性 tools service，不在 API runtime 中执行：

```bash
docker compose --env-file .env.production --profile strategy-tools run --rm strategy-history
docker compose --env-file .env.production --profile strategy-tools run --rm strategy-history npm run strategy:history:check -- /app/strategy-data/route-b-history.json
```

## 数据限制

Hyperliquid `candleSnapshot` 不能作为长期分钟数据仓库使用。当前下载器会在请求被截断时直接失败，不会把不完整样本伪装成完整回测。

官方历史数据说明指出，S3 归档提供 L2 快照、资产上下文与成交相关数据，但不提供历史 candles。长期研究需要在以下方案中选择其一：

1. 从现在开始持续采集并持久化 Hyperliquid 1m candles；
2. 从官方历史成交数据重建 candles；
3. 导入经过批准、可追溯的第三方历史数据集，并在报告中标明来源差异。

现阶段路线 B 的历史研究和前向 Paper 验证统一使用 Binance USD-M BTCUSDT perpetual。Hyperliquid 行情与下单不属于这条研究路线，项目既有 `/app/demo` 和 `/app/trade` 能力保持隔离、不受改写。

## 长期研究数据

已批准使用 Binance Vision USD-M `BTCUSDT` perpetual 5m 数据作为长期研究代理市场。下载器会验证官方 `.CHECKSUM`，拒绝存在5分钟缺口的数据，并在报告中固定标注：

- 研究市场：Binance USD-M BTCUSDT perpetual
- 前向验证：Binance USD-M BTCUSDT perpetual 公开 `5m` K 线
- 执行状态：Paper only，自动订单关闭

使用示例：

```bash
npm run backtest:ict:binance -- 2026-06 2026-06
```

Binance Vision 归档用于历史回测，Binance Futures 公共 REST K 线用于冻结时点后的前向 Paper 验证。两者都不代表真实成交，也不授权自动下单。

## 冻结候选与研究结论

当前影子候选为 `ictResearchCandidateV5`。V5 保留 V3 的信号参数，但把交易窗口改为只限制新入场，并暂时关闭账户级风险拦截。由于该执行规则是在 2026 数据已经被查看后确定，2026 结果只能视为历史复算，不能继续称为干净留出检验：

V5 已另行冻结在 `STRATEGY_V5_ARCHIVE.md`，后续不原地覆盖。研究拆分为路线 A“扩大交易机会”和路线 B“Binance 100x、单次保证金2%–5%”。路线 B 已确认使用全仓模式：100x决定初始保证金，2%–5%保证金对应账户2x–5x实际名义敞口；此前61.3%清算的逐仓结果已作废，仅保留审计记录。

路线 B 全仓复算2024-01至2026-07-13共193笔、无清算。2%–5%保证金档PF为1.357 / 1.314 / 1.275 / 1.241，最大回撤为20.9% / 30.4% / 39.2% / 47.2%。当前选择2%档进入前向 Paper：100x杠杆设置、初始保证金占权益2%、实际名义敞口约2x、全仓、同一时间最多一个BTC仓位。按用户确认，历史资金费率默认忽略，Mark Price、动态杠杆档位和跳空等细节暂时忽略；这些是研究简化条件，不得被解释为实盘已验证。

前向 Paper 从 `2026-07-15T00:00:00Z` 开始，观察门槛为累计60天或50笔已完成交易，任一先达到即进入人工复核。收集器每次从冻结时点确定性重算，只使用已收盘K线，校验5分钟缺口，将样本末尾的 `end_of_data` 仓位保留为未完成持仓并排除在完成交易指标之外。首次核验截至 `2026-07-15T05:35:00Z`：前向已完成交易0笔、净收益0、缺口0、无未平仓仓位，状态为收集中。

用户端只读接口：

```http
GET /api/strategy/ict/forward
```

该接口要求用户登录，只读取已经生成的前向 Paper 报告，不触发 Binance 远端抓取、
长回测或任何下单动作。响应固定标注：

- `assumptions.venue = binance_usdm_btcusdt_perpetual`
- `assumptions.symbol = BTCUSDT`
- `assumptions.leverageSelection = 100`
- `assumptions.marginMode = cross`
- `assumptions.marginFraction = 0.02`
- `assumptions.effectiveNotionalEquityMultiple = 2`
- `assumptions.onePositionAtATime = true`
- `assumptions.fundingIgnored = true`
- `assumptions.markPriceAndDynamicBracketIgnored = true`
- `assumptions.automaticOrdersEnabled = false`

报告不存在时返回 `200` 与 `status=unavailable` 的安全空态；报告损坏或无法读取时
返回 `503` 与同样不含本地路径、堆栈或环境变量的安全响应。`profitFactor` 在没有可计算
亏损样本时返回 `null`，避免用 `0` 误导前端展示。

历史回测只读接口：

```http
GET /api/strategy/ict/history?from=2024-01-01&to=2026-07-13&limit=50&cursor=0
```

该接口要求用户登录，只读取预生成历史报告。默认报告范围为 `2024-01-01` 至当前
Binance Vision 已确认完整日，接口响应会明确 `availableRange` 与 `dataThrough`；
不会伪造缺失日期，也不会用实时 K 线静默补齐历史归档。区间指标按请求区间内的
已完成 Paper 交易重新计算，交易归属字段固定为 `entryTime`。响应包含：

- `requestedRange / availableRange / dataThrough / dataQuality`
- `metrics.tradeCount / netPnl / profitFactor|null / averageR / maxDrawdownFraction / fees`
- `completedTrades` 分页结果，公开字段与前向报告 `PublicForwardTrade` 一致
- `pagination.limit / cursor / nextCursor / hasMore / total`
- `assumptions.automaticOrdersEnabled=false`
- `warnings`，例如无报告、报告损坏或请求范围被裁剪

## 独立自动马丁网格 Paper

独立路线 `binance-usdm-martingale-grid-paper-v1` 从 `2026-07-16T19:20:00Z`（北京时间 `2026-07-17 03:20`）开始，只使用 Binance USD-M `BTCUSDT / ETHUSDT` 公开 5 分钟已收盘 K 线。它不修改冻结 V5 或 Route B，不连接交易 API，不需要 API key，自动订单固定关闭。完整规则见 `STRATEGY_MARTINGALE_GRID_PAPER_V1.md`。

服务端启动时默认同时启动独立 Worker；BTC 或 ETH 的 closed candle 推进后确定性复算并原子写入 `server/data/strategy/research-martingale-grid-paper.json`。数据缺口、网络或写入失败保留上一份有效报告且不影响主服务。登录用户只读接口：

```http
GET /api/strategy/martingale/forward
```

环境变量为 `MARTINGALE_GRID_PAPER_WORKER_ENABLED`、`MARTINGALE_GRID_PAPER_WORKER_POLL_MS` 和 `MARTINGALE_GRID_PAPER_REPORT_PATH`。首版使用 BTC/ETH 各 5,000 USDT 独立 Paper 账本、5x隔离风险模型、第一层0.5%保证金、1.35倍、最多5层、ATR/价格比例自适应间距、整组目标和1.5%计划损失上限。观察门槛为60天或100个已完成网格组任一先达到。

马丁页签K线使用 `GET /api/strategy/martingale/candles`，要求登录且只允许 `BTCUSDT / ETHUSDT`；接口复用内部标准化K线契约、缓存、已收盘过滤和安全错误响应，不允许前端直连交易所。

独立历史复算已按预注册完成，评价区间为2021-01-01至2026-07-15，BTC/ETH各591,264根5分钟K线、checksum通过、重复0、缺口0。组合1,622组、净收益160.53、PF 1.304、平均0.0049R、标记最大回撤0.91%；BTC PF 1.093，ETH PF 1.546。双倍手续费与滑点后净亏损411.63、PF 0.378。由于平均R与双倍成本门槛失败，状态固定为 `rejected_historical_qualification`；完整结果见 `docs/strategy/archive/STRATEGY_MARTINGALE_GRID_HISTORY_V1_RESULT.md`。自动Paper可继续记录，但不得解释为历史合格候选。

15分钟入场 V2 已按独立预注册完成受控复算：只把 RSI/ATR 信号从5分钟改为已完成15分钟，下一根5分钟开盘执行，其余 V1 参数冻结。2021-01-01至2026-07-15 的 BTC/ETH 各591,264根K线中，两标的合格信号和完成组均为0；15分钟极值回撤与同周期15分钟顺势过滤没有同时满足。两次运行哈希一致，路线固定为 `rejected_historical_qualification`，不修改当前自动Paper。详见 `docs/strategy/archive/STRATEGY_MARTINGALE_GRID_15M_ENTRY_V2_RESULT.md`。

策略图表 K 线只读接口：

```http
GET /api/strategy/ict/candles?interval=5m&from=2026-07-15T00:00:00.000Z&to=2026-07-15T06:00:00.000Z&limit=500
```

该接口要求用户登录，固定读取 Binance USD-M `BTCUSDT` 公共 K 线，只用于
`/app/strategy` 的前向 Paper 与历史回测交易标记图表。接口不读取 Binance API key，
不接交易 API，不触发 Paper Worker 重算，不下载多年 Binance Vision 归档，也不修改
`/app/demo` 或 `/app/trade`。响应使用内部标准化结构：

- `source=binance_usdm`
- `symbol=BTCUSDT`
- `interval=5m|15m|1h|4h`
- `status=available|unavailable`
- `requestedRange.from/to`
- `dataThrough`
- `candles[{time,open,high,low,close,volume}]`
- `warnings`

`time` 统一为 Unix 秒。默认 `interval=5m`、`limit=500`，最大 `limit=1000`；
单次请求窗口不能超过对应 interval 的 `1000` 根 K 线，前端应围绕当前视窗或选中交易
附近按窗口请求。服务端只返回已收盘 K 线，并对 Binance 原始响应做排序、去重和数值
校验；网络失败、限频、超时或空数据返回安全状态，不影响 Paper Worker、全局 health、
`/app/demo` 或 `/app/trade`。

路线 A 首个 V6 实验采用 `0.8333%` 止损下限及结构上限，BTC 60,000 时对应 500。2024–2025 为 77 笔、PF 1.404，2026 至 7 月 13 日为 17 笔、PF 1.460；质量为正但机会数约减半，因此没有通过路线 A 的增频目标，不替换 V5。

| 区间 | 交易数 | 净收益 | PF | 平均 R | 最大回撤 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2024-01 至 2025-12 | 159 | 1,042.88 | 1.427 | 0.271 | 2.36% |
| 2026-01 至 2026-07-13 | 33 | 188.60 | 1.368 | 0.235 | 1.01% |

开发集年度交易数为 2024 年 77 笔、2025 年 82 笔；2026 至 7 月 13 日为 33 笔。跨时段持仓会占用后续信号，因此机会数略低于 V3。V5 的既有 Demo 只读影子状态保持不变；路线 B 另行从冻结时点积累 Binance 前向 Paper 样本，自动 Demo/Testnet/Binance 下单全部关闭。

以下为已被 V3/V5 取代的 V1 研究记录：

候选 `ictResearchCandidateV1` 在查看 2024 年以后数据前已冻结。分段结果如下：

| 数据角色 | 区间 | 交易数 | 净收益（初始权益 10,000） | PF | 平均 R |
| --- | --- | ---: | ---: | ---: | ---: |
| 开发集 | 2021-01 至 2023-12 | 72 | 363.96 | 1.371 | 0.239 |
| 验证集 | 2024-01 至 2025-06 | 74 | 118.70 | 1.107 | 0.064 |
| 最终留出集 | 2025-07 至 2026-06 | 34 | 191.25 | 1.452 | 0.254 |

V1 的预设验证门槛要求 `PF >= 1.15` 且 `平均 R >= 0.10`。验证集两项均未通过，因此 V1 已被否决。

止损消融结论：移除盘中硬止损会放大尾部风险；开发集无止损版本出现约 `-14.18R` 单笔亏损，结果显著弱于硬止损版本，因此冻结候选保留硬止损。

已拒绝的增频方案：ETHUSDT 跨资产扩展在 2024、2025、2026H1 全部亏损；MSS/FVG 延续 setup 没有形成稳定优势；把波动阈值降至 `1.18` 虽能增加 2024–2025 机会，但截至 2026-07-13 的 PF 降至 `1.036`，因此未进入当前影子候选。Route A 预注册的独立趋势回撤 V7 虽把2024–2025组合交易数从159笔增至278笔，但组合PF降至1.107、最大回撤升至5.03%，2025组合转亏；V7独立多空两侧均亏损，已按 `docs/strategy/archive/STRATEGY_ROUTE_A_RESEARCH.md` 否决，不修改V5或Route B。V3 的强制时段平仓结果仍保留为历史基线，不覆盖为 V5 结果。

## 明确边界

- `/app/demo` 仍只使用原有内部模拟成交，当前策略模块没有自动下单权限。
- `/app/trade` 仍只支持 Hyperliquid testnet 用户本地签名，策略模块不保存私钥、不服务器代签。
- `/api/strategy/ict/status` 只提供冻结配置、最新信号和滚动影子模拟，不具备下单权限。
- 当前候选没有规则变更后的干净留出样本，不能宣称已证明可部署的正期望。
