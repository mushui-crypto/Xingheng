# ETHUSDT SMC / ICT V3 预注册规则

- 规则冻结日期：2026-07-16
- Route ID：`ict-eth-htf-aligned-immediate-sweep-fvg-ob-v3-2026-07-16`
- 状态：首次历史运行前冻结
- 用途：只读历史研究，不连接 Binance 下单 API
- 数据源：Binance Vision USD-M Futures `ETHUSDT` 5m
- 说明：V3 是独立新路线，不修改或覆盖已经冻结的 ETH V1 / V2。

## 1. 研究动机

ETH V2 把“扫流动性 → MSS 位移 → FVG → Fib 0.5 折价/溢价 → 订单块”客观化后，在 2024-01-01 至 2026-07-14 连续历史中仍为负期望。V2B 的分批止盈降低了回撤，但没有修复信号质量。

V3 只引入事先冻结的四项变化：

1. 复用 BTC V5 的高波动过滤思想；
2. 要求上一根完整 15m 与上一根完整 1h 的 EMA20 方向一致；
3. 把 sweep 与 MSS 的最大间隔从 24 根缩短到 6 根 5m；
4. 把持仓限制为最多 24 根 5m，避免把 ICT 日内模型变成长时间隔夜持仓。

其他价格行为、止损、杠杆和分批退出规则沿用 V2B，不根据 V3 首次结果回头改参数。任何参数变化必须建立 V4 或其他新 route。

## 2. 市场、周期与方向

- 市场：Binance USD-M `ETHUSDT` perpetual，仅用于历史研究。
- 执行周期：5m。
- 快速高周期：15m。
- 慢速高周期：1h。
- EMA 周期：20。
- 方向只使用已经完成的高周期 K 线：
  - 多头：上一根完整 15m close > EMA20，且上一根完整 1h close > EMA20；
  - 空头：上一根完整 15m close < EMA20，且上一根完整 1h close < EMA20；
  - 两个周期不一致或任一周期仍在 EMA warm-up 阶段：不交易。
- 不使用未来尚未完成的 15m / 1h K 线。

## 3. 波动率过滤

沿用 BTC 研究中的 regime 定义：

- 当前 ATR14：5m 当前索引的 ATR14；
- 基准 ATR：向前最多 240 根 5m，每隔 5 根采样一次 ATR14 后取平均；
- `volatilityRatio = current ATR14 / baseline ATR`；
- 只有 `volatilityRatio >= 1.25` 才允许产生新信号。

阈值 `1.25` 在首次 V3 历史运行前冻结。

## 4. ICT 交易时段

- 时区：`America/New_York`，自动处理夏令时；
- 周一至周五；
- 只在纽约时间 `07:00 <= time < 10:00` 产生新信号和成交挂单；
- 周末不交易；
- 时段结束后取消未成交挂单；
- 已成交仓位不因 10:00 到来立即平仓，但受第 10 节的 2 小时持仓上限约束。

## 5. Confirmed liquidity sweep

使用 5m confirmed swing，左右各 2 根：

- 多头：某根已完成 K 线下破当时已经确认的 swing low，并收盘重新站回该 swing low 之上；
- 空头：某根已完成 K 线上破当时已经确认的 swing high，并收盘重新跌回该 swing high 之下；
- sweep penetration 必须在 `0.02 ATR` 至 `0.50 ATR` 之间；
- sweep 必须严格早于 MSS 位移 K 线；
- MSS 只能关联最近 6 根 5m 内的 sweep，即最多相隔 30 分钟；
- 超过 6 根的 sweep 不再有效。

## 6. MSS、位移与 FVG

- MSS 参考 MSS 前一根 K 线时已经确认的反向 swing：
  - 多头首次从前收盘不高于 swing high，变为当前收盘高于 swing high；
  - 空头首次从前收盘不低于 swing low，变为当前收盘低于 swing low。
- MSS K 线实体必须至少为 `0.30 ATR`，方向与交易方向一致；
- MSS K 线必须直接形成同方向三根 K 线 FVG；
- FVG 大小必须在 `0.05 ATR` 至 `1.00 ATR`；
- 不接受 MSS 后若干根才形成的延迟 FVG。

## 7. Fibonacci 0.5 与订单块

