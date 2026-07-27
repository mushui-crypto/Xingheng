# PROJECT_ONBOARDING.md

# 星衡项目交接与当前状态说明

> 面向新团队成员、新 AI Agent 和新工作区的快速入口。
>
> 更新时间：2026-07-27

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

当前处于真实交易能力建设与稳定性验证阶段。

当前优先级：

1. 保证资金安全和交易正确性。
2. 保持 Demo、Testnet 和生产公共能力稳定。
3. 完成自动套利退出、恢复和仓位归属闭环。
4. 在既有接口与行为不变的前提下渐进治理自动套利模块。

自动套利各阶段可以开发和离线验收，但阶段性生产发布已暂停。统一生产发布和 Mainnet 真实资金窗口分别需要用户明确批准，二者不能互相替代。

---

# 4. 当前运行基线

## 正式环境

- 入口：`https://app.stellaxtrade.com`
- Compose project：`xingheng`
- 截至 2026-07-27 的 verified release：`45cbcea5a191b2b866131efcfecc8776daad16c8`
- 策略邮件通知关闭；登录、安全和账户类邮件路径不受影响。

## 真实测试环境

- 入口：`https://test.stellaxtrade.com`
- Compose project：`xingheng-real-test`
- 与正式环境保持域名、cookie、网络、数据卷、WIF/KMS 和运行身份隔离。
- 截至 2026-07-27 运行同一 verified release，服务端总急停保持开启。

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
- 已有公开市场扫描、机会分析、RWA/主流币组合和自动执行框架。
- XAUT 是当前唯一启用的执行 profile；BTC、ETH、SOL 仍为保留配置，不得因公开行情可见而进入真实执行。
- 生产执行开关和急停保持 fail-closed，Mainnet 真实资金窗口当前未授权。
- 真实 Binance/Bybit adapter 的活动连续性仍返回 `incomplete` 时，自动退出必须拒绝执行并转人工核对。

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

- 自动套利自动退出的活动连续性证明仍未完成，生产环境继续拒绝自动退出。
- “管理账户内全部 XAUT”的授权边界仍待最终确认，不能把旧讨论当作已冻结产品规则。
- 自动套利核心服务职责集中，后续只允许行为不变的渐进治理，不在当前安全收口期间大规模重写。
- Hyperliquid Testnet 的账户激活、Agent 授权和受控钱包签名 smoke 仍需用户配合安排。
- 双环境部署后的私有 provider 身份 preflight、授权、下单和资金动作均未因环境上线而自动获批。

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
