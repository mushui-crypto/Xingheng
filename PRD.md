# 星衡模拟交易平台 PRD

版本：v0.4.0  
整理日期：2026-07-02  
文档范围：基于当前代码已实现能力整理，不包含未落地的真实入金、真实出金、真实撮合、清算、托管、KYC、AML、生产级风控等能力。

## 1. 产品概述

星衡当前是一个“Binance 合约行情源 + 内部模拟交易 + 内部账户体系 + BSC Testnet 钱包闭环”的交易模拟 MVP。

系统当前主线聚焦：

- 单交易品种：`BTCUSDT`
- 主资金资产：`USDT`
- 行情来源：Binance USDT-M 永续合约公开行情
- 交易性质：仅内部模拟成交，不接真实交易所下单
- 钱包网络：`BSC Testnet`

当前已具备用户注册登录、行情查看、K 线图、模拟交易、账户总览、账户划转、用户间内部转账、测试网充值地址分配、链上充值记录、出金申请与后台审核确认等基础闭环。

## 2. 产品目标

1. 提供可运行的用户端模拟交易闭环：注册、登录、看行情、下单、持仓、平仓、订单查询。
2. 提供基础账户与钱包闭环：资金账户、模拟账户、交易账户、账户划转、内部转账、测试网充值地址、出金申请。
3. 提供后台运营闭环：用户启停、`BTCUSDT` 单品种配置、资金调整、链上充值扫描、出金审核与确认。
4. 为后续真实交易、更多品种、多链钱包与风控能力保留结构，但当前不承诺这些能力已落地。

## 3. 用户角色

| 角色 | 说明 | 当前权限 |
| --- | --- | --- |
| 游客 | 未登录访问者 | 可访问用户登录、注册页；用户页需登录 |
| 注册用户 | 模拟交易用户 | 查看首页、行情、交易终端、账户页；执行账户操作 |
| 管理员 | 后台操作人员 | 固定账号登录后台，管理用户、品种、资金、充值、出金 |

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
| `/register` | 用户注册 | 邮箱、昵称、密码注册 |
| `/app/dashboard` | 首页 | 展示账户摘要、入口和模拟环境提示 |
| `/app/markets` | 行情 | 展示 `BTCUSDT` 行情与状态 |
| `/app/trading` | 交易终端 | K 线图、最新报价、模拟下单、持仓、订单 |
| `/app/account` | 账户页 | 账户总览、资产、订单、充值/提现/划转入口 |

### 4.2 账户页导航层级

当前账户页左侧导航按以下层级组织：

- 账户总览
- 资产
  - 钱包总览
  - 资金账户
  - 交易账户
  - 模拟账户
- 订单
  - 出金订单
  - 入金订单
  - 资金流水
  - 链上充值记录
  - 交易订单

账户页统一提供：

- 充值：链上入金、模拟账户相关入口展示
- 提现：内部转账、链上出金、出金申请
- 划转：资金账户 / 交易账户 / 模拟账户之间划转

其中：

- “内部转账” = 不同用户之间的转账
- “划转” = 同一用户不同账户之间的转账

### 4.3 后台路由

| 路由 | 页面 | 功能 |
| --- | --- | --- |
| `/admin/login` | 后台登录 | 固定管理员账号登录 |
| `/admin/dashboard` | 数据概览 | 展示用户与运营摘要 |
| `/admin/users` | 用户管理 | 查看用户、启用/禁用用户 |
| `/admin/symbols` | 品种管理 | 编辑 `BTCUSDT` 配置 |
| `/admin/trading` | 交易与资金管理 | 查看账户、充值、转账、出金、链上记录、行情状态 |

## 5. 已实现功能说明

### 5.1 账号与鉴权

#### 用户注册

规则：

| 规则项 | 说明 |
| --- | --- |
| 邮箱格式 | 必须为有效邮箱 |
| 密码长度 | 至少 6 位 |
| 确认密码 | 必须一致 |
| 邮箱唯一性 | 不可重复注册 |
| 默认状态 | `active` |
| 用户 ID | `USR-{timestamp base36}` |

#### 用户登录

用户登录成功后，服务端返回 Bearer Token。后续用户侧交易、钱包、账户接口统一使用 Bearer Token 鉴权。

| 场景 | 结果 |
| --- | --- |
| 邮箱不存在或密码错误 | 返回“邮箱或密码不正确。” |
| 用户状态为 `disabled` | 返回“账号已禁用，请联系管理员。” |
| 登录成功 | 返回 Bearer Token 与用户信息 |

当前不再允许前端通过 `x-user-id` 或 query 参数伪装用户身份。

#### 后台登录

后台通过 `POST /api/admin/login` 获取 Bearer Token。当前未接入 RBAC、多管理员体系或权限细分。

