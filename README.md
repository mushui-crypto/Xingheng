# 星衡项目

## 项目简介

星衡是一个自动交易套利平台。

项目目标：

-   提供自动化套利交易能力；
-   支持用户绑定自己的交易所 API Key；
-   构建可扩展的多交易所、多策略套利基础设施。

当前核心方向：

-   资金费率套利；
-   多用户 Binance Personal Trading；
-   后续扩展更多交易所、DeFi、钱包能力以及 AI 策略能力。

------------------------------------------------------------------------

# 当前阶段

项目不是从零开发阶段。

当前状态：

> Binance Personal Trading Mode 已合并并部署，正在进行真实运行与长期稳定性验证。

当前重点：

-   保持已有交易能力稳定；
-   保持策略、风险、订单、仓位和 reconciliation 闭环稳定；
-   保持多用户凭证隔离和 GCP KMS envelope encryption；
-   保持真实交易默认关闭、kill switch 默认开启和既定风险上限。

------------------------------------------------------------------------

# 技术架构概览

## 前端

技术：

-   React 19
-   TypeScript 5.8
-   Vite 8
-   Tailwind CSS 3
-   React Router 7
-   Zustand
-   Lightweight Charts
-   Ethers 6

## 后端

技术：

-   Node.js 22
-   TypeScript
-   Express 5
-   WebSocket
-   esbuild

## 数据存储

当前：

-   SQLite

存储：

-   用户
-   账户
-   订单
-   持仓
-   流水
-   审计数据

------------------------------------------------------------------------

# 部署环境

当前：

-   Docker
-   Docker Compose
-   Caddy
-   Cloudflare
-   Vultr Linux

正式部署环境：

    xingheng

要求：

-   生产数据卷固定；
-   使用普通 ADC / Workload Identity 访问 KMS；
-   Git commit / deployment version 标识运行 revision。

------------------------------------------------------------------------

# 项目文档入口

新成员或新 AI Agent 建议按照以下顺序阅读：

    AGENTS.md

    ↓

    AI_CONTEXT_PRIORITY.md

    ↓

    PROJECT_CONTEXT.md

    ↓

    ARCHITECTURE.md

    ↓

    PROJECT_ONBOARDING.md

    ↓

    项目沟通规则.md

历史信息按需从 PROJECT_HISTORY.md 进入，不作为默认当前上下文。

文档职责：

  文件                     用途
  ------------------------ -----------------
  AGENTS.md                AI 工作规则
  AI_CONTEXT_PRIORITY.md   AI 信息读取规则
  PROJECT_CONTEXT.md       当前项目事实
  ARCHITECTURE.md          架构边界
  PROJECT_ONBOARDING.md    项目快速理解
  PROJECT_HISTORY.md       项目历史索引
  项目沟通规则.md          协作流程

------------------------------------------------------------------------

# AI 开发原则

本项目为已有项目。

开发时必须遵守：

1.  不按新项目重新设计。
2.  不主动重构已有架构。
3.  不为了最佳实践增加复杂度。
4.  不将历史方案视为当前需求。
5.  不将未来规划视为当前任务。
6.  涉及交易、安全、资金逻辑时优先确认。

------------------------------------------------------------------------

# 目录说明

    /
    ├── AGENTS.md
    ├── AI_CONTEXT_PRIORITY.md
    ├── PROJECT_CONTEXT.md
    ├── ARCHITECTURE.md
    ├── PROJECT_ONBOARDING.md
    ├── PROJECT_HISTORY.md
    ├── 项目沟通规则.md
    │
    ├── ai-team/
    │   └── roles/
    │
    ├── docs/
    │   ├── decisions/
    │   └── history/
    │
    └── src/

------------------------------------------------------------------------

# 注意事项

README 仅用于项目入口说明。

当前事实以：

    PROJECT_CONTEXT.md

为准。

架构设计以：

    ARCHITECTURE.md

为准。

历史信息请查看：

    PROJECT_HISTORY.md

------------------------------------------------------------------------

# 一句话介绍

星衡是一个面向真实交易场景的自动交易套利系统，当前主线是个人多用户 Binance 自动套利与长期稳定运行。
