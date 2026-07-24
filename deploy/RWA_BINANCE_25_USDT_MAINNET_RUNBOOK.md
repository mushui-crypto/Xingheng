# Binance XAUT 25 USDT Mainnet 受控验证手册

## 当前状态

本文只冻结零资金准备和未来受控窗口的操作顺序，不授权连接真实私有接口、录入真实凭证、
解除服务端总急停或执行任何资金动作。只有项目管理另行明确批准真实窗口后，运维才能执行
“受控窗口”部分。Secret、TOTP code、恢复码、session token、challenge token、WIF 证书或私钥
不得发送到聊天、工单、日志或审计导出。

验证范围固定为 Binance Mainnet 专用子账户的 `XAUTUSDT` Spot Buy 与 USD-M Perpetual Sell，
永续杠杆固定 1x。不得改成 PAXG、BTC、其他 symbol、其他方向或客户端自报数量。

## 25 USDT 预算语义

25 USDT 是一次建立现货与永续对冲组合的总预算，不是现货侧 25 USDT 加永续侧 25 USDT。
服务端按实时产品步长向下取整：

```text
quantityXaut = floor_to_common_step(25 * 0.95 / (spotAsk + perpetualBid))
estimatedCapitalRequiredUsd =
  estimatedSpotNotionalUsd
  + estimatedPerpetualNotionalUsd
  + estimatedTakerFeesUsd
  + estimatedSlippageReserveUsd
```

preflight 必须同时证明：

- `totalBudgetUsd === 25`
- `estimatedCapitalRequiredUsd <= 25`
- `estimatedSpotNotionalUsd + estimatedPerpetualNotionalUsd < 25`
- `total_budget` 和 `strategy_cap` 均通过
- 现货与永续数量、最小名义、余额和盘口深度分别通过

服务端 venue 资本硬上限仍为 300 USDT；它只是不可突破的全局上限，不允许把本次 25 USDT
验证提高到 300 USDT。若实时精度或最小名义无法在 25 USDT 内同时满足，停止验证。

计划的组合总资本不超过 25 USDT；短时对冲未完成时，单侧计划名义不超过 preflight 返回的
`max(estimatedSpotNotionalUsd, estimatedPerpetualNotionalUsd)`。25 USDT 不是保证亏损上限：
市场跳空、provider 不可用、部分成交、退出失败或清算仍可能造成超出准备金的损失。专用子账户
不得持有无关订单、XAUT 仓位或多余资产，资金只保留本次报告所需金额和经批准的最小运维准备金。

## 真实窗口前置条件

以下项目必须全部由运维双人核对并留存脱敏结果；任一项未知即停止：

| 项目 | 继续条件 | 停止条件 |
| --- | --- | --- |
| 部署拓扑 | Vultr 单主机、一个 Node API、Compose 无 replicas | 多主机、cluster、PM2 或第二 API |
| 执行租约 | local named volume、锁文件/目录 owner 与 mode 正确、唯一 owner | 网络卷、锁竞争、mount 或 inode 异常 |
| 出口网络 | 服务端配置的精确固定 IPv4 集合与 Binance 返回集合完全相同 | 配置缺失、通配、无限制、查询失败或不匹配 |
| Binance 账户 | 无其他用途的专用子账户，账户身份与绑定记录一致 | 主账户、共享账户或归属不确定 |
| API 权限 | read、Spot trade、Futures trade 开启；withdraw=false | 提现开启、权限无法确认或多余高风险权限 |
| 持仓模式 | one-way、single-asset、USD-M 1x | hedge mode、multi-assets 或模式未知 |
| 产品 | Mainnet 实时确认 XAUTUSDT Spot TRADING 与 USD-M PERPETUAL TRADING | 任一产品不存在、暂停或被替换 |
| 产品约束 | tick、step、最小数量/名义均能在 25 USDT 内满足 | 需要提高预算或手工改数量 |
| 账户状态 | 现货与 Futures 余额分别足够，无 XAUT 存量和活动订单 | 余额混用、已有仓位或活动订单 |
| 市场状态 | 报价新鲜、两侧盘口深度覆盖计划名义 | stale、缺 Bid/Ask、深度不足或异常价差 |
| KMS/WIF | 冻结 CryptoKey、X.509 WIF/ADC、tmpfs、UID/GID/mode/mount 全部通过 | JSON Key、本地主密钥、材料过期或 KMS 不健康 |
| 数据与灾备 | automation data/backup/lock 独立卷，存在本次加密恢复点 | 与 SQLite/WIF 混卷、备份失败或无法验证 |
| 二次验证 | 普通用户已完成 TOTP，恢复码已离线保管 | 未 enrollment、KMS 不可用或恢复材料不完整 |
| 风险开关 | 窗口开始前两层执行开关关闭、用户急停开启、服务端总急停开启 | 状态无法读取或已提前放开 |
| 人员与时间 | 一名操作者、一名复核者、Binance 网页人工退出权限和完整观察窗口 | 无复核者、无法人工登录交易所或窗口不足 |