#### 禁用用户规则

用户被后台禁用后：

- 应立即禁止交易接口访问
- 应立即禁止钱包接口访问
- MVP 可不做完整 token 主动回收
- 但每次鉴权都必须检查用户当前状态

即使用户仍持有旧 token，只要状态已变为 `disabled`，也必须被拒绝访问。

### 5.2 首页

首页展示：

| 模块 | 内容 |
| --- | --- |
| 欢迎区 | 当前用户昵称/邮箱、模拟环境提示 |
| 模拟账户权益 | 读取模拟账户权益 |
| 资金账户可用余额 | 读取资金账户 `available` |
| 账户入口 | 跳转账户页 |

### 5.3 行情模块

当前行情页只展示后台配置为 `isVisible=true` 的 `BTCUSDT`。

展示字段：

| 字段 | 说明 |
| --- | --- |
| 品种代码 | `BTCUSDT` |
| 展示名称 | 后台配置的 displayName |
| Bid | 系统标准化买价 |
| Ask | 系统标准化卖价 |
| Last | 最新价 |
| Change % | 本地变化百分比 |
| 状态 | `connected` / `stale` / `disconnected` |
| 更新时间 | 本地更新时间 |

当前默认口径：

| Symbol | 名称 | 分类 | Digits | Spread | 杠杆 | 合约单位 | 手数范围 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| BTCUSDT | PERP BTC/USDT | crypto | 2 | 10 | 20 | 1 | 0.001-10 / 0.001 |

### 5.4 交易终端

交易终端由 K 线图、实时行情、下单面板、持仓表和订单表组成。

#### K 线图

| 能力 | 说明 |
| --- | --- |
| 图表库 | `lightweight-charts` |
| 支持周期 | `1m`、`5m`、`15m`、`1h` |
| 初始数据 | `/api/market/candles` |
| 实时更新 | `/ws` 订阅 candle |
| 历史数据来源 | Binance REST 拉取并回补 |

#### 行情状态

| 状态 | 用户展示 | 交易影响 |
| --- | --- | --- |
| `connected` | 实时行情 | 允许交易 |
| `stale` | 行情延迟 | 禁止市价成交 |
| `disconnected` | 行情中断 | 禁止市价成交 |

超过 10 秒未收到实时行情，即判定为 `stale`。

#### 当前下单能力

当前第一版只支持：

- 限价开仓
- 撤单
- 持仓级 TP/SL 为后续设计口径

同时保留现有模拟成交与持仓/订单展示能力。交易引擎口径上：

- 买入按 ask 成交
- 卖出按 bid 成交
- 多单平仓按 bid
- 空单平仓按 ask

#### 下单校验

| 校验项 | 规则 |
| --- | --- |
| 品种配置 | 未配置品种拒单 |
| 交易状态 | `enabled` 允许开仓和平仓；`disabled` / `close_only` 禁止新开仓但允许平仓 |
| 行情存在性 | 无 tick 拒单 |
| 行情状态 | 非 `connected` 拒单 |
| 行情时效 | 超过 10 秒拒单 |
| Bid/Ask | 必须为正数且 Ask > Bid |
| 点差异常 | 当前 spread 大于配置 spread 的 10 倍拒单 |
| 手数范围 | 必须在 `minLot` 与 `maxLot` 之间 |
| 手数步进 | 必须符合 `lotStep` |
| 保证金 | 可用保证金不足拒单 |

#### 资金与盈亏

| 指标 | 公式 |
| --- | --- |
| 保证金 | `price * volume * contractSize / leverage` |
| 多单浮盈亏 | `(markBid - entryPrice) * volume * contractSize` |
| 空单浮盈亏 | `(entryPrice - markAsk) * volume * contractSize` |
| Equity | `Balance + Floating P/L` |
| Used Margin | 所有持仓保证金之和 |
| Free Margin | `Equity - Used Margin` |

剩余持仓在部分平仓后：

- 保留原 `entryPrice`
- `margin` 按剩余 `volume` 重算

### 5.5 账户体系

当前账户体系包含：

| 账户类型 | 说明 |
| --- | --- |
| `funding` | 资金账户，承接充值、出金、内部转账、账户划转 |
| `simulation` | 模拟账户，承接当前模拟交易能力 |
| `realTrading` | 交易账户，作为未来真实交易入口；当前为新增账户类型 |
| `trading` | 旧兼容字段，历史上表示模拟账户；前端仅作为 `simulation` 兜底，不再作为主口径展示 |

#### 资金账户

展示字段：

- `balance`
- `frozen`
- `available`

#### 模拟账户

展示字段：

- `balance`
- `equity`
- `usedMargin`
- `freeMargin`
- `floatingPnl`

