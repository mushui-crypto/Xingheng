# 任务信息

## 基础信息

任务名称：独立 real-test 零资金基础设施、WIF/KMS 与部署接续

任务编号：TASK-001

创建时间：2026-07-28 09:07 CST

创建人：Product-Technical Lead

------------------------------------------------------------------------

# Owner 信息

当前 Owner：Product-Technical Lead

角色：D2B0-R2-R1-P1 代码层审查收口与受信 revision 准备

下一 Owner：Product-Technical Lead（等待 commit/push 与工具行为验证授权）

交接状态：

-   D2B0-R2-R1-P1 代码层限定复审通过，无 P0-P3；真实 576.0.0 工具行为验证尚未授权，
    现场 P1 仍保持阻断。D2B1 两次 PREWRITE 均 fail-closed，helper attempts=0，D2B2/E 未授权

------------------------------------------------------------------------

# 任务目标

## 背景

StellaX 需要在独立 GCP 项目 `xingheng-real-test` 中建立单 VM real-test 环境，用于零资金、
零交易所凭证、零 Mainnet private API 和零 provider mutation 的部署与 UI 验收。独立公网入口、
real-test WIF 安装路径、激活成功门禁和 KMS 项目隔离修复已完成开发、Review 与主分支集成。
GCP 基础设施、real-test KMS、Workload Identity Pool 和架构复核后的 X.509 Provider 已创建；
单一 CryptoKey 最小 IAM、root-only 私钥/CSR、P30D 叶证书签发及公开 leaf/chain 隔离发布已完成。
ADC、real-test 四文件 source、tmpfs 安装、STS/KMS probe、DNS/TLS 和部署仍未执行。

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
Level 3 Code Review 并进入 `origin/main`。批次 B3 Provider、批次 C 最小 IAM、D1 私钥/CSR 和
D2A 叶证书已按冻结身份模型完成；Architecture Reviewer 已有条件接受当前隔离、短期、单 workload
real-test 使用 DEVOPS tier 及其不可单证书撤销的残余风险。

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
-   `scripts/prepare-real-test-gcp-wif-source.py`
-   `scripts/prepare-real-test-gcp-wif-source.test.mjs`
-   `scripts/install-gcp-wif.sh`
-   `scripts/verify-deployment-revision.mjs`
-   `scripts/verify-real-test-web-health.sh`
-   `server/modules/arbitrage/automation/CredentialKeyProvider.ts`
-   `server/modules/arbitrage/automation/GcpKmsCredentialKeyProvider.test.ts`

------------------------------------------------------------------------

# 当前状态

状态：D2B0-R2-R1-P1 代码层 Review 通过；待受信 revision 与真实工具行为验证独立授权；
D2B1 attempts=0，D2B2/E 未授权

Git 状态：

-   当前分支：`develop`
-   当前 HEAD / `origin/develop`：
    `46198065a142af70d2dd3de9ec36692bc10629bf`
    （`fix(deploy): support direct-root real-test WIF`，D2B0-R1 受信 revision）
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
    - 批次 C 前 Pool、KeyRing、CryptoKey 和 project KMS IAM 均为空；Provider 无独立 policy
      surface。批次 C 仅在目标 CryptoKey 添加一个冻结 workload subject 的
      `roles/cloudkms.cryptoKeyEncrypterDecrypter` binding。
    - 批次 C 后 Pool/KeyRing/project KMS IAM 仍为空，CryptoKey IAM exact-set 仅含上述唯一
      subject/role、无 condition；VM 服务账号在 project/KeyRing/CryptoKey 及可见上级仍无 KMS
      binding。
