# DECISION_LOG.md

记录重要技术决策。

格式：

## ADR-编号

日期：

问题：

候选方案：

最终决定：

原因：

影响：

## ADR-001

日期：2026-07-31

问题：独立真实测试部署环境增加了发布入口、凭证域、数据卷和恢复链路的维护成本，且当前不再继续使用。

候选方案：

1. 保留并修复独立测试部署。
2. 只停止测试虚拟机，继续保留源码能力。
3. 从源码和发布链路中移除独立测试部署，收敛为 production-only。

最终决定：采用方案 3。

原因：用户明确放弃独立测试部署；删除未使用的部署能力可减少发布和安全边界，同时保留 Demo、Hyperliquid Testnet 与普通自动化测试。

影响：删除测试 Compose、域名、环境模板、凭证域、卷、受信入口及相关运维脚本；生产发布、回滚、备份、WIF/KMS 与交易安全门禁保持不变。资金与交易开关不因该决策启用。

## ADR-002

日期：2026-08-17

问题：Binance、OKX、Bybit、Bitget 需要长期共存，但各 venue 的数量单位、订单身份、仓位字段和
交易规则不同；如果这些差异进入套利业务层或公共执行模型，后续扩展会污染已验证的 Binance 闭环。

候选方案：

1. 为每个交易所复制一套端到端业务流程。
2. 在公共 `ExecutionIntent`、`ExecutionRecord` 和仓位模型中增加各交易所专用字段。
3. 保持统一执行流程，在 `ExecutionCapability`、`FormalExecutionRuntime`、venue adapter 和
   Provider 边界隔离差异。

最终决定：采用方案 3。Binance 已验证执行闭环作为基准；OKX、Bybit、Bitget 通过独立能力和运行
适配接入，不能要求统一核心理解 `sz`、张数、`ctVal`、`lotSz`、`positionAmt` 或其他 venue 原始
字段。

原因：统一核心可以保持状态流转、审计、恢复和风险语义一致；venue adapter 可以独立处理数量、订单
引用、仓位和交易规则，避免特殊字段横向扩散。

影响：`ARCHITECTURE.md` 新增多交易所共存边界，明确 canonical base quantity、统一订单引用、
`PositionReader` 链、独立凭证和能力注册规则。该决策不代表任何 venue 已部署、已获 Provider mutation
授权或已获得真实资金测试许可；当前状态仍以 `PROJECT_CONTEXT.md` 和独立证据为准。
