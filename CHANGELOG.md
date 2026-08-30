# Changelog

本文档记录星衡项目的阶段版本。

## Production Baseline — 2026-08-31

- Production SHA: `2a9ad650eeae532c65a5e5323aada3f9c2164a9d`
- Status: `STABLE_BASELINE`
- Core venues: Binance / OKX / Bybit / Bitget
- Funds execution: `Validated`
- All-venues live Stage A: `PASS`
- Provider duplicate mutations: `0`
- Cross-venue / account / instance routing incidents: `0`
- Active production trade gates: 四家全部 `live=false / kill=true`

本条记录当前稳定运行基线；以下旧日期条目保留为历史，不代表当前部署状态。
真钱验收结论沿用已完成并由用户确认的验收，不代表本次文档整理重新执行了交易或压力测试。
本次只读复核生产 health、revision 和四家 gate；文档提交不改变上述 Production SHA，亦不需要部署。

### 本阶段版本摘要

范围：最近冻结基线 `20c9aa5c051337576e119fde6be79d262d6a83af` 至当前 Production SHA。

1. **Four-venue funds execution**：Binance、OKX、Bybit、Bitget 核心 Start → Exit 已通过真钱验收；
   execution identity、账户和实例归因继续保持隔离。
2. **Start / Exit UX**：一次正式 Start 确认、Spot 权威成交与 attribution 后自动执行第二腿；
   一次正式 Exit 确认完成两腿退出与 dust finalization。`974ff51` 将 Start terminal 后的实例、
   verification / CloseSafety / Delta / Exit capability 纳入共享 authoritative refresh，loading 覆盖刷新提交。
3. **Provider eventual consistency**：`88cb8bd` 支持 Bybit execution evidence 暂未同步时，
   在同一 command 内继续有界只读 reconcile；不重复 Start 或 Provider mutation。
4. **Managed-close safety / final reliability cleanup**：fresh CloseSafety 的 attempt-scoped
   verified facts 传递至 mutation boundary；`1787893` / `d82d800` 收口 OKX，`5212dab` 收口 Bitget，
   `99dfc88` 清理 Binance / Bybit 重复 pre-dispatch safety reads。保留必要权限、open-orders、
   signing time 和 final pricing 读取及既有安全 fallback，不将所有 Provider GET 一概视为重复。
5. **Bitget fixes**：`f8c2e05` 支持并严格校验 HEDGE `open_long/open_short/close_long/close_short`；
   `d12e67a` 在权威 linear perpetual / base-quantity 条件下，对缺失 contractSize 派生内部
   contractValue=1，显式非1仍 fail closed，canonical/native base quantity 语义不变。
6. **Dust / Management Release**：`034f578` 完成 verified dust context 后的 fresh Spot balance-only
   final release；release 不触发 Provider mutation，releasedQuantity 独立记录，不伪造 confirmed close。
7. **Recovery / failure authority**：`26e05dc` 保留 pre-mutation failureStage 和受控诊断，区分
   `NOT_DISPATCHED` 与 `DISPATCHED_OR_POSSIBLE`。不确定派发继续 fail closed；旧 intent 不自动恢复交易。
8. **Lightweight observability**：`6667627` 提供 SQLite 轻量 per-command GET/place/cancel/amend
   trace、post-safety window 和跨 venue/account/instance mutation 归属；best-effort，不记录敏感原始载荷。
9. **All-venues live Stage A**：四家同时 live，逐 venue Start，再顺序完成 Exit；总计16笔 Provider
   place orders，duplicates=0，cross venue/account/instance=0，Stage A 已 PASS。后续 cleanup
   发布采用只读/隔离 smoke，没有将其描述成在新 SHA 上重新运行整轮真钱 Stage A。
10. **Code reduction**：Batch 1（`2a9ad65`）已部署：删除无消费者 outer verifiedAt、
    outer managedQuantityCeiling、native-rules contextFingerprint；共享 Formal execute/reconcile/cancel
    纯 mapper，保留内部 freshness、scope authority 和 WeakSet provenance。受影响生产文件物理行净减89。
    Batch 2 候选收益仅22行，低于30行门槛，未落地，FILES_CHANGED=0，无代码 commit 或部署。

### 验证与后续边界

- Batch 1 全量测试 `2348/2348 PASS`，typecheck、Web/API build、diff check 通过；生产 revision 与
  commit 一致，health=true、API writers=1，WAL-aware backup/checksum/SQLite quick/integrity checks 通过，
  历史 execution/reference/ledger 与订单库摘要不变，发布期间 Provider mutation=0。
