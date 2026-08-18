# Codex 任务交接记录

> 本文件用于跨 Codex 对话、账号和 worktree 的 Owner 交接。当前项目事实仍以
> [`PROJECT_CONTEXT.md`](../../PROJECT_CONTEXT.md) 为准；历史交接不得覆盖用户最新明确要求。

## 2026-08-18：OKX Test C 完成与账号切换交接

【当前 Owner】

当前 Codex 账号，已完成本轮记录与代码候选收敛。

【下一 Owner】

接手 StellaX 的新 Codex 账号。

【生产事实】

- Production revision：`2bcea91e4e57096d34b63ef0098cf2811e56c547`，API healthy，restart count 0。
- 安全开关：`OKX_LIVE_TRADING_ENABLED=false`、`OKX_KILL_SWITCH=true`、
  `LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true`。
- OKX Provider identity `okx:896ceacb1bc120af` 已验证，withdraw permission=false。
- Test C 实例 `arbitrage-85ffc5966169a9a9e3ca41cc87740946ecdb2da130ddff53ebd5790e80486b06`
  已 `CLOSED`。Spot open `110 DOGE`，实际 exposure `109.89 DOGE`；Perp open/close `100 DOGE`；
  Spot close `109.89 DOGE`。四条 ExecutionRecord 均 `CONFIRMED`，四个 `ordId` 唯一，无重复订单。
- 最终 Perp=`FLAT/0`，active orders=`0`，DOGE Spot=`0.000000824`（测试前 dust），无残余敞口。
- Test C 临时服务端认证会话已撤销，新增会话计数为 0。

【已部署修复】

- `058afc7`：第二腿从第一腿实际 base exposure 生成 hedge target。
- `7f985b8`：OKX placeOrder response strict contract。
- `2bcea91`：ExecutionCoordinator 保留 Capability failure cause；当前 production 固定在此 revision。

【本交接提交包含但尚未部署】

- 删除旧 Funding Manual Service/Route/Resolver 等无生产消费者路径。
- Funding Strategy / IntentBuilder / Coordinator / Bridge 的 Spot/Perpetual 本地扩展和测试；这些文件
  仍没有 production consumer，不得替代正式 `Draft -> ArbitrageExecutionCommandService -> FormalRuntime`。
- 套利导航收拢为“套利系统”菜单；套利看板行点击/键盘操作进入套利分析。
- Funding Opportunity Evaluator 只读架构边界及本次进度文档。

【未完成/P1】

- `NOTIONAL_USDT` 第一腿执行前权威 Draft 重验使用精确 quantity equality，报价变化会产生
  `arbitrage_instance_mismatch`。该路径 fail closed 且 mutation=0，但会留下无执行引用、无敞口的
  空 `OPENING` 实例（本次：`arbitrage-6dd96a3b4f49beaf918a1d48c79d82a03ade158859377b57e351d827d38ec537`）。
- 不要直接改 DB 清理实例；下一步应先独立审查第一腿预算重验语义和空实例生命周期。
- 本交接提交尚未部署。任何部署或真实资金测试均需新 Owner 重新取得用户明确授权并做只读预检。

【运维注意】

- Compose 重建 production API 时必须显式传入
  `GIT_COMMIT=<approved-sha> ENV_FILE=/opt/xingheng/.env.production`；只传 `--env-file` 不足以覆盖
  compose 内的 `env_file` 路径和旧 `GIT_COMMIT` 值。
- 不得从当前 Git `main` 自动推断 production revision，必须分别检查容器 image、`GIT_COMMIT` 和健康状态。

## 2026-08-13：四交易所只读前置完成与 Bitget Position 修复部署

【任务名称】

StellaX 套利系统、Account Read、ArbitrageInstance 与四交易所真实只读核验阶段进度记录

【当前 Owner】

Stella · 产品技术负责人

【下一 Owner】

等待 Moss 明确分配

【任务目标】

在不执行真实资金操作的前提下，完成套利系统产品结构、四交易所账户读取、套利实例持久化、
真实持仓只读核验及 production GET-only 前置验证，为后续独立的小额真实资金测试设计与授权提供
可靠基础。

【当前状态】

