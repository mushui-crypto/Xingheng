# BTC / ETH 策略研究与自动 Paper 总交接

更新时间：2026-07-17
适用对象：策略研究、后端、前端、测试、项目管理
市场范围：Binance USD-M `BTCUSDT / ETHUSDT` 永续；Hyperliquid BTC公开行情影子状态
产品入口：`/app/strategy`
总边界：所有策略自动订单关闭，不保存交易所密钥，不构成收益承诺

## 1. 当前真实结论

整个研究体系目前只有“冻结基线”和“自动Paper观察路线”，没有任何可宣称已经证明可实盘的策略。

| 路线 | 市场 | 当前身份 | 状态 |
| --- | --- | --- | --- |
| ICT BTC V5 | BTCUSDT | 冻结的正收益历史基线 | 保留，不再原地修改 |
| Route B | Binance BTCUSDT | V5信号的100x设置、2%保证金、全仓自动Paper | 正在前向收集，真实订单关闭 |
| Hyperliquid V5状态 | Hyperliquid BTC | 滚动公开行情影子诊断 | 只读，不下单 |
| ETH因子/SMC研究 | Binance ETHUSDT | 独立研究 | 尚无合格候选，不进入方向策略Paper |
| BTC+ETH马丁网格V1 | Binance BTC/ETH | 独立自动Paper | 历史资格未通过，继续保留前向记录 |
| 马丁15分钟V2 | Binance BTC/ETH | 受控历史实验 | 0个合格信号，已否决 |

关键判断：

- BTC V5在历史上有正向质量，但交易频率低，而且2026数据已经被查看，不能再称为干净留出。
- Route B把V5信号转换为Binance全仓固定保证金模型；100x是交易所杠杆设置，当前2%保证金只形成约2倍账户名义敞口。
- ETH迄今没有通过研究门槛的独立方向策略。不能因为某个小样本、空头分项或个人40/100点习惯局部较好就包装成候选。
- 马丁网格基础成本下略有正收益，但优势小于费用和成本误差，双倍成本后转负。
- 当前真正应该积累的是冻结参数后的新前向Paper证据，而不是继续围绕已经看过的历史反复调参。

## 2. 三套容易混淆的体系

### 2.1 ICT BTC V5：信号与研究基线

Route ID / 存档：`ict-btc-v5-2026-07-15`。

它回答“什么时候做BTC、多空方向、结构止损和目标在哪里”，研究定仓采用每笔权益0.25%风险归一化。它本身不是100x仓位模型。

### 2.2 Route B：V5的Binance执行尺寸Paper

它复用V5信号，但改用：

- Binance USD-M BTCUSDT；
- 100x交易所杠杆设置；
- 初始保证金占账户权益2%；
- 全仓模式；
- 账户名义敞口约2x；
- 同一时间最多一个BTC仓位。

它回答“同一信号在Binance固定保证金/全仓账户下会怎样”，不能把Route B净收益与V5的0.25%风险归一化净收益直接横向比较。

### 2.3 BTC+ETH马丁网格：完全独立策略

马丁路线不使用ICT流动性扫荡/MSS/FVG信号，不使用Route B的100x全仓模型。它采用15分钟EMA趋势、5分钟RSI触发、5x隔离风险假设、有限5层网格。它有独立routeId、独立Worker、独立报告和独立前端页签。

## 3. 研究治理规则

后续所有研究继续遵守：

1. **先预注册再运行**：先写清规则、数据角色、成本、门槛和失败条件。
2. **一次固定运行**：看到结果后不在同一路线追加阈值、删方向或改年份。
3. **独立routeId**：新假设建立新路线；失败记录不得覆盖。
4. **无未来函数**：只使用当时已经收盘、已经确认的结构；信号后最早下一根5分钟成交。
5. **保守撮合**：同K线止损和止盈同时覆盖时按止损；入场当根同样检查止损。
6. **成本必须进入**：默认每边Taker 0.045%，每边1 bp不利滑点；重要路线做双倍成本压力测试。
7. **分段报告**：年度、形成段、评价段、2026复算、多空、费用和回撤必须拆开。
8. **样本身份准确**：2021—2026大部分区间已被多条路线查看，不再标记为干净留出。
9. **未来数据保留**：2026-07-15之后优先留给冻结路线Paper，不用于短期历史调参。
10. **不以杠杆修复负期望**：PF、平均R、费用敏感性未通过时，提高杠杆只会放大问题。
11. **失败即关闭**：接近门槛也不放宽预注册标准。
12. **Paper不等于订单**：自动运行只允许计算、记账、保存和展示。

