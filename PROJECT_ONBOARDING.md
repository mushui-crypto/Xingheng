# PROJECT_ONBOARDING.md

# 星衡项目交接与当前状态说明

> 面向新团队成员、新 AI Agent 和新工作区的快速入口。
>
> 更新时间：2026-08-16

本文件提供项目入口和当前状态摘要，不替代需求、架构、变更日志或历史归档。发生冲突时，以用户最新明确要求以及更高优先级文档为准。

---

# 1. 先读什么

建议阅读顺序：

1. [`AGENTS.md`](./AGENTS.md)：AI 工作边界和任务分级。
2. [`AI_CONTEXT_PRIORITY.md`](./AI_CONTEXT_PRIORITY.md)：信息可信级别和读取规则。
3. [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)：当前项目事实。
4. [`ARCHITECTURE.md`](./ARCHITECTURE.md)：当前架构与交易安全边界。
5. `PROJECT_ONBOARDING.md`：快速交接摘要。
6. [`项目沟通规则.md`](./项目沟通规则.md)：协作、验收和文档同步规则。
7. 当前任务对应的产品、策略或运维文档。

历史背景通过 [`PROJECT_HISTORY.md`](./PROJECT_HISTORY.md) 按需查阅，不默认作为当前开发依据。

---

# 2. 项目定位

星衡是一个持续开发中的自动交易套利系统，不是从零建设的新项目。

当前核心方向：

- 保留内部 Demo 模拟交易能力；
- 推进 Hyperliquid Testnet 真实交易链路；
- 建设用户自有交易所账户的自动套利能力；
- 验证 RWA/XAUT、资金费率及多 venue 套利；
- 在真实运行前完成安全、恢复、审计和运维闭环。

平台不托管用户资金，不保存用户钱包私钥。交易权限允许交易，禁止提现。

---

# 3. 当前阶段

当前处于 Binance 正式真实执行闭环完成、OKX ExecutionCapability 已完成本地数量边界修复，且
Position Verification foundation 已验收、等待 production 私有仓位事实复核的阶段。

当前优先级：

1. 保证资金安全、交易正确性和已完成 Binance 闭环的稳定性。
2. 保持 Demo、Testnet 和 production 公共能力稳定。
3. 在已完成本地实现的基础上，独立验收 OKX 正式 ExecutionCapability，不把 Binance readiness 外推到其他 venue。
4. 保持权威成交归因、恢复、退出、撤单和实例生命周期可追踪、可恢复、可审计。
5. 继续保持 OKX production 私有仓位复核和真实 Provider mutation 阻断，直到取得独立批准。

Binance DOGEUSDT Spot LONG + USD-M Perpetual SHORT 已通过 production 真实资金开仓、对冲、退出和最终核账。后续部署、OKX 开发和任何新的真实资金窗口仍分别需要用户明确批准，不能互相替代。

---

# 4. 当前运行基线

## 正式环境

- 入口：`https://app.stellaxtrade.com`
- Compose project：`xingheng`
- 最后已知 production revision：`25588b2206ba4c39062f3e9d06ee315fed972ea6`。
- 当前主线代码 checkpoint：`030f50a4c8a841903097f511ed638c780275e3a8`，tree
  `45995916dcbe5f8cdc0e463d42df3bd97f390268`；本地与 GitHub 统一使用 `main`，未部署。
- 当前安全开关：`LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true`。
- 当前只保留这一套部署环境；开始发布前仍必须重新核对 fixed revision、数据库备份和运行健康。
- 当前只保留 `/Users/moss/Documents/StellaX` 一个代码工作区；仓库同步不会自动触发 production 部署。
- 策略邮件通知关闭；登录、安全和账户类邮件路径不受影响。

运行哈希只是归档时点基线。开始发布或运维任务前，必须重新核对当前 Git、manifest、镜像 digest 和运行环境，不能仅依赖本文件。

---

# 5. 核心模块

## Demo 交易

- 路径：`/app/demo`
- 作用：模拟成交、流程验证和产品演示。
- 边界：保持独立，不被真实交易逻辑破坏。

## Hyperliquid Testnet 交易

- 路径：`/app/trade`
- 用户钱包签名，平台不保存用户私钥。
- 当前保持 Testnet 边界；Mainnet 和真实资金动作必须另行确认。

## 钱包与账户

- 主资产：`USDT`
- 当前网络：`BSC_TESTNET`
- 注册后分配专属充值地址。
- 资金账户、模拟账户、交易账户和第三方钱包按已确认归属展示。

## 自动套利