- Batch 2 保留原实现；基线定向测试 `304/304 PASS`、全量 `2348/2348 PASS`，typecheck/build/diff check 通过。
- **Known legacy items**：5条已审查的历史 CLOSED-managed 记录属于 legacy residual model，
  明确不属于当前版本新 Exit 路径产生；仅保留已批准的验收白名单，不补 release、不修改历史数据，
  不将该豁免扩展到任何新实例。
- **Deferred**：Stage B/C/D concurrency stress tests 已取消；Perp context-missing fallback cleanup、
  manual recovery route cleanup、legacy migrations/rebind cleanup、diagnostic mapping cleanup 延期。
- **Current strategy**：稳定运行观察，只处理真实 bug；不继续主动增加执行层复杂度。
  后续代码修改、部署与真钱执行仍分别需要对应授权。

## Unreleased - OKX Spot/Perpetual real-money closed loop and handoff cleanup

日期：2026-08-18

状态：OKX 核心修复已部署并完成 Test C；本地 cleanup、Funding 平行模型、导航与文档改动待部署

### 已完成并部署

- `058afc7`：第二腿以第一腿实际 base exposure 为 hedge target，并在 venue 边界向下合法化数量。
- `7f985b8`：收紧 OKX `placeOrder` response contract，固定 `sCode/ordId/clOrdId/instId` 权威边界。
- `2bcea91`：保留 Capability 原始失败原因；该 revision 为当前 production 基线。
- OKX Test C 完成四笔真实订单：Spot open、Perpetual open、Perpetual close、Spot close；全部
  `CONFIRMED` 且 `ordId` 唯一，最终 Perpetual=`FLAT`、active orders=`0`、无残余敞口。
- Spot gross fill `110 DOGE`，base fee `0.11 DOGE`，第二腿 target=`109.89 DOGE`，OKX 可执行
  `100 DOGE`，venue 粒度 residual=`9.89 DOGE`；退出后 Spot 回到测试前 dust。
- 测试结束后恢复 `OKX_LIVE_TRADING_ENABLED=false`、`OKX_KILL_SWITCH=true`；Binance 始终关闭。

### 当前本地主线候选

- 删除无生产消费者且已被 Formal Runtime 主链覆盖的旧 Funding Manual API/Service 路径。
- 收拢套利顶栏为“套利系统”菜单，并支持从套利看板整行进入套利分析。
- Funding Strategy / IntentBuilder / Coordinator / Bridge 的 Spot/Perpetual 扩展仍没有 production
  consumer，不得视为新的正式执行入口。
- 记录 Funding Opportunity Evaluator 的只读分析边界；它不是执行、策略或自动交易系统。

### 已知问题

- `NOTIONAL_USDT` 第一腿精确重验可能因报价变化产生 quantity drift，安全阻断且 mutation=`0`，但会
  留下空 `OPENING` 实例。该 P1 尚未修复。

## Unreleased - Multi-venue coexistence architecture boundary

日期：2026-08-17

状态：已记录为长期架构边界，未改变运行权限或部署状态

### 已记录

- 明确 Binance、OKX、Bybit、Bitget 共存的统一分层：统一执行流程、正式运行层、交易所能力层、
  venue adapter 和 Provider 层。
- 固化 `ExecutionIntent` 使用 canonical base quantity；`sz`、张数、`ctVal`、`lotSz`、
  `contractSize` 等交易所字段只允许在 venue 边界解释。
- 固化统一订单引用、`PositionReader -> Canonical PositionSnapshot -> PositionVerification`、
  交易规则转换、独立凭证/client/session 和 venue-specific 风控参数边界。
- 明确新交易所通过能力和运行适配接入，不修改统一核心；Binance 已验证闭环作为基准。

### 当前边界

- 本条目是架构和决策记录，不是部署、Provider mutation 或真实资金授权。
- 接入矩阵与当前实现、生产 revision、实时 Provider 事实必须以 `PROJECT_CONTEXT.md` 和独立验收
  证据重新核对。

## Unreleased - Position Verification foundation checkpoint

日期：2026-08-16

状态：已验收并集成到 `main`，未部署

### 已完成

