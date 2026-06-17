# 星衡 TradeSim Pro 模拟交易平台 PRD

版本：v0.1.0  
整理日期：2026-06-16  
文档范围：基于当前代码已实现能力整理，不包含未落地的真实入金、出金、撮合、清算、KYC、风控后台等生产交易所能力。

## 1. 产品概述

星衡 TradeSim Pro 是一个“外部行情源 + 内部模拟交易 + 白标后台”的交易模拟 MVP。系统面向希望演示外汇、贵金属、加密货币等 CFD/保证金类交易流程的运营方，提供用户注册登录、行情查看、K 线图、模拟市价单、持仓/订单展示，以及后台用户、品种、资金和白标配置管理。

当前交易均为虚拟成交，不涉及真实资金交易。行情可接入 TraderMade WebSocket；未配置真实行情 Key 时，系统自动使用本地 Mock 行情。

## 2. 产品目标

1. 提供可演示的用户端模拟交易闭环：注册、登录、看行情、下市价单、看持仓、平仓、看订单。
2. 提供后台基础运营能力：用户启停、交易品种配置、行情状态查看、模拟账户资金调整、白标信息配置。
3. 建立行情标准化与 K 线聚合能力，为后续接入真实行情、多品种交易、风控和报表打基础。

## 3. 用户角色

| 角色 | 说明 | 当前权限 |
| --- | --- | --- |
| 游客 | 未登录访问者 | 可访问用户登录、注册页；其他用户页会跳转登录 |
| 注册用户 | 模拟交易用户 | 查看首页、行情、交易终端、我的账户；提交模拟市价单和平仓 |
| 管理员 | 后台操作人员 | 固定账号登录后台，管理用户、品种、交易查询、系统配置 |

管理员默认账号：

| 字段 | 默认值 |
| --- | --- |
| 邮箱 | `admin@example.com` |
| 密码 | `admin123` |

## 4. 信息架构

### 4.1 用户端路由

| 路由 | 页面 | 功能 |
| --- | --- | --- |
| `/login` | 用户登录 | 邮箱密码登录；禁用用户无法登录 |
| `/register` | 用户注册 | 邮箱、昵称、密码注册；校验邮箱、密码长度、重复邮箱 |
| `/app/dashboard` | 首页 | 展示欢迎语、风险提示、账户入口、默认币种等概览 |
| `/app/markets` | 行情 | 展示用户端可见品种的 Bid/Ask/Last、涨跌幅、状态、更新时间 |
| `/app/trading` | 交易终端 | K 线图、实时 ticker、模拟市价单、持仓、订单记录 |
| `/app/account` | 我的账户 | 用户资料、资金指标、持仓/订单数量、账户状态 |

### 4.2 后台路由

| 路由 | 页面 | 功能 |
| --- | --- | --- |
| `/admin/login` | 后台登录 | 固定管理员账号登录 |
| `/admin/dashboard` | 数据概览 | 注册用户、启用/禁用用户、默认币种、白标信息 |
| `/admin/users` | 用户管理 | 查看注册用户；启用/禁用用户 |
| `/admin/symbols` | 品种管理 | 新增、编辑、停用/启用、软删除品种；配置交易规格 |
| `/admin/trading` | 交易查询 | 查看模拟账户、持仓、订单、行情状态；调整虚拟资金 |
| `/admin/settings` | 系统配置 | 配置平台名称、Logo 文案、主题色、默认币种、风险提示 |

## 5. 已有功能说明

### 5.1 账号与权限

#### 用户注册

用户填写邮箱、昵称、密码、确认密码后创建账号。

规则：

| 规则项 | 说明 |
| --- | --- |
| 邮箱格式 | 必须为有效邮箱 |
| 密码长度 | 至少 6 位 |
| 确认密码 | 必须与密码一致 |
| 邮箱唯一性 | 同一邮箱不可重复注册 |
| 默认状态 | 注册后状态为 `active` |
| 用户 ID | 格式为 `USR-{timestamp base36}` |

#### 用户登录