- Fib range：从 sweep extreme 到 MSS displacement extreme；
- equilibrium：二者中点；
- 挂单价格：FVG midpoint；
- 多头 FVG midpoint 必须位于 sweep extreme 至 equilibrium 的 discount half；
- 空头 FVG midpoint 必须位于 sweep extreme 至 equilibrium 的 premium half；
- 最近 6 根内寻找离 MSS 最近的反向实体 K 线作为订单块；
- FVG 与该最近订单块价格区间距离不得超过 `0.50 ATR`；
- 若最近反向订单块距离过远，不跳过它去选择更老的订单块。

## 8. 入场与挂单有效期

- 入场：FVG midpoint 限价；
- 多头挂单必须低于信号 K 收盘，空头挂单必须高于信号 K 收盘；
- 挂单最多保留 6 根 5m（30 分钟）；
- 若纽约时间到达 10:00 仍未成交，则取消；
- 同时最多持有一个 ETH 仓位，不叠加仓位。

## 9. 结构止损与 20–40 点规则

原始结构止损：

- 多头：`min(sweep low, order-block low) - 0.10 ATR`；
- 空头：`max(sweep high, order-block high) + 0.10 ATR`。

点数客观化：

- 原始结构风险距离 `< 20 USDT`：向外扩到 20 点；
- `20 <= 距离 <= 40 USDT`：保留原结构止损；
- 距离 `> 40 USDT`：拒绝信号；
- 绝不把大于 40 点的结构止损截短成 40 点。

## 10. 分批止盈、保本与时间退出

固定沿用 V2B：

- TP1：50% 仓位在 1R；
- TP2：剩余 50% 仓位在 2.5R；
- TP1 成交后，把余仓 stop 移到实际滑点后的入场成交价；
- 最大持仓：从实际成交开始最多 24 根 5m，即 2 小时；
- 时间上限到达时，余仓按当前 K 收盘价退出并计入 taker 退出费与不利滑点；
- 若同一根 5m 同时触及多个条件，采用保守顺序：
  1. 清算；
  2. 当前有效止损；
  3. TP1；
  4. 移动后的保本止损；
  5. TP2；
  6. 时间退出。

## 11. 杠杆、全仓与仓位档位

- 交易所杠杆设置：100x；
- 保证金模式：cross / 全仓；
- 分别研究初始保证金占当时权益：2%、3%、4%、5%；
- 名义仓位：`equity × marginFraction × 100 / entryPrice`；
- 近似账户名义敞口分别为 2x、3x、4x、5x，不是全账户 100x；
- 回测假设同一时间没有其他 cross 仓位或挂单消耗抵押品；
- 不启用账户级“每日最多几笔/连亏锁仓”等过滤，避免把信号质量和账户风控混为一谈。

## 12. 费用、滑点和清算假设

- 初始权益：10,000 USDT；
- 限价入场费率：0.045%；
- 退出费率：0.045%；
- 每次成交不利滑点：1 bps；
- 研究用维护保证金率：0.50%；
- 研究用清算费率：1.25%；
- funding 不计入；
- ETH 数量连续，不做 0.001 ETH 步进、价格 tick、最小名义金额取整；
- 以上清算与精度均是研究简化，不能直接用于实盘。

## 13. 首次冻结评估门槛

V3 只运行一个方向对称 route，分别评估 2%–5% 四个保证金档。每个档位必须同时满足以下条件才可标记为“历史基线通过”：

### 连续区间 2024-01-01 至最新可用日

- 至少 20 笔完整交易；
- 净收益 > 0；
- Profit Factor >= 1.20；
- Avg R >= 0.10；
- 最大回撤 <= 20%；
- 清算次数 = 0。

### 年度稳定性

2024、2025、2026 至最新可用日每个分段均必须：

- 至少 5 笔完整交易；
- 净收益 > 0；
- Profit Factor > 1；
- Avg R > 0。

任一条件失败，则该保证金档失败。不得在查看结果后删除多头、删除空头、调整 1.25 波动率阈值、放宽 6 根 sweep 时限、改变持仓上限或改止盈比例；后续变化必须新建 route。

## 14. 数据角色与上线边界

- 2024-01-01 至 2026-07-14 已被此前 BTC / ETH 研究接触，不是 clean holdout；
- V3 的参数选择也受到 V2 失败诊断影响，因此首次 V3 历史运行只能称为“seen-history preregistered recalculation”；
- 即使历史门槛全部通过，也只能进入新的 forward paper / shadow 观察；
- `shadowEligible` 在首次历史报告中固定为 `false`，等待独立 forward 方案；
- `automaticExecutionEligible=false`；
- 不接 Binance 交易 API，不自动下单，不把历史回测称为实盘或 forward。