当前阶段已完成。四交易所 GET-only readiness 均为 `READY`，可以进入“小额真实资金测试设计/授权
阶段”，但真实资金执行仍为 `BLOCKED_PENDING_AUTHORIZATION`，不得自动进入资金测试。

【已完成内容】

- Phase A2：完成“套利看板 / 套利分析 / 我的套利”三模块收敛、看板语义与筛选调整、单腿标准化
  APR 展示，以及通过 `opportunityId` 恢复的套利分析页面。
- Phase B1-B6：完成 Binance / OKX / Bybit / Bitget 用户隔离 Account Read Provider、我的套利账户
  概览，以及基于真实公开行情的派生 USDT 估值。
- Phase C1-C5：完成 ArbitrageInstance 数据来源审查、最小 SQLite 持久化、ExecutionIntent 关联、
  查询 API，以及“我的套利”当前/历史套利实例展示。
- Phase C6.1-C6.2：完成已知 `userId + arbitrageId` 的真实 Position / Balance 只读核验边界与四所
  production composition；核验只返回 `MATCHED / MISMATCH / UNKNOWN`，不会修改实例生命周期。
- C6.3.1 真实响应兼容 checkpoint：`a320e424ecde498a2f4be29c3698baee98e60fd2`。
- Bitget Position 空仓兼容 checkpoint：`03508fe624d612b1870a45075c9c890950bc8789`，仅修改
  `BitgetAccountReadClient.ts` 及其测试，支持 `data.list=[]` 和 `data.list=null` 合法空仓，并对缺失或
  非法 shape 保持 fail-closed。
- 已将固定 revision `03508fe624d612b1870a45075c9c890950bc8789` 部署至 production；API
  `running/healthy`，Web `running`。
- Production 安全状态已确认：`USER_CREDENTIAL_ENVIRONMENT=production`、
  `LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true`、
  `BINANCE_ALLOWED_EGRESS_IPS=207.148.64.33`。
- Bitget production GET-only 复验通过：CredentialStore decrypt、Account Info、Account Settings、
  Account Assets、BTCUSDT Position、Instrument Mapping 和 Trading Rules 均为 `PASS`；Unified
  账户的 `data.list=null` 被识别为合法空仓。
- 当前逐所 readiness：Binance `READY`、OKX `READY`、Bybit `READY`、Bitget `READY`。
- 全部真实复验期间 Provider mutation、订单和资金操作次数均为 `0`。

【未完成内容】

- 尚未设计或批准四交易所小额真实资金测试的具体批次、金额、顺序、退出条件和核账标准。
- 尚未为当前固定 production revision 生成并人工批准新的 Capital Test Authorization / Permit。
- 尚未打开真实交易开关，未关闭 kill switch，未执行任何下单、撤单、开仓、平仓、调仓、转账或
  提现操作。

【涉及文件/模块】

- `PROJECT_CONTEXT.md`
- `docs/thread-handoffs/THREAD_HANDOFFS.md`
- `server/modules/bitget/BitgetAccountReadClient.ts`
- `server/modules/bitget/BitgetAccountReadClient.test.ts`
- Account Read、Instrument Catalog、ArbitrageInstance 与 Position Verification 既有模块
- Production Compose project：`xingheng`

【关键决策】

- 四所 `READY` 仅表示真实 GET-only 技术前置通过，不等于真实资金授权或 execution readiness。
- 后续真实资金测试优先使用各交易所真实支持且经 Trading Rules 复核的 BTC/USDT Spot / Perpetual
  品种，不固定使用 XAUT，也不得硬编码候选 symbol 的规则。
- ArbitrageInstance 继续作为 StellaX 套利归属事实；交易所 Position / Balance 只作为当前真实状态
  核验，不自动发现、归组或修改套利实例。
- 任何资金动作必须继续使用现有 Execution、OrderManager、RiskGuard 和 Provider 安全链，不得新增
  第二条 mutation 路径。

【风险事项】

- 当前尚无有效的真实资金授权；任何 mutation 都是阻断项。
- 四所 Trading Rules 和账户状态会变化，正式资金测试前必须重新取得新鲜只读证据。
- Production revision、环境变量和 kill switch 状态必须在授权材料中固定，并在执行前再次核验。