真实 Docker volume owner/mode、mountinfo、WIF 挂载、双进程租约竞争、容器重建、备份恢复和
旧卷迁移必须先在 Vultr 现场验证。仓库离线测试不能替代这些条件。

## 可保存的证据

只允许保存以下脱敏字段；私有 HTTP 响应均为 `Cache-Control: no-store`：

- 部署 commit、镜像 digest、单实例/卷/mount 检查结果和时间
- credential lifecycle、权限布尔值、account fingerprint、产品状态和检查时间
- preflight 的 quantity、两侧估算名义、总资本、预算、检查结果、生成/过期时间
- execution ID、幂等键的不可逆摘要、状态、策略 order ID/client order ID、成交数量/均价/费率
- PnL 的策略归因两侧数量、net delta、费用、滑点、Funding 与净 PnL
- kill switch、两层执行开关、恢复/人工处理状态和稳定错误类别
- 加密备份严格文件名、manifest hash、创建时间和恢复演练结果

不得保存原始 accountId、完整 API Key、Secret、固定出口 IP、原始 provider response、
authorization token、challenge token、TOTP code、恢复码或 WIF 内容。preflight 原始响应含一次性
challenge token，不得直接写日志或保存为证据；只提取上述白名单字段。

现有接口足以提供证据：

- `GET /api/arbitrage/automation/venues`
- `GET /api/arbitrage/automation/venues/binance/credentials`
- `GET /api/arbitrage/automation/venues/binance/config`
- `GET /api/arbitrage/automation/venues/binance/account`
- `POST /api/arbitrage/automation/preflight`
- `POST /api/arbitrage/automation/execute`
- `GET /api/arbitrage/automation/positions`
- `GET /api/arbitrage/automation/pnl`
- `GET /api/arbitrage/automation/audit`
- `POST /api/arbitrage/automation/venues/binance/close-all`

敏感操作必须通过普通用户会话和现有 UI 完成 step-up；不得把 token 放入 shell history。

## 受控窗口步骤

### 0. 冻结变更与角色

记录部署 commit/镜像、操作者、复核者、窗口起止和人工 Binance 退出负责人。禁止窗口内发布代码、
迁移数据、轮换无关证书或修改产品范围。

继续：两人均在线，人工交易所登录可用。
停止：任何负责人缺席或版本不一致。

### 1. 建立恢复点

保持服务端总急停开启，停止 API，取得同一 automation operation lock，创建自动套利整体加密备份；
SQLite 仍使用独立备份流程。验证 manifest/hash 和异机加密副本后再启动 API。

继续：备份严格成功，API 重启后仍 disarm，用户急停开启，两层执行开关关闭。
停止：备份/KMS/lock/重启任一失败；保留原数据，不做部分恢复。

### 2. 只读部署与身份检查

核对单实例、租约、WIF、KMS health、API 健康和无敏感日志。此时不得录入凭证或关闭服务端总急停。

继续：全部部署门禁通过，无第二执行实例。
停止：租约丢失、身份材料异常、KMS 不健康或日志出现敏感字段。

### 3. 凭证与账户只读验证

项目管理批准真实窗口后，用户只能通过私有 UI 输入 Binance API Key/Secret；不得经聊天或运维日志
转交。验证账户、权限、固定 IP、withdraw=false、one-way、现货/Futures 独立余额、XAUT 存量和
活动订单。轮换后从头重做。

继续：credential lifecycle active，所有前置条件完全匹配。
停止：任一权限、IP、账户、余额、仓位、订单或产品事实不确定；凭证保持不可执行状态。

### 4. TOTP 与初始开关

确认 TOTP enrollment 和恢复码离线保管。保持 global/strategy execution 关闭、用户急停开启。

继续：step-up 正常且恢复路径可用。
停止：验证码重放、限流、KMS、session 或恢复材料异常。

### 5. 临时打开服务端窗口

这一步必须取得项目管理对真实资金窗口的单独确认。由运维将服务端总急停改为允许状态并受控重启；
重启后 challenge、step-up authorization、armed/in-flight 必须为空，用户急停仍开启。

继续：服务仅有一个租约 owner，所有新增风险仍被用户急停和两层开关阻断。
停止：重启恢复出现未知 execution、活动策略订单、XAUT 敞口或 `manual_intervention`。

### 6. 开启用户门禁并执行 preflight

用户通过 TOTP 依次开启 global execution、strategy execution、解除用户急停。服务端重读机会和
私有状态后执行一次 preflight。保存白名单预算证据，不保存 challenge token。

