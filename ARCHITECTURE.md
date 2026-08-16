# ARCHITECTURE.md

# 项目架构说明

> 本文件描述当前已确认架构。
>
> 目的： - 帮助 AI 理解系统边界； - 防止未经确认的架构重构； -
> 保证项目持续演进。
>
> 注意：
>
> 当前架构不代表理论最优架构。
> 除非明确要求，不允许主动迁移、替换或重构。

------------------------------------------------------------------------

# 1. 项目定位

本项目是一个自动交易套利系统。

当前核心方向：

-   真实行情接入；
-   真实交易能力；
-   用户绑定自己的交易所 API Key；
-   当前主要套利方式为资金费率套利；
-   后续可扩展更多交易所和套利策略。

当前阶段：

真实交易能力稳定性验证阶段。

------------------------------------------------------------------------

# 2. 总体架构原则

## 2.1 最小复杂度原则

项目优先：

-   简洁；
-   可维护；
-   易排查；
-   易恢复。

禁止为了"大厂标准"主动引入：

-   微服务；
-   Kubernetes；
-   复杂中间件；
-   不必要基础设施。

------------------------------------------------------------------------

## 2.2 资产安全原则

当前采用：

用户自有交易所账户模式。

平台：

-   不托管用户资金；
-   不保存用户交易所 API 私钥明文；
-   不托管用户 Hyperliquid API Wallet 私钥。

------------------------------------------------------------------------

# 3. 前端架构

技术栈：

-   React 19
-   TypeScript 5.8
-   Vite 8
-   Tailwind CSS 3
-   原生 CSS
-   React Router 7
-   Zustand
-   Lightweight Charts
-   Lucide React
-   Ethers 6

职责：

负责：

-   用户交互；
-   数据展示；
-   钱包连接；
-   策略管理界面；
-   交易状态展示。

禁止：

前端承担：

-   核心交易判断；
-   资金逻辑；
-   安全校验。

------------------------------------------------------------------------

# 4. 后端架构

技术栈：

-   Node.js 22
-   TypeScript
-   Express 5
-   原生 WebSocket(ws)
-   esbuild

职责：

负责：

-   用户管理；
-   账户管理；
-   策略管理；
-   订单处理；
-   持仓管理；
-   流水记录；
-   审计记录；
-   交易接口。

------------------------------------------------------------------------

# 5. 数据存储架构

当前：

SQLite。

保存：

-   用户；
-   账户；
-   订单；
-   持仓；
-   流水；
-   审计数据。

当前未使用：

-   Redis；
-   PostgreSQL；
-   MySQL；
-   ORM。

禁止：

无需求情况下迁移数据库。

------------------------------------------------------------------------

# 6. 交易架构

## 6.1 Hyperliquid

使用：

-   Hyperliquid SDK
-   REST
-   WebSocket

应用：

-   Demo模拟交易；
-   Testnet真实交易流程。

------------------------------------------------------------------------

## 6.2 Binance / Bybit

用于：

-   RWA/XAUT 自动套利模块。

当前：

总急停开启。

原因：

真实交易风险控制。

------------------------------------------------------------------------

## 6.3 Canonical Position Verification

套利仓位验证遵循单向依赖：

    Provider Position
    ↓
    Venue PositionReader
    ↓
    Canonical PositionSnapshot
    ↓
    PositionVerification
    ↓
    ArbitragePositionVerificationService

约束：

-   交易所 symbol、side、contract quantity 和 contract size 只允许在 Venue reader 边界解释。
-   通用层只接收 canonical instrument、`LONG / SHORT / FLAT`、unsigned Decimal base quantity、
    tolerance 和账户身份。
-   snapshot 缺失、非法或 instrument identity 无法确认时必须 fail closed，不得猜测仓位。
-   账户总余额、外部持仓和历史实例不得作为当前套利实例 managed quantity。
-   Position Verification 是只读事实确认，不修改 Execution 模型、订单状态、数据库 schema 或 Provider 状态。
-   新增 venue 必须实现独立 `PositionReader` 后才能宣称接入统一仓位验证；GET-only Account Read
    不能替代该能力。