用户使用邮箱和密码登录。

规则：

| 场景 | 结果 |
| --- | --- |
| 邮箱不存在或密码错误 | 返回“邮箱或密码不正确。” |
| 用户状态为 `disabled` | 返回“账号已禁用，请联系管理员。” |
| 登录成功 | 进入 `/app/dashboard` |

#### 后台登录

后台使用固定管理员账号密码。当前未接入服务端鉴权、RBAC 或管理员账号体系。

### 5.2 用户端首页

首页展示：

| 模块 | 内容 |
| --- | --- |
| 欢迎区 | 当前用户昵称/邮箱、平台名称、风险提示 |
| 模拟账户权益 | 展示默认文案中的 `100,000.00`，当前非实时接口值 |
| 账户状态 | Active |
| 当前币种 | 后台系统配置中的默认币种 |
| 模拟账户入口 | 跳转我的账户 |

### 5.3 行情模块

用户端行情页展示后台配置为 `isVisible=true` 的品种。

展示字段：

| 字段 | 说明 |
| --- | --- |
| 品种代码 | 如 XAUUSD、EURUSD、BTCUSDT |
| 展示名称 | 后台配置的 displayName |
| Bid | 标准化买价 |
| Ask | 标准化卖价 |
| Last | 最新价 |
| Change % | 与前一次报价比较后的变化百分比 |
| 状态 | normal、stale、error 等本地报价状态 |
| 更新时间 | 本地更新时间 |
| 操作 | 进入交易终端并带入品种 |

当前默认品种：

| Symbol | 名称 | 分类 | Digits | Spread | 杠杆 | 合约单位 | 手数范围 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| XAUUSD | Gold | metal | 2 | 0.3 | 100 | 100 | 0.01-10 / 0.01 |
| EURUSD | Euro / US Dollar | forex | 5 | 0.00012 | 100 | 100000 | 0.01-20 / 0.01 |
| BTCUSDT | Bitcoin / USDT | crypto | 2 | 10 | 20 | 1 | 0.01-5 / 0.01 |

### 5.4 交易终端

交易终端由 K 线图、实时行情、下单面板、持仓表和订单表组成。

#### K 线图

| 能力 | 说明 |
| --- | --- |
| 图表库 | `lightweight-charts` |
| 支持周期 | `1m`、`5m`、`15m`、`1h` |
| 初始数据 | 从 `/api/market/candles` 拉取 |
| 实时更新 | 通过 WebSocket 订阅 candle 推送 |
| 无历史数据 | 服务端会生成 seed 历史 K 线 |

#### 最新报价

展示 Last、Spread、Bid、Ask、来源、更新时间和行情连接状态。

行情状态：

| 状态 | 用户展示 | 交易影响 |
| --- | --- | --- |
| `connected` | 实时行情 | 允许下单 |
| `stale` | 行情延迟 | 禁止市价成交 |
| `disconnected` | 行情连接中断 | 禁止市价成交 |

#### 模拟市价单

当前仅支持市价单：

| 操作 | 成交价格 |
| --- | --- |
| 买入 | 按当前 Ask 开多 |
| 卖出 | 按当前 Bid 开空 |
| 多单平仓 | 按当前 Bid 平仓 |
| 空单平仓 | 按当前 Ask 平仓 |

下单校验：

| 校验项 | 规则 |
| --- | --- |
| 品种配置 | 未配置品种拒单 |
| 交易状态 | `disabled` 禁止开仓和平仓；`close_only` 禁止新开仓 |
| 行情存在性 | 无 tick 拒单 |
| 行情状态 | 非 `connected` 拒单 |
| Bid/Ask | 必须为正数且 Ask > Bid |
| 行情时效 | 超过 10 秒拒单 |
| 点差异常 | 当前 spread 大于配置 spread 的 10 倍拒单 |
| 手数范围 | 必须在 `minLot` 与 `maxLot` 之间 |
| 手数步进 | 必须符合 `lotStep` |
| 保证金 | 可用保证金不足拒单 |

资金与盈亏计算：

