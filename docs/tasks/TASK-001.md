# 任务信息

## 基础信息

任务名称：独立 real-test 零资金基础设施、WIF/KMS 与部署接续

任务编号：TASK-001

创建时间：2026-07-28 09:07 CST

创建人：Product-Technical Lead

------------------------------------------------------------------------

# Owner 信息

当前 Owner：Product-Technical Lead（当前账号）

角色：跨角色协调、冻结边界维护、Review 与现场门禁回收

下一 Owner：Product-Technical Lead（新账号接续会话）

交接状态：

-   准备交接

------------------------------------------------------------------------

# 任务目标

## 背景

StellaX 需要在独立 GCP 项目 `xingheng-real-test` 中建立单 VM real-test 环境，用于零资金、
零交易所凭证、零 Mainnet private API 和零 provider mutation 的部署与 UI 验收。独立公网入口、
real-test WIF 安装路径和激活成功门禁已完成开发、Review 与主分支集成；GCP 基础资源已部分创建。

在创建 KMS 前发现代码将 real-test CryptoKey 错误冻结到 production 项目。定向修复已形成
本地提交 `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0`，但 Code Reviewer 尚未给出最终结论。

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

架构状态：Architecture Reviewer 已批准独立 GCP 单 VM real-test 拓扑；用户已确认使用独立
`xingheng-real-test` 项目、`asia-southeast1` 区域及收费资源创建。独立入口与 WIF 安装路径
补丁已完成 Level 3 Code Review。KMS 项目隔离修复仍待最终 Code Review。

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

状态：Review 中 / 准备跨账号交接

Git 状态：

-   当前分支：`develop`
-   当前 HEAD：`8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0`
-   `origin/develop`：`89d001f3c629aed50d7bee1b920dafe791de4655`
-   `origin/main`：`5be1644db82ddfbddd33a2ed5f7267978ff5e7e0`
-   `2a59f2e06470c31bc64e168ec749bd08073812f1` 与
    `89d001f3c629aed50d7bee1b920dafe791de4655` 已包含在 `origin/main`。
-   `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0` 尚未 push/merge，`develop` 比
    `origin/develop` 领先 1 个提交。
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
    production 常量未改。当前仅本地提交，待最终 Code Review。
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
    - Docker 尚未安装。
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

## 未完成

1. Code Reviewer 尚未对 `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0` 给出最终 P0-P3 结论。
   Reviewer 已确认审查范围，但连续两次执行被系统/会话中断；不得把确认范围当作 Review 通过。
2. Review 通过后才可将 `8b6dc687...` push 到 `origin/develop` 并按既定流程合并 `main`。
3. 尚未创建 real-test Cloud KMS：
   - KeyRing：`xingheng-rwa-real-test-sg`
   - CryptoKey：`exchange-credentials`
   - location 必须精确为 `asia-southeast1`
   - rotation/protection level/销毁保护策略需按安全方案冻结并现场核对。
4. 尚未创建 Workload Identity Pool、X.509 Provider、attribute mapping/condition 与 IAM principal binding。
   CA Pool 名称不等于 Workload Identity Pool，禁止混淆。
5. 尚未在 VM 的 root-only 路径生成 leaf 私钥/CSR；尚未签发短期 clientAuth 叶证书、
   导出 root trust chain、生成 `adc.json`/`certificate_config.json` 或安装五文件 tmpfs bundle。
6. 尚未执行真实 STS token exchange 或单一 KMS health probe。
7. Docker/Compose plugin、受信 operation launcher、canonical release tree/manifest/env、
   named volumes、flock/lease、备份恢复与回滚尚未在 VM 安装或验证。
8. Cloudflare DNS、ACME、公网证书链、HTTPS health/revision/no-store 尚未验证。
9. 日志脱敏、VM/container/HTTPS/disk/OOM/backup/WIF/KMS 告警与恢复收据尚未完成。
10. `.env.real-test` 尚未创建；不得在聊天或仓库记录 secret。
11. real-test 尚未部署，浏览器登录、环境标签、导航及空态/不可执行态验收尚未执行。

## 当前问题

-   Code Review 对话执行被系统中断，当前没有最终 Review 结论。
-   叶证书的精确生命周期、X.509 Provider attribute mapping/condition 和 KMS rotation/protection
    参数必须由后续 Security DevOps/Code Review 依据当前 GCP 官方契约冻结，禁止现场猜测。
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