当前 Binance 与 OKX perpetual 已接入该基础链。Bybit、Bitget reader 和 legacy OKX verifier cleanup
不属于当前 checkpoint；production 私有验证仍需要独立授权和实时 GET 证据。

## 6.4 多交易所共存架构边界

### 目标

长期目标是让 Binance、OKX、Bybit、Bitget 共存，同时保持统一执行流程、交易所差异隔离，且不让
单一交易所的特殊字段污染公共模型。Binance 已验证的执行闭环作为基准；新交易所通过能力注册和
运行适配接入，不修改统一执行层的语义。

### 分层

```text
用户操作
    |
套利业务层
    |
统一执行流程层 (ExecutionIntent / ExecutionCoordinator)
    |
正式执行运行层 (FormalExecutionRuntime)
    |
交易所能力层 (ExecutionCapability)
    |
交易所适配层
    |
Provider/API
```

| 层级 | 职责 | 是否可知道交易所差异 |
| --- | --- | --- |
| 用户层 | 选择执行目标、开仓、平仓 | 否 |
| 套利业务层 | 管理套利实例与执行命令 | 否 |
| 统一执行层 | 控制入口、状态流转、记录和异常处理 | 否 |
| 正式执行运行层 | 负责 `execute`、`reconcile`、`cancel` 的运行编排 | 否 |
| 交易所能力层 | 暴露该 venue 已验证的交易能力 | 部分 |
| 交易所适配层 | 转换数量、订单字段、仓位和规则语义 | 是 |
| Provider 层 | 调用具体交易所 API | 是 |

### 公共模型边界

`ExecutionIntent` 只表达用户、账户、交易所、canonical instrument、方向、基础资产数量和执行
模式等统一语义。公共模型禁止出现 `sz`、张数、`contract quantity`、`lot`、`ctVal` 或任何
单一 venue 的原始字段。

数量转换必须沿单向边界进行：

```text
canonical base quantity
        |
        v
venue adapter / trading rules
        |
        v
provider quantity
```

例如同一 `100 DOGE` 意图可在 OKX 转换为 `sz=1000`，在 Binance 保持
`quantity=100`；转换结果不得回流污染 `ExecutionIntent` 或通用执行记录。

### 正式运行层与能力层

`ExecutionCoordinator` 通过 `ExecutionCapabilityRegistry` 和
`FormalExecutionRuntimeRegistry` 解析 venue 能力。每个 venue 可以有独立的
`FormalExecutionRuntime`，但运行层只接收统一意图、记录和结果，不负责 Provider 参数、API 字段或
数量单位换算。Provider 失败、能力缺失或类型不受支持时必须 fail closed。

### 订单身份

公共层保存统一的交易所订单引用，不在 `ExecutionRecord` 中增加
`BinanceOrderId`、`OKXOrdId`、`BybitOrderId`、`BitgetOrderId` 等横向字段。交易所特有引用由
venue reference value 保存：

| Venue | 交易所引用字段 |
| --- | --- |
| Binance | `orderId` |
| OKX | `ordId`、`clOrdId`、`instId` |
| Bybit | `orderId`、`orderLinkId` |
| Bitget | `orderId`、`clientOid` |

### 仓位与交易规则

仓位统一经过 `PositionReader -> Canonical PositionSnapshot -> PositionVerification`；业务层不得
直接读取 OKX `pos`、Binance `positionAmt` 或 Bybit `size`。交易规则同样由 venue adapter 读取并
转换为统一的最小数量、最小金额、精度和可交易状态；`ctVal`、`lotSz`、`contractSize` 等内部
字段只能在适配边界解释。

### 凭证与风控

每个 venue 使用独立 credential、client 和 session，不共享 API Key、客户端实例或会话。统一风险
层负责 kill switch、权限、数量和状态检查；如 `reduceOnly` 等 venue-specific 参数必须留在对应
adapter，不能改变公共风险模型的语义。平台允许交易权限，禁止提现权限。

### 四交易所接入矩阵

