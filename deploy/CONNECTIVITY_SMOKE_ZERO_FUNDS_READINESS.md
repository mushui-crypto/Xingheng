# connectivity_smoke 零资金现场准备与受控窗口门禁

## 适用范围与当前授权

本文用于 `connectivity_smoke` 的 Security/DevOps 零资金准备、双人现场核验和只读 UI 环境验收。
本文不授权录入真实交易凭证、连接 Mainnet 私有接口、解除任何执行开关或急停、执行 provider
mutation、部署、发布或开启资金窗口。真实窗口必须由项目管理另行明确授权。

冻结范围为 Binance Mainnet 专用空白子账户、`XAUTUSDT`、计划资本不超过 25 USDT、单次
execution、建立后立即退出。该流程是 `nonAtomic/incomplete`：最多只能证明“用户承诺的独占运维
窗口；截至 scanner cutoff 未发现 REST 可见外部活动”，不能证明账户锁定、原子隔离或完全排他。
scan cutoff 竞态、REST 历史延迟、同净额往返不可见、资产可替代以及退出失败均为残余风险；
25 USDT 不是最大损失保证。

## 仓库审计结论

截至本文件建立时，可由仓库静态证明：

- 正式环境身份固定为 `production / xingheng`，真实测试身份固定为
  `real-test / xingheng-real-test`；前端只接受这两组 `/api/health` 精确组合。
- 正式与真实测试 Compose 均固定单 API、`WEB_CONCURRENCY=1`、single-host execution、独立 local
  named lock volume，并把 `RWA_AUTOMATION_SERVER_KILL_SWITCH` 固定为 `true`。
- 正式与真实测试使用不同 env、Compose project、WIF 路径、volume、cookie namespace 和域名；
  root 运维入口及 Compose wrapper 拒绝测试 seam、环境污染、拓扑 override 和直接 build。
- WIF/KMS、自动套利数据/备份/lock 分卷、`flock`、备份恢复、日志脱敏和固定出口 IP 的
  fail-closed 契约已存在；离线测试不能替代真实 Linux、Docker daemon、WIF/KMS、网络或交易所
  现场证据。
- `connectivity_smoke` 已有独立 policy/preflight/execute/exact lookup/status/receipt 契约；
  scanner 证据始终为 `nonAtomic/incomplete`。

本地工作区不存在 `.env.production`、`.env.real-test` 或 `deploy/release-manifest.json`。这只说明
当前代码工作区没有现场输入，不能据此判断服务器是否已部署。任何现场项在取得脱敏收据前均保持
`field-pending`。

## 零资金现场准备 Checklist

以下检查不得读取、回显或保存 secret 值。只记录时间、完整 revision/digest、布尔结果、稳定错误
类别及必要的不可逆 fingerprint；不得记录 UID、完整账户标识、固定 IP 明细、token、credential
envelope、TOTP、WIF 内容或 provider 原始响应。

### A. 人员、授权与变更冻结

- [ ] 当前 Owner、操作者、复核者和未来人工退出负责人均已登记；本轮授权仍为零资金、零 mutation。
- [ ] 没有真实 Binance credential；没有 Mainnet private API 请求；没有 provider mutation。
- [ ] 服务端总急停开启，global/strategy execution 关闭，用户急停开启。
- [ ] 窗口内禁止发布、迁移、轮换无关材料、修改 symbol/预算/账户或启用第二执行实例。
- [ ] 任何新增基础设施、真实 secret、部署或外部权限需求均已停止并回传 Product-Technical Lead。

### B. Release、Linux 单实例与租约

- [ ] release manifest 为不可变、单硬链接、非 symlink 的 `0444` regular file；revision 和三个
  image digest 与批准 release 完全一致，生产 Compose 不含 `build:`。
- [ ] Vultr 只有一个主机、一个 API 容器、一个 Node execution；无 replicas、PM2、cluster、
  orphan/one-off API 或第二主机副本。
- [ ] API 固定 `WEB_CONCURRENCY=1`、`RWA_AUTOMATION_EXECUTION_MODE=single-host`、
  `RWA_AUTOMATION_INSTANCE_COUNT=1`。
- [ ] lock 是 local named volume，不是 bind、NFS、CIFS、9p、Ceph、GlusterFS、FUSE 或远端卷；
  mountinfo、Compose schema 与运行容器 mount 三方一致。
- [ ] lock 目录/文件 owner、mode、inode、nlink 和只读目录边界正确；第二 API/进程竞争同一
  `flock` 时必须 fail-closed，且不得初始化 KMS、provider 或恢复流程。
- [ ] 租约 FD/inode 在每个 provider mutation 前后均复核；租约失效后旧 owner 不得继续任何
  provider 调用。

### C. WIF/KMS、出口与权限

- [ ] 正式和真实测试分别使用独立 WIF audience/certificate bundle 与独立 KMS CryptoKey；不使用
  Service Account JSON key、本地主密钥或明文降级。