【待确认事项】

- Moss 是否批准进入“小额真实资金测试设计/授权阶段”。
- 逐所测试顺序、单笔/总资金上限、允许的订单类型、最大执行时长、退出与残差处理标准。
- 新 Capital Test Authorization、Permit 与人工审批材料的 Owner 和验收流程。

## 2026-08-12：其他交易所 API 可配置改动的侧边栏审查交接

【任务名称】

其他交易所 API 可配置（Bybit / Bitget / OKX）代码审查与安全审查

【当前 Owner】

当前 Codex 账号的 Product Technical Lead

【下一 Owner】

Code Reviewer；如审查认定触发安全边界，再转 Architecture Reviewer

【任务目标】

审查本批改动是否真正让 Bybit / Bitget / OKX 进入“可配置 API 凭证”路径，同时保持
credential-only、fail-closed、不过度开放交易执行，并确认没有引入凭证泄露、重复保存、删除回退或
错误状态映射。

【当前状态】

待审查。当前本地代码、类型检查、build 和目标测试均已通过，但还未取得独立 reviewer 结论。

【已完成内容】

- 后端 `UserExchangeCredentialService` 已支持 Bybit / Bitget / OKX 仅凭证加密配置。
- Bitget / OKX 强制 passphrase，Bybit 不要求 passphrase。
- 前端 `saveExchangeCredential`、个人交易页与状态展示已对齐新能力。
- KMS/WIF 失败已映射成服务恢复提示，不误导用户重建交易所 API Key。
- HTTP -> service -> store -> fake KMS envelope -> SQLite 的三家交易所集成测试已通过。

【未完成内容】

- 独立 Code Reviewer 审查结论。
- 如 reviewer 认为触发安全边界，则还需要 Architecture Reviewer 结论。
- 若 review 指出问题，需要按 review 结果修复并重新验证。

【涉及文件/模块】

- `server/modules/credentials/UserExchangeCredentialService.ts`
- `server/modules/credentials/UserExchangeCredentialService.test.ts`
- `server/modules/credentials/UserExchangeCredentialStore.test.ts`
- `server/modules/api/exchangeCredentialRoutes.test.ts`
- `src/api/exchangeCredentials.ts`
- `src/api/exchangeCredentials.test.ts`
- `src/features/personalTrading/components/ExchangeCredentialsPanel.tsx`
- `src/features/personalTrading/model/personalTradingState.ts`
- `src/features/personalTrading/model/personalTradingState.test.ts`
- `docs/thread-handoffs/THREAD_HANDOFFS.md`

【关键决策】

- 只开放“API 凭证可配置”，不开放交易执行、私有 provider 校验或资金动作。
- Binance 保持原有真实验证路径不变。
- 其他三家交易所统一走 credential-only 语义，保存成功但 execution stay closed。

【风险事项】

- 生产 KMS/WIF/IAM/key version 仍未恢复，线上保存烟测未完成。
- 当前不允许把 review 结论误当成生产可用结论。
- 任何 review 发现的 P0/P1/P2 问题都必须先修复再回传。

【待确认事项】

- Code Reviewer 是否通过，或是否给出必须修复的问题。
- 是否需要 Architecture Reviewer 介入。
- 生产部署与线上烟测是否已具备条件。

【回传格式】

审查完成后，请在同一条交接记录下回传：

【修改概览】

【问题】

位置：

影响：

建议：

【最终结论】

- 通过
- 修改后通过
- 不建议合并

【回传要求】

1. 只基于实际代码、测试和项目文档给结论。
2. 若有问题，按严重度列出，不要混入未来优化建议。
3. 若可进入下一步，请明确写出“是否允许进入开发/部署”。

## 2026-08-10：Phase 8B Capital Test Revalidation 与 Harness 候选改动

【任务名称】

Phase 8B-0 Read-only Capital Test Revalidation / Phase 8B-1 one-shot Harness 候选实现回收

【当前 Owner】

当前 Codex 账号的 Product Technical Lead；来源任务
`019fea5b-dbe9-78b2-a601-d5099aee7d42`

【下一 Owner】

接手 StellaX 的新 Codex 账号 Product Technical Lead

