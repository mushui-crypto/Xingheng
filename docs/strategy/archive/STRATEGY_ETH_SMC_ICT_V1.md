# ETH SMC / ICT Fib-FVG-OB V1 预注册

## 研究身份

- Route ID: `ict-eth-smc-fib-fvg-ob-v1-2026-07-16`
- 品种: Binance USD-M `ETHUSDT` perpetual
- 行情源: Binance Vision 公共 `5m` K 线
- 用途: 只读历史研究，不连接 Binance 交易 API，不自动下单
- 参数状态: 本文件在首次运行该 Route 回测前冻结；首次结果出来后不在同一 Route 内删方向或调参
- 样本状态: 2024 至 2026-07-14 已被其他 ETH 路线观察过，因此不是 clean holdout

## 把主观术语转为客观规则

用户给出的核心逻辑是：突破前高/前低后，对 impulse 拉 Fibonacci，等待回调到 0.5 以下/以上区域，以 FVG 为进场位置、订单块为邻近确认，并只在 ICT 交易时段操作。

V1 固定为以下可复现定义：

1. **结构时间框架**：15m；执行时间框架：5m。
2. **前高/前低**：15m 的 2-left / 2-right confirmed swing；只有右侧两根 15m K 线闭合后才可使用，禁止前视。
3. **看多 BOS**：当前 5m 收盘首次上破最近可用的 confirmed 15m swing high；该 swing high 之前必须存在 confirmed swing low，作为 impulse origin。
4. **看空 BOS**：当前 5m 收盘首次下破最近可用的 confirmed 15m swing low；该 swing low 之前必须存在 confirmed swing high，作为 impulse origin。
5. **位移确认**：BOS K 线必须为同方向 displacement，实体至少为 `0.8 ATR(14)`，且收盘靠近 K 线方向极值。
6. **Fibonacci 0.5 区域**：
   - 多头从 impulse origin low 拉到 BOS K 线 high，只允许在 equilibrium（0.5）及以下的 discount 区挂单。
   - 空头从 impulse origin high 拉到 BOS K 线 low，只允许在 equilibrium（0.5）及以上的 premium 区挂单。
7. **FVG**：只搜索 origin 之后、BOS 之前或当根形成的同方向 5m 三蜡烛 FVG；FVG midpoint 必须位于对应 Fib 半区，且在 BOS 前未被触达。
8. **订单块**：FVG 形成前最近 6 根内最后一根反向 5m K 线，使用整根 high-low 作为订单块范围；FVG midpoint 到订单块范围的距离不得超过 `0.5 ATR`。
9. **进场**：在合格 FVG midpoint 放置限价单；必须是真正回调（多头 entry < BOS close，空头 entry > BOS close）；订单最多保留 12 根 5m K 线。
10. **止损**：订单块极值外加 `0.1 ATR`；止损距离必须位于 `0.25..4.0 ATR`。
11. **止盈**：固定 `2.5R`，不因回测结果改变。
12. **ICT 时段**：仅在 `America/New_York` 07:00–10:00 产生信号和成交；自动处理夏令时。
13. **日历过滤**：周末不新开仓。
14. **风险与成本假设**：单笔风险为权益的 0.25%；进场和离场均按 0.045% 费用、每边 1 bps 不利滑点；研究阶段关闭账户级日亏/连亏/笔数门槛，以观察原始策略分布。
15. **持仓管理**：交易时段只限制新开仓；已开持仓继续由硬止损或目标价管理，不在时段结束强平。

## 首轮判定规则

V1 首轮仅做基线诊断，不因结果修改规则。只有连续区间和每个日历区间同时满足以下条件，才可进入新的 clean forward shadow 评审：

- 净收益大于 0
- Profit Factor 大于 1
- Average R 大于 0
- `automaticOrdersEnabled` 始终为 `false`

如果失败，Route 状态记为 `baseline_rejected_no_same_route_tuning`；后续任何修改必须创建新的 Route ID，并保留本结果。