-   批次 D1 已生成并验收唯一 root-only 私钥与 CSR：
    - `VERSION=20260728T062225Z`。
    - STAGE 为
      `/var/lib/xingheng-real-test/gcp-wif-build/20260728T062225Z`，root:root `0700`。
    - 私钥为 STAGE 内 `leaf-20260728T062225Z.key.pem`，root:root `0400`、`nlink=1`，
      SHA-256=`b995347dc21a46b7f1adec98564eb71109b6c6ea07c88a22fd57222c844a22a8`。
    - CSR 为
      `/var/lib/xingheng-real-test/gcp-wif-csr/leaf-20260728T062225Z.csr.pem`，
      root:root `0400`、`nlink=1`，
      SHA-256=`f9c01a7916de7c482e59a439fb17b855c066c03e286bd89434933d08ca0e4792`。
    - KEY/CSR public-key DER SHA-256 均为
      `764d265a2b83f0d2eccd5c46a81bb03a6596e16e8973b128b8295297ad3aaf17`；KEY 未离开 VM。
    - 单次 CA `--validate-only` 返回成功且 DEVOPS Pool 未出现持久 Certificate resource；
      未实际签发。
-   批次 D2A 仅实际签发一次 P30D clientAuth 叶证书。DEVOPS tier 不存储、不支持
    list/describe/revoke 单张证书，因此逻辑
    `CERT_ID=xingheng-rwa-api-real-test-20260728T062225Z` 只用于本地请求和证据关联，不表述为
    可 describe 的持久 Certificate resource。
    - 返回 chain exact 2 blocks，顺序为 leaf + 冻结 Root；chain SHA-256=
      `3af05da0f58d62852f99d97c173a185d25195448d6fe066378653f86dcfc2218`。
    - leaf SHA-256=`b0c4ad3a5b72d2294abd6fcf91bf474408b50b91de7393470c6c980de0d6ac35`；
      fingerprint=`F2:B1:D8:CD:84:2B:26:65:E8:54:44:4B:8E:22:4D:72:CD:74:9E:24:26:CC:E6:13:F0:1A:9A:50:CD:9A:CF:23`。
    - Root 原始 PEM bytes SHA-256=
      `b26409d853c515516d2a713dfcf3323c0a6ccd5050688145f840beaac95e25a3`，
      指纹仍为冻结值；验证时禁止规范化、补删结尾 LF 或重编码后再比较 raw SHA。
    - serial=`CD15E10F8E62C527ABC4E1502D686DC7A65102`；
      validity=`2026-07-28T06:58:56Z` 至 `2026-08-27T06:58:55Z`，共 2,591,999 秒。
    - subject、issuer、唯一 URI SAN、critical CA:false、critical KU、EKU 仅 clientAuth、
      RSA2048、SHA256/RSA、Root 验证与 D1 public-key hash 均精确通过。
-   D2A-R1 因错误地为 Root raw bytes 补 LF 后比较原始 SHA，在任何发布前 fail-closed；
    D2A-R2 修正 raw-byte 门禁后完成临时与 final 验收，但因错误依赖 `os.listdir` 排序而
    fail-closed。两批均按本批 inode/hash 收据清理临时/最终公开文件，D1 KEY/CSR 无漂移，
    未再次签发。
-   D2A-R3 仅将最终 STAGE 断言修正为 `len(items) == 3` 与无序 exact-set，其他安全门禁不变；
    leaf/chain 已用 `O_EXCL|O_NOFOLLOW`、同目录临时文件、fsync 和
    `renameat2(RENAME_NOREPLACE)` 排他发布：
    - `leaf-20260728T062225Z.cert.pem`：dev/ino=`2049/946305`、root:root `0400`、
      `nlink=1`、size=1879，SHA-256 为上述 leaf 冻结值。
    - `issued-chain-20260728T062225Z.pem`：dev/ino=`2049/946306`、root:root `0400`、
      `nlink=1`、size=3752，SHA-256 为上述 chain 冻结值。
    - STAGE exact-set 仅为 D1 KEY、leaf cert 与 issued chain；D1 KEY/CSR inode/hash 未漂移。
      Cloud Shell public evidence 已按 exact path/dev/ino/size/SHA 清理并证明目录不存在。
    - 未生成 ADC、certificate config、audience 或 real-test 四文件 source；未安装、probe 或
      进入 D2B/E。
