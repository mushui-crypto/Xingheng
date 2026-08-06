# Repository Migration Handoff

- updated: `2026-08-04`
- scope: Git 可同步的非敏感项目进度
- branch: `codex/production-main`

本交接摘要用于在另一台电脑恢复仓库状态。它不包含密钥、凭证、私人账号信息、任务 ID、主机
连接信息或私有 authorization 内容。

## Git progress

当前已完成但尚未推送到远端的本地提交：

| Commit | Tree | 内容 |
| --- | --- | --- |
| `e2582b8f8fb8d09e8616c560448d9124a862c492` | `b43ded99ae1efa048ebb7f63faae1000f0fbfa04` | 归类公开 Release/审查证据，更新项目上下文和本机私有文件忽略边界 |
| `0d1ff58c4e8a01db0adbdba8f4690f9b3217ba14` | `00576f6f20aed53542c39427c12f9fe691aa0cdf` | 暴露 Capital Test Gate readiness 状态，补充测试和独立审查证据 |

迁移前应将这些提交推送到目标远端分支，或通过受控 Git bundle 迁移。另一台电脑仅执行普通
Git clone/fetch 不能取得尚未 push 的本地提交。

## Release candidate progress

- revision：`6efe18eb943b8a57750eeeb06700f101bd676414`
- tree：`4963acf254d3fa6f9483aa21646befef9ded83f3`
- historical/current production revision：
  `1ad3579c8f7b1c0f9b9982701db14871ec9d672e`
- trusted Linux build host 人工范围确认：`PASS`
- trusted candidate：`PASS`
- artifact build：`PASS`
- manifest generation：`PASS`
- release verify：`PASS`
- production preflight：`NOT_RUN_PENDING_APPROVAL`
- canonical promotion：`NOT_RUN_PENDING_APPROVAL`
- standard activation：`NOT_RUN_PENDING_APPROVAL`
- deployment revision：`NOT_DEPLOYED`

### Artifact identity

| Evidence | SHA-256 |
| --- | --- |
| `code.tar` | `0e7153e70d384c37bbd318ff59b093fdbfb291678e8588bc188f3bba821f974d` |
| `candidate-build-receipt.json` | `f6b97b2d7cc28590ab6598fcd945ce9a5bf9d1e56fc29985a37ac3c8fb8f71a7` |
| `release-manifest.json` | `ceab5314a0e37e4c7886433a2a91c0cb352bf79f956dc167345d5e5f498b142a` |
| `RELEASE_SHA256SUMS` | `3e5aa884f66e3322c93b339c11737ece0ced9b0d66e1736f2ae07a7b0ff78dac` |

完整 artifact 证据见
[`RELEASE_ARTIFACT_BUILD_REPORT.md`](./RELEASE_ARTIFACT_BUILD_REPORT.md)。

## Verification

- Runtime Permit supplied suite：`127/127 PASS`
- Stage Five readiness suite：`21/21 PASS`
- TypeScript checks：`PASS`
- release check、source identity、candidate install、artifact build、manifest/checksums 和 release
  verify：`PASS`

构建期间的既有依赖审计警告仍需由既有 security/production gate 处理；本交接不将其标记为已接受
风险。

## Uncommitted review boundary

以下内容仍留在工作区，未纳入本交接提交：

- Release Workflow 治理草案：`AGENTS.md`、`项目沟通规则.md`、`RELEASE_PROCESS.md`。
- Release 脚本草案：`scripts/release-check.sh`、`scripts/release-build.sh`、
  `scripts/release-verify.sh`、`scripts/release-promote.sh`。

这些脚本在 trusted production launcher/lock boundary 的整合审查完成前，不应视为可用的标准
production release 流程。后续必须逐文件审查和暂存，禁止使用 `git add .`。

## Local encrypted migration boundary

以下内容不进入 Git，必须通过独立加密渠道迁移：

- `.env` 及其他实际环境变量文件；
- 私钥、API key、token、云凭证和主机访问材料；
- `docs/private/`；
- `docs/thread-handoffs/`。

`.env.example` 等不含真实值的模板可以保留在 Git。迁移后应在新电脑本地验证文件权限和忽略规则，
不得把敏感值写入日志、文档或提交历史。

## Authorization boundary

- Provider Access：`NOT_AUTHORIZED`
- Real Funds：`NOT_AUTHORIZED`
- Execution：`BLOCKED_PENDING_AUTHORIZATION`
- real-funds Permit generated：`NO`
- Provider connection attempted：`NO`
- trade attempted：`NO`
- approval gate bypassed：`NO`

## Remaining blockers

1. 公开提交尚未 push，另一台电脑暂时无法仅通过远端取得。
2. Release Workflow 草案及脚本仍需完成 trusted launcher/lock boundary 审查。
3. `6efe18e` 的 production preflight、promotion、activation 和 deployment verification 均等待独立
   production approval。
4. Provider、真实资金与 execution 继续保持未授权状态。
