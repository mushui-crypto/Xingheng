# 任务信息

## 基础信息

任务名称：独立 real-test 零资金基础设施、WIF/KMS 与部署接续

任务编号：TASK-001

创建时间：2026-07-28 09:07 CST

创建人：Product-Technical Lead

------------------------------------------------------------------------

# Owner 信息

当前 Owner：Product-Technical Lead

角色：任务协调、审批与 Owner 交接负责人

下一 Owner：Security DevOps Engineer（批次 C，待用户独立授权）

交接状态：

-   B4-R1 复审通过回传已接收；批次 C 尚未授权或交接

------------------------------------------------------------------------

# 任务目标

## 背景

StellaX 需要在独立 GCP 项目 `xingheng-real-test` 中建立单 VM real-test 环境，用于零资金、
零交易所凭证、零 Mainnet private API 和零 provider mutation 的部署与 UI 验收。独立公网入口、
real-test WIF 安装路径、激活成功门禁和 KMS 项目隔离修复已完成开发、Review 与主分支集成。
GCP 基础设施、real-test KMS、Workload Identity Pool 和架构复核后的 X.509 Provider 已创建；
IAM、叶证书、五文件、STS/KMS probe、DNS/TLS 和部署仍未执行。

## 目标

1. 完成并合并 real-test KMS 项目隔离修复。
2. 在 `xingheng-real-test` 中建立独立 X.509 Workload Identity Federation（WIF）身份、
   短期客户端证书与单一用途 Cloud KMS CryptoKey。
3. 以最小 IAM 权限让 real-test workload identity 仅能对指定 CryptoKey 执行
   `roles/cloudkms.cryptoKeyEncrypterDecrypter`，虚拟机服务账号不得取得 KMS 权限。
4. 完成受信 Linux/Docker、release、volume、WIF/KMS、DNS/ACME/TLS、日志告警和回滚现场证据。
5. 在全部交易门禁保持关闭的前提下部署 real-test，并完成登录入口、环境身份、
   connectivity-smoke 空态/不可执行态验收。

## 非目标

-   不录入 Binance 或其他交易所真实凭证。
-   不调用 Mainnet private API，不进行 provider mutation 或资金操作。
-   不解除 server/global/strategy/user kill switch。
-   不复用 production WIF、KMS、证书、账户、volume 或 cookie namespace。
-   不创建 Service Account JSON key，不使用本地主密钥或明文凭证降级。
-   不把 real-test 解释为 Binance Testnet；connectivity-smoke 仍固定 Mainnet，当前仅做零资金环境准备。
-   不执行普通套利 `/preflight`、`/execute`、`close-all` 或 connectivity-smoke execute。

------------------------------------------------------------------------

# 任务等级

Level：Level 3（架构审查）

判断依据：涉及部署架构、云 IAM、X.509 WIF、Cloud KMS、安全身份、公开 HTTPS 入口和未来交易执行门禁。

架构状态：Architecture Reviewer 已批准独立 GCP 单 VM real-test 拓扑，并在批次 B2 失败后
唯一冻结 X.509 Provider ID `rwa-api-x509`。独立入口、WIF 安装路径和 KMS 项目隔离修复均已完成
Level 3 Code Review 并进入 `origin/main`。批次 B3 Provider 已按冻结身份模型创建并验收。

------------------------------------------------------------------------

# 影响范围

涉及：

-   前端：仅后续空态/不可执行态浏览器验收；不改交易 UI 语义。
-   后端：real-test 冻结 KMS CryptoKey 完整资源名与运行时 fail-closed 校验。
-   数据：本地 Docker named volumes、SQLite/RWA/strategy 独立卷、加密备份与恢复证据。
-   部署：独立 GCP VM、standalone Compose、Caddy HTTPS、release manifest、Docker、DNS。
-   安全：IAP、OS Login/2FA、WIF、Certificate Authority Service、KMS、IAM 最小权限、日志脱敏。
-   交易逻辑：不修改交易逻辑；所有交易门禁继续关闭。

相关文件：

-   `.env.real-test.example`
-   `compose.real-test.yaml`
-   `compose.real-test-standalone.yaml`
-   `deploy/Caddyfile.real-test-standalone`
-   `deploy/PRODUCTION_REAL_TEST_DUAL_ENVIRONMENT_RUNBOOK.md`
-   `deploy/CONNECTIVITY_SMOKE_ZERO_FUNDS_READINESS.md`
-   `scripts/real-test-standalone-compose.sh`
-   `scripts/activate-real-test-release.sh`
-   `scripts/install-gcp-wif.sh`
-   `scripts/verify-deployment-revision.mjs`
-   `scripts/verify-real-test-web-health.sh`
-   `server/modules/arbitrage/automation/CredentialKeyProvider.ts`
-   `server/modules/arbitrage/automation/GcpKmsCredentialKeyProvider.test.ts`