#### 交易账户

当前作为未来真实交易入口预留，已在账户体系中存在，当前不承诺真实交易闭环已实现。

### 5.6 账户操作

#### 账户划转

支持同一用户账户间划转：

- `funding -> simulation`
- `simulation -> funding`
- `funding -> realTrading`
- `realTrading -> funding`

当前不允许：

- `simulation -> realTrading`
- `realTrading -> simulation`

即账户划转必须经过资金账户中转。

#### 用户间内部转账

支持用户 A 向用户 B 转账，当前从发起人 `funding` 扣减，转入接收人 `funding`。

支持 `clientRequestId` 幂等：

- 同一个 `clientRequestId` 重复提交，返回同一条转账记录
- 不重复扣款

#### 资金流水

当前可记录以下类型：

- `deposit`
- `withdrawal_freeze`
- `withdrawal_approved`
- `withdrawal_rejected`
- `transfer_in`
- `transfer_out`
- `internal_transfer_in`
- `internal_transfer_out`
- `adjustment`

### 5.7 BSC Testnet 钱包

#### 当前网络口径

| 项目 | 值 |
| --- | --- |
| 网络 | `BSC_TESTNET` |
| 展示名称 | `BNB Smart Chain Testnet` |
| 主链资产 | 测试 USDT |

#### 充值地址

每个用户可分配专属充值地址。

当前环境变量口径：

- `BSC_TESTNET_RPC_URL`
- `BSC_TESTNET_CHAIN_ID`
- `BSC_TESTNET_TOKEN_ADDRESS`
- `BSC_TESTNET_TOKEN_DECIMALS`
- `BSC_TESTNET_CONFIRMATIONS`
- `BSC_TESTNET_SCAN_START_BLOCK`
- `BSC_TESTNET_SCAN_BATCH_SIZE`
- `BSC_TESTNET_PRIVATE_KEY`
- `BSC_TESTNET_DEPOSIT_MNEMONIC`
- `BSC_TESTNET_DERIVATION_PATH`

说明：

- 热钱包私钥仅通过 `.env` 配置
- 充值地址助记词仅通过 `.env` 配置

#### 链上充值

当前已具备：

- 查询用户充值地址
- 查询用户充值记录
- 查询后台充值地址列表
- 后台触发链上扫描
- 后台查询链上充值记录

当前风险：

- `eth_getLogs` 可能被公共 BSC Testnet RPC 限流，导致 scan 失败
- 因此真实链上充值扫描闭环仍受外部 RPC 稳定性限制

#### 链上出金

当前已具备：

- 用户提交出金申请
- 提交时先冻结 Funding 金额
- 后台审核通过后先广播
- 链上确认后正式扣减
- 广播或确认失败时释放冻结
- 保存 `txHash`、确认数、失败原因、链上地址

出金状态包括：

- `pending_review`
- `broadcasting`
- `broadcasted`
- `confirmed`
- `failed`
- `rejected`

### 5.8 后台用户管理

能力：

| 功能 | 说明 |
| --- | --- |
| 用户列表 | 展示用户 ID、邮箱、昵称、状态、注册时间 |
| 禁用用户 | 将 `active` 用户置为 `disabled` |
| 启用用户 | 将 `disabled` 用户置为 `active` |

### 5.9 后台品种管理

当前后台只允许维护 `BTCUSDT`。

| 功能 | 说明 |
| --- | --- |
| 编辑品种 | 当前只允许编辑 `BTCUSDT` |
| 可编辑字段 | `displayName`、`spread`、`leverage`、`contractSize`、`minLot`、`maxLot`、`lotStep`、`tradeStatus`、`isVisible` |
| 不可编辑字段 | `symbol`、`apiSymbol` |
| 新增其他 symbol | 当前不允许 |
| 配置持久化 | 服务端持久化，刷新和重启不丢失 |

交易状态口径：

| 状态 | 含义 |
| --- | --- |
| `enabled` | 可开仓、可平仓 |
| `close_only` | 兼容旧字段；当前产品语义等同于禁止新开仓但允许平仓 |
| `disabled` | 禁止新开仓但允许平仓 |

当前产品不设计“禁止平仓”状态，避免用户无法退出已有持仓。

### 5.10 后台交易与资金管理

当前后台可查看或操作：

| 模块 | 功能 |
| --- | --- |
| 指标卡片 | 用户、持仓、流水、出金等摘要 |
| 后台入金 | 按用户 ID 给资金账户入金 |
| 账户列表 | 查看资金账户、模拟账户、交易账户 |
| 转账记录 | 查看账户划转、内部转账 |
| 资金流水 | 查看全量流水 |
| 充值地址列表 | 查看用户充值地址 |
| 链上充值记录 | 查看 detected / confirming / confirmed / failed |
| 出金审核 | approve / reject / confirm |
| 行情状态 | 查看品种连接状态与报价 |