| 指标 | 公式 |
| --- | --- |
| 保证金 | `price * volume * contractSize / leverage` |
| 多单浮盈亏 | `(markBid - entryPrice) * volume * contractSize` |
| 空单浮盈亏 | `(entryPrice - markAsk) * volume * contractSize` |
| Equity | `Balance + Floating P/L` |
| Used Margin | 所有持仓保证金之和 |
| Free Margin | `Equity - Used Margin` |

### 5.5 我的账户

展示：

| 模块 | 字段 |
| --- | --- |
| 用户资料 | 用户 ID、邮箱、昵称、状态、注册时间 |
| 资金指标 | Balance、Equity、Used Margin、Free Margin |
| 模拟账户状态 | 账户 ID、浮动盈亏、当前持仓数、订单记录数、币种、创建时间 |

交易账户当前由用户首次访问交易/账户接口时自动创建。

### 5.6 后台数据概览

展示注册用户、启用用户、禁用用户、默认币种，以及当前白标平台名称、Logo 文案、风险提示。

### 5.7 后台用户管理

能力：

| 功能 | 说明 |
| --- | --- |
| 用户列表 | 展示用户 ID、邮箱、昵称、状态、注册时间 |
| 禁用用户 | 将 `active` 用户置为 `disabled` |
| 启用用户 | 将 `disabled` 用户置为 `active` |

影响：

| 用户状态 | 登录影响 |
| --- | --- |
| active | 可登录 |
| disabled | 登录时被拦截 |

### 5.8 后台品种管理

能力：

| 功能 | 说明 |
| --- | --- |
| 新增品种 | 配置 symbol、displayName、apiSymbol、分类、报价位数、点差、杠杆、合约单位、手数规则、交易状态、可见性 |
| 编辑品种 | 修改已有品种配置 |
| 停用/启用 | 快速切换 `enabled` / `disabled` |
| 删除品种 | 当前为软删除：设置 `isVisible=false` 且 `tradeStatus=disabled` |
| 恢复默认品种 | 重置为默认 XAUUSD、EURUSD、BTCUSDT |
| 刷新行情 | 拉取并刷新前端本地报价 |

交易状态：

| 状态 | 含义 |
| --- | --- |
| `enabled` | 可开仓、可平仓 |
| `close_only` | 仅允许平仓，不允许新开仓 |
| `disabled` | 禁止开仓和平仓，用户端交易不可用 |

### 5.9 后台交易查询

能力：

| 模块 | 功能 |
| --- | --- |
| 指标卡片 | 模拟账户数、当前持仓数、订单记录数、行情品种数 |
| 资金调整 | 按用户 ID 增加、扣减或重置虚拟 Balance |
| 模拟账户 | 查看每个用户的 Balance、Equity、Used Margin、Free Margin、Floating P/L |
| 行情状态 | 查看每个品种的 API Symbol、连接状态、Bid/Ask、来源、行情时间 |
| 最近订单 | 查看最近 30 条订单 |

资金调整规则：

| 类型 | 规则 |
| --- | --- |
| deposit | Balance 增加指定金额 |
| withdraw | Balance 扣减指定金额，最低为 0 |
| reset | Balance 重置为指定金额 |
| 金额校验 | 金额不得小于 0 |

### 5.10 后台系统配置

配置项：

| 字段 | 默认值 | 影响范围 |
| --- | --- | --- |
| 平台名称 | TradeSim Pro | 用户端、后台品牌展示 |
| Logo 文案 | TSP | 用户端、后台 Logo |
| 主题色 | `#00C896` | 主要按钮、Logo、图表涨色 |
| 默认币种 | USD | 账户展示、账户创建 |
| 风险提示文案 | 模拟交易风险提示 | 登录、首页等文案 |

## 6. 行情与交易服务

### 6.1 行情源

| 模式 | 触发条件 | 说明 |
| --- | --- | --- |
| TraderMade | 配置 `TRADERMADE_API_KEY` | 使用 `wss://stream.tradermade.com/feedAdv` 订阅行情 |
| Mock | 未配置 `TRADERMADE_API_KEY` | 使用本地模拟行情，便于开发演示 |

