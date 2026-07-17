# ETHUSDT SMC / ICT V4 正常止盈派生路线预注册

冻结日期：2026-07-16

本文件在 V4 正常止盈路线首次历史运行之前冻结。原 `STRATEGY_ETH_SMC_ICT_V4.md`、原 V4 分批止盈代码与 `STRATEGY_ETH_SMC_ICT_V4_RESULT.md` 保持不变；本路线只替换退出方法，不根据原 V4 结果修改入场、方向、时段、止损、杠杆或仓位规则。本路线只做 Binance USD-M `ETHUSDT` perpetual 历史研究，不连接 Binance 下单 API，不自动交易。

## 1. 独立路线与正常止盈

基础路线：`ict-eth-mtf-session-sweep-fvg-ob-v4-normal-tp-2026-07-16`

三条候选只允许全仓止盈目标不同，入场与初始止损完全相同，首次运行必须全部报告：

- V4N-A：`ict-eth-mtf-session-sweep-fvg-ob-v4n-a-2026-07-16`：`100% @ 1.5R`。
- V4N-B：`ict-eth-mtf-session-sweep-fvg-ob-v4n-b-2026-07-16`：`100% @ 2.0R`。
- V4N-C：`ict-eth-mtf-session-sweep-fvg-ob-v4n-c-2026-07-16`：`100% @ 2.5R`。

“正常止盈”定义为单目标全仓退出：不在 1R 分批止盈，不在到达 1R 后移动止损到保本。5m OHLC 同一根同时触及不利与有利价位时，按清算 → 初始止损 → 全仓止盈的保守顺序处理。不得只展示表现最好的候选，也不得在看到首次结果后修改同一 route。

## 2. 数据和样本

- 品种：`ETHUSDT`；合约：Binance USD-M / U 本位永续。
- 数据源：`https://data.binance.vision/data/futures/um`。
- 原始执行数据：5m；15m、1h、4h 全部由同一 ETHUSDT 5m 数据聚合。
- 高周期判断只允许使用信号时刻之前最后一根完整收盘 K 线，禁止未来数据。
- 官方 ZIP SHA256 必须验证；数据去重；任一 5m 缺口大于 0 时停止运行。
- 首次样本：2024-01 至 2026-06 monthly，加 2026-07-01 至 2026-07-14 daily。
- 历史已被前序研究接触，不是 clean holdout；结果只能称为 seen-history preregistered baseline。

## 3. 时间、周末与机会频率

时区统一为 `America/New_York`。仅周一至周五以下窗口允许产生新信号与新成交：

- London：02:00–05:00；
- New York：07:00–11:00。

周六、周日不产生新信号、不允许新成交；未成交挂单在窗口结束时取消；已成交仓位允许跨窗口、跨交易日和跨周末持有；同时最多一笔仓位；每个纽约交易日最多两次实际新开仓。连续止损停止开单和每日亏损锁仓均关闭。

## 4. 多周期方向

- 4h、1h：观察趋势背景；15m：决定最终方向；5m：执行入场。
- 各周期使用上一根完整 K 线收盘与 EMA20：上方 bullish、下方 bearish、相等或暖机不足 neutral。
- 15m 必须非 neutral；1h、4h 至少一个与 15m 同向。
- 另一个高周期若反向，仅当 `abs(close-EMA20)/ATR14 < 0.75` 时允许；达到或超过 0.75 ATR 拒绝。

## 5. 5m 入场结构

- swing 左右各 2 根确认，只使用当时已确认 swing。
- MSS 前最近 12 根内寻找流动性 sweep，penetration 为 ATR14 的 0.01–0.75。
- sweep 必须严格早于 MSS；MSS 必须是首次突破确认结构，并有同向位移，实体至少 0.20 ATR。
- MSS K 线必须直接形成同方向三根 K 线 FVG，大小为 0.02–1.25 ATR。
- Fib dealing range 从 sweep extreme 到 MSS displacement extreme；多头 FVG midpoint 位于 discount half，空头位于 premium half。
- 入场价为 FVG midpoint；MSS 前最多回看 8 根，最近反向实体 K 线作为订单块；FVG 与订单块最短距离不得超过 1 ATR。
- 限价挂单最多保留 12 根 5m，且不得越过当前 London/NY 窗口结束。

## 6. 结构止损

- 多头原始止损：`min(sweep low, order-block low) - 0.10 ATR`。
- 空头原始止损：`max(sweep high, order-block high) + 0.10 ATR`。
- 原始距离不足 20 USDT 点时扩到 20 点；20–40 点保留；超过 40 点拒绝，不截短到 40 点。
- 止损成交遵循回测滑点模型；正常止盈路线不移动止损到保本。

## 7. 仓位、杠杆、费用与清算

- 初始权益 10,000 USDT；100x 交易所杠杆；cross / 全仓模式。
- 初始保证金权益占比候选固定为 2%、3%、4%、5%；约对应账户权益 2x、3x、4x、5x 初始名义敞口，不表示整个账户承受 100x 名义敞口。
- 入场费率 0.045%，退出费率 0.045%，每次成交不利滑点 1 bp。
- 维护保证金率研究简化值 0.50%，清算费 1.25%；无其他交叉仓位占用权益。
- funding 不计入；ETH 数量连续，不模拟交易所数量步长、价格 tick、最小名义和真实杠杆档位。

## 8. 冻结判定门槛

连续区间 2024-01-01 至 2026-07-14，每个目标 × 保证金组合必须同时满足：

- trades >= 100；netPnl > 0；PF >= 1.20；Avg R >= 0.10；maxDD <= 20%；liquidations = 0。

年度 2024、2025、2026-01-01 至 2026-07-14 每段必须同时满足：

- trades >= 20；netPnl > 0；PF > 1；Avg R > 0。

任一年度或连续门槛失败即拒绝。全部拒绝则状态冻结为 `all_candidates_rejected_no_same_route_tuning`，`shadowEligible=false`，`automaticExecutionEligible=false`。若有通过组合，也只能进入新的 forward paper / shadow 样本；自动实盘始终不合格。