【任务目标】

唯一主线是先完成 production revision
`5f95f27c96f0ebbdf6b0bc6a269d6a945623b11d` 的 Phase 8B-0 生产只读 Gate，取得目标用户
`USR-MRDQ6DT1` 的新鲜认证 GET 证据。任何真实资金步骤仍须独立、明确授权。

【当前状态】

准备交接。Phase 8B-0 为 `NOT_READY`；Phase 8B-1 已进入代码主线 `70a2206`，但尚未被记录为
已部署 production revision，也未获得真实资金授权。

【已完成内容】

- 已确认 Chrome Profile `Stellar` 即 `chrome-stellar`。
- 已限定只读白名单为 `/api/auth/me`、`/api/binance/status`、`/api/binance/account`、
  `/api/binance/market`、`/api/binance/strategy`、`/api/binance/orders`。
- 浏览器控制尝试未产生 POST、Provider mutation、订单、仓位、资金或配置变化；mutation=`0`。
- 独立 worktree 形成的 4 个 Phase 8B-1 修改已与 `main` commit `70a2206` 完成内容比对，完全
  一致：
  - `scripts/run-binance-capital-test-once.ts`
  - `scripts/run-binance-capital-test-once.test.ts`
  - `server/modules/binance/BinanceCapitalTestPreflight.ts`
  - `server/modules/binance/BinanceExecutionCapability.test.ts`
- 实现保持单一 Runtime 与既有安全链，支持 `PRICE_PRIORITY -> IOC_LIMIT`、
  `EXECUTION_PRIORITY -> MARKET`，并将 run identity/receipt 隔离；来源任务报告定向测试
  `38/38`、Binance/Harness 回归 `133/133` 和 production build 通过。

【未完成内容】

- 恢复 `chrome-stellar` 控制连接并取得新的认证 GET 响应体。
- 重新确认用户 binding、权限、账户状态、XAUTUSDT 产品规则、现有 exposure、open/processing
  orders 及运行态安全开关。
- 复核 `70a2206` 的测试与部署准备；用户确认前不得部署或执行该 Harness。

【涉及文件/模块】

- 主工作区：`/Users/dq/Documents/StellaX/main`
- 已回收代码 worktree：`/Users/dq/.codex/worktrees/0580/main`（内容已由 `70a2206` 保存）
- 生产基线 commit：`5f95f27c96f0ebbdf6b0bc6a269d6a945623b11d`
- 本次交接文档：`PROJECT_CONTEXT.md`、`PROJECT_ONBOARDING.md`、`PROJECT_HISTORY.md`、
  `docs/history/2026-08.md`、`docs/thread-handoffs/THREAD_HANDOFFS.md`

【关键决策】

- Phase 8B-0 缺少新鲜生产证据时必须 fail closed，不能沿用旧证据判定 READY。
- 浏览器连接失败且没有业务 action 提交，不消耗真实资金执行次数，也不代表路线永久淘汰。
- Phase 8B-1 已进入代码主线，但代码主线与 production runtime revision 仍须严格区分。
- 真实执行继续限定为 Registry、PersonalTradingService、Runtime、OrderManager、RiskGuard、
  BinanceClient 的既有链路；不得新增 API、scheduler、batch 或第二套 mutation 路径。

【风险事项】

- Chrome 控制通道当前无法提供新鲜运行态证据，这是继续 Capital Test 的直接阻断项。
- 回收 worktree 原为 detached `HEAD`；其 4 个文件已确认由 `origin/main` commit `70a2206` 完整
  保存，可在核验后清理该重复现场。
- 主工作区已有用户所有的未提交/未跟踪文档改动；不得整体回退、清理、暂存或提交未核对内容。
- 上一次确认的 `LIVE_TRADING_ENABLED=false`、`BINANCE_KILL_SWITCH=true` 只是历史证据，正式继续
  前必须重新只读确认。

【待确认事项】

- 新 Owner 是否继续 Phase 8B-0 浏览器只读复核。
- 新 Owner 是否继续 `70a2206` 的 production 部署准备；代码已合入不自动授予部署权限。
- 任何 commit、deploy、开关变化或真实资金 mutation 均需用户新的明确授权。
