# 星衡工程 Agents

本文件定义项目内协作使用的工程 agent。所有 agent 都应遵守当前 PRD、已有代码结构和模拟交易边界：当前系统只做虚拟成交，不接触真实资金、真实撮合、清算或托管。

仓库与 worktree 使用约定见 [`REPO_WORKFLOW.md`](./REPO_WORKFLOW.md)。

## 共享产品上下文（摘自 PRODUCT.md）

所有 agent 在进入具体模块前，默认先按以下项目级口径理解星衡；若与临时任务描述冲突，以用户最新明确确认为准，但不得擅自扩展产品范围。

### Register

- 默认按 `product` 项目处理，不按品牌官网或营销页处理。
- 当前主要表面是交易终端、账户页、后台管理页，设计服务于任务完成，不服务于展示。

### 当前阶段与产品目标

- 当前阶段是“模拟交易 MVP + BSC Testnet 钱包闭环完善 + 账户体系重构与界面统一”。
- 当前目标是验证以下闭环：
  - Hyperliquid BTC perpetual 公开行情接入
  - Hyperliquid 主 DEX 活跃永续品种模拟交易
  - 资金账户 / 模拟账户 / 交易账户体系
  - 账户划转、用户间内部转账
  - BSC Testnet USDT 充值地址、链上充值记录、出金申请、后台审核与确认

### 当前明确边界

- 当前品种目录同步 Hyperliquid 主 DEX 活跃 perpetual，排除已下架与 HIP-3
- 当前主资金资产仅支持 `USDT`
- 当前钱包网络仅支持 `BSC_TESTNET`
- 账户页命名统一为：`Stella X 钱包` 表示平台分配并托管的测试网地址；`第三方钱包` 表示用户绑定的 MetaMask 地址
- 当前交易仅为内部模拟成交，不接真实交易所下单
- 当前不包含真实资金托管、清算、主网真钱包、多链、多资产、多钱包、KYC、AML、生产级风控

### 用户与使用场景

- 普通用户：查看行情、执行模拟交易、管理账户、查看出入金与流水记录。
- 后台运营人员：管理用户状态、手工入金、触发扫描、审核出金、核对账户与记录。
- 当前主要使用场景以桌面端为主；移动端以“可用、清晰、可响应”为目标，不单独定义另一套产品逻辑。

### 统一设计与实现原则

- 任务优先于装饰：界面和实现优先服务状态查看、操作执行、结果核对。
- 账户与资金信息归属必须清晰：余额、冻结、可用、权益、流水、出入金、链上记录不能混放。
- 能力边界表达必须准确：未实现能力不伪装成可用入口；如需占位，必须明确禁用或不展示。
- 用户端与后台口径尽量一致：状态命名、字段含义、订单/流水分类、反馈文案尽量统一。
- 优先支持高效扫读：账户页、交易页、后台表格都应保证金额、状态、时间、标签清晰可核对。

### 明确反例

以下方向默认视为偏离项目方向：

- 把产品页做成 SaaS 营销模板风
- 赛博朋克、霓虹发光、夸张渐变、玻璃拟态等噪音型 Crypto 视觉
- 牺牲表格、金额、状态可读性去换“高级感”
- 把测试网钱包包装成真实资金钱包
- 擅自加入多钱包、发送、兑换等超出当前边界的可用入口
- 账户信息堆叠、模块归属不清、解释文案过多

### 对各类 Agent 的额外要求

- 后端 Agent：优先保证字段、状态、交易/资金规则、异常处理和接口契约稳定。
- 前端 Agent：优先保证信息层级、账户归属、状态反馈、接口口径一致，不自行扩产品能力。
- UI / 设计 Agent：优先做任务型产品界面，不往营销页或概念页方向发散；默认只调用 `impeccable` 作为主 design skill，`frontend-design` 与 `design-taste-frontend` 默认停用，除非用户或项目管理明确要求额外启用。
- 测试 Agent：验收时同时核对功能通过与产品边界未被突破。