-   D2B 前置只读核验确认 direct-root、无 intermediate；Architecture Reviewer 有条件批准
    D2B0 使用显式双 profile：
    - production 保持 ADC、certificate config、证书、私钥、trust chain 五文件。
    - real-test 使用 ADC、certificate config、冻结 leaf、冻结 KEY 四文件；ADC 不含
      `trust_chain_path`，source 不得出现 `trust-chain.pem`。
-   D2B0 Security DevOps 独占实现已新增
    `scripts/prepare-real-test-gcp-wif-source.py` 及聚焦本地测试。helper 固定
    `real-test`、冻结路径/inode/hash、canonical gcloud 576.0.0 和 direct-root argv，
    使用 no-follow FD、`O_EXCL`、fsync、`RENAME_NOREPLACE` 与本批 inode 收据清理。
    该代码只准备未来 D2B1 离线 source/audience，不 install、不 mount、不 probe。
-   D2B1 已两次在 PREWRITE 门禁停止：第一次确认 `/usr/bin/gcloud` 是 symlink，与旧 helper
    “regular file”假设冲突；第二次确认 SDK 既有 `__pycache__` 需要 package manifest 加动态
    baseline，而不能按固定数量或零缓存判断。两次 helper attempts 均为 0，未打开/复制 KEY/cert，
    未创建 SOURCE/AUDIENCE 或 runtime target。
-   D2B0-R2 本地实现固定
    `/usr/bin/dash /usr/lib/google-cloud-sdk/bin/gcloud`、Cloud SDK bundled Python、
    dpkg package/manifest/verify 与 component exact-set；所有 gcloud 调用使用空环境 allowlist 和
    两个固定 root-only config/pycache 隔离目录。工具链、Python prefix/user-site、SDK 动态缓存
    baseline 与第一次 version 门禁全部在接触 STAGE 前完成。

## 未完成

1. D2B0-R2-R1-P1 canonical 工具链与 config/pycache 隔离 diff 已由同一 Code Reviewer 确认
   无 P0-P3，但尚未 commit/push，不能作为新的 D2B1 现场受信 revision。
2. D2B1 已获批但尚未执行 helper；两次 PREWRITE 均在写入前停止，attempts=0。尚未生成
   root-only audience、`adc.json`、`certificate_config.json` 和最终 real-test 四文件 source，
   真实 KEY 未被复制。
3. D2B2 尚未授权或执行。尚未安装 `/run/xingheng-real-test/gcp-wif` tmpfs bundle。
4. 批次 E 尚未授权或执行。尚未执行真实 STS token exchange 或仅限目标 CryptoKey 的 KMS
   health probe。
5. 批次 F 尚未授权或执行。受信 operation launcher、canonical release tree/manifest/env、
   named volumes、flock/lease、备份恢复与回滚尚未在 VM 安装或验证。
6. 批次 G 尚未授权或执行。Cloudflare DNS、ACME、公网证书链、HTTPS
   health/revision/no-store 尚未验证。
7. 批次 H 尚未授权或执行。real-test 尚未部署，浏览器登录、环境标签、导航及
   空态/不可执行态验收尚未执行。
8. `privateca.googleapis.com` 的 `DATA_WRITE` Data Access Audit Logs 尚未启用；它不阻断
   当前公开材料或离线 D2B 准备，但必须在下一次签发/续期前以独立授权批次启用并验收，
   建议同时在任何真实交易启用前完成。
9. 日志脱敏、VM/container/HTTPS/disk/OOM/backup/WIF/KMS 告警与恢复收据尚未完成。
10. `.env.real-test`、root-only audience、ADC 和 certificate config 均尚未创建；
   不得在聊天或仓库记录其敏感内容。
11. 所有交易门禁继续关闭：服务端总急停开启，global/strategy execution 关闭，用户急停保持；
    不录入真实交易凭证，不调用 Mainnet private API，不执行 provider mutation 或资金动作。

## 当前问题

-   D2B0 只增加本地代码、测试和文档能力；不能把本地测试解释为 D2B1/D2B2/E、Audit Logs、
    安装、probe 或部署授权。