- 固化 `030f50a4c8a841903097f511ed638c780275e3a8` 作为 Position Verification foundation checkpoint。
- 建立 `Provider Position -> Venue PositionReader -> canonical PositionSnapshot -> PositionVerification -> ArbitragePositionVerificationService` 统一边界。
- Binance 与 OKX perpetual position reader 已接入 canonical base quantity、方向、instrument identity 和 fail-closed 校验。
- 保持 `ExecutionIntent`、`ExecutionRecord`、`ExecutionReference`、`ExecutionCoordinator`、
  `ArbitrageInstance` schema、Trading Rules 和正式 mutation 链不变。
- 全量 Server 测试 `1156 passed / 0 failed`，Server TypeScript、`npm run build` 和 `git diff --check` 通过。

### 当前边界

- `POSITION_VERIFICATION_FOUNDATION_CHECKPOINT = ACCEPTED`；这只确认本地基础架构和回归结果。
- `OKX_PRIVATE_POSITION_VERIFICATION = NOT_REVERIFIED / BLOCKED`；尚未使用 production 私有 GET 重新确认真实仓位事实。
- Bybit、Bitget 尚无独立 `PositionReader`；legacy `OkxPositionVerification` 仍保留但没有 production wiring。
- 最后已知 production revision 仍为 `25588b2`，Provider mutation 为 `0`；本条目不授权部署或真实资金执行。

## Unreleased - OKX canonical quantity boundary checkpoint

日期：2026-08-16

状态：已集成并收敛到唯一 `main` 工作线，未部署

### 已完成

- 将 `9f57c6177542f5eee587a5798bc781c61ae805d1` 以 fast-forward 方式集成到本地 `main`。
- 在 OKX Venue 边界完成 Canonical Base Quantity 与 Provider Contract Quantity 的双向转换，并对
  `ctVal`、`lotSz`、`minSz`、身份和 metadata 新鲜度执行 fail-closed 校验。
- 保持 Binance 已验证执行链不变；统一数量边界 checkpoint 为 `PASS / CLOSED`。
- OKX 定向测试 `98 passed`，全量 Server 测试 `1120 passed`，Server TypeScript 与 `npm run build` 通过。
- 完成仓库单线收敛：旧实验分支、额外 worktree、过期 PR 与历史 stash 不再作为开发入口。

### 当前边界

- 最后已知 production revision 仍为 `25588b2`；当前代码 checkpoint 为 `9f57c617`，仓库同步不等于部署。
- 当时 OKX Position Verification 仍为 `BLOCKED`；后续 foundation checkpoint 见上方条目。
- 旧 phase-11 实验提交已明确放弃，没有合入 `main`；Bybit/Bitget execution 仍不在当前范围。

## 0.4.0 - Binance Real Execution Closed Loop

日期：2026-08-15

状态：已实现并完成 production 真实资金闭环验证

### 已完成

- 建立套利分析 Draft/Preview、Final Confirm、Resume 与 authenticated ArbitrageInstance 正式产品入口。
- 完成 Binance USDT Spot 与 USDT Linear Perpetual generic instrument、Decimal quantity/price、Trading Rules、RiskGuard 和 provider order identity 链。
- 完成 ExecutionReference/ExecutionRecord 持久化、partial fill Decimal attribution、PENDING/UNKNOWN reconciliation、link recovery 和 restart recovery。
- 完成 Perpetual reduceOnly close、Spot LONG close、known-order cancel、cancel dispatch recovery 与 residual safety。
- Spot 成交归因改为按 Binance `myTrades` 的真实 symbol/orderId/fills/commission 读取，不使用账户总余额或 balance delta 猜实例归属。
- DOGEUSDT production 真实验证完成：Spot BUY 73、Perpetual SHORT 73、Perpetual close 73、Spot close 72；最终 Futures position=0、active orders=0、ArbitrageInstance=CLOSED、unresolved=0。

### 当前边界

- Binance 当前正式支持 USDT Spot LONG 与 USDT Linear Perpetual LONG/SHORT。
- OKX、Bybit、Bitget 仅完成真实 GET-only Account Read，尚无正式 ExecutionCapability。
- `CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK` 保持 `RESIDUAL`；不以复杂事务系统掩盖 HTTP/SQLite 物理非原子窗口。
- 新的部署和真实资金窗口继续需要独立明确授权。

## Unreleased - Production-only 部署收敛

日期：2026-07-31

状态：待发布

### 已完成