## 4. 共用概念

### 市场结构与ICT

- **确认摆动点**：局部高低点必须等右侧确认K线收盘后才可使用，避免未来函数。
- **流动性扫荡**：价格刺破此前确认高/低点后回收，表示止损流动性被触发但突破未延续。
- **位移**：实体相对ATR足够大的方向性K线，代表短时订单流明显偏向一侧。
- **MSS（Market Structure Shift）**：扫荡后价格突破短期反向结构，作为市场结构转换证据。
- **FVG（Fair Value Gap）**：三根K线形成的价格不平衡区，作为ICT入场上下文，不代表必然回补。
- **斐波那契回撤区域**：研究路线使用过0.618—0.786与0.705核心，但历史结果为负，当前不是有效候选。
- **结构止损**：放在使原交易逻辑失效的摆动或扫荡极值之外，不使用任意固定点数截断正常波动。
- **R倍数**：净盈亏除以开仓时计划风险。BTC V5目标为2.5R；多数ETH正常化研究目标为2R。

### 指标与绩效

- **EMA**：指数移动平均。用于方向或趋势斜率，不单独构成交易信号。
- **ATR**：平均真实波幅。用于归一化不同价格阶段的波动、结构距离和位移强度。
- **ATR相对波动比**：当前ATR相对更长基准波动的比例。BTC V5要求至少1.25，过滤低波动噪声。
- **RSI**：相对强弱指标。当前只用于马丁V1的5分钟回撤触发。
- **PF**：总盈利 / 总亏损绝对值。大于1不等于稳健，必须结合平均R、年度、费用和回撤。
- **平均R**：每笔R的均值，比绝对净收益更适合比较不同仓位模型。
- **最大盯市回撤**：逐K线把未实现盈亏纳入权益后，从峰值到低点的最大跌幅。
- **胜率陷阱**：高胜率策略可能靠大量小赢掩盖少量大亏；马丁V1就是典型案例。

### 仓位与合约

- **交易所杠杆设置**不等于账户实际杠杆。
- Route B例子：本金1,000 USDT，2%保证金为20 USDT；100x对应2,000 USDT名义仓位，即账户实际约2x敞口。
- 用户此前举例的50 USDT保证金 × 100x = 5,000 USDT名义仓位，对应的是5%保证金档、实际5x账户敞口，不是当前选择的2%档。
- **全仓**：整个期货账户权益共同支撑仓位；**逐仓**：只用分配给该仓位的保证金。Route B当前为全仓，马丁Paper是隔离风险研究假设。
- **研究风险0.25%**：BTC V5/ETH因子用它把不同止损距离归一化；10,000初始权益时每笔计划风险约25 USDT。它不是统计推导出的最优实盘风险。

## 5. 数据源总览

### 5.1 历史研究主数据：Binance Vision U本位归档

当前BTC/ETH历史研究使用：

```text
https://data.binance.vision/data/futures/um/monthly/klines/{SYMBOL}/5m/
https://data.binance.vision/data/futures/um/daily/klines/{SYMBOL}/5m/
```

示例：

```text
https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-2024-01.zip
https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-2024-01.zip.CHECKSUM
https://data.binance.vision/data/futures/um/daily/klines/ETHUSDT/5m/ETHUSDT-5m-2026-07-15.zip
```

数据处理：

- 下载ZIP与官方 `.CHECKSUM`；
- 逐文件计算并核对SHA256；
- 解析、排序、去重；
- 5分钟时间间隔缺口检查；
- 缓存与源ZIP SHA256绑定；
- 任何缺口或Checksum失败时整次研究失败。

当前CSV保留：OHLCV、quoteVolume、tradeCount、takerBuyBaseVolume、takerBuyQuoteVolume。BTC V5只依赖价格/成交量；BTC/ETH K线订单流实验使用过额外字段。