-   `/usr/bin/gcloud` 只作为发行包 symlink 现场事实，不是 helper 执行入口。D2B1 必须固定执行
    canonical gcloud，并在每批动态冻结 package-manifest 之外允许的安全 pycache exact baseline；
    任何工具、package、component、SDK module、隔离目录或 baseline 漂移都在 KEY copy 前停止。
-   real-test direct-root source 必须是四文件；production 继续是五文件。两个 profile 必须由
    installer/verifier 的显式 environment 参数选择，禁止按文件存在性自动推断或跨环境安装。
-   Provider ID/full resource/audience 已冻结为 `rwa-api-x509` 契约；历史失败 ID
    `gcp-vm-x509` 只能保留在明确标注的失败记录中，不得作为当前配置。
-   DEVOPS tier 的 `describe=NOT_FOUND` 与区域 list 为空是预期，不得据此判定签发失败；
    同样不得把返回的有效证书链写成 CLI exit=0、持久 Certificate resource 或服务端 exact-set
    的证据。
-   DEVOPS tier 无单证书 revoke。当前短期、单 workload、零资金 real-test 仅以 Provider disable、
    CryptoKey IAM 移除、runtime bundle 清理、API/Web 停止和等待 P30D 到期作为补偿控制；
    不得把这些操作表述为 CA revoke。
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
10. 批次 B3 只创建 Provider，不自动进入 IAM；批次 C 只建立目标 CryptoKey 的单一
    subject/role binding；D1、D2A、D2B、E、F、G、H 均为独立批次，任一阶段证据不完整即停止。
11. DEVOPS tier 对当前 P30D、T-7d 轮换、单 workload、单 Provider、单 CryptoKey、零资金
    real-test 有条件可接受。它不存储、不支持 list/describe/revoke 单张证书；逻辑 CERT_ID 只作
    本地证据关联，不能表述为持久 Certificate resource。
12. 证书泄露事件不得声称 CA revoke；补偿控制固定为清除/隔离 runtime 凭证、移除目标
    CryptoKey IAM、disable 单 workload Provider、停止 API/Web 并等待证书到期。若未来需要
    逐证书撤销、长期身份、证书库存、多主体共享 Provider 或合规级生命周期管理，必须重新进行
    Architecture Review 并评估 Enterprise 新 Pool/CA。
13. `privateca.googleapis.com` 的 `DATA_WRITE` Data Access Audit Logs 必须在下一次证书
    签发/续期前启用并验收；当前历史签发无法事后补记。该 IAM `auditConfigs` 写操作必须单独授权，
    保留现有 etag/bindings、不得以宽泛 `set-iam-policy` 覆盖策略，并记录费用与传播延迟。
14. WIF source 使用显式双 profile：production 保持含 trust chain 的五文件；real-test
    direct-root 使用不含 `trust_chain_path`/`trust-chain.pem` 的四文件。D2B1 只能通过固定
    `scripts/prepare-real-test-gcp-wif-source.py real-test` 入口准备，D2B2 再独立批准安装。
15. D2B1 gcloud 调用固定为 `/usr/bin/dash` 加 canonical
    `/usr/lib/google-cloud-sdk/bin/gcloud`，并固定 bundled Python、空环境 allowlist、独立
    config/pycache 目录和 dpkg/SDK/component/dynamic-cache baseline；所有门禁必须先于 STAGE/KEY
    访问。

影响：

-   旧的 production 项目 real-test KMS 路径在修复合并后会被明确拒绝。
-   real-test 部署只能在 WIF/KMS、受信 release、volume/lease、DNS/TLS 和回滚证据全部通过后激活。
-   任一身份、权限、证书、KMS、provider、lease 或恢复证据不完整均停止，不允许以手工降级绕过。
-   当前 leaf/chain 仅在 VM root-only STAGE 隔离保存，尚未形成 ADC/real-test 四文件或运行身份能力。

------------------------------------------------------------------------

# Agent 交接信息

【任务名称】

TASK-001 D2B0-R2：canonical gcloud 工具链与 pycache/config 隔离实现

【当前 Owner】

Product-Technical Lead

【下一 Owner】

Code Reviewer（D2B0-R2 独立审查）