## 6. 行情与交易服务

### 6.1 行情源

当前使用 Binance USDT-M 永续合约公开行情：

- REST：拉取历史 K 线
- WebSocket：接收实时 ticker / kline
- 内部按品种配置 spread 生成用于模拟成交的 Bid / Ask

当前主线不再保留 TraderMade / Mock 行情链路作为产品口径。

### 6.2 K 线聚合

系统支持：

- `1m`
- `5m`
- `15m`
- `1h`

当前 K 线存储方式：

- 进程内内存保存当前与历史 K 线
- 服务启动时从 Binance REST 回补
- 服务重启后重新拉取

### 6.3 数据存储

当前主线数据使用 SQLite 持久化，主要包括：

- 用户
- 模拟账户
- 持仓
- 订单
- 资金账户
- 资金流水
- 账户划转 / 内部转账
- 出金申请
- 链上充值记录
- 充值地址
- `BTCUSDT` 品种配置

## 7. 接口清单

基础地址：`http://127.0.0.1:8787`

### 7.1 基础与鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/auth/register` | 用户注册 |
| POST | `/api/auth/login` | 用户登录 |
| POST | `/api/auth/logout` | 用户登出 |
| GET | `/api/auth/me` | 获取当前用户 |
| POST | `/api/admin/login` | 后台登录 |

### 7.2 行情接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/market/symbols` | 获取品种配置与行情状态 |
| PUT | `/api/market/symbols/config` | 保存 `BTCUSDT` 品种配置 |
| GET | `/api/market/ticker` | 获取最新 ticker |
| GET | `/api/market/candles` | 获取 K 线 |

### 7.3 模拟交易接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/trading/account` | 获取或创建模拟交易账户 |
| GET | `/api/trading/positions` | 获取当前持仓 |
| GET | `/api/trading/orders` | 获取当前订单 |
| POST | `/api/trading/order` | 提交交易订单 |
| POST | `/api/trading/positions/:id/close` | 平仓 |

### 7.4 用户钱包接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wallet/accounts` | 获取 `funding / simulation / realTrading / trading` |
| GET | `/api/wallet/deposit-address` | 获取专属充值地址 |
| GET | `/api/wallet/deposits` | 获取链上充值记录 |
| GET | `/api/wallet/ledger` | 获取资金流水 |
| GET | `/api/wallet/transfers` | 获取转账记录 |
| POST | `/api/wallet/account-transfer` | 账户划转 |
| POST | `/api/wallet/internal-transfer` | 用户间内部转账 |
| POST | `/api/wallet/withdrawals` | 提交出金申请 |
| GET | `/api/wallet/withdrawals` | 获取用户出金单 |

兼容旧接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/wallet/transfer` | 旧账户划转接口，保留兼容 |

### 7.5 后台钱包接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/wallet/accounts` | 查看全量账户 |
| GET | `/api/admin/wallet/deposit-addresses` | 查看充值地址列表 |
| GET | `/api/admin/wallet/deposits` | 查看链上充值记录 |
| GET | `/api/admin/wallet/ledger` | 查看全量资金流水 |
| GET | `/api/admin/wallet/transfers` | 查看转账记录 |
| GET | `/api/admin/wallet/withdrawals` | 查看全量出金单 |
| POST | `/api/admin/wallet/deposit` | 后台手动入金 |
| POST | `/api/admin/wallet/onchain/scan` | 扫描链上充值 |
| POST | `/api/admin/wallet/withdrawals/:id/approve` | 审核通过并广播 |
| POST | `/api/admin/wallet/withdrawals/:id/reject` | 拒绝出金 |
| POST | `/api/admin/wallet/withdrawals/confirm` | 确认链上出金 |

## 8. 当前边界与非目标

以下能力当前不属于已交付范围：

- 真实交易所下单
- 真实撮合、清算、爆仓、资金费结算
- 主网钱包
- 多链钱包
- 多资产钱包
- KYC / AML
- 生产级风控、限额、黑名单、审计
- 完整 token 主动回收
- 多品种真实交易闭环

## 9. 已知限制与风险

1. 当前只有 `BTCUSDT`，多品种尚未开放。
2. `close_only` 与 `disabled` 当前产品语义已收敛，但接口字段仍保留两个值做兼容。
3. BSC Testnet 公共 RPC 可能对 `eth_getLogs` 限流，影响充值扫描稳定性。
4. 行情服务可能出现外部 REST 451/418 等交易所侧限制日志，需要单独治理。
5. 钱包与交易虽已有基础闭环，但仍属于 MVP，不等同生产可用交易所系统。