明确排除：

- 不使用用户误发的 `futures/cm` 币本位目录。
- 不使用1分钟历史作为当前策略基准。
- 15分钟、1小时等研究周期通常由5分钟K线确定性聚合。
- 不用实时REST偷偷补历史归档缺口。

### 5.2 Binance自动Paper与图表：公共USD-M REST

```text
https://fapi.binance.com/fapi/v1/klines
```

用途：

- Route B BTC前向Paper；
- BTC/ETH马丁网格前向Paper；
- `/app/strategy` 的K线图。

只读取公开已收盘K线，不需要API key。前向REST没有归档式逐文件Checksum，因此通过已收盘过滤、数值校验、排序、去重和时间缺口检查控制质量。

### 5.3 Hyperliquid公开行情

`GET /api/strategy/ict/status` 的V5滚动影子状态使用项目现有Hyperliquid公开主网行情服务，内部把 `BTCUSDT` 映射为Hyperliquid perpetual `BTC`。它只做最新信号和滚动影子诊断：

- 数据来自Hyperliquid公共REST / WebSocket行情链路；
- 不需要用户钱包；
- Hyperliquid Testnet执行仍是只读验证；
- 自动订单固定关闭；
- 它与Binance Route B报告不是同一个数据源或同一份绩效报告。

### 5.4 当前未使用的数据

- 当前没有tick-by-tick或逐笔撮合回放。
- Binance `aggTrades / trades` 可用于未来主动成交簇、冲击与恢复速度研究，但尚未接入本策略闭环。
- 用户已明确日内OI和资金费率因子暂时跳过，因此不作为近期优先方向。
- 没有历史订单簿、真实点差、盘口深度和市场冲击模型。
- Route B和马丁均忽略历史资金费率、Mark Price和动态强平档位。

## 6. BTC主线：ICT V5

### 冻结规则

- 市场：BTCUSDT perpetual。
- 周期：15分钟方向，5分钟入场。
- 新入场窗口：北京时间18:00至次日08:00，排除周末。
- 信号链：EMA20方向、确认摆动点扫荡、位移、MSS、FVG。
- 波动过滤：ATR相对波动比至少1.25。
- 入场：信号确认后的下一根5分钟开盘市价。
- 止损：扫荡/结构极值之外，最大允许4.25 ATR；不移除硬止损。
- 目标：按实际成交价到结构止损固定2.5R。
- 持仓：交易窗口结束不强制平仓；不能在非交易窗口新开仓。
- 研究定仓：单笔0.25%权益风险。
- 研究阶段账户级每日风控暂时关闭，但结构止损始终存在。
- 成本：双边Taker 0.045%，每边1 bp不利滑点。

### 冻结表现

| 区间 | 交易数 | 净收益 | PF | 平均R | 最大回撤 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2024—2025 | 159 | +1,042.88 | 1.427 | +0.271R | 2.36% |
| 2026-01至07-13 | 33 | +188.60 | 1.368 | +0.235R | 1.01% |

2024为77笔、2025为82笔，约6.6笔/月。2026已被用于规则判断，不是干净留出。

## 7. BTC Route B：100x全仓自动Paper

### 当前选择

- 初始研究权益：10,000 USDT。
- 交易所杠杆设置：100x。
- 初始保证金：权益2%，即初始200 USDT。
- 名义仓位：约20,000 USDT，即账户权益2x。
- 保证金模式：全仓。
- 同时仓位：一个BTC仓位。
- 前向开始：2026-07-15T00:00:00Z。
- 观察门槛：60天或50笔已完成交易，任一先达到后人工复核。

### 历史固定保证金结果

| 保证金占权益 | 账户名义敞口 | 净收益 | PF | 最大回撤 | 清算 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2% | 2x | +17,620.44 | 1.357 | 20.9% | 0 |
| 3% | 3x | +31,450.56 | 1.314 | 30.4% | 0 |
| 4% | 4x | +48,323.84 | 1.275 | 39.2% | 0 |
| 5% | 5x | +67,112.84 | 1.241 | 47.2% | 0 |