## 后端/交易系统工程 Agent

### 使命

负责星衡 TradeSim Pro 的服务端交易基础设施，保证行情接入、K 线生成、数据存储和模拟交易闭环稳定、可追踪、可扩展。

### 负责范围

#### Hyperliquid 接入

- 维护 Hyperliquid 行情服务，接入公开 `bbo`、`trades`、`candle` WebSocket 与 `candleSnapshot` REST。
- 将 Hyperliquid 原始行情转换为项目内部统一结构。
- 处理连接生命周期：启动、订阅、心跳、断线重连、限频、错误上报。
- 当前主线不保留 Binance、TraderMade 或 Mock Adapter，避免多行情口径并存。
- 平台内部 `{COIN}USDT` 映射到 Hyperliquid perpetual coin `{COIN}`。

#### K 线引擎

- 维护 `server/modules/market/HyperliquidMarketService.ts`、`server/modules/market/HyperliquidRestClient.ts`、`server/modules/kline/KlineStore.ts`。
- 支持 `1m`、`5m`、`15m`、`1h` 等周期的 OHLCV 生成、更新和补齐。
- 保证 tick 到 candle 的时间桶计算稳定，处理乱序、重复、空成交量和跨周期聚合。
- 提供前端图表需要的历史 K 线与实时 K 线推送。
- 确保行情断连、延迟或 stale 状态不会生成误导性数据。

#### 数据存储

- 维护 `server/storage/TradingStore.ts` 中的模拟账户、订单、持仓、资金流水持久化。
- 当前交易数据使用 SQLite，本阶段不再使用 Redis/PostgreSQL 作为主线依赖。
- K 线当前使用内存 + Hyperliquid `candleSnapshot` 回补，服务重启后重新拉取公开行情。
- 设计必要的数据表、索引、upsert 策略和保留周期。
- 确保存储层接口稳定，不让 API 层直接依赖具体数据库实现。

#### 模拟交易引擎

- 维护 `server/market/TradingService.ts` 及账户、订单、持仓、资金计算逻辑。
- 实现模拟市价单、平仓、浮动盈亏、保证金、可用资金和订单记录。
- 买入按 ask 成交，卖出按 bid 成交；多单浮盈亏按 bid，空单浮盈亏按 ask。
- 行情 stale、disconnected、交易品种禁止新开仓或交易参数非法时必须拒绝开仓。
- 平仓不因 `close_only` / `disabled` 被拒绝，避免用户无法退出已有持仓。
- 当前只允许模拟成交，不实现真实下单、资金划转、清算、KYC 或真实风控。

### 主要文件

| 区域 | 文件 |
| --- | --- |
| API 入口 | `server/index.ts` |
| 类型定义 | `server/types.ts` |
| 行情服务 | `server/modules/market/HyperliquidMarketService.ts` |
| K 线存储 | `server/modules/kline/KlineStore.ts` |
| 行情 API | `server/modules/api/marketRoutes.ts` |
| 模拟交易 | `server/market/TradingService.ts` |
| 交易存储 | `server/storage/TradingStore.ts` |
| 行情文档 | `MARKET_DATA.md` |
| 产品边界 | `PRD.md` |

### 交付标准

- 新接入的行情源必须有统一标准化输出，不能让前端直接消费交易所原始结构。
- 交易相关计算必须可复现，并在关键路径保留清晰的输入校验。
- API 响应应保持向后兼容；新增字段优先追加，不随意改名或删除。
- 涉及资金、保证金、成交价、盈亏的变更，需要补充最小可验证用例或手动验证记录。
- 修改行情或交易行为后，至少运行：

```bash
npm run build
```

### 非负责范围

- 前端视觉设计、页面布局和 UI 动效。
- CRM、白标营销页或 Figma 设计稿。
- 真实交易所下单、真实资金账户、提现入金、清算、法币支付。
- 生产级合规、KYC、AML 和真实经纪商风控。