------------------------------------------------------------------------

# 当前状态

状态：批次 B4-R1 复审通过，无 P0-P3；批次 C 待独立授权

Git 状态：

-   当前分支：`develop`
-   B4 提交前 HEAD / `origin/develop`：`de84309f78e26836def189e2ba48b8dab2b701fa0`
-   `origin/main`：`623d5d1fa888ad0dbbbe56ce6ee9754a72bfc0db`
-   `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0` 已完成 Code Review，并与任务记录提交
    `de84309f78e26836def1896aa8015cd2bbb95fdb` 一并通过 merge commit
    `623d5d1fa888ad0dbbbe56ce6ee9754a72bfc0db` 进入 `origin/main`。
-   工作区另有用户既有 `TASK_TEMPLATE.md`、`项目沟通规则.md` 修改；禁止覆盖、暂存或纳入其他提交。

------------------------------------------------------------------------

# 执行记录

## 已完成

### 代码、Review 与发布链

-   connectivity-smoke 后端、policy discovery、status/receipt、exact lost-response lookup、
    前端受控控制台及 runbook 已完成既定 Review 与提交链。
-   React Router 已最小升级到 7.18.1；剩余 RSC-only advisory 仅在当前静态 Declarative SPA
    架构下登记为不可达例外，架构变化时必须重审。
-   `2a59f2e06470c31bc64e168ec749bd08073812f1`：
    新增独立 real-test standalone 80/443 HTTPS 入口、受信 Compose/激活路径和
    production/real-test WIF 安装路径枚举。
-   `89d001f3c629aed50d7bee1b920dafe791de4655`：
    激活仅在 API/Web healthy、实际拓扑与身份/revision/no-store 精确匹配后成功；
    任一 post-up 失败停止 API/Web。Code Review 已通过。
-   `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0`：
    将 real-test KMS 路径从错误的 production 项目迁到
    `projects/xingheng-real-test/locations/asia-southeast1/keyRings/xingheng-rwa-real-test-sg/cryptoKeys/exchange-credentials`；
    production 常量未改。Code Review 已通过并已进入 `origin/main`。
-   KMS 隔离修复验证：
    - `NODE_ENV=test ...GcpKmsCredentialKeyProvider.test.ts`：14/14 通过。
    - 双环境：7/7 TypeScript + 25/25 Node 通过。
    - `npm run deploy:validate`：通过。
    - Server TypeScript 与四文件 diff check：通过。

### GCP 现场资源

-   专用 GCP 项目 `xingheng-real-test` 已创建，结算已启用，预算提醒已创建。
-   自定义 VPC `xingheng-real-test-vpc` 已创建。
-   新加坡子网 `xingheng-real-test-sg-subnet` 已创建，区域 `asia-southeast1`，
    IPv4 CIDR `10.30.0.0/24`。
-   IAP SSH 防火墙规则与 Web 80/443 防火墙规则已创建；公网 22 未开放。
-   OS Login、2FA 与 IAP/OS Login IAM 已配置并通过 Google Prompt 登录验证。
-   专用虚拟机服务账号已创建；不得授予 KMS 权限。
-   静态外部 IPv4 资源 `xingheng-real-test-public-ip` 已预留并绑定 VM；任务文档不记录具体地址值。
-   VM `xingheng-real-test-01` 已创建并运行：
    - zone：`asia-southeast1-b`
    - 规格：`e2-standard-2`（2 vCPU / 8 GB）
    - OS：Debian 12 amd64
    - 启动盘：50 GB `pd-balanced`
    - 标签：`application=stellax`、`environment=real-test`、`role=single-host`
    - 删除保护已启用，Shielded VM 的 vTPM 与完整性监控已启用。
-   VM 现场只读核验：
    - OS/架构/CPU/内存/磁盘符合预期。
    - Ops Agent active。
    - OS Login guest agent manager/compat manager active。
    - 无 80/443/8787 listener。
    - Docker Engine 29.6.2 已安装、active 且 enabled；尚未安装应用 release 或启动 StellaX 容器。
-   域名确定为 `test.stellaxtrade.com`，DNS 托管在 Cloudflare；A/AAAA 记录和代理模式尚未记录为完成。
-   Certificate Authority Service API 已启用。
-   CA Pool `xingheng-real-test-wif` 已创建：
    - location：`asia-southeast1`
    - tier：DevOps