TraderMade 接入流程：

1. 建立 WebSocket 连接。
2. 发送 login 消息：`{"action":"login","key":"...","fmt":"JSON"}`。
3. 登录成功后订阅配置品种的 `apiSymbol`。
4. 外部 tick 标准化为内部 `MarketTick`。

### 6.2 K 线聚合

系统根据实时 tick 聚合 `1m`、`5m`、`15m`、`1h` K 线。

存储策略：

| 数据 | 优先存储 | 降级存储 |
| --- | --- | --- |
| 当前未完成 K 线 | Redis，配置 `REDIS_URL` | `server/data/candles.json` |
| 已完成历史 K 线 | PostgreSQL，配置 `DATABASE_URL` | `server/data/candles.json` |

PostgreSQL 表：

```sql
create table if not exists candles (
  symbol text not null,
  interval text not null,
  time integer not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume double precision not null,
  primary key(symbol, interval, time)
);
```

## 7. 接口清单

### 7.1 REST API

基础地址：`http://127.0.0.1:8787`

#### 健康检查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 返回 API 状态和行情源 |

响应示例：

```json
{
  "ok": true,
  "source": "mock"
}
```

#### 行情接口

| 方法 | 路径 | 参数/Body | 说明 |
| --- | --- | --- | --- |
| GET | `/api/market/symbols` | - | 获取服务端当前品种配置与行情状态 |
| PUT | `/api/market/symbols/config` | `{ "symbols": MarketSymbol[] }` | 同步前端品种配置到服务端行情服务 |
| GET | `/api/market/ticker` | query: `symbol`，默认 XAUUSD | 获取单品种最新 ticker |
| GET | `/api/market/candles` | query: `symbol`、`interval`、`limit` | 获取 K 线，`limit` 最大 1000 |

`GET /api/market/ticker?symbol=XAUUSD` 响应：

```json
{
  "symbol": "XAUUSD",
  "status": "connected",
  "bid": 2320.1,
  "ask": 2320.4,
  "last": 2320.25,
  "spread": 0.3,
  "source": "mock",
  "timestamp": 1760000000000
}
```

`GET /api/market/candles?symbol=XAUUSD&interval=1m&limit=500` 响应：

```json
[
  {
    "symbol": "XAUUSD",
    "interval": "1m",
    "time": 1760000000,
    "open": 2320.1,
    "high": 2321.2,
    "low": 2319.8,
    "close": 2320.6,
    "volume": 42
  }
]
```

#### 用户交易接口

用户身份通过请求头 `x-user-id` 传入；未传时默认 `demo-user`。

| 方法 | 路径 | 参数/Body | 说明 |
| --- | --- | --- | --- |
| GET | `/api/trading/account` | header: `x-user-id`；query: `currency` | 获取或创建模拟交易账户 |
| GET | `/api/trading/positions` | header: `x-user-id` | 获取当前用户持仓 |
| GET | `/api/trading/orders` | header: `x-user-id` | 获取当前用户订单 |
| POST | `/api/trading/order` | `{ "symbol": "XAUUSD", "side": "buy", "volume": 0.01 }` | 提交模拟市价单 |
| POST | `/api/trading/positions/:id/close` | header: `x-user-id` | 平指定持仓 |

`TradingAccount` 响应结构：

```json
{
  "id": "ACC-USR-XXX",
  "userId": "USR-XXX",
  "currency": "USD",
  "balance": 10000,
  "equity": 10000,
  "usedMargin": 0,
  "freeMargin": 10000,
  "floatingPnl": 0,
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000
}
```

`PositionView` 响应结构：

```json
{
  "id": "POS-XXX",
  "userId": "USR-XXX",
  "symbol": "XAUUSD",
  "side": "long",
  "volume": 0.01,
  "entryPrice": 2320.4,
  "margin": 23.2,
  "openedAt": 1760000000000,
  "source": "mock",
  "quoteTime": 1760000000000,
  "entryBid": 2320.1,
  "entryAsk": 2320.4,
  "entrySpread": 0.3,
  "markPrice": 2320.6,
  "pnl": 0.2
}
```