- [ ] WIF 位于各自 `/run/.../gcp-wif` tmpfs，容器内只读挂载；目录及五文件的 UID/GID/mode、
  regular/non-symlink、audience、证书有效期和 KMS health 均通过现场验证。
- [ ] 固定出口只在服务器受限配置与 Binance 私有 UI/API 内核对；两端精确 IPv4 集合相同，无
  CIDR、通配、无限制或额外地址。证据只保存 PASS/FAIL，不保存 IP 明细。
- [ ] 未来真实窗口使用无其他用途的专用空白子账户；API 权限仅 read、Spot trade、Futures trade，
  `withdraw=false`，无多余高风险权限。
- [ ] Binance UI 与 API 对提现关闭、IP 白名单、one-way、single-asset、USD-M 1x 做双人核对；
  任一来源不可读、不一致或不新鲜即停止。

### D. 数据、灾备、日志与告警

- [ ] automation data、backup、lock 与 SQLite、strategy、WIF 分离；owner/mode/mount 与容量边界
  均通过。
- [ ] 同一 operation lock 下的加密备份、manifest/hash、异机副本、隔离卷 verify/restore/rollback
  演练通过；恢复后 global/strategy 关闭、用户急停开启、challenge/armed/in-flight 清空。
- [ ] API 重建、宿主重启后 WIF tmpfs 重注入、双进程竞争、租约首次写后失效和未完成 execution
  恢复演练均有脱敏收据。
- [ ] 日志抽检不含 API Key、Secret、UID、IP 明细、authorization/challenge/step-up token、TOTP、
  WIF、credential envelope、provider raw response 或私有 HTTP body。
- [ ] 告警至少覆盖 API/lease 退出、KMS/WIF 不可用、备份/恢复失败、`manual_intervention`、
  provider snapshot stale/unavailable/ambiguous、急停变化和残余非零；告警正文同样脱敏。

## 只读 UI 环境结论与准备方案

允许 Frontend 登录后浏览器验收的唯一现有 runtime 方案是已批准并正确部署的真实测试环境：

- `/api/health` 必须精确返回 `deploymentEnvironment=real-test` 与
  `composeProject=xingheng-real-test`，且 revision 与 release manifest 一致。
- 使用 `scripts/real-test-compose.sh` 和 `.env.real-test`，不得把 development 伪装成 real-test，
  不得修改前端 allowlist，也不得直接使用 `docker compose` override 身份。
- 保持服务端总急停开启；不写入 Binance credential，不配置真实交易权限；global/strategy
  execution 保持关闭、用户急停保持开启。
- `RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS` 保持空；不得执行 provider identity preflight、
  credential validation、account private read、connectivity preflight/execute 或任何 mutation。
- 只允许登录、环境标签、导航、空态/不可执行态、公开数据和不触发 provider 的本地只读页面验收。
  浏览器 Network 必须确认敏感响应 `no-store`，且没有 Binance private endpoint 请求。

当前仓库没有可在已部署 real-test runtime 安全注入的 UI contract fixture。现有 fake console 属于
测试代码，没有 production/real-test 选择入口；root 运维 wrapper 也明确拒绝测试 seam。因此：

- 若只验收空态/不可执行态，部署已批准的 `xingheng-real-test` 即为最小方案，但当前仍需独立的
  部署授权、real-test WIF/KMS/DNS/TLS/release 输入和现场收据；本任务不执行部署。
- 若必须验收带 account metadata、policy discovery 或完整 connectivity smoke 数据的登录后页面，
  当前无“无真实凭证”的已批准 runtime fixture 路径。需要 Product-Technical Lead 另立任务，
  由 Frontend/Backend 明确设计仅 real-test 可用、零 provider 的受控 fixture 契约并经过安全审查；
  在此之前不得借测试 fake client、伪造 health 或录入 Mainnet secret 达成验收。

## 未来 Mainnet 受控窗口双人 Checklist

本节仅冻结未来操作顺序，不构成当前授权。每一项必须由操作者执行、复核者独立确认并记录脱敏
PASS/FAIL 与时间；任一未知、超时或人员离线立即停止。

### 1. 开始前

- [ ] 项目管理已对本次真实窗口单独明确授权；操作者、复核者、人工退出负责人同时在线。
- [ ] 专用子账户在 Binance UI 与 private API 双确认：Spot XAUT total/free/locked 为 0、Futures
  XAUT position 为 0、两侧 XAUT open orders 为 0；不得表述为“账户已锁定”。
- [ ] 权限、固定出口、WIF/KMS、单实例/租约、备份恢复、日志告警及四层 fail-closed 门禁全部通过。
- [ ] 用户明确承诺窗口内不使用 Binance UI、其他 API Key、转账或其他系统操作 XAUT。
- [ ] policy version/digest、`nonAtomic/incomplete` 风险、单 execution、立即退出和人工恢复责任已
  双人确认；preflight 新鲜且总计划资本不超过 25 USDT。