-   Root CA `xingheng-real-test-root-ca` 已创建并确认状态“已启用”：
    - Root CA
    - RSA PKCS1 4096 / SHA-256
    - 10 年有效期
    - Google-managed key
-   real-test Cloud KMS 已创建并验收：
    - KeyRing：
      `projects/xingheng-real-test/locations/asia-southeast1/keyRings/xingheng-rwa-real-test-sg`
    - CryptoKey：
      `projects/xingheng-real-test/locations/asia-southeast1/keyRings/xingheng-rwa-real-test-sg/cryptoKeys/exchange-credentials`
    - `purpose=ENCRYPT_DECRYPT`、`protectionLevel=SOFTWARE`、`rotationPeriod=90d`
    - `nextRotationTime=2026-10-26T00:00:00Z`、`destroyScheduledDuration=30d`
    - 仅一个初始 `ENABLED` 版本，算法 `GOOGLE_SYMMETRIC_ENCRYPTION`
-   Workload Identity Pool
    `projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test`
    已创建，状态 `ACTIVE`。
-   X.509 Provider 创建历史已保留：
    - 批次 B 与 B1：Provider 创建均因 TrustAnchor PEM format `INVALID_ARGUMENT` 失败；
      Pool 保持隔离，Provider 未创建。
    - 批次 B2：官方双引号、转义换行、解析后无尾随 LF 的 trust store 静态门禁全部通过，
      但冻结 ID `gcp-vm-x509` 因 `gcp-` 为 Google 保留前缀被拒绝；未重试。
    - Architecture Reviewer 随后唯一冻结 Provider ID `rwa-api-x509`，不改变 Root、mapping、
      condition、subject 或 IAM 模型。
    - 批次 B3 单次创建成功，Provider
      `projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509`
      为 `ACTIVE`、`disabled=false`、type `X509`。
    - mapping 精确为 `google.subject=assertion.subject.dn.cn`。
    - condition 精确为
      `assertion.subject.dn.cn == 'xingheng-rwa-api-real-test' && assertion.san.uri == 'spiffe://stellaxtrade.com/real-test/rwa-api'`。
    - Root SHA-256 指纹为
      `AA:B8:C0:C0:47:66:1F:1E:D2:B8:98:5B:6E:46:25:D3:F7:F1:2B:CA:85:D9:B9:21:51:B1:C4:C7:3A:44:F0:5F`。
    - 当前 audience 为
      `//iam.googleapis.com/projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509`。
    - Pool/Provider/KeyRing/CryptoKey IAM 均为空；VM 服务账号在 project/KeyRing/CryptoKey
      均无 KMS binding。批次 C 未执行。

## 未完成

1. 批次 C 尚未授权或执行。Pool/Provider/KeyRing/CryptoKey IAM 仍为空；必须另批仅在单一
   CryptoKey 资源层级向冻结的 workload identity principal 授予唯一
   `roles/cloudkms.cryptoKeyEncrypterDecrypter`，VM 服务账号继续不得获得 KMS 权限。
2. 批次 D 尚未授权或执行。尚未在 VM 的 root-only 路径生成 leaf 私钥/CSR；尚未签发
   P30D clientAuth 叶证书、
   导出 root trust chain、生成 `adc.json`/`certificate_config.json` 或安装五文件 tmpfs bundle。
3. 批次 E 尚未授权或执行。尚未执行真实 STS token exchange 或仅限目标 CryptoKey 的 KMS
   health probe。
4. 批次 F 尚未授权或执行。受信 operation launcher、canonical release tree/manifest/env、
   named volumes、flock/lease、备份恢复与回滚尚未在 VM 安装或验证。
5. 批次 G 尚未授权或执行。Cloudflare DNS、ACME、公网证书链、HTTPS
   health/revision/no-store 尚未验证。
6. 批次 H 尚未授权或执行。real-test 尚未部署，浏览器登录、环境标签、导航及
   空态/不可执行态验收尚未执行。
7. 日志脱敏、VM/container/HTTPS/disk/OOM/backup/WIF/KMS 告警与恢复收据尚未完成。
8. `.env.real-test`、root-only audience、ADC、certificate config 和任何 secret 文件均尚未创建；
   不得在聊天或仓库记录其敏感内容。
9. 所有交易门禁继续关闭：服务端总急停开启，global/strategy execution 关闭，用户急停保持；
    不录入真实交易凭证，不调用 Mainnet private API，不执行 provider mutation 或资金动作。

## 当前问题

