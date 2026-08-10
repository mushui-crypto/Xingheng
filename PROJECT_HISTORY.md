# PROJECT_HISTORY.md

# 星衡项目历史索引

> 本文件是项目历史导航，不是当前状态来源。
>
> 当前事实以 [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) 为准，架构边界以
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) 为准，快速交接入口见
> [`PROJECT_ONBOARDING.md`](./PROJECT_ONBOARDING.md)。

更新时间：2026-08-10

---

# 1. 月份归档

| 月份 | 主要内容 | 详细记录 |
| --- | --- | --- |
| 2026-08 | Binance Personal Trading Mode、多用户 KMS 凭证、最小资金闭环、部署与主线收敛 | [`docs/history/2026-08.md`](./docs/history/2026-08.md) |
| 2026-07 | Paper 策略闭环、Hyperliquid Testnet 交易、安全与生产部署收口、RWA/XAUT 套利、Mainnet 小额烟测 | [`docs/history/2026-07.md`](./docs/history/2026-07.md) |

2026 年 7 月归档由原《项目进度总览》完整迁移，保留当时的当前快照、阶段路线、治理约束、测试证据、发布记录和风险说明。

---

# 2. 2026 年 7 月里程碑摘要

- 7 月 15 日：策略自动 Paper、历史只读接口和页面形成闭环并进入生产观察。
- 7 月 17 日：多条 BTC/ETH 策略路线完成研究与淘汰，固定价差网格进入自动 Paper。
- 7 月 18 日至 19 日：`/app/trade` Hyperliquid Testnet 的 P0/P1、安全门禁、持仓与会话体验完成多轮验收和生产部署。
- 7 月 22 日至 23 日：公共套利看板、RWA/主流币市场聚合和多 venue 自动套利后端逐步完成验收。
- 7 月 24 日至 26 日：KMS/WIF、TOTP、独立持久化与灾备、单实例租约、容量治理、XAUT 通用 profile、接管及自动退出完成安全收口；Binance Mainnet 小额烟测完成后重新关闭执行门禁。
- 7 月 27 日：生产发布链路完成安全收口并运行 verified release。

摘要只用于定位历史。发布哈希、测试数量、风险结论和当时的待办以月份归档原文为准。

---

# 3. 2026 年 8 月里程碑摘要

- 8 月 10 日：最后确认的 Phase 8A production revision 为
  `5f95f27c96f0ebbdf6b0bc6a269d6a945623b11d`；Phase 8B-0 因 `chrome-stellar` 控制通道超时
  未取得新鲜认证 GET 证据，维持 `NOT_READY`、mutation `0`。Phase 8B-1 Harness 双模式改动
  已进入代码主线 `70a22062425115e5c7fa696ec28ffaa01335a6a5`，尚未作为 production revision 验证。
- 8 月 8 日：Binance 自动套利从企业治理链路裁剪为 Personal Trading Mode，保留真实交易、
  策略、风险、订单与对账闭环，Hyperliquid 未修改。
- 8 月 8 日：恢复按用户隔离的交易所凭证管理，以 GCP KMS envelope encryption 保存
  `UserExchangeCredential`，并恢复用户端 API 配置和“我的自动套利”界面。
- 8 月 8 日：完成 Binance 测试、构建、部署验证和用户确认的最小资金真实交易闭环，随后恢复
  fail-closed 默认值。
- 8 月 9 日：PR #26 合并到 `main`，本地与远端收敛为唯一 `main` 主线。

---

# 4. 专题历史资料

| 主题 | 文件 | 状态 |
| --- | --- | --- |
| 早期产品需求 | [`docs/history/PRD.md`](./docs/history/PRD.md) | 历史参考 |
| 早期产品说明 | [`docs/history/PRODUCT.md`](./docs/history/PRODUCT.md) | 历史参考 |
| 早期行情说明 | [`docs/history/MARKET_DATA.md`](./docs/history/MARKET_DATA.md) | 历史参考 |
| Hyperliquid 真实交易方案 | [`docs/history/HYPERLIQUID_REAL_TRADING.md`](./docs/history/HYPERLIQUID_REAL_TRADING.md) | 历史参考 |
| 策略研究归档 | [`docs/strategy/archive/README.md`](./docs/strategy/archive/README.md) | 历史参考 |
| 技术决策记录 | [`docs/decisions/DECISION_LOG.md`](./docs/decisions/DECISION_LOG.md) | 决策追溯 |

历史资料可能包含已失效的产品口径、路径、限制和技术方案，不得直接作为开发依据。

---

# 5. 文档职责

| 文件 | 记录内容 | 不记录内容 |
| --- | --- | --- |
| `PROJECT_CONTEXT.md` | 当前有效事实、环境和边界 | 完整开发流水 |
| `PROJECT_ONBOARDING.md` | 快速入口、当前摘要、阅读顺序 | 详细历史证据 |
| `ARCHITECTURE.md` | 当前架构和不可突破的边界 | 每次实现过程 |
| `CHANGELOG.md` | 影响系统行为的重要版本变化 | 临时调试和逐日进度 |
| `PROJECT_HISTORY.md` | 月份与专题历史索引 | 当前需求和验收标准 |
| `docs/history/YYYY-MM.md` | 当月详细记录和历史证据 | 跨月当前状态汇总 |
| `docs/decisions/DECISION_LOG.md` | 关键决策及原因 | 普通进度流水 |

---

# 6. 后续归档规则

1. 当前事实发生变化时，先更新 `PROJECT_CONTEXT.md`；影响快速交接时同步更新 `PROJECT_ONBOARDING.md`。
2. 影响系统行为的重要功能、安全或架构变化按规则写入 `CHANGELOG.md`。
3. 需要保留的详细进度按月写入 `docs/history/YYYY-MM.md`，月份内按日期倒序排列。
4. 新月份建立归档后，在本文件和 `docs/history/README.md` 增加入口。
5. 已归档内容原则上不改写；确需纠错时注明纠错日期和原因，不覆盖原始历史语境。
6. 已被新记录覆盖的旧限制、旧计划和旧验收结论不得继续作为当前执行依据。