下表是长期边界下的能力拆分，不是部署或真实资金授权。每一项状态都必须以当前代码、独立测试和
实时 Provider 证据重新核对，不能由本表推断 execution permit。

| 模块 | Binance | OKX | Bybit | Bitget |
| --- | --- | --- | --- | --- |
| Provider/client | 已有 | 已有 | 已有 | 已有 |
| ExecutionCapability | 基准已验证 | 目标独立接入 | 目标独立接入 | 目标独立接入 |
| FormalExecutionRuntime | 已有 | 目标边界 | 目标边界 | 目标边界 |
| 数量边界 | 已验证 | canonical -> contract | 待独立验证 | 待独立验证 |
| PositionReader/verification | 已验证 | 基础链已接入，需实时复核 | 待独立接入 | 待独立接入 |
| 真实资金测试 | 已完成历史闭环 | 未授权 | 未授权 | 未授权 |

当前实现状态、部署 revision、Provider mutation 和授权状态仍以 `PROJECT_CONTEXT.md` 及独立验收
证据为准；本节只定义长期结构和不可越过的边界。

### 演进顺序与禁止事项

推荐顺序为：Binance 真实闭环 -> 抽取统一边界 -> OKX 接入并验证第二个平台 -> Bybit/Bitget
分别接入 -> 统一交易规则。当前不做四 venue 一次性重构、不提前建设企业级账户治理、不把 venue
字段放入公共模型，也不为了 OKX 修改已验证的 Binance 语义。

------------------------------------------------------------------------

# 7. 交易安全边界

## 用户 API Key 模式

用户绑定：

自己的交易所 API Key。

要求：

-   加密存储；
-   权限最小化；
-   不记录敏感信息。

------------------------------------------------------------------------

## 钱包安全

平台：

不保存用户 Hyperliquid API Wallet 私钥。

交易签名：

由用户钱包完成。

------------------------------------------------------------------------

# 8. 凭证与云安全

使用：

Google Cloud KMS。

用途：

-   加密交易所凭证；
-   加密备份数据。

使用：

Google Cloud WIF。

目的：

服务器不持有长期云私钥。

------------------------------------------------------------------------

# 9. 部署架构

当前：

单台 Vultr Linux。

容器：

-   Docker
-   Docker Compose

代理：

-   Caddy 2.10

作用：

-   静态前端；
-   HTTPS；
-   反向代理。

网络：

Cloudflare：

-   DNS；
-   代理。

------------------------------------------------------------------------

# 10. 环境架构

当前只保留正式部署环境：

## 正式环境

xingheng

生产运行身份、Compose project、域名、数据卷、WIF/KMS 与受信发布入口均固定，不接受调用方
切换部署身份。开发、单元测试、集成测试和 Demo/Testnet 业务能力不构成第二套部署环境。

------------------------------------------------------------------------

# 11. 测试架构

当前测试方式：

-   TypeScript 编译检查；
-   Vite 构建；
-   esbuild 构建；
-   Node.js 原生测试运行器；
-   TSX测试。

重点：

交易系统测试优先保证：

-   状态一致性；
-   异常恢复；
-   重复执行防护；
-   数据正确性。

------------------------------------------------------------------------

# 12. AI 修改边界

## 可以直接修改

-   小范围 Bug；
-   文案；
-   UI调整；
-   明确需求范围内代码。

## 需要确认

-   新业务流程；
-   新数据字段；
-   新接口；
-   模块调整。

## 必须架构审查

-   交易链路变化；
-   资金逻辑变化；
-   数据模型变化；
-   安全边界变化；
-   新基础设施。

------------------------------------------------------------------------

# 13. 当前架构演进方向

未来可能：

-   更多交易所；
-   更多套利方式；
-   DeFi；
-   钱包能力；
-   AI策略生成。

但是：

未来规划不等于当前实现。

任何扩展必须经过：

需求确认 → 技术评估 → 架构判断 → 开发。

------------------------------------------------------------------------

# 14. 架构原则总结

当前系统遵循：

    简单可靠

    ↓

    安全优先

    ↓

    最小修改

    ↓

    可维护演进

不要为了未来可能性牺牲当前稳定性。