-   B4 初审发现 audience 最终路径使用普通重定向，可能在 verifier 拒绝前覆盖既有链接目标；
    B4-R1 已改为排他、no-follow 创建并执行结构化文件契约核验，同一 Code Reviewer 复审通过，
    无 P0-P3。批次 C 仍须用户独立授权，不能把文档更新解释为 IAM 授权。
-   Provider ID/full resource/audience 已冻结为 `rwa-api-x509` 契约；历史失败 ID
    `gcp-vm-x509` 只能保留在明确标注的失败记录中，不得作为当前配置。
-   VM 正在运行并持续计费；CA Pool/Root CA、静态 IP、磁盘、日志等资源也可能产生持续费用。

------------------------------------------------------------------------

# 决策记录

关键决策：

1. real-test 使用独立 GCP 项目、单 zone 单 VM、SQLite、本地 Docker named volumes 与单实例 flock/lease。
2. 区域统一为 `asia-southeast1`，VM zone 为 `asia-southeast1-b`。
3. 公网入口使用 VM 静态 IPv4 + Caddy 自动 HTTPS；管理面只允许 IAP + OS Login + 2FA。
4. production 与 real-test 的 KMS、WIF、证书、域名、volume、cookie、provider account 必须隔离。
5. VM 服务账号只用于基础日志/监控，不持有 KMS 权限；应用通过 X.509 WIF 获取短期身份。
6. WIF workload identity 仅对一个 real-test CryptoKey 获得
   `roles/cloudkms.cryptoKeyEncrypterDecrypter`，不得授予项目级 KMS 管理权限。
7. 叶私钥只能在 VM root-only 路径生成/保存，再原子安装到
   `/run/xingheng-real-test/gcp-wif` tmpfs；不得进入仓库、聊天、env、镜像或备份。
8. 当前阶段严格零资金、零交易凭证、零 Mainnet private API、零 provider mutation；
   所有 kill switch 保持 fail-closed。
9. real-test X.509 Provider ID 唯一为 `rwa-api-x509`；完整资源名为
   `projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509`，
   对应 audience 仅在前方增加 `//iam.googleapis.com/`。`create-cred-config` 使用无该前缀的
   Provider 完整资源名；ADC、服务端 env 和 root-only audience 文件使用带前缀的完整 audience。
10. 批次 B3 只创建 Provider，不自动进入 IAM。批次 C/D/E/F/G/H 均须独立批准，任一阶段
    证据不完整即停止。

影响：

-   旧的 production 项目 real-test KMS 路径在修复合并后会被明确拒绝。
-   real-test 部署只能在 WIF/KMS、受信 release、volume/lease、DNS/TLS 和回滚证据全部通过后激活。
-   任一身份、权限、证书、KMS、provider、lease 或恢复证据不完整均停止，不允许以手工降级绕过。

------------------------------------------------------------------------

# Agent 交接信息

【任务名称】

独立 real-test 零资金基础设施、WIF/KMS 与部署接续

【当前 Owner】

Product-Technical Lead

【下一 Owner】

Security DevOps Engineer（批次 C，待用户独立授权）

【任务目标】

审查 `.env.real-test.example`、real-test runbook/readiness 和本任务记录是否与已创建的
`rwa-api-x509` Provider 及 exact audience 一致，确认未修改 production 常量、脚本逻辑、实际 env
或云资源。Review 通过后交回 Product-Technical Lead，再单独申请批次 C。

【当前状态】

批次 B4-R1 已经同一 Code Reviewer 复审通过，无 P0-P3。独立入口、健康门禁和 KMS
项目隔离修复已进入 `origin/main`；
KMS、Workload Identity Pool 与 `rwa-api-x509` Provider 已创建并验收。IAM 仍为空，
叶证书/五文件、probe、release、DNS/TLS 和部署均未执行。

【已完成内容】

见“执行记录 / 已完成”。本批次重点是：

-   `.env.real-test.example` 已冻结 exact audience。
-   real-test runbook 已区分 Provider full resource 与带前缀 audience，并冻结
    `create-cred-config`/五文件逻辑路径。
-   readiness 已加入 `rwa-api-x509` exact-set 和 audience 门禁。
-   本任务记录保留 B/B1/B2 失败历史，并追加 Architecture Review、B3 成功、IAM 为空和后续批次状态。

【未完成内容】

见“执行记录 / 未完成”。当前第一步是由 Product-Technical Lead 取得批次 C 的独立用户授权；
不得把 B4 Review 通过解释为 IAM 写操作获批。

【涉及文件/模块】

