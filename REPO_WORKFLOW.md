# Repository Workflow

本文档定义当前仓库的命名关系、目录约定、分支约定和长期 worktree 用法，避免后续在 `StellarX` 与 `xingheng` 两套名字之间继续混淆。

## 1. 名称关系

当前本地目录关系如下：

- 工作区目录：`/Users/dq/Documents/StellarX`
- 实际 Git 仓库：`/Users/dq/Documents/StellarX/xingheng`
- 长期主线 worktree：`/Users/dq/Documents/StellarX/xingheng-main`

明确约定：

- `StellarX` 目前只是本地工作区容器目录，不是实际 Git 仓库名。
- `xingheng` 是当前实际代码仓库目录名。
- `Xing Heng / 星衡` 是当前代码、文档、前端文案、存储 key、包名所对应的实际产品名。

如果未来决定统一品牌命名，应整体重命名，而不是只改某一层：

- 仓库目录名
- `package.json`
- 前端文案
- localStorage key
- PRD / Changelog / 交付文档

在正式统一前，默认以 `xingheng` 作为工程主名，`StellarX` 只视为上层工作区名。

## 2. 当前 worktree 布局

### 主开发仓库

- 路径：`/Users/dq/Documents/StellarX/xingheng`
- 用途：功能开发、临时分支、实验性改动
- 当前典型分支：`codex/*`、`feature/*`、`fix/*`

### 长期主线 worktree

- 路径：`/Users/dq/Documents/StellarX/xingheng-main`
- 分支：`main`
- 用途：保持一个长期干净的主线工作树，用于：
  - 拉取最新 `main`
  - 对比功能分支
  - 做基线构建验证
  - 避免频繁切换当前开发目录分支

## 3. 分支约定

建议约定如下：

- `main`
  - 永远保持可发布或至少可验收状态
- `feature/<topic>`
  - 常规功能开发
- `fix/<topic>`
  - 问题修复
- `chore/<topic>`
  - 工程整理、文档、配置、依赖升级
- `codex/<topic>`
  - AI 协作阶段性任务分支；如需长期保留，应在合并前收敛到正式分支语义

当前仓库暂不建议继续引入更多长期分支，除非后面出现明确的：

- `release/*`
- `staging`
- `hotfix/*`

## 4. 推荐日常操作

### 更新主线

```bash
cd /Users/dq/Documents/StellarX/xingheng-main
git pull
```

### 在开发仓库查看当前工作

```bash
cd /Users/dq/Documents/StellarX/xingheng
git status
git branch --show-current
```

### 让功能分支跟进主线

```bash
cd /Users/dq/Documents/StellarX/xingheng
git fetch origin
git rebase main
```

如本地 `main` 未更新，先在 `xingheng-main` 中执行 `git pull`，再回到开发仓库执行：

```bash
git checkout main
git pull
git checkout <your-branch>
git rebase main
```

## 5. 新增 worktree 的规则

只有在以下情况才新增长期 worktree：

- 需要长期并行维护一个稳定分支
- 需要一个长期存在的验收/演示目录
- 需要避免频繁切换已有目录分支

建议命名：

- `xingheng-main`
- `xingheng-staging`
- `xingheng-release`

不建议使用含糊名称，例如：

- `test`
- `temp`
- `new`
- `origin`

## 6. 清理规则

定期清理以下内容：

- 已合并且不再使用的本地分支
- 已失效的远端跟踪分支
- 无用途的临时 worktree
- 构建产物和本地数据库文件（继续依赖 `.gitignore` 管理）

常用命令：

```bash
git fetch --prune
git branch --merged main
git worktree list
```

## 7. 当前结论

当前建议保持如下状态，不立即做破坏性重命名：

- 保留工作区目录 `StellarX`
- 保留仓库目录 `xingheng`
- 保留长期主线 worktree `xingheng-main`

原因很直接：

- 现有代码与文档都已经系统性使用 `xingheng / Xing Heng / 星衡`
- 现在只改目录名，不能真正解决品牌和工程命名一致性问题
- 若未来要统一到 `StellarX`，应作为一次完整重构来做，而不是零散局部改名