- 路径：`/app/arbitrage`、`/app/my-arbitrage`
- 已有公开市场扫描、机会分析、正式 Draft/Preview、Final Confirm、Resume、ExecutionRecord、reconcile、close 和 known-order cancel。
- Binance 当前正式支持 USDT Spot LONG 与 USDT Linear Perpetual LONG/SHORT；generic canonical asset data 当前包含 BTC、ETH、DOGE、XAUT。
- DOGEUSDT 实例已完成 Spot BUY 73、Perp SHORT 73、Perp reduceOnly close 73、Spot close 72；最终 Futures position=0、active orders=0、instance=CLOSED、unresolved=0。
- Spot opening commission 使用 Binance `myTrades` 权威归因；实例残余按 Trading Rules fail-closed，不使用账户总余额或外部余额补足。
- OKX 已有本地正式 ExecutionCapability 与 canonical quantity boundary：`baseQuantity` 在 OKX Venue
  边界转换为 contract quantity；定向测试 `98/98`、全量 Server 测试 `1120/1120` 和 build 均通过。
- Position Verification foundation 已通过 `ACCEPTED` checkpoint：Binance/OKX perpetual reader 统一输出
  canonical `PositionSnapshot`，再由通用 verifier 进入套利验证服务。
- OKX production 私有 position GET 仍为 `NOT_REVERIFIED / BLOCKED`，真实 Provider mutation 保持 `0`；
  Bybit、Bitget 尚无独立 `PositionReader`，GET-only Account Read 通过不代表可执行。
- 生产执行开关和急停已恢复 fail-closed；新的真实资金窗口当前未授权。

## 策略 Paper

- 自动 Paper 与历史只读闭环已经部署并持续观察。
- 参数继续冻结，直到累计 60 天或 50 笔已完成交易任一先达到后人工复核。

---

# 6. 技术与部署概览

| 层级 | 当前技术 |
| --- | --- |
| 前端 | React 19、TypeScript 5.8、Vite 8、Tailwind CSS 3、React Router 7、Zustand、Lightweight Charts、Ethers 6 |
| 后端 | Node.js 22、TypeScript、Express 5、WebSocket、esbuild |
| 数据 | SQLite |
| 部署 | Docker、Docker Compose、Caddy、Cloudflare、Vultr Linux |
| 凭证安全 | Google Cloud KMS Envelope 加密、WIF、TOTP、受限挂载 |

SQLite 当前保存用户、账户、订单、持仓、流水和审计数据。除非出现明确需求或瓶颈，不迁移数据库，不主动引入 Redis、PostgreSQL、微服务或 Kubernetes。

---

# 7. 必须守住的边界

- 策略模块不直接操作交易所；交易执行必须经过风险检查和执行模块。
- 新增风险必须有上限；退出、减仓和急停不能被入场额度阻止。
- 不通过数量或最近成交猜测策略仓位归属，必须依赖权威状态和审计记录。
- 外部人工成交、不可交易小额、部分成交和恢复路径必须 fail-closed、可追踪、可恢复、可审计。
- 不保存明文凭证，不在日志输出敏感信息，不保存钱包私钥，不绕过权限控制。
- 生产发布批准不等于真实资金批准；未经明确授权不连接私有 provider、不下单、不执行资金动作。

---

# 8. 当前风险与待办

- 下一阶段是 OKX 正式 ExecutionCapability；完成前不得尝试 Binance + OKX Perpetual/Perpetual 真实执行。
- `CANCEL_TRANSPORT_PERSISTENCE_ATOMICITY_RISK = RESIDUAL`：Provider HTTP transport 与 SQLite dispatch 状态无法形成真正原子事务，继续保留 query-first、fail-closed 与人工接管边界。
- 第一腿完成、第二腿尚未人工确认期间存在短时裸露敞口，这是当前安全阶段的已知产品残余风险。
- 历史 `RESIDUAL` instance、外部余额和新实例 managed exposure 必须严格隔离，不能按 symbol、方向或账户总余额自动归属。
- Legacy XAUT/Capital Test 与 generic execution 仍共存，只能在后续独立 cleanup 阶段处理。
- Hyperliquid Testnet 的账户激活、Agent 授权和受控钱包签名 smoke 仍需用户配合安排。

具体任务开始前，应以 `PROJECT_CONTEXT.md`、当前代码、对应模块文档和用户最新指令重新确认这些状态。

---

# 9. 文档地图

| 需要了解 | 文档 |
| --- | --- |
| AI 工作规则 | [`AGENTS.md`](./AGENTS.md) |
| 当前项目事实 | [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) |
| 架构和安全边界 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| 协作与验收 | [`项目沟通规则.md`](./项目沟通规则.md) |
| 重要行为变化 | [`CHANGELOG.md`](./CHANGELOG.md) |
| 历史时间线 | [`PROJECT_HISTORY.md`](./PROJECT_HISTORY.md) |
| 月份与专题归档 | [`docs/history/README.md`](./docs/history/README.md) |
| 关键技术决策 | [`docs/decisions/DECISION_LOG.md`](./docs/decisions/DECISION_LOG.md) |

历史记录只解释项目如何走到当前状态。任何旧计划、旧限制或旧验收结论，都不能覆盖当前事实与用户最新明确要求。