【任务目标】

对 canonical gcloud、dash、bundled Python、dpkg/SDK baseline、空环境和两个固定隔离目录的
本地实现进行独立 Code Review。D2B1 虽已获批，但因两次 PREWRITE fail-closed 仍为 attempts=0；
R2 未形成新受信 revision并完成独立真实工具行为验证前不得继续 D2B1。

【当前状态】

D2B0-R1 已在受信 revision `46198065a142af70d2dd3de9ec36692bc10629bf`。D2B0-R2 按
Architecture Reviewer 已批准裁定完成本地代码、测试和文档修改；首轮 Review 的文件日志 P1 已
完成最小修复并由同一 Code Reviewer 确认代码层无 P0-P3。当前仍未提交、未 push，且真实 576.0.0
工具行为验证未授权。真实 ADC/source/audience 未生成，KEY 未复制，未安装、mount、probe、访问
VM/云或进入 D2B2/E。

【已完成内容】

见“执行记录 / 已完成”。本批重点是：

-   helper 不再执行 `/usr/bin/gcloud`；固定通过 `/usr/bin/dash` 执行 canonical gcloud，并冻结
    gcloud/dash/bundled Python 的 metadata/SHA、package、manifest、verify 和 component exact-set。
-   子进程从空环境构造 allowlist；两个固定隔离目录使用排他 mkdir、同 inode/empty 门禁和
    receipt rmdir。prefix/user-site probe 与 SDK 动态安全 pycache baseline 先于 STAGE/KEY。
-   helper 保留 D1/D2A inode/hash/owner/mode/nlink、验证 FD 分块复制、direct-root JSON、
    no-follow/no-replace/fsync 与敏感字段拒绝契约。
-   source/audience 使用 `O_EXCL|O_NOFOLLOW`、0400、fsync、
    `renameat2(RENAME_NOREPLACE)` 和 final reopen；失败只按本批 inode 收据清理。
-   聚焦测试只用临时 fixture/fake SDK，覆盖 prefix 控制组、ambient env/PATH、package/component/
    SDK drift、隔离 inode/nonempty/cleanup、version/create/version 漂移及原四文件负例；不读取真实
    KEY。
-   runbook、Decision Log 与任务记录同步 R2 工具链和“现场未执行”边界。

【未完成内容】

D2B0-R2 首轮独立 Code Review 发现 1 个 P1：真实 gcloud 可能默认在隔离 config 目录初始化文件
日志，而 fake 成功路径没有覆盖该行为。Architecture Reviewer 已批准固定
`CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true`，同一 Reviewer 已确认代码层无 P0-P3；但受信 revision
和另行授权的真实 576.0.0 version/create/version 工具行为验证均完成前，不得关闭现场 P1 或恢复
D2B1；D2B2/E 仍须独立授权。

【涉及文件/模块】

-   `scripts/prepare-real-test-gcp-wif-source.py`
-   `scripts/prepare-real-test-gcp-wif-source.test.mjs`
-   `deploy/PRODUCTION_REAL_TEST_DUAL_ENVIRONMENT_RUNBOOK.md`
-   `docs/tasks/TASK-001.md`
-   `deploy/README.md`
-   `RWA_NEUTRAL_AUTOMATION_V1.md`
-   `docs/decisions/DECISION_LOG.md`
-   `PROJECT_CONTEXT.md`（仅记录代码支持、现场未执行）

严禁触碰、暂存、覆盖或回退用户既有 `TASK_TEMPLATE.md`、`项目沟通规则.md` 修改。

【关键决策】

production 保持五文件与 trust chain；real-test 的叶证书由 Provider 已配置 Root 直接签发且
无 intermediate，因此必须使用不含 `trust_chain_path`/`trust-chain.pem` 的四文件。shared
installer/verifier 只能通过显式 environment 选择 profile，不得自动推断。D2B1 只准备离线
source/audience；D2B2 才安装 tmpfs，两个批次必须分别授权。

【风险事项】

