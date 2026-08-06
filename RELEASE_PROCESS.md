# 标准 Release 流程

本文定义项目统一、可审计的 Release Workflow。它补充而不替代现有可信 Linux
候选构建、verified release、production acceptance、zero capital acceptance、
permit schema 和生产 operation lock。发生冲突时，现有生产安全门禁取更严格值；任何
Release PASS 都不授予 provider、交易、持仓、资金或 permit 权限。

## 1. Release 生命周期

```text
Development
→ Review
→ Commit
→ Revision Identity
→ Build Artifact
→ Release Manifest
→ Production Gate
→ Deploy
→ Verify
```

各阶段必须使用同一提交及其制品身份。Review 包含任务等级要求的 Code Review、Architecture
Review 和安全审查；未经所需审查不得进入 Commit。Agent 可以准备候选、运行只读检查和整理
证据，但不得自行创建或部署 production release。

## 2. 提交规范

所有提交必须精确指定文件，禁止使用 `git add .`、`git add -A` 或等价的全工作区暂存方式。
提交前必须执行：

```bash
git status
git diff --check
git diff --stat
```

推荐先运行 `./scripts/release-check.sh`。工作区中任何未提交或未跟踪文件都会阻断 release
candidate；不得通过清理、覆盖或夹带其他人的改动来绕过。

Commit message 格式：

```text
<type>(scope): description
```

`type` 只能是：`feat`、`fix`、`refactor`、`test`、`docs`、`chore`、`security`、
`release`。

## 3. Revision Identity

每个 release candidate 必须从精确、已提交的 Git 对象记录：

- commit SHA：`git rev-parse --verify HEAD^{commit}`
- git tree SHA：`git rev-parse --verify HEAD^{tree}`
- parent commit：`git rev-parse --verify HEAD^1`

合并提交仍记录第一父提交；如需审计其他父提交，必须作为补充证据列出。短 SHA、工作区
diff、tag 或分支名不能替代完整 revision identity。

## 4. Artifact Identity

正式制品只能由既有可信构建链生成。每次构建必须记录：

- image/artifact name
- 不可变 `sha256:<64 hex>` digest
- UTC build timestamp

项目的 canonical artifact manifest 仍是严格 schema 的 `release-manifest.json`，其中绑定完整
commit SHA 与 API、Web、strategy-tools 三个 image digest。构建时间由外层审计输出记录，禁止
向既有 JSON schema 增加未批准字段。

`RELEASE_<version>.md` 在 Deploy 后由 Verify 结果完成 production 身份归档；在它生成前，
canonical `release-manifest.json` 已在 Build Artifact 阶段生成并作为后续 Gate 与 Deploy 的唯一
制品输入。两者名称相近但职责不同，不得互相替代。

## 5. Release Manifest

每个正式版本生成根目录下的 `RELEASE_<version>.md`，文件名中的 version 只允许字母、数字、
点、下划线和连字符。它是对 canonical `release-manifest.json` 的审计摘要，不替代后者，必须包含：

- version
- commit sha
- tree sha
- artifact digest（逐项列出）
- environment
- test status
- security status
- approval status
- deployment revision / health / rollback point 的 Production Gate 结果

若任何 required evidence 缺失，manifest 状态只能是 `BLOCKED`，不得写成 production release。

## 6. Production Gate

production release 必须对同一个 revision 全部验证为 `PASS`：

- commit identity
- tree identity
- artifact digest
- deployment revision
- health check
- rollback point

此外 test、security、approval 必须明确为 `PASS`。任一项失败、未知、缺失或不一致时，整体状态
必须为 `BLOCKED`，不得标记为 production release。Production Gate 的批准只允许部署已验证制品；
它不等于 Mainnet、真实资金、provider access、kill switch 解除或 permit 批准。

部署仍必须通过既有受控入口：

```bash
./scripts/activate-release.sh deploy/release-manifest.json
```

不得让新包装脚本直接调用 Docker Compose、改写 `.env.production`、修改权限或更改生产配置。

## 7. Rollback

禁止通过重新构建回滚。回滚目标必须是 release lifecycle receipt 中已冻结且验证过的上一制品：

```text
deploy previous verified artifact
```

标准入口为：

```bash
./scripts/rollback-release.sh <RELEASE_OPERATION_ID>
```

该入口恢复并验证 receipt 绑定的 previous revision、image digest 与 environment identity。不得用
可覆盖 tag、当前源码重建或人工拼接镜像替代。

## 8. 标准脚本边界

- `release-check.sh`：只读检查 Git 状态、diff、未提交文件和敏感文件名。
- `release-build.sh`：默认只做候选预检；仅显式传入 `--build` 时调用既有可信制品构建入口。
- `release-verify.sh`：只读核对 commit/tree、manifest digest、镜像及可选的 production runtime。
- `release-promote.sh`：默认只读执行 Production Gate；仅显式传入 `--generate` 且全部 PASS 时创建
  `RELEASE_<version>.md`。

这些脚本不得执行资金动作、修改权限或修改生产配置。构建、部署和回滚分别保留各自既有的人工
批准与可信 operation boundary。