仓位越高净收益越高，但PF下降、回撤明显增加，因此选择2%档。此前逐仓模型产生大量清算的结果已被用户纠正，只作为错误假设审计记录，不能复用。

简化条件：忽略资金费率、Mark Price、动态杠杆档位和真实跳空细节；因此这仍是Paper研究，不是Binance实盘风险引擎。

## 8. BTC增频和入场研究结论

冻结V5只产生约8.4个原始信号/月；2024—2025有202个原始信号、159笔实际交易，43个因已有持仓被忽略，其中40个同方向。持仓中位约4小时，55笔超过8小时，最长约96.8小时。低频不仅来自入场严格，也来自长持仓占用。

| 路线 | 主要结果 | 结论 |
| --- | --- | --- |
| V6 500点等价止损下限 | 2024—2025仅77笔，PF 1.404 | 质量尚可但频率减半，否决 |
| V7趋势FVG回撤 | 组合278笔，PF 1.107，2025转负 | 增频成功、质量失败 |
| 触及后5分钟确认 | 组合179笔，PF 1.293 | 只增20笔且质量下降 |
| 25%回撤/6根同向加仓槽 | 组合188笔，PF 1.512 | 质量较好但少于预注册191笔，关闭 |
| 同向双仓V5 | 195笔，PF 1.452，平均0.282R | 回撤3.48%超过3.11%上限，关闭 |
| 亚洲白盘区间扫荡 | 组合624笔，PF 0.818 | 高频但负期望 |
| K线主动成交量延续 | 组合831笔，PF 0.811 | 高频但负期望 |
| Fibonacci 0.618—0.786直接入场 | 组合576笔，PF 0.908 | 多空和年度均失败 |

结论：BTC V5当前正向质量与低频筛选绑定。只靠放宽阈值、加入常见价格形态或K线级订单流，能增加交易数但会把噪声转成交易。

## 9. ETH研究

### 当前身份

ETH没有类似BTC V5的冻结合格方向策略，也没有独立ETH方向自动Paper。当前ETH只出现在：

- 已否决的ETH因子/SMC研究；
- BTC+ETH统一入场研究；
- 独立马丁网格Paper中的ETH腿。

### ETH因子V1—V5

五条路线共330个预注册配置，全部未通过2021—2023形成段，因此按规则没有打开2024—2025评价段。

| 路线 | 信息 | 配置数 | 形成段最佳PF | 状态 |
| --- | --- | ---: | ---: | --- |
| V1 | ETH 5分钟价格量能 | 108 | 0.902 | 否决 |
| V2 | ETH 15分钟因子、5分钟执行 | 72 | 0.906 | 否决 |
| V3 | BTC—ETH 15分钟跨资产因子 | 108 | 0.814 | 否决 |
| V4 | 用户习惯40点止损/100点止盈 | 24 | 1.080 | 改善但仍否决 |
| V5 | K线订单流 + 结构止损 + 2R | 18 | 1.137（145笔） | 未达1.15/0.10R门槛 |

V5最接近配置：145笔、净收益+303.73、PF 1.137、平均0.079R、最大回撤3.16%；2023为负。高阈值配置PF 1.604但只有16笔，不具备样本资格。多头PF 0.985、空头PF 1.398，但不允许事后只保留空头。

### 固定点数不是正常化标准

用户的ETH操作习惯约40点止损、100点以上止盈曾作为独立V4测试。它相对早期因子有所改善，但不同价格和波动阶段的40点含义不同，因此不能作为通用策略标准。正常化研究使用：

- 已确认结构失效点；
- ATR波动缓冲；
- 止损距离的ATR上下限；
- 按实际成交到止损定义1R，再设置2R等目标。

### 达到1R后保本实验

低频基线145笔、PF 1.137、净收益+303.73；达到1R后整仓移至入场价变为146笔、PF 0.978、净亏损39.31。高频版本从PF 0.925进一步降至0.713。原因是保本规则同时截断了原本可以到达2R的右尾盈利，路线已否决。

### BTC+ETH统一回撤入场

