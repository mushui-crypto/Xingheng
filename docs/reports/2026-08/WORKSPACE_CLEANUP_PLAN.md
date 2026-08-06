# Workspace Cleanup Plan

> Historical local-housekeeping plan. It is not Release, authorization, or
> production-gate evidence.

## Scope

本次仅清理可以明确证明为 macOS Finder 缓存、未被 Git 跟踪且未被项目引用的 `.DS_Store` 文件。

## Planned Deletions

| 文件 | 删除原因 | 是否被引用 |
| --- | --- | --- |
| `.DS_Store` | macOS Finder 目录元数据缓存；被 `.gitignore` 排除 | 否；项目全文检索无引用 |
| `ai-team/.DS_Store` | macOS Finder 目录元数据缓存；被 `.gitignore` 排除 | 否；项目全文检索无引用 |
| `ai-team/roles/.DS_Store` | macOS Finder 目录元数据缓存；被 `.gitignore` 排除 | 否；项目全文检索无引用 |
| `dist/.DS_Store` | macOS Finder 目录元数据缓存；所在目录被 `.gitignore` 排除 | 否；项目全文检索无引用 |
| `docs/.DS_Store` | macOS Finder 目录元数据缓存；被 `.gitignore` 排除 | 否；项目全文检索无引用 |
| `public/.DS_Store` | macOS Finder 目录元数据缓存；被 `.gitignore` 排除 | 否；项目全文检索无引用 |

## Protected Files

以下内容不在清理范围内，并保持原状：

- 所有 Git 跟踪文件；
- release、authorization、risk、review 与 SHA-256 记录；
- build、artifact 与 Gate 证据；
- 项目上下文与线程交接文件；
- Runtime Permit 实施报告及其他未跟踪正式文档；
- 无法明确证明为安全临时输出的任何文件。

## Decision

仅删除上表 6 个精确路径，不进行目录级、通配符或递归删除。