-   `.env.real-test.example`
-   `deploy/PRODUCTION_REAL_TEST_DUAL_ENVIRONMENT_RUNBOOK.md`
-   `deploy/CONNECTIVITY_SMOKE_ZERO_FUNDS_READINESS.md`
-   `docs/tasks/TASK-001.md`

严禁触碰、暂存、覆盖或回退用户既有 `TASK_TEMPLATE.md`、`项目沟通规则.md` 修改。

【关键决策】

Provider ID 唯一为 `rwa-api-x509`；`create-cred-config` 使用无 `//iam.googleapis.com/` 前缀的
Provider full resource，ADC/env/audience 文件使用带前缀 audience。历史 `gcp-vm-x509`
仅作为失败记录。IAM 与后续批次不因本地一致性更新自动获批。

【风险事项】

-   Provider 已存在，但 IAM、证书、ADC 和 probe 尚未建立；不得把 `ACTIVE` 解释为可执行。
-   文档中的 credential-config 命令仍是未来受控批次预览，版本化 cert/key 名必须在批次 D 冻结。
-   DNS/ACME/TLS、release、volume、备份恢复、回滚和告警仍为 `field-pending`。
-   所有交易门禁保持关闭；任何真实凭证、急停解除、执行开关或资金窗口均未授权。

【待确认事项】

1. 由 Product-Technical Lead 是否发起独立批次 C IAM 审批。
2. 批次 D 的版本化 cert/key ID、签发与五文件现场命令仍须按既定 P30D/T-7d 方案冻结。
3. Cloudflare A-only、DNS-only、TTL=300 的后续执行批次和 DNS/ACME 顺序仍须单独批准。

------------------------------------------------------------------------

# Review 记录

Reviewer：Architecture Reviewer

时间：2026-07-28

结果：通过独立 GCP 单 VM real-test 拓扑；要求独立入口与 real-test WIF 路径补丁完成 Level 3 Review。

问题：原仓库只支持 production 同机 ingress，WIF 安装路径只支持 production；现已由
`2a59f2e...` 与 `89d001f...` 关闭。

Reviewer：Code Reviewer

时间：2026-07-28

结果：`2a59f2e...` 初审发现激活健康门禁 P1；`89d001f...` 最小修复复审通过，
无 P0-P3，批准进入合并准备。

问题：真实 Linux/DNS/ACME/WIF/KMS/volume/回滚仍为现场待验。

Reviewer：Code Reviewer

时间：2026-07-28

结果：`8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0` KMS 项目隔离修复通过，
无 P0-P3；已进入 `origin/main`。

问题：无代码阻断；真实 WIF/KMS/IAM/证书/probe 与部署仍需按独立现场批次验收。

Reviewer：Architecture Reviewer

时间：2026-07-28

结果：批次 B2 命名失败后，有条件通过并唯一冻结 Provider ID `rwa-api-x509`；认定为既有
身份模型内的最小标识修正，不改变信任、subject 或 IAM 模型。

问题：Provider full resource 与 audience 的本地引用必须同步，并经独立 Code Review 后才能
申请批次 C。

Reviewer：Code Reviewer

时间：2026-07-28

结果：批次 B4 初审发现 1 个 P2：runbook 使用普通重定向写 audience 最终路径，可能在
verifier 拒绝前跟随既有 symlink/hardlink 并发生覆盖。其他项无 P0-P3。

问题：B4-R1 已将该段改为 root 下 `O_EXCL|O_NOFOLLOW` 排他创建，写入并 fsync 后核验
regular、root:root、`0400`、`nlink=1`、同一 inode 和 exact audience 单换行；失败只清理本次
新建且 inode 匹配的文件，不覆盖旧路径。同一 Code Reviewer 复审通过，无 P0-P3。

------------------------------------------------------------------------

# 文档同步

任务完成后检查：

需要更新：

-   PROJECT_CONTEXT.md：部署和现场验收完成后更新真实状态；当前不得提前写成已部署。
-   ARCHITECTURE.md：当前架构裁定已覆盖独立单 VM；若 WIF/KMS 身份模型发生变化才需更新。
-   CHANGELOG.md：KMS 项目隔离修复与 real-test 正式部署完成后更新。
-   docs/decisions/：若冻结新的 WIF Provider mapping、证书生命周期或 KMS rotation 决策则记录。

同步状态：批次 B4-R1 已修复 runbook audience 创建 P2，并经同一 Code Reviewer 复审通过，
无 P0-P3；
`PROJECT_CONTEXT.md`、`ARCHITECTURE.md`、`CHANGELOG.md` 和 `docs/decisions/` 本批不修改。