- Capital Test 授权时间规则改为自 `approvedAt` 起 24 小时有效，不再要求预填固定执行开始/结束时间；单次 Maximum execution duration、Permit expiry、过期重新确认及 fail-closed 状态保持不变。
- 删除独立真实测试部署环境的 Compose、Caddy、环境模板、运行入口、清理、备份、恢复与验证能力。
- 部署环境、WIF、KMS、受信操作、运行身份、拓扑和卷边界收敛为 production-only。
- 保留 Demo、Hyperliquid Testnet、普通单元/集成测试及生产发布、回滚、备份能力。
- 不改变生产 Compose project `xingheng`、WIF 路径 `/run/xingheng/gcp-wif` 或生产 KMS key。
- 本次变更不启用资金、凭证或交易开关。

## 0.3.0 - Hyperliquid 行情源切换

日期：2026-07-06

状态：已实现

### 已完成

- 从 BTC 单品种升级为 Hyperliquid 主 DEX 全量活跃 perpetual 自动目录。
- 排除已下架与 HIP-3 市场；下架历史配置软禁用并保留记录。
- 行情列表使用 `allMids`，BBO、成交与 K 线改为按需订阅和释放。
- 删除 Binance REST/WebSocket 行情 Adapter 与对应环境变量。
- 接入 Hyperliquid `candleSnapshot` 历史 K 线。
- 接入 Hyperliquid `bbo`、`trades`、`candle` WebSocket 订阅。
- 平台内部 `BTCUSDT` 固定映射到 Hyperliquid perpetual coin `BTC`。
- 增加 WebSocket 心跳、指数退避重连、行情 stale/disconnected 保护。
- 保持模拟交易边界，不接 Hyperliquid 真实下单、钱包或签名能力。

## 0.1.0 - Binance 行情 + 模拟交易 MVP

日期：2026-06-22

状态：准备封版

### 已完成

- 接入 Binance 加密行情，当前支持 `BTCUSDT / ETHUSDT / DOGEUSDT`。
- 支持 `1m / 5m / 15m / 1h` K 线。
- 支持 REST 历史 K 线查询。
- 支持 WebSocket 实时行情和实时 K 线推送。
- 前端交易终端已切换到 Binance 三个加密品种。
- 支持模拟账户资金展示。
- 支持市价开仓、持仓、平仓。
- 支持订单记录生成。
- 买入按 Ask，卖出按 Bid。
- 多单平仓按 Bid，空单平仓按 Ask。
- DOGEUSDT 图表价格精度调整为 6 位小数。

### 已知问题

- `/api/trading/orders` 默认查询和带 `userId=demo-user` 查询存在差异，V0.2 需要统一用户身份规则。
- `DOGEUSDT` 曾出现 `stale` 状态，V0.2 封版复测需要确认实时行情是否稳定。
- 当前账户、订单、持仓仍以轻量存储为主，服务重启后的数据保存能力需要在 V0.2 完善。

### 暂不包含

- 不接真实交易。
- 不处理真实资金。
- 不扩展 A 股、美股、ETF、基金、黄金、外汇。
- 不做复杂风控。
- 不做止盈止损。
- 不做强制平仓。

## 0.2.0 - 交易系统稳定化

日期：2026-06-22

状态：已完成本轮实现

### 已完成

- 不扩充资产，集中完善模拟交易系统。
- 使用 SQLite 持久化模拟账户、订单、持仓和资金调整日志。
- 后台支持模拟充值、扣减、重置余额。
- 统一账户、订单、持仓的用户身份规则。
- 完善订单记录、持仓记录、平仓记录和拒单记录。
- 新增后台资金流水查询。
- 账户页新增最近订单摘要。
- 服务重启后，模拟账户、订单、资金流水可恢复。

### 技术说明

- 数据库文件默认写入 `server/data/trading.sqlite`。
- SQLite 使用 Node 内置 `node:sqlite`，没有新增 npm 依赖。
- `server/data/trading.sqlite*` 已加入 `.gitignore`，运行数据不会提交到 GitHub。
- Node 当前会提示 `node:sqlite` 是 experimental，这是 Node 官方实验功能提示，不影响本地稳定演示。

### 已验证

- `npm run build` 通过。
- 后台给 `demo-user` 模拟充值 1000 后，资金流水出现记录。
- `demo-user` 买入 BTCUSDT 后，生成持仓和开仓订单。
- 平仓后，余额按盈亏变化，生成平仓订单。
- 非法手数会拒单，并生成带原因的拒单订单。
- 重启临时 API 服务后，账户、订单、资金流水仍可查询。

### 暂不包含

- 不新增资产。
- 不接真实交易。
- 不接真实资金。
- 不做复杂风控。
- 不做 UI 大改。