### 2. 每次 provider mutation 前后

- [ ] 前：复核租约 FD/inode、账户快照、四个固定 `rwacs` client ID、scanner 全来源 coverage、
  cutoff、新鲜度和无 REST 可见外部 XAUT 活动。
- [ ] 前：scanner 来源失败、分页不完整、非法值、归属不明、非 `rwacs` 活动、snapshot
  stale/unavailable/ambiguous 时 provider mutation 必须为 0。
- [ ] 后：读取 provider 权威订单终态、成交、position、余额与 open orders；确认数量未超过 smoke
  账本，记录新的 scanner cutoff。
- [ ] 后：只声明“截至该 cutoff 未发现 REST 可见外部活动”；不得声明原子隔离、完全排他或账户
  锁定。任何异常立即停止后续写、激活用户急停并进入人工核对。

固定 mutation 顺序仅可为：Spot IOC Buy → Futures IOC Sell → Futures reduce-only Buy →
Spot Sell。退出授权必须在首次 mutation 前与 reservation、`noReopen=true` 一并持久化；恢复只允许
降低风险，不得补仓或重新开仓。

### 3. `manual_intervention` 与人工接管

- [ ] provider、租约、KMS、scanner 或权威归属无法确认，或自动退出不能闭环时，立即停止自动写、
  激活用户急停并保持 global/strategy 关闭。
- [ ] 不重放 execute、不换幂等键、不删除 execution/credential/审计、不恢复旧业务数据，也不以
  代码回滚或清卷替代退出。
- [ ] 人工退出负责人在 Binance UI 核对并按风险降低原则先平 Futures、再卖 Spot；只处理本次
  专用空白子账户的 XAUT，不推断未知订单归属。
- [ ] 保留稳定错误类别、最后 verified snapshot/cutoff、四个 smoke order 槽位和人工动作时间；
  不保存敏感标识或原始 provider response。

### 4. 最终 flat 与关闭窗口

- [ ] 系统只读 status/receipt fresh verified：Spot/Futures residual 均为 0，两侧及 total open
  orders 均为 0，`providerFlatConfirmed=true`。
- [ ] Binance UI 独立确认 Spot XAUT total/free/locked 为 0、Futures XAUT position 为 0、两侧
  XAUT open orders 为 0；系统证据与 UI 证据必须由两人分别确认。
- [ ] 若数量低于交易最小精度但不为绝对 0，不得签发成功 flat 结论；保持人工处置与窗口未关闭。
- [ ] 先关闭 global/strategy、激活用户急停，再恢复服务端总急停并受控重启；重启后再次确认四层
  fail-closed、无自动 reopen、无未知 execution。
- [ ] 创建退出后加密恢复点并验证 hash/异机副本；证据导出仅包含白名单字段。

### 5. 事故回滚与恢复门禁

- [ ] 未最终 flat 前禁止应用版本回滚、数据恢复、credential 删除、volume 清理或环境销毁。
- [ ] 最终 flat 且当前状态/证据已持久化后，版本回滚仍必须使用冻结 release operation 和回滚
  runbook；不得恢复旧 automation state 覆盖当前 execution 事实。
- [ ] 恢复结果必须保持 server kill switch 开启、global/strategy 关闭、用户急停开启，且不恢复
  challenge、step-up authorization、armed 或 in-flight。
- [ ] 事故关闭只有在双人确认 provider flat、四层门禁复位、备份可恢复、告警已归档后完成；
  任一项未知则任务状态保持阻塞/人工处理中，不得标记成功。

## 当前证据状态

| 门禁 | 仓库/离线结论 | 现场状态 |
| --- | --- | --- |
| runtime identity 与双环境隔离 | 静态契约存在 | `field-pending` |
| Linux 单实例、local volume、flock/lease | 静态契约与 Linux fixture 存在 | `field-pending` |
| WIF/KMS、证书、IAM health | 安装与校验契约存在 | `field-pending` |
| 固定出口、提现关闭、专用子账户 flat | fail-closed 契约存在 | `field-pending`，且本轮禁止调用 |
| 自动套利备份/恢复/回滚 | 加密与隔离契约存在 | 真实 KMS/异机/容器演练 `field-pending` |
| 日志脱敏与告警 | 脱敏边界已冻结 | 真实日志/告警链路 `field-pending` |
| connectivity scanner 与最终 flat | exact 契约与测试存在 | Mainnet 私有证据 `field-pending`，且本轮禁止调用 |
| 登录后只读 UI | real-test 身份方案存在 | 环境部署可用性 `field-pending`；数据型 fixture 不存在 |

所有 `field-pending` 项完成前，不得宣称 Mainnet readiness 通过，不得录入真实交易凭证或申请开启
资金窗口。