25%信号K线回撤、6根有效对BTC有局部改善：114笔、PF 1.208；但ETH同规则728笔、PF 0.925、净亏损871.33，组合PF 0.955。统一路线关闭，不能只截取BTC分项替换现有Route B。

## 10. BTC+ETH马丁网格

专题完整交接见 `STRATEGY_MARTINGALE_GRID_HANDOFF.md`。

当前V1：

- BTC/ETH各5,000 Paper权益；
- 5x隔离风险模型；
- 首层保证金0.5%；
- 1.35倍，最多5层；
- 15分钟EMA50/200趋势 + 5分钟RSI30/70触发；
- ATR/价格比例自适应网格；
- 整组计划风险不超过1.5%；
- 24小时超时；
- 60天或100组观察门槛。

历史结果：1,622组，净收益+160.53，PF 1.304，平均0.0049R，最大盯市回撤0.91%；双倍成本后净亏损411.63、PF 0.378。状态为历史资格未通过。

15分钟V2：把RSI/ATR机械放大到15分钟后，BTC和ETH合格信号均为0。若继续，应建立独立“1小时趋势 + 15分钟回撤 + 下一根5分钟执行”V3，而不是覆盖V2失败记录。

新增固定价差V3参数设计见 `STRATEGY_MARTINGALE_GRID_FIXED_STEP_V3.md`：使用4小时确认摆动结构确定主方向、1小时结构突破确认，只按BTC 200点/ETH 10点固定距离建立12层单向网格；全部层累计保证金仍限制为5%，当前马丁V1不变。

## 11. 自动运行、接口与页面

### BTC V5 / Route B

```http
GET /api/strategy/ict/status
GET /api/strategy/ict/forward
GET /api/strategy/ict/history?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&cursor=...
GET /api/strategy/ict/candles?interval=5m&from=...&to=...&limit=500
```

- `status`：Hyperliquid公共行情上的V5滚动影子状态。
- `forward`：Binance Route B自动Paper报告与Worker状态。
- `history`：读取预生成Route B历史报告，不在HTTP请求中跑长回测。
- `candles`：BTCUSDT Binance公共K线，用于图表交易标记。

### 马丁网格

```http
GET /api/strategy/martingale/forward
GET /api/strategy/martingale/candles?symbol=ETHUSDT&interval=5m&from=...&to=...&limit=500
```

### 管理员健康状态

```http
GET /api/admin/strategy/health
```

用户接口要求登录。无报告返回安全空态，报告损坏返回不泄漏路径/堆栈的503。PF无亏损样本时为`null`。

`/app/strategy` 当前展示Route B的前向/历史报告以及马丁网格Paper页签。页面是只读研究界面，没有启动策略、停止策略、调杠杆、复制交易或真实下单入口。

## 12. Worker与报告

### Route B

```text
STRATEGY_FORWARD_WORKER_ENABLED=true
STRATEGY_FORWARD_WORKER_POLL_MS=300000
STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json
STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json
```

### 马丁网格

```text
MARTINGALE_GRID_PAPER_WORKER_ENABLED=true
MARTINGALE_GRID_PAPER_WORKER_POLL_MS=300000
MARTINGALE_GRID_PAPER_REPORT_PATH=/app/strategy-data/martingale-grid-paper.json
```

共同机制：启动立即检查、最新closed candle推进才完整复算、single-flight、缺口拒绝覆盖、失败保留旧报告、原子写入、Worker失败不影响主API健康。

## 13. 代码与文档导航