继续：所有 checks 通过，预算精确满足本文定义，报告仍在 60 秒有效期内。
停止：任何 warning 未被人工理解、任何 check 失败、产品/价格/余额变化或报告过期。

### 7. 人工确认并建立对冲组合

复核者逐项对照 preflight。用户通过独立 TOTP step-up 执行一次；服务端继续要求同一 challenge、
session、账户、venue、请求摘要、名义金额和幂等键。禁止重发不同幂等键。

继续：权威状态确认现货侧与永续侧订单均属于策略 client order ID，成交数量形成允许误差内的组合。
停止：任一状态 New/Unknown/Rejected/超时、部分成交未闭环、租约/KMS/IP 失效或预算字段变化。

### 8. 权威核对与异常补偿

通过 positions/PnL 和 Binance 网页分别核对策略订单、成交、现货数量、永续数量、net delta、费用和
Funding。系统异常补偿只操作策略订单与策略归因仓位。

继续：execution 为 `hedged`，无活动策略订单，两侧数量匹配，证据完整。
停止：`compensating`、`failed`、`manual_intervention` 或权威状态不一致。立即激活用户急停、关闭
两层执行开关并在 Binance 人工核对；不得再次建立组合。

### 9. 退出与 PnL

用户使用新的幂等键和独立 TOTP step-up 执行 close-all。系统最多按冻结策略重试退出，并只撤销/
退出策略归因订单和仓位。

继续：execution 为 `closed`，openOrders 为空，两侧数量为零，net delta 为零或在产品最小精度下
不可交易，PnL/费用/滑点/Funding 已记录。
停止：退出超时、剩余数量可交易、状态未知或 `manual_intervention`。保持急停，转 Binance 人工退出。

### 10. 关闭窗口与回滚

先关闭 global/strategy execution 并激活用户急停，再恢复服务端总急停并受控重启。导出白名单证据，
创建退出后的第二个加密备份。只有权威状态确认无策略仓位和活动订单后，才允许应用版本回滚。

继续：四个门禁均回到默认 fail-closed，重启无自动建立组合。
停止：任何残余状态未知；不恢复旧数据，不删除当前凭证或 execution 记录。

## 重启与故障规则

- challenge、step-up authorization、armed 和 in-flight 在重启后失效，必须重新授权。
- `accepted/opening_spot/opening_perpetual/compensating` 会按策略 ID 查询并尝试安全退出，不会重放
  建立组合。
- 正常 `hedged` 记录不会因重启自动退出；重启后必须先权威读取，再由用户决定 close-all。
- KMS/WIF 不可用时不能承诺自动退出；进入 `manual_intervention` 后由人工在 Binance 处理。
- 租约失效后旧实例不得继续任何 provider 调用；新 owner 只按持久 reservation 恢复。
- 服务端总急停、用户急停或关闭执行开关不应阻止已授权的受控退出，但无租约实例不得并发退出。

## 零资金离线 rehearsal

在干净开发环境运行：

```bash
npm run test:rwa-mainnet-readiness
```

脚本在启动测试前拒绝 production、关闭服务端总急停、真实 ADC、本地主密钥、固定出口 IP 或常见
Binance credential 环境变量；随后只运行 fake KMS/provider、临时目录和公开测试值。

覆盖映射：

- 正向组合、25 USDT 合计预算与 300 USDT 硬上限
- 首次 provider mutation 失败且零订单/零仓位
- 永续侧失败后的现货侧补偿退出
- 现货侧部分成交后按权威成交量建立永续侧
- 权威订单超时、撤单和零未对冲仓位
- close-all 部分成交重试、退出失败转人工处理并激活用户急停
- 未完成 execution 的重启恢复与 challenge disarm
- 租约竞争、路径替换和首次写后失效
- KMS/WIF/AAD/权限故障、固定 IP 不匹配、TOTP 错码/重放/过期
- 凭证隔离、Secret 脱敏、策略订单/PnL 归因和灾备恢复

该命令不是 Mainnet 验证，不会证明 Vultr、真实 WIF、真实 Binance 产品、真实账户或真实资金可用。

## 受控窗口仍需外部提供

- Vultr 现场 Docker/mount/volume/UID/GID/租约验证结果
- 经核对的固定出口 IPv4，仅写服务端受限配置，不发到聊天
- Binance 专用子账户及用户自行在私有 UI 输入的 API Key/Secret
- Binance 网页中提现关闭、权限、IP 白名单和 one-way 模式的人工复核
- GCP WIF 实际 audience/provider、短期证书和 KMS IAM 健康结果
- TOTP enrollment 用户、离线恢复码保管人和人工 Binance 退出负责人
- 项目管理对真实 25 USDT 窗口、开始时间和停止条件的单独确认

未取得上述材料或真实产品无法在 25 USDT 内满足约束时，本次验证保持取消状态。