拒单响应：

```json
{
  "message": "行情延迟，禁止市价成交。"
}
```

#### 后台接口

| 方法 | 路径 | 参数/Body | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/accounts` | - | 获取全部模拟账户 |
| GET | `/api/admin/positions` | - | 获取全部持仓 |
| GET | `/api/admin/orders` | - | 获取全部订单 |
| POST | `/api/admin/accounts/:id/adjust-balance` | `{ "type": "deposit", "amount": 1000, "note": "后台手动调整" }` | 调整指定用户虚拟资金 |
| GET | `/api/admin/market/status` | - | 获取全部品种行情状态 |

资金调整类型：

| type | 说明 |
| --- | --- |
| `deposit` | 增加余额 |
| `withdraw` | 扣减余额 |
| `reset` | 重置余额 |

### 7.2 WebSocket API

连接地址：`ws://127.0.0.1:8787/ws`

#### 订阅 ticker

请求：

```json
{
  "type": "subscribe",
  "channel": "ticker",
  "symbol": "XAUUSD"
}
```

推送：

```json
{
  "type": "ticker",
  "symbol": "XAUUSD",
  "bid": 2320.1,
  "ask": 2320.4,
  "last": 2320.25,
  "spread": 0.3,
  "source": "mock",
  "status": "connected",
  "timestamp": 1760000000000
}
```

#### 订阅 candle

请求：

```json
{
  "type": "subscribe",
  "channel": "candle",
  "symbol": "XAUUSD",
  "interval": "1m"
}
```

推送：

```json
{
  "type": "candle",
  "symbol": "XAUUSD",
  "interval": "1m",
  "data": {
    "time": 1760000000,
    "open": 2320.1,
    "high": 2321.2,
    "low": 2319.8,
    "close": 2320.6,
    "volume": 42
  }
}
```

异常请求响应：

```json
{
  "type": "error",
  "message": "invalid message"
}
```

## 8. 数据模型

### 8.1 用户 User

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 用户 ID |
| email | string | 邮箱 |
| password | string | 明文密码，当前仅本地 MVP 使用 |
| nickname | string | 昵称，可选 |
| status | `active` / `disabled` | 用户状态 |
| createdAt | string | 注册时间 |

### 8.2 平台配置 PlatformConfig

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| platformName | string | 平台名称 |
| logoText | string | Logo 文案 |
| themeColor | string | 主题色 |
| defaultCurrency | string | 默认账户币种 |
| riskNotice | string | 风险提示 |

### 8.3 交易品种 MarketSymbol / TradeSymbol

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| symbol | string | 内部展示品种代码 |
| displayName | string | 展示名称 |
| apiSymbol | string | 行情源订阅代码 |
| category | enum | `forex`、`metal`、`crypto`、`index`、`stock` |
| digits | number | 报价小数位 |
| spread | number | 固定点差 |
| leverage | number | 杠杆 |
| contractSize | number | 合约单位 |
| minLot | number | 最小手数 |
| maxLot | number | 最大手数 |
| lotStep | number | 手数步进 |
| tradeStatus | enum | `enabled`、`close_only`、`disabled` |
| isVisible | boolean | 用户端是否可见 |

### 8.4 订单 OrderRecord

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 订单 ID |
| userId | string | 用户 ID |
| accountId | string | 账户 ID |
| positionId | string | 关联持仓 ID |
| symbol | string | 品种 |
| side | `buy` / `sell` | 买卖方向 |
| positionSide | `long` / `short` | 持仓方向 |
| orderType | `Market` | 当前仅市价单 |
| action | `open` / `close` | 开仓或平仓 |
| status | `filled` / `rejected` | 成交或拒单 |
| volume | number | 手数 |
| price | number/null | 成交价 |
| bid/ask/spread | number/null | 下单时行情快照 |
| source | string | 行情来源 |
| quoteTime | number/null | 行情时间 |
| simulated | true | 是否模拟成交 |
| reason | string | 拒单原因 |
| pnl | number | 平仓盈亏 |
| createdAt | number | 创建时间 |