| 范围 | 文件 |
| --- | --- |
| BTC V5冻结规则 | `STRATEGY_V5_ARCHIVE.md` |
| 总研究记录 | `STRATEGY_RESEARCH.md` |
| Route A趋势回撤 | `STRATEGY_ROUTE_A_RESEARCH.md` |
| BTC入场容量/增频/双仓 | `STRATEGY_BTC_ENTRY_CAPACITY_V1.md`、`STRATEGY_BTC_ENTRY_EXPANSION_V2.md`、`STRATEGY_BTC_MULTI_POSITION_V1.md` |
| BTC高频/Fibonacci | `STRATEGY_BTC_SESSION_SWEEP_V1.md`、`STRATEGY_BTC_ORDERFLOW_V1.md`、`STRATEGY_BTC_FIB_RECLAIM_V1.md` |
| BTC+ETH统一入场 | `STRATEGY_BTC_ETH_ENTRY_ROUTE_V1.md` |
| ETH累计总结 | `STRATEGY_ETH_FACTOR_RESEARCH_SUMMARY.md` |
| ETH最近因子与保本 | `STRATEGY_ETH_FACTOR_ROUTE_V5.md`、`STRATEGY_ETH_BREAK_EVEN_ROUTE_V1.md` |
| 马丁专题 | `STRATEGY_MARTINGALE_GRID_HANDOFF.md` |
| 固定价差12层马丁V3 | `STRATEGY_MARTINGALE_GRID_FIXED_STEP_V3.md` |
| 历史数据源 | `server/modules/strategy/backtest/BinanceVisionHistoricalDataSource.ts` |
| 通用回测引擎 | `server/modules/strategy/backtest/BacktestEngine.ts` |
| BTC V5模型 | `server/modules/strategy/models/IctLiquidityReversalStrategy.ts`、`server/modules/strategy/models/ictResearchCandidate.ts` |
| Route B Worker/报告 | `server/modules/strategy/runtime/ForwardPaperWorker.ts`、`server/modules/strategy/runtime/ForwardReportService.ts` |
| 马丁引擎/Worker | `server/modules/strategy/runtime/MartingaleGridPaperEngine.ts`、`server/modules/strategy/runtime/MartingaleGridPaperWorker.ts` |
| API | `server/modules/api/strategyRoutes.ts` |
| 前端请求/页面 | `src/api/strategy.ts`、`src/features/strategy/` |

## 14. 当前研究优先级

1. Route B保持2%保证金、100x设置、全仓、单BTC仓位，继续冻结前向Paper至60天或50笔门槛。
2. 马丁V1保持参数不变继续记录，但历史资格未通过的标签必须始终展示。
3. BTC增频不再放宽V5阈值；如继续，应使用独立新信息或独立setup，并保护V5组合PF/回撤。
4. ETH在没有新信息前不继续扩大OHLCV/K线订单流阈值网格；用户已跳过OI和资金费率，优先候选只能是aggTrades成交簇/冲击恢复或扩大到新市场组合。
5. 马丁15分钟路线若继续，先预注册1小时趋势 + 15分钟信号 + 5分钟执行V3。
6. 所有通过历史门槛的新路线仍必须建立独立前向Paper，不能直接接真实订单。

## 15. 风险与未覆盖

- 历史资金费率被忽略。
- Mark Price、动态杠杆档位、真实强平、ADL未完整模拟。
- K线回测不能恢复分钟内真实路径或盘口成交量。
- Binance公共REST前向数据没有Binance Vision逐文件Checksum。
- 真实点差、市场冲击、限频和交易账户状态未进入策略收益。
- Route B全仓假设同一时间只有一个BTC仓位；与其他全仓仓位共享保证金时结果会变化。
- Hyperliquid影子状态与Binance历史/前向报告不能直接拼接为一条连续绩效。
- 当前大部分历史已经被查看，任何新参数的历史改善都高度可能包含选择偏差。

## 16. 固定交接信息

交接对象：策略研究 / 后端 / 前端 / 测试 / 项目管理。
触发原因：切换对话、账号或owner时保留BTC、ETH、Route B和马丁网格的完整上下文。
已完成：BTC V5冻结、Route B自动Paper、BTC增频诊断、ETH V1—V5研究、BTC+ETH统一入场、马丁自动Paper与历史复算、用户端只读展示。
当前生产：Route B与马丁Worker已部署运行；自动真实订单关闭。
当前本地：worktree `/Users/dq/.codex/worktrees/2c58/xingheng`，`develop`，本文编写时HEAD `131eb12`，存在共享未提交改动；本地5173/8787未监听。
下一步：继续前向观察；任何新研究先预注册独立routeId。
不属于当前范围：Binance实盘下单、API key、主网真实资金、平台代签、自动跟单。
风险 / 阻塞：BTC无干净历史留出；ETH无合格方向候选；马丁历史资格失败；资金费率/Mark Price/真实成交尚未覆盖。
