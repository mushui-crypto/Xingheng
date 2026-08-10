# PROJECT_ONBOARDING.md

# 星衡项目交接与当前状态说明

> 面向新团队成员、新 AI Agent 和新工作区的快速入口。
>
> 更新时间：2026-08-10

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
- 运行用户自有 Binance 账户的资金费率套利；
- 维护多用户交易所凭证隔离、风险、订单和对账闭环；
- 保持 Demo 与 Hyperliquid 既有能力不受 Binance Personal Trading 改造影响。

平台不托管用户资金，不保存用户钱包私钥。交易权限允许交易，禁止提现。

---

# 3. 当前阶段

当前处于 Binance Personal Trading Mode 真实运行与长期稳定性验证阶段。

当前优先级：

1. 保证资金安全和交易正确性。
2. 保持 Demo、Hyperliquid 和生产公共能力稳定。
3. 保持 Binance 策略、风险、订单、仓位和 reconciliation 一致。
4. 不恢复已删除的企业治理抽象，不扩大架构和风险上限。

真实交易默认关闭且 kill switch 默认开启。部署完成不自动授予开启真实交易、关闭急停或提高额度的权限。

---

# 4. 当前运行基线

## 正式环境

- 入口：`https://app.stellaxtrade.com`
- Compose project：`xingheng`
- 当前只保留这一套部署环境。
- 唯一代码主线：`main`，当前 commit 为 `70a2206`；最后确认的 production revision 为
  `5f95f27`，两者不得混为一谈。
- 策略邮件通知关闭；登录、安全和账户类邮件路径不受影响。

运行哈希只是归档时点基线。开始发布或运维任务前，必须重新核对当前 Git commit、deployment
version、镜像和运行环境，不能仅依赖本文件。

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
- 已有公开市场扫描、机会分析和用户端 Binance 自动套利操作界面。
- Binance 支持连接、行情、余额、资金费率、订单创建/撤销、成交查询、仓位同步和 reconciliation。
- 用户可配置多交易所 API；当前自动执行范围仅为 Binance，Hyperliquid 保持原有链路。
- `LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true`、`MAX_ORDER_USD=25`、
  `MAX_POSITION_USD=100` 是必须保持的默认值。

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
| 凭证安全 | UserExchangeCredential、AES-256-GCM envelope encryption、Google Cloud KMS、ADC / Workload Identity |

SQLite 当前保存用户、账户、订单、持仓、流水和审计数据。除非出现明确需求或瓶颈，不迁移数据库，不主动引入 Redis、PostgreSQL、微服务或 Kubernetes。

---

# 7. 必须守住的边界

- 策略模块不直接操作交易所；交易执行必须经过风险检查和执行模块。
- Binance 固定经过 `API -> Strategy -> RiskGuard -> OrderManager -> BinanceClient`。
- 新增风险必须有上限；退出、减仓和急停不能被入场额度阻止。
- 不通过数量或最近成交猜测策略仓位归属，必须依赖权威状态和审计记录。
- 外部人工成交、不可交易小额、部分成交和恢复路径必须 fail-closed、可追踪、可恢复、可审计。
- 不保存明文凭证，不在日志输出敏感信息，不保存钱包私钥，不绕过权限控制。
- 应用不得自动开启真实交易、关闭 kill switch 或提高风险额度。
- KMS IAM 保持最小权限；应用不得修改 KMS key policy。

---

# 8. 当前风险与待办

- Binance 最小真实闭环已经通过，但长期运行、异常恢复和 reconciliation 仍需持续观察。
- Phase 8B-0 生产只读复核因 `chrome-stellar` 控制通道超时未取得新的认证 GET 响应体，当前为
  `NOT_READY`；恢复浏览器连接并补齐白名单 GET 证据是当前主线的最小下一步。
- Phase 8B-1 one-shot Harness 双模式改动已进入代码主线 `70a2206`，但尚未取得 production
  revision 验证或真实资金执行授权。
- 当前生产凭证数量和用户实际启用状态属于运行数据，不能由代码部署状态推断。
- 自动套利只允许围绕当前个人多用户架构小范围演进，不恢复 Permit、Promotion、Release、
  Lifecycle、Trusted Build、Admin Approval 或 Recovery workflow。
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