-   IAM 与 leaf 已建立，但 ADC、real-test 四文件、安装和 probe 尚未建立；不得把 Provider `ACTIVE`、
    CryptoKey IAM 或 STAGE 中存在 leaf/KEY 解释为可执行运行身份。
-   helper 将在 D2B1 增加一份 root-only KEY 副本；R2 代码层虽已 Review，但尚未形成受信
    revision且真实工具行为验证未完成，当前不得恢复现场执行。
-   当前本地测试不能证明 VM canonical gcloud/dash/bundled Python、dpkg/SDK dynamic baseline、
    Linux `renameat2`、真实文件系统或 gcloud 文件日志行为已通过。新 revision 后还须另行授权
    D2B0-R2-R1 工具行为验证，用公开 fixture 执行 version/create/version 并证明 config/pycache
    始终为空；该批次不得读取 D1 材料或创建 SOURCE/AUDIENCE。
-   `deploy/STEP_0_PRODUCTION_CHECKLIST.md` 的 verifier CLI 已补入显式 `production` profile并通过
    Review，但必须随 D2B0 受信 revision 提交后才可执行。
-   DEVOPS leaf 无法单独 revoke；当前补偿控制只对单 workload、零资金 real-test 有效，不得外推。
-   本次历史签发未被 Data Access Logs 覆盖且无法补记。
-   DNS/ACME/TLS、release、volume、备份恢复、回滚和告警仍为 `field-pending`。
-   所有交易门禁保持关闭；任何真实凭证、急停解除、执行开关或资金窗口均未授权。

【待确认事项】

1. 用户是否批准将已通过代码层 Review 的限定五文件 commit/push 为新受信 revision。
2. 新受信 revision 形成后，用户是否单独授权 D2B0-R2-R1 真实 576.0.0 工具行为验证；该批次
   通过前不得重新交接 D2B1。
3. 工具行为验证通过后，Product-Technical Lead 是否重新交接已批准的 D2B1；D2B2 仍须再次批准。
4. Data Access Logs 必须另批启用并在下一次签发/续期前验收，不与 D2B 隐式捆绑。

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

Reviewer：Architecture Reviewer

时间：2026-07-28

结果：有条件接受 DEVOPS tier 用于当前 P30D、T-7d、单 workload、单 Provider、单 CryptoKey、
零资金 real-test；将 D2A 成功标准修正为 returned chain 与 D1 KEY/CSR/Root 的 exact
密码学验收。DEVOPS 的 list 为空和 describe NOT_FOUND 属于 tier 预期，逻辑 CERT_ID 不得表述为
持久资源。

问题：DEVOPS 不存储、不支持 list/describe/revoke 单张证书。本次历史签发无 Data Access Audit
Log 且无法补记；下一次签发/续期前必须另批启用 `privateca.googleapis.com` 的 `DATA_WRITE`
Data Access Logs。当前事件补偿控制仅限 Provider disable、目标 CryptoKey IAM 移除、runtime
clear、服务停止和等待 P30D 到期，不得声称 CA revoke。

Reviewer：Code Reviewer

时间：2026-07-28

结果：D2A 本地一致性更新独立审查通过，无 P0-P3。DEVOPS tier、逻辑 CERT_ID、returned chain
验收、C/D1/D2A/R1/R2/R3 历史、Data Access Logs 门禁、事件补偿控制和 D2B/E 未授权边界均与
冻结事实一致；未要求修改 `ARCHITECTURE.md`。

问题：现场事实和哈希仅按任务收据完成本地一致性审查，本轮未重新连接云端或 VM。DEVOPS 无单证书
撤销、历史签发无 Data Access Log、D2B/E 与运行身份链未执行的残余风险继续有效。

Reviewer：Code Reviewer

时间：2026-07-28

结果：D2B0 初审发现 1 个 P1：文档允许在 production active WIF 目录内保留 old+new cert/key，
与单 generation 五文件 exact-set 冲突，并误述当前已具备原子轮换能力。

