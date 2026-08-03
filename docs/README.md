# Documentation Index

本目录用于归类项目的辅助文档；根目录继续保留具有全局约束或最高上下文优先级的文档。

## Project-level sources

- [`PROJECT_CONTEXT.md`](../PROJECT_CONTEXT.md)：当前项目与生产事实。
- [`ARCHITECTURE.md`](../ARCHITECTURE.md)：架构约束。
- [`PROJECT_ONBOARDING.md`](../PROJECT_ONBOARDING.md)：项目上手说明。
- [`PROJECT_HISTORY.md`](../PROJECT_HISTORY.md)：历史索引。

## Classified documents

- [`decisions/`](./decisions/)：架构与产品决策记录。
- [`history/`](./history/)：已归档的历史背景与月度记录。
- [`strategy/`](./strategy/)：策略研究与策略交接。
- [`reports/2026-08/`](./reports/2026-08/)：2026 年 8 月的审查、实现和 Release 证据。

`reports/2026-08/RELEASE_ACTIVATION_REPORT.md` 是 artifact 构建前的历史中间记录；
`reports/2026-08/RELEASE_ARTIFACT_BUILD_REPORT.md` 是当前 `6efe18e` artifact 状态证据。
`reports/2026-08/REPOSITORY_MIGRATION_HANDOFF.md` 是可通过 Git 同步的脱敏迁移交接摘要。

## Local-only documents

以下目录被 Git 忽略，不进入 GitHub：

- `private/`：可能包含账户标识、审批记录、资金限制或其他私有 authorization evidence。
- `thread-handoffs/`：可能包含任务 ID、会话身份和跨账号交接信息。

迁移电脑时，这些目录必须通过单独的加密渠道复制，不得与 Git 提交或普通云盘分享混合。