## 9. 当前存储与状态边界

| 数据 | 当前存储 | 说明 |
| --- | --- | --- |
| 用户、登录态、管理员登录态、白标配置、品种配置、前端报价缓存 | 浏览器 `localStorage` | 不同浏览器/设备不共享 |
| 模拟账户、持仓、订单、资金调整记录 | API 服务进程内存 | 服务重启后丢失 |
| 当前/历史 K 线 | Redis/PostgreSQL 优先，文件降级 | 未配置外部存储时使用 `server/data/candles.json` |

localStorage key：

| Key | 说明 |
| --- | --- |
| `xingheng.users` | 注册用户 |
| `xingheng.auth` | 用户登录态 |
| `xingheng.adminAuth` | 管理员登录态 |
| `xingheng.config` | 白标配置 |
| `xingheng.tradeSymbols.v2` | 品种配置 |
| `xingheng.marketQuotes.v2` | 前端报价缓存 |

## 10. 非功能与风控要求

当前已具备：

| 能力 | 说明 |
| --- | --- |
| 行情断线保护 | stale/disconnected 时禁止市价成交 |
| 点差异常保护 | spread 超过配置值 10 倍时拒单 |
| 保证金校验 | 可用保证金不足时拒单 |
| 持仓实时估值 | 基于最新 Bid/Ask 计算浮盈亏 |
| 订单审计字段 | 记录成交/拒单时的 Bid、Ask、Spread、来源和行情时间 |

后续生产化必须补齐：

| 方向 | 要求 |
| --- | --- |
| 鉴权 | 服务端 Session/JWT、管理员账号体系、RBAC |
| 密码安全 | 密码哈希、重置密码、登录限流 |
| 数据持久化 | 用户、账户、订单、持仓、调整记录入库 |
| 风控 | 最大持仓、最大杠杆、强平线、风控日志、异常行情熔断 |
| 真实交易合规 | KYC、AML、资金账户、出入金、报表、监管审计 |
| 监控 | 行情延迟、WebSocket 连接、API 错误率、订单拒绝率 |

## 11. 已知限制

1. 当前是模拟交易 MVP，不是生产级交易所或真实经纪商系统。
2. 用户注册和登录在前端本地完成，密码明文保存在浏览器 localStorage。
3. 后台管理员为固定账号，未接入服务端鉴权。
4. 交易账户、持仓、订单保存在 API 服务内存，服务重启会丢失。
5. 首页“模拟账户权益 100,000.00”是静态展示，实际交易账户初始 Balance 为 10,000。
6. 品种配置从前端同步到服务端，服务端重启后会回到默认品种，需前端再次同步。
7. 当前仅支持市价单，不支持限价单、止损止盈、挂单撤单、部分平仓。
8. 当前无手续费、隔夜费、滑点、爆仓/强平、交易时段等规则。
9. 当前没有真实充值、提现、钱包、账变流水、KYC、代理返佣等交易所/经纪商生产模块。

## 12. 建议下一阶段需求

| 优先级 | 需求 | 说明 |
| --- | --- | --- |
| P0 | 服务端用户与管理员鉴权 | 将用户、管理员、登录态迁移到服务端 |
| P0 | 交易数据持久化 | 账户、持仓、订单、资金调整入库 |
| P0 | 账户首页修正 | 首页权益改为真实 `/api/trading/account` 数据 |
| P1 | 订单能力增强 | 支持挂单、止盈止损、部分平仓、撤单 |
| P1 | 风控能力 | 最大手数、最大持仓、保证金率、强平规则 |
| P1 | 资金流水 | 记录每笔资金调整、成交盈亏账变 |
| P2 | 报表导出 | 用户交易记录、后台订单/账户导出 |
| P2 | 行情监控 | 行情源延迟、断线、异常跳价监控 |