问题：Architecture Reviewer 已冻结 production active source/runtime 永远为单 generation
五文件 exact-set；candidate 仅在 active 外准备，retired 仅用于 rollback/evidence 且不得被
容器、active validator 或备份看到。已签发 token 不依赖旧文件。D2B0-R1-P1 已按该裁定完成
五文件内最小文档修复；具体轮换机制留待未来独立 Level 3 任务。

Reviewer：Code Reviewer

时间：2026-07-28

结果：D2B0-R1 限定复审通过，无 P0-P3；原 production active old+new 重叠 P1 已关闭。

问题：production active 始终为单 generation 五文件 exact-set；candidate/retired 只能位于 active
外，active 配置不得引用其路径。当前不具备 production 无中断或原子整体轮换能力，D2B1/D2B2/E
和 production rotation 现场操作均未授权。

Reviewer：Architecture Reviewer

时间：2026-07-28

结果：批准 D2B0-R2 本地实现与独立 Code Review。D2B1 两次 PREWRITE 均在 helper 调用前
fail-closed，attempts=0；修复固定 canonical gcloud、dash、bundled Python、dpkg/SDK/component
收据、空环境及两个 root-only config/pycache 隔离目录。

问题：SDK 既有未 manifest 对象只允许安全 `__pycache__`/`.pyc`，每批动态 baseline 必须在所有
gcloud 调用前后不漂移；任何工具或隔离门禁失败都必须保持 KEY/cert copy=0 和
SOURCE/AUDIENCE=0。D2B0-R2 不能自判 Review 通过，也不授权 D2B1/D2B2/E 现场写入。

Reviewer：Code Reviewer

时间：2026-07-28

结果：D2B0-R2 首轮独立 Review 不通过；发现 1 个 P1，无其他 P0-P3。

问题：helper 要求隔离 `CLOUDSDK_CONFIG` 在每次调用后为空，但未关闭真实 Cloud SDK 默认文件
日志；fake gcloud 成功路径未覆盖该副作用。必须加入并精确测试
`CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true`，保持 config 非空即 fail-closed。

Reviewer：Architecture Reviewer

时间：2026-07-28

结果：批准上述 P1 最小本地修复与同一 Reviewer 复审，但不批准恢复 D2B1。

问题：代码复审和受信 revision 后，还须另行授权真实 576.0.0 工具行为验证批次，以公开 fixture
执行 version/create/version 并证明 config/pycache 始终为空；该批次不得接触 D1 材料、
SOURCE/AUDIENCE、Provider/IAM/KMS 或 STS。

Reviewer：Code Reviewer

时间：2026-07-28

结果：D2B0-R2-R1-P1 限定复审通过，无 P0-P3；代码层 P1 关闭。

问题：`CLOUDSDK_CORE_DISABLE_FILE_LOGGING` 已精确固定为字符串 `true`，fake gcloud 在
version/create 前统一断言，config/pycache 空目录门禁未放宽。真实 576.0.0 工具行为验证尚未
授权或执行，因此现场 P1 仍保持阻断，不构成 D2B1/D2B2/E 授权。

------------------------------------------------------------------------

# 文档同步

任务完成后检查：

需要更新：

-   PROJECT_CONTEXT.md：部署和现场验收完成后更新真实状态；当前不得提前写成已部署。
-   ARCHITECTURE.md：当前架构裁定已覆盖独立单 VM；若 WIF/KMS 身份模型发生变化才需更新。
-   CHANGELOG.md：KMS 项目隔离修复与 real-test 正式部署完成后更新。
-   docs/decisions/：若冻结新的 WIF Provider mapping、证书生命周期或 KMS rotation 决策则记录。

同步状态：D2B0-R2-R1-P1 已更新 helper、聚焦测试、TASK-001、real-test runbook 与 Decision Log，
加入 Cloud SDK 文件日志禁用变量并冻结独立真实工具行为验证边界；同一 Reviewer 已确认代码层
无 P0-P3，当前等待 commit/push 授权与后续真实工具行为验证独立授权。
`PROJECT_CONTEXT.md` 已有“D2B1/D2B2 现场未执行”边界且无冲突，本批不改；
`ARCHITECTURE.md`、`CHANGELOG.md` 本批不改。