影响：

-   旧的 production 项目 real-test KMS 路径在修复合并后会被明确拒绝。
-   real-test 部署只能在 WIF/KMS、受信 release、volume/lease、DNS/TLS 和回滚证据全部通过后激活。
-   任一身份、权限、证书、KMS、provider、lease 或恢复证据不完整均停止，不允许以手工降级绕过。

------------------------------------------------------------------------

# Agent 交接信息

【任务名称】

独立 real-test 零资金基础设施、WIF/KMS 与部署接续

【当前 Owner】

Product-Technical Lead（当前账号，准备跨账号交接）

【下一 Owner】

Product-Technical Lead（新账号接续会话）

【任务目标】

先完成 `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0` 独立 Code Review 与合并，再按冻结路径创建
real-test WIF/KMS/短期证书和最小 IAM，完成受信 Linux/Docker/release/DNS/TLS/volume/回滚证据，
最后仅在交易门禁保持关闭的条件下部署和验收空态/不可执行态 UI。

【当前状态】

Review 中。独立入口与健康门禁已在 `origin/main`；KMS 隔离修复仅在本地 `develop`，
Code Reviewer 尚无最终结论。GCP VM、网络、IAP/OS Login、静态 IP 和根 CA 已创建；
Docker、WIF Provider、叶证书、KMS、DNS/TLS 与部署尚未完成。

【已完成内容】

见“执行记录 / 已完成”。重点提交：

-   `2a59f2e06470c31bc64e168ec749bd08073812f1`
-   `89d001f3c629aed50d7bee1b920dafe791de4655`
-   `8b6dc687f5f75d99ec189e2ba48b8dab2b701fa0`（待 Review）

【未完成内容】

见“执行记录 / 未完成”。第一步必须是恢复 Code Reviewer 对 `8b6dc687...` 的只读审查；
不得跳过 Review 直接创建 KMS 或部署。

【涉及文件/模块】

见“影响范围 / 相关文件”。严禁触碰或提交用户既有 `TASK_TEMPLATE.md`、
`项目沟通规则.md` 修改。

【关键决策】

独立 real-test 项目、新加坡区域、IAP-only SSH、VM SA 无 KMS 权限、X.509 WIF 短期身份、
单 CryptoKey 最小权限、零资金 fail-closed。

【风险事项】

-   所有云资源可能持续计费。
-   CA 已启用但 WIF/KMS 链尚未形成。
-   VM 已运行但未安装 Docker；不得手工绕过受信 launcher/release 流程。
-   DNS/ACME/TLS、真实 Linux、WIF/KMS、volume、备份恢复和回滚仍为 `field-pending`。
-   connectivity-smoke 的 nonAtomic/incomplete 残余风险、scan cutoff、REST 延迟、
    资产可替代和 25 USDT 非最大损失保证继续存在。
-   任何真实凭证、急停解除、执行开关或 Mainnet 资金窗口仍未获本任务授权。

【待确认事项】

1. 新账号 Owner 需先明确确认已理解任务目标、当前状态、修改范围和禁止项。
2. Code Reviewer 对 `8b6dc687...` 的最终 P0-P3 结论。
3. Security DevOps 冻结 WIF Provider mapping/condition、叶证书生命周期和 KMS rotation/protection 参数。
4. Cloudflare A/AAAA 与代理模式、现场 DNS/ACME 验证顺序。
5. VM 是否持续运行；若暂不继续，应由用户决定是否停止以降低计算费用，但不得删除 VM/磁盘/IP/CA。

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

结果：`8b6dc687...` 审查未完成。

问题：Reviewer 已确认范围，但审查执行连续被系统/会话中断；没有最终结论。

------------------------------------------------------------------------

# 文档同步

任务完成后检查：

需要更新：

-   PROJECT_CONTEXT.md：部署和现场验收完成后更新真实状态；当前不得提前写成已部署。
-   ARCHITECTURE.md：当前架构裁定已覆盖独立单 VM；若 WIF/KMS 身份模型发生变化才需更新。
-   CHANGELOG.md：KMS 项目隔离修复与 real-test 正式部署完成后更新。
-   docs/decisions/：若冻结新的 WIF Provider mapping、证书生命周期或 KMS rotation 决策则记录。

同步状态：未完成；当前仅新增本跨账号任务记录。
