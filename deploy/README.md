# 生产部署与运维

当前拓扑固定为单台服务器、单个 Node API、SQLite 与 Caddy。不得横向扩展 API
副本；SQLite 数据卷只能由这一实例写入。行情和成交仍是 Hyperliquid 公开行情驱动的
内部模拟交易，链上能力固定为 BSC Testnet。

## 历史 failed Permit receipt 恢复

旧 schema v1 且终态为 `failed` 的 production self-test Permit receipt 不能直接删除、覆盖，
也不能改写为成功。只有在当前 release/runtime identity 正常、server kill switch 保持开启、
Host 与 API 均无 active Permit、Capital Test window 已关闭时，才允许通过固定 trusted operation
执行一次恢复。操作者必须提供现场只读核验得到的原 receipt SHA-256：

```bash
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node /opt/xingheng-release/code/scripts/trusted-operation-launcher.mjs \
  production scripts/recover-production-self-test-permit.sh FAILED_RECEIPT_SHA256
```

Wrapper 会在任何归档动作前输出 `PERMIT_RECOVERY_OPERATION_ID`。若进程或 SSH 在 terminal receipt
完成前中断，只允许把该 ID 作为第二参数与相同 SHA-256 一起重新执行；不得生成新的 ID：

```bash
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node /opt/xingheng-release/code/scripts/trusted-operation-launcher.mjs \
  production scripts/recover-production-self-test-permit.sh \
  FAILED_RECEIPT_SHA256 RECOVERY_OPERATION_ID
```

恢复操作只会把原 receipt 与对应 attempt 目录原子移动到 root-only archive，并生成独立
operation journal 与 terminal recovery receipt；不会生成或安装 Permit，也不会修改生产环境或
重启容器。`success`、`prepared`、`unknown`、未知 schema、未知字段、partial state、active Permit、
active/unknown window、重复 recovery 或 identity drift 均必须 fail-closed。恢复中断后只能使用
同一 operation identity 与 source SHA-256 延续；terminal recovery 完整前 installer 继续阻断。

已过期且安装成功、但从未建立 Capital Test Window 的 schema v2 Permit，只能通过一次性
`terminalize-success` trusted operation 恢复安装前环境。该入口要求人工提供原 success receipt
SHA-256 与固定 operation ID，保留原 receipt、attempt 和环境快照不变，使用追加式 root-only
journal 记录 `prepared -> environment_restored -> api_restarted -> completed`。它只允许原子恢复
`environment.before`、通过固定 Compose allowlist 重启 API，并以普通 promotion guard 验证 baseline；
不提供 Permit revoke、renew、cleanup 或 lifecycle 管理能力，也不会生成或安装 Permit：

```sh
/usr/bin/node /opt/xingheng-release/code/scripts/trusted-operation-launcher.mjs \
  production scripts/terminalize-production-self-test-permit.sh \
  terminalize-success SOURCE_RECEIPT_SHA256 OPERATION_ID
```

该命令只能在独立审批和生产只读 preflight 后执行。未过期 Permit、存在 Window/lease、已有消费、
环境或 runtime identity 漂移均会 fail-closed；中断恢复必须复用相同 source SHA-256 与 operation ID。

正式项目名固定为 `xingheng`，环境文件固定为 `.env.production`；不得把 production wrapper
泛化成调用方可变项目或部署身份。

## 首次部署

要求：安装 Docker Engine 与 Docker Compose plugin；域名 A/AAAA 记录已指向服务器，
并开放入站 TCP 80/443 和 UDP 443。服务器出站网络必须能访问
`api.hyperliquid.xyz:443`（HTTPS/WSS）、`fapi.binance.com:443`（策略 Paper 前向
公开K线）、`data.binance.vision:443`（仅手工历史报告生成）及配置的 BSC Testnet RPC；若云厂商或节点区域
限制上述连接，API 会启动失败，应先更换可访问的节点或网络，不应绕过行情就绪检查。

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# 替换所有 replace-me / REPLACE_WITH 占位值；这些值刻意不可部署，API 会拒绝启动。
# 核对 DOMAIN、APP_PUBLIC_URL、CORS_ALLOWED_ORIGINS、ADMIN_EMAIL、ADMIN_PASSWORD、SMTP、RPC 和测试网合约地址。
REVISION="$(git rev-parse --verify HEAD^{commit})"
MANIFEST="/受控发布目录/xingheng-$REVISION.release.json"
./scripts/build-release-images.sh "$REVISION" "$MANIFEST"
# 通过受控镜像归档或 registry 交付清单中的三个精确 digest，并把清单以 0444
# 普通文件安装为生产 deploy/release-manifest.json；不得改写清单内容或用 symlink 代替。
# 在生产 .env.production 把 XINGHENG_REVISION 设置为同一个完整 commit 后：
./scripts/activate-release.sh deploy/release-manifest.json
./scripts/smoke.sh "https://你的域名"
```

Caddy 自动申请和续期 HTTPS 证书。API 不发布宿主机端口，仅由 Caddy 在 Compose
内部网络访问。`/api/*` 和 `/ws` 会先反代到 API，其余路径由静态前端处理；不存在
的路径回退到 `index.html`。Web 容器只接收 `DOMAIN` 与非敏感 revision；管理员密码、
私钥和助记词仅进入 API 容器。所有手工 Compose 命令都不得传入 `--env-file` 或设置
`COMPOSE_*`；`scripts/production-compose.sh` 只接受仓库根目录固定的 `.env.production`，
并先通过 `scripts/load-release-manifest.sh` 从已安装清单加载镜像
digest，再调用该脚本提供的 `production_compose` 函数；生产 `compose.yaml` 不包含 `build:`。

## 发布 revision 门禁

生产镜像禁止在缺少可信 Git checkout 的服务器目录内直接构建。发布构建只能由
`scripts/build-release-images.sh` 从干净 Git worktree 对指定 commit 执行 `git archive`，在一次性
目录构建 API、Web、strategy tools 三类镜像。脚本把 revision 写入 OCI
`org.opencontainers.image.revision` label 和镜像内 `/app/.build-revision`，取得实际 Docker image
ID 后输出严格 release manifest，将完整 revision 与三个不可变 `sha256:<64 hex>` digest 绑定。
生产目标架构固定为 `linux/amd64`；即使在 Apple Silicon/ARM 构建机上也必须显式跨架构构建，
并在写 manifest 前用镜像 metadata 复核 OS/Architecture，禁止把构建机默认架构镜像交付到
x86_64 生产主机。

### 与运行目录隔离的可信候选构建

生产主机不得为了构建下一版本而替换当前 `/opt/xingheng-release/code`。候选源码固定安装为
`/opt/xingheng-release/candidates/FULL_REVISION/code`，其父目录、源码归档和独立
`candidate-build-receipt.json` 不属于 canonical 运行收据。候选安装器只接受固定
`.incoming-FULL_REVISION.tar`，验证本地冻结的 SHA-256 与 Git archive 内置完整 commit 后，
原子安装 root-only 候选目录；收据绑定源码 exact tree、archive inode/SHA、本机工具和 Docker
daemon 身份。

```bash
# 可信操作者先在 clean worktree 生成并冻结：
REVISION="$(git rev-parse --verify HEAD^{commit})"
git archive --format=tar --output="xingheng-$REVISION.tar" "$REVISION"
ARCHIVE_SHA256="$(sha256sum "xingheng-$REVISION.tar" | awk '{print $1}')"

# 上传后只安装到固定 incoming/candidate 路径；bootstrap 两个文件必须从同一已校验 archive 提取。
install -d -o root -g root -m 0700 /opt/xingheng-release/candidates
install -o root -g root -m 0400 "xingheng-$REVISION.tar" \
  "/opt/xingheng-release/candidates/.incoming-$REVISION.tar"
printf '%s  %s\n' "$ARCHIVE_SHA256" \
  "/opt/xingheng-release/candidates/.incoming-$REVISION.tar" | /usr/bin/sha256sum -c -
test "$(/usr/bin/git get-tar-commit-id \
  < "/opt/xingheng-release/candidates/.incoming-$REVISION.tar")" = "$REVISION"
BOOTSTRAP="/opt/xingheng-release/candidates/.bootstrap-$REVISION"
cleanup_candidate_bootstrap() {
  rm -rf -- "$BOOTSTRAP"
}
trap cleanup_candidate_bootstrap EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
install -d -o root -g root -m 0700 "$BOOTSTRAP/scripts"
tar -xf "/opt/xingheng-release/candidates/.incoming-$REVISION.tar" \
  -C "$BOOTSTRAP" \
  scripts/install-trusted-release-candidate.mjs scripts/trustedReleaseCandidate.mjs
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node "$BOOTSTRAP/scripts/install-trusted-release-candidate.mjs" \
  install "$REVISION" "$ARCHIVE_SHA256"
cleanup_candidate_bootstrap
trap - EXIT HUP INT TERM

CANDIDATE="/opt/xingheng-release/candidates/$REVISION"
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node "$CANDIDATE/code/scripts/trusted-operation-launcher.mjs" \
  release-build scripts/build-release-images.sh \
  "$REVISION" "$CANDIDATE/release-manifest.json"
```

`release-build` 只允许上述候选根内的 `build-release-images.sh`，Docker 参数只允许三个
`linux/amd64` build 和 image inspect；manifest 与 `RELEASE_SHA256SUMS` 只能写入同一候选目录。
它不接受 Compose、activation、env、container、volume 或 provider 操作，也不能读取或替换
canonical release tree/receipt。候选构建成功不等于安装或部署；后续 activation 仍需另行批准，
再走既有 canonical release lifecycle。
自动套利 backup/restore 复用清单中的 API digest，不允许单独漂移。候选构建不读取 `.git`，
而是消费收据绑定的 Git archive；普通 worktree 构建仍要求 `.git` 和 clean worktree。短 SHA、
非法字符或调用者期望 revision 不一致时，构建在 Docker 前拒绝。

生产主机只接收已构建镜像和随发布交付的清单。清单必须是单硬链接、非 symlink、只读 `0444`
普通文件，并使用精确 schema；未知字段、非法 digest 或可写清单均拒绝。`.env.production` 的
`XINGHENG_REVISION` 只能与清单交叉核对，不能单独证明版本。`scripts/activate-release.sh` 启动前
按清单 digest 检查三个实际 image ID、OCI label 与镜像内 revision；启动后继续检查 API/Web
容器的实际 image ID、label、内置 revision 和运行时 `XINGHENG_EXPECTED_REVISION`。任一证据缺失、
非完整 commit、digest/组件不一致、运行时 env 被改写或容器数量不为 1，都会拒绝发布或现场继续。
核验不读取生产 `.git`，也不输出 env 全文、Secret、证书、固定 IP、token 或 provider 原始响应。

独立核验命令：

```bash
MANIFEST=deploy/release-manifest.json
node scripts/verify-deployment-revision.mjs env "$MANIFEST" .env.production
node scripts/verify-deployment-revision.mjs images "$MANIFEST"
node scripts/verify-deployment-revision.mjs containers "$MANIFEST"
```

不得用容器 ID、可覆盖 tag、同一 env 派生的 label/file、健康状态或人工口述替代上述核验。生产
`compose.yaml` 完全没有构建入口，只接受清单加载的不可变 digest，并固定 `pull_policy: never`。
`compose.build.yaml` 仅是本地开发 override，禁止出现在生产激活命令。镜像转移后必须保持清单
digest 可由本机 `docker image inspect` 精确解析，并在激活前重新运行 image verification。

生产脚本和手工 runbook 不得直接调用 `docker compose`。`scripts/production-compose.sh` 固定
`-f compose.yaml -p xingheng`，只在子命令前解析 Compose 全局参数，拒绝 `COMPOSE_FILE`、
`--env-file`、全部 ambient `COMPOSE_*`、`-f FILE`/`-fFILE`、`-p NAME`/`-pNAME` 等
project/file override；固定 env 在 Docker 前须通过 regular/O_NOFOLLOW/nlink/0600/owner/inode
验证。进入已允许子命令后保留其
合法参数，因此 `production_compose logs -f api` 可正常跟踪日志。`production_compose`
会在每一条 `up/run/exec/stop` 前解析最终 JSON，确认五个服务都没有 `build`，且 image、
`pull_policy` 与 runtime revision 精确匹配当前 release manifest。即使目录中存在自动 override，
也不会进入生产文件选择。启动后的容器证据失败时脚本会停止 API/Web，不保留未验证容器。

## 首次 legacy 到 verified release 桥接

生产旧版本没有标准 release manifest 或可验证 revision 时，不得把旧 tag、容器 ID 或人工记录
伪装成标准清单。只允许使用一次独立 bridge：

首次 bridge 接受已由 bridge verifier 冻结的独立 release env 文件；activation 通过安全 FD 校验后
以 `O_EXCL/0600` 原子安装到候选仓库固定 `.env.production`。任一后续 preflight 或 activation
失败时只按安装 receipt 的 inode/SHA 精确撤销，成功后 Compose 仍只读取固定路径。

生产现场优先按一页版
[`STEP_0_PRODUCTION_CHECKLIST.md`](./STEP_0_PRODUCTION_CHECKLIST.md)
逐项执行；本节保留完整设计约束与原理说明。

```bash
sudo scripts/legacy-release-bridge.sh capture \
  /受控桥接目录/legacy-bridge /opt/xingheng/.env.production
node scripts/legacy-release-bridge.mjs verify /受控桥接目录/legacy-bridge
node scripts/legacy-release-bridge.mjs verify-runtime /受控桥接目录/legacy-bridge
./scripts/activate-first-verified-release.sh \
  /受控桥接目录/legacy-bridge \
  deploy/release-manifest.json \
  /opt/xingheng/.env.verified-release
```

`capture` 在旧服务仍运行时冻结 API/Web 精确 image ID，生成只读 `docker save` 归档及 SHA-256、
只引用旧 image ID 和五个既有 named volume 的恢复 Compose，并用 SQLite `.backup` 建立独立
recovery point，记录 integrity/hash/size。bridge manifest 使用精确 schema，拒绝 Secret、env
值、WIF、token、固定 IP、provider raw response、symlink、hardlink、可写文件和未知字段。旧环境
文件不复制、不归档明文；manifest 只冻结绝对路径、device/inode、owner、mode、nlink、size 和
SHA-256。每次 verify、restore 与实际 Compose up 前都会用 `O_NOFOLLOW` 重新核验同一文件，任何
替换或内容变化都会 fail-closed。新 release 必须使用不同路径且不同 inode 的独立环境文件，整个
bridge 窗口不得覆盖旧环境文件。

首次 activation 在任何 stop/recreate 前依次复核 bridge 文件、仍运行的旧 API/Web、SQLite
恢复点、新旧环境身份、卷 driver/options/mountinfo/owner/mode/实际挂载数、新 release Compose、
三镜像和 WIF/KMS preflight。恢复 Compose 源文件和 Docker 最终解析 JSON 均使用精确递归契约，
拒绝 privileged、host namespace、device/capability、额外 bind、命令、端口、health 或 mount
扩展。local volume 必须没有 driver options，宿主文件系统必须是本地可写文件系统；NFS、CIFS、
9p、Ceph、GlusterFS、FUSE 和 bind-backed local volume 均拒绝。新 activation 或
post-start 证据失败时，即使停止新容器失败也继续恢复旧卷 owner 并按冻结 image ID 恢复旧
API/Web。恢复前会以旧 API 镜像、无网络、只读根和只读备份卷再次检查 SQLite；恢复后核对旧
image ID、唯一容器、health、卷映射和 recovery point。首次激活只在 release/WIF/KMS 与新卷
初始化预检通过后停止旧 API，拒绝 symlink、hardlinked file 或混合 owner 的旧卷树，再把三个
API 数据卷整体从冻结 owner 迁移到 `20001:20001`；任一后续失败会恢复冻结 owner。SQLite、
strategy、Caddy 和既有数据均原地保留，不删除或覆盖。

新容器的 API/Web 精确 mount 数量、target 与 RW 属性及全部证据最终通过后，才以安全 FD 写入
固定 `/var/lib/xingheng/verified-release-established` 的 `0444` 一次性 marker。生产不接受
marker 路径 override；写入或 fsync 失败会按创建 inode 安全清理。marker 存在后 bridge 永久禁用；
后续升级和回滚只接受标准 verified manifest，普通 `activate-release.sh` 不包含 legacy 路径。
自动套利 data/backup/lock 新卷只接受 release 镜像冻结的初始 schema，并在旧 API 停止前完成
隔离初始化；不会复制 WIF、SQLite 或旧策略数据。

当前 bridge/WIF 工具仅为 owner 可测、待固定安全复验；尚未在生产执行 capture、`docker save`、
stop/start、activation、UID/卷迁移或 rollback，不能据此宣称已部署或步骤 0 已通过。

## RWA 自动套利凭证 KMS

RWA 交易所凭证使用 Google Cloud KMS Envelope V2。生产只接受以下 provider 与 CryptoKey；
不得配置 `RWA_AUTOMATION_MASTER_KEY`，不得使用 Service Account JSON Key，也不得在 API
同机配置可降级的本地主密钥：

```bash
RWA_CREDENTIAL_KEY_PROVIDER=gcp-kms
RWA_GCP_KMS_KEY_NAME=projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials
RWA_GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp-wif/adc.json
RWA_AUTOMATION_DATA_DIR=/app/rwa-automation-data
```

Vultr 主机通过 X.509 Workload Identity Federation 获取 ADC 短期身份。`adc.json`、证书配置、
证书和对应私钥必须放在宿主机 tmpfs `/run/xingheng/gcp-wif`。API 与宿主文件固定使用专用
UID/GID `20001:20001`；目录权限为 `0700`，所有身份文件权限为 `0400`。Compose 将整个目录
只读 bind 到容器 `/run/secrets/gcp-wif`，不得写入 `.env.production`、Compose 配置正文、
镜像或仓库。ADC 必须是 `external_account` 配置且不得内嵌 `private_key`。GCP IAM 仅授予
该 workload identity 对上述单一 CryptoKey 的
`roles/cloudkms.cryptoKeyEncrypterDecrypter`，不得授予项目级管理、密钥创建或销毁权限。

ADC audience 必须与服务端 `RWA_GCP_WIF_AUDIENCE` 精确一致，subject token type 固定为 mTLS，
token URL 固定为 `https://sts.mtls.googleapis.com/v1/token`。`adc.json`、
`certificate_config.json`、证书、私钥和 trust chain
均必须位于 `/run/secrets/gcp-wif` 的真实路径内；启动和每次 KMS 使用前都会执行
`lstat + realpath + stat`，拒绝 symlink、非 regular file、非 UID `20001` owner 或非 `0400`
权限；根目录必须为 UID `20001` owner 且权限为 `0700`。API 固定以 `20001:20001` 非 root
身份运行，并拒绝 rootless Docker、user namespace remap、非 tmpfs 来源、可写挂载和可写子挂载。
实际 project number、pool 与 provider 尚未写入示例，部署前必须由已创建的 WIF 资源补齐。

KMS/ADC 不可用、证书过期、权限撤销、CryptoKey disabled 或 AAD 不匹配时，凭证新增、读取、
轮换和所有新增风险动作均 fail-closed；公开看板继续可用。若存在未完成执行且凭证无法解密，
系统进入 `manual_intervention` 并要求用户在对应交易所人工核对订单和仓位，不得声称能够自动退出。

完整五文件 bundle 必须先位于服务器本地、仓库外、root-only 的受控 source 目录，audience
另存为 root-only 文件；不得通过 CLI 参数、环境变量、shell history 或聊天传入材料内容。
`scripts/install-gcp-wif.sh` 先完整验证 source，再建立新的 tmpfs staging，复制为
`20001:20001`、目录 `0700`、文件 `0400`，最后以 `mount --move` 一次性发布。部分 bundle、
额外文件、symlink/hardlink、路径逃逸、非 mTLS ADC、错误 audience/STS、owner/mode 或最终 mount
校验失败均不会保留可供 runtime 使用的目标。
安装器首参数必须严格为 `production`，并固定映射到 `/run/xingheng/gcp-wif`；不接受调用方目标
路径。若宿主 `/run` 使用 shared mount propagation，安装器会先把 `/run/xingheng` 建成独立的
private self-bind 边界，再在其中执行
staging tmpfs 的原子 `mount --move`；不会修改整个
`/run` 的传播属性，也不会退化为磁盘文件或非原子复制。

宿主机部署前必须先确认 `/run` 为 tmpfs，再由 root 注入身份材料；Compose 不会自动创建宿主目录：

```bash
findmnt -T /run/xingheng/gcp-wif -o FSTYPE,TARGET
./scripts/install-gcp-wif.sh production \
  /服务器本地受控source /服务器本地受控audience文件
```

身份文件先在受限临时位置完整生成并校验，再安装为 `20001:20001 / 0400`。日常叶证书轮换使用
版本化 cert/key 文件：先写入并 `fsync` 新文件，再让新的 certificate config 同时指向它们，
最后在同一目录原子替换 `certificate_config.json`。旧 cert/key 至少保留两个 access-token
生命周期后再删除。ADC audience/provider 或 trust chain 变化使用受控 API 重启，不承诺单实例
零中断。吊销后立即保持服务端急停，并删除 tmpfs 中对应材料；宿主重启会清空 `/run`，必须由
受控部署流程重新注入后才能启动 API。Google Auth 会在 token 刷新时持续读取这些文件，不能在
启动后撤掉挂载。

WIF 身份材料不得进入项目备份/恢复、SQLite 备份或自动套利数据备份。`compose.yaml` 已完成
只读 WIF 目录挂载和自动套利独立数据卷接线；第 4 项代码与静态契约已通过固定安全复验，但实际
Docker named volume owner/mount、旧容器迁移及恢复演练尚未在真实 Docker 环境验证。完成真实
部署演练前，禁止在生产录入真实交易所凭证或解除真实执行急停。

生产 WIF 当前资源口径固定为 project `xingheng-production`、project number
`1056262324418`、Pool `xingheng-rwa-prod`、Provider `vultr-x509`。leaf 私钥只允许在 Vultr
本机 root-only source 保存；离线 root CA 私钥只用于一次签发，并在 Provider/IAM 与真实
STS/KMS health 完成后销毁。公开 CSR、leaf 证书、root trust store 和 fingerprint 可在受限路径
归档。当前五文件 bundle 已完成 source 与 tmpfs 安装校验；仍需在同一 release 的 activation
preflight 中证明真实 STS/KMS health，未通过前不得进入 legacy capture 或 release activation。

敏感操作 TOTP 状态与交易所凭证使用同一个 KMS provider，但采用独立 purpose/AAD/domain 和独立
密文文件；TOTP secret、恢复码明文和一次性授权 token 不得写入环境变量。其密文位于
`RWA_AUTOMATION_DATA_DIR` 当前 generation 下的 `step-up-security`，由自动套利专用加密备份覆盖。
密码重置只在 SQLite 保存非敏感 enrollment invalidation epoch，用于在 KMS 暂时不可用时仍持续
拒绝旧 pending enrollment；该字段不包含 TOTP secret、验证码或恢复材料。

## RWA 自动套利数据备份与恢复

生产使用三个互不复用的 named volume：

- `rwa_automation_data` 只挂载到 API 的 `/app/rwa-automation-data`，保存 generation 指针、
  交易所 credential envelope、TOTP security envelope、账户配置、用户/策略急停、执行恢复记录、
  策略归因/PnL 与审计。
- `rwa_automation_backups` 只挂载到一次性备份/恢复工具的 `/app/rwa-automation-backups`；API
  不可见该卷。
- `rwa_automation_lock` 只保存本机 `flock` 协调文件。API 在 Node 进程内以安全 FD 持有独占锁；
  备份、恢复和回滚取得同一锁后才能执行，避免 API 未停止时生成跨文件不一致快照。

SQLite 继续只使用 `sqlite_data/sqlite_backups` 与 `scripts/backup.sh/restore.sh`；策略报告继续只
使用 `strategy_data`。WIF `/run/secrets/gcp-wif`、SQLite、策略报告、临时文件、lock、preflight
challenge、一次性 step-up token、内存 cache/armed 状态和 provider raw response 均不进入自动
套利归档。

自动套利备份采用独立 `purpose=automation-backup`、AAD schema
`rwa-automation-backup:v1:backupId:environment` 和 domain
`rwa-automation-disaster-recovery`。每份备份生成随机 32-byte DEK，以 AES-256-GCM 整体加密
manifest 与全部文件，再由现有 provider-neutral GCP KMS 包裹 DEK；归档不包含明文 DEK、
凭证、TOTP secret、恢复码或 WIF 身份材料。manifest 固定记录 schema、UTC 创建时间、环境、
严格相对路径、文件大小和 SHA-256。任何未知文件、symlink、hard link、路径逃逸、错误 owner/mode、
未知 schema、hash/AAD/tag/wrap reference 不一致或 KMS 不可用均 fail-closed。

备份与恢复命令：

```bash
# 停止 API、取得独占锁、创建整体加密备份，再重启 API/web。
./scripts/rwa-automation-backup.sh

# 只接受精确文件名；停止 API，在新 generation 全量校验后原子切换 current.json。
./scripts/rwa-automation-restore.sh rwa-automation-YYYYMMDDTHHMMSSZ.rwa.enc.json

# 恢复后验证不通过时，停止 API 并把 current.json 切回上一 generation。
./scripts/rwa-automation-rollback.sh rollback
```

恢复不会覆盖原 generation：工具先在同一数据卷的全新 generation 解密、写入并复核所有文件，
通过后原子替换 `current.json`；该单一 pointer 同时记录 current 与 rollback generation。中断发生在切换前时
原数据完全不变；切换后新 generation 已完整，原 generation 仍可回滚。恢复出的 automation state
会清除全部 challenge，并强制 `globalExecutionEnabled=false`、`strategyEnabled=false`、
`killSwitchActive=true`；服务端总急停来自运行配置，不受备份控制。服务重启只允许既有
recovery/manual_intervention 与退出流程，不会自动重放建立对冲组合。

生产保留配置：

```bash
RWA_AUTOMATION_BACKUP_RETENTION_DAYS=30
RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES=1073741824
RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES=104857600
```

保留期允许 `1..365` 天，总容量允许 `1 MiB..10 GiB`，单快照允许 `1 KiB..500 MiB` 且不得超过
总容量；非法值拒绝启动/执行。清理仅匹配
`rwa-automation-YYYYMMDDTHHMMSSZ.rwa.enc.json`，未知文件或 symlink 会让操作失败，不会被删除。
至少每日备份，并把生成的密文文件复制到独立主机或对象存储；异机副本只复制 `.rwa.enc.json`，
不得复制 WIF。至少每月在隔离卷执行一次恢复演练并验证 credential/TOTP 可解密、急停开启、
未完成执行进入恢复或人工处理。GCP CryptoKey/WIF 权限不可用时备份与恢复均失败；仅有密文副本
不能绕过 KMS 解密。

当前没有生产真实自动套利凭证，旧容器层或手工目录不得自动迁移。若部署前发现旧数据，必须停止
API，逐文件核对既有不可逆用户域、venue 与 accountId 的已知归属，先复制到隔离位置并完成 fake/
离线结构验证，再由明确的迁移任务写入新 generation；不能根据文件名猜测用户或账户。真实 Docker
daemon、named volume 首次 owner `20001:20001`、只读/读写 mount、flock、容器重建、异机副本和
恢复/回滚演练仍属于部署前现场验证项。

首次从旧 UID `1000` 切换到 `20001` 时，现有 `sqlite_data`、`strategy_data` 和
`sqlite_backups` 卷不会自动改 owner。该迁移只允许由首次 verified activation 在
production transaction lock 内调用固定 migration CLI；公开 Compose wrapper 会拒绝调用者
扩展的 `--user`、`--entrypoint` 和任意 shell：

```bash
sudo ./scripts/activate-first-verified-release.sh \
  /受控桥接目录/legacy-bridge \
  /opt/xingheng-release/code/deploy/release-manifest.json \
  /opt/xingheng/.env.verified-release
```

首次 activation 会在失败时恢复冻结 owner 和 legacy runtime。不得手工重放 ownership
迁移，也不得通过放宽目录为全员可写来规避迁移。

## 自动套利单执行实例租约

生产只支持一台主机和一个 Node 执行实例。固定配置如下，缺失或改变任一项都会拒绝启动：

```bash
RWA_AUTOMATION_EXECUTION_MODE=single-host
RWA_AUTOMATION_INSTANCE_COUNT=1
RWA_AUTOMATION_LOCK_DIR=/app/rwa-automation-lock
RWA_AUTOMATION_LOCK_PATH=/app/rwa-automation-lock/operation.lock
```

API 不再依赖 Compose command 外层锁；应用在构造 GCP KMS provider 和自动套利服务前安全打开
锁文件 FD，并以 util-linux `flock` 竞争 non-blocking exclusive 租约。第二实例竞争失败会在任何
registry 初始化、KMS 解密或 provider 私有读写前退出。锁目录必须是当前主机的独立可写 local
named volume mount，禁止 NFS/CIFS/9p/Ceph/GlusterFS/FUSE。Compose 不允许 replicas，
cluster/PM2 和第二套 API 容器均不受支持；同一配置复制到另一台主机也被明确禁止，因为本地锁无法
跨主机提供 fencing。

镜像预置锁目录 `root:root 0555` 和锁文件 `20001:20001 0600`。API UID 可打开锁文件但不能删除或
替换目录项；生产缺文件、owner/mode 不符、symlink、hardlink、非独立 mount、只读 mount 或网络
文件系统均 fail-closed。已有第 4 项锁卷若仍是整体 `20001:20001 0700`，升级前必须停止 API 和
运维 one-shot，在受控 root 运维容器中核对卷只含 `operation.lock` 后改为上述 owner/mode；不得
删除数据卷、备份卷或 WIF mount，也不得以 `0777` 绕过。

进程崩溃会由内核随 FD 关闭自动释放锁，锁文件本身不是 PID/stale owner。新进程取得租约后按已
持久化 execution reservation 和策略订单 ID 恢复，只允许权威查询、撤销策略订单、退出策略两侧
仓位或进入 `manual_intervention`，不会重放建立对冲组合。锁丢失监控会立即终止旧进程；无租约
实例不得执行 provider 写，包括退出。正常持锁实例的激活急停、关闭执行开关与受控退出保持可用。

第 6 项代码与静态契约已通过固定安全复验。独立测试确认当前锁路径被替换时旧 owner 立即失效，
且租约在首次 provider 写后失效时不会继续执行后续下单、撤单、补偿或恢复写入。真实 Linux
容器内 `flock`、named volume owner/mode、双容器竞争、崩溃重启与旧锁卷迁移仍需部署现场演练；
完成前不得录入真实交易所凭证、解除服务端总急停或把当前能力描述为多主机支持。

## 自动套利限流与容量

第 5 项限流、challenge、step-up authorization、in-flight 互斥与用户 registry 仍依赖单进程同步
原子状态；第 6 项通过上述本机租约保证只有一个此类进程存活。不得增加 API replicas、并行启动
第二个 API 容器或用多进程 cluster/PM2 绕过该约束。

`.env.production.example` 固定了完整安全默认值。关键门禁为：credential `4/10min`，
preflight `4/10s + 30/10min`，execute `2/60s + 6/1h` 且同账户并发 1，退出共享
`12/60s`、reserve `3/1h` 且同账户并发 1。状态默认保留 30 天幂等记录，完成执行
soft/hard `2000/2200`，状态文件 soft/hard `8/10 MiB`。所有值必须是安全范围内的正整数；
0、负数、unlimited、极大值、hard 小于 soft、持续窗口不长于 burst 窗口或幂等保留短于
30 天都会使生产启动失败。

429 响应带 `Cache-Control: no-store` 和整数 `Retry-After`。限流审计不得包含源 IP、内部 hash、
账户 domain、bucket key、Secret 或 provider 原始响应。激活急停、关闭执行开关不使用新增风险
预算；受控退出有独立预算与有界 reserve。容量达到 soft 上限时只拒绝新增风险，hard reserve
留给退出、恢复与安全状态持久化。若 hard 上限也无法维持，API 保持 fail-closed并提示在交易所
人工处理，不得删除开放仓位、manual_intervention 或保留窗口内的幂等记录。

Request admission 必须先于 request-driven registry 创建；非敏感账户元数据只在第一
阶段通过后读取，KMS/provider 恢复初始化只在账户级第二阶段也通过后执行。step-up authorize
解析自动套利 intent 时同样携带服务端来源 IP 并先走两阶段门禁；authorization 使用全局及每
用户原子 reservation，跨用户并发不能突破配置硬上限。

## 自动退出活动连续性

活动连续性候选方案只接受专用子账户。Binance 生产环境必须显式配置
`RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS`，值为服务端派生的 `binance:<16位小写hex>`
内部指纹列表；默认空。不得把 provider UID、API Key、固定 IP 或其他凭证填入该变量。Bybit
只接受已证明为非 master 的 UTA 专用子账户。

候选监控要求 XAUT 现货、永续仓位和两侧活动订单从零开始，15 分钟补扫，5 分钟重叠，最大断档
24 小时。离线 scanner 覆盖 Binance 32 个来源请求加一次账户证明、Bybit 13 个来源请求加一次
账户证明；每来源最多 20 页，并发 4，瞬时错误只按 100ms、500ms 重试。理论最坏单轮 provider
尝试上限分别为 1921 和 781；状态继续受每来源 32 个事件 ID、每侧 64 个 provider order ID、
256 个策略订单前缀、每用户 100 条 active execution 与 8/10 MiB soft/hard 上限约束。

当前真实 Binance/Bybit REST API 没有跨这些来源的原子活动水位。扫描前 cutoff 之后发生的事件
会被端点的 `endTime/createTimeTo` 排除，任何有限次数的补扫仍会留下“最后扫描结束到首次写”
窗口。因此真实 adapter 即使完成上述只读遍历也固定把结果降级为 `incomplete`，不会建立 monitored
coverage，自动 leverage/cancel/place 均不可用。scanner 的 complete 只证明一个冻结时间窗内的
离线协议遍历，不得用环境变量、专用账户口述或缩小数量把它提升为真实执行许可。

启动/恢复首轮 provider 或 coverage 失败时，服务先原子进入 `manual_intervention`、关闭
global/strategy execution、激活用户急停并清除 challenge，然后可以只读方式监听，供查看与人工
处置；状态/租约读取或 disarm 落盘失败则阻止监听。两种结果必须分别记录，不能把“只读启动成功”
写成“活动监控通过”。

## Hyperliquid Testnet 真实交易运维

`/app/trade` 第一阶段固定 Hyperliquid Testnet。平台后端不保存用户 API wallet 私钥、
助记词、签名或可重放 payload；exchange 动作只转发前端已签名请求，并继续拒绝 Mainnet、
资金转移、Builder fee 等越界动作。

生产 `.env.production` 中可调整以下安全默认值；Compose 已通过 `env_file` 注入 API 容器，
不需要在 `compose.yaml` 里硬编码：

```bash
REAL_TRADING_EXCHANGE_RATE_LIMIT_MAX=30
REAL_TRADING_RISK_MAX_SNAPSHOT_AGE_MS=10000
REAL_TRADING_AUDIT_RETENTION_DAYS=180
REAL_TRADING_REALTIME_TOKEN_TTL_MS=60000
REAL_TRADING_REALTIME_MAX_ADDRESSES=100
REAL_TRADING_RECONCILIATION_INTERVAL_MS=60000
REAL_TRADING_RECONCILIATION_BATCH_SIZE=50
```

服务端不再设置平台自定义最高杠杆、单笔名义、总敞口或当前委托数量上限；这些约束交由
Hyperliquid Testnet 按品种、账户和交易所规则裁决。服务端仍在新增风险订单前校验账户
与市场快照新鲜度，仍保留登录鉴权、禁用用户 `403`、签名恢复、Agent 绑定、cloid 幂等、
审计脱敏、pending reconciliation、provider 逐项错误处理和 Reduce-only 防反手。

Pending reconciliation worker 启动后立即检查一次，之后按
`REAL_TRADING_RECONCILIATION_INTERVAL_MS` 限频运行；合法范围为 `30000..300000` 毫秒，
非法或缺失时使用 `60000`。每轮按 `REAL_TRADING_RECONCILIATION_BATCH_SIZE` 读取待恢复
request；合法范围为 `1..500`，非法或缺失时使用 `50`。该 worker 只查询 Hyperliquid
Testnet `orderStatus`，不会重放原 order/cancel、不会重新发送签名 payload。只有同一
request 的全部 cloid 均查到权威订单时才自动恢复；非 order 或仍未知的 pending 会留给
运营核对。

后台只读状态：

```http
GET /api/admin/real-trading/operations
```

该接口走现有后台登录保护，返回 Testnet 网络、reconciliation 状态、实时 user stream
状态、风险 in-flight、pending 数量与最老年龄、近 24 小时 accepted/rejected/partial/
pending 计数和审计清理状态。顶层状态为 `ok / degraded / unavailable`；存在 manual review
pending、reconciliation 连续失败或 stale、active stream stale/reconnecting 时应按
`degraded` 处理。无 active stream 属于 `idle` 场景，不单独视为异常。

用户刷新恢复接口：

```http
GET /api/real-trading/orders/reconciliation
```

该接口走用户登录保护，禁用用户返回 `403`，只返回当前用户仍需对账的脱敏 pending 记录，
用于前端硬刷新后恢复页面锁与审计轮询；HTTP 请求本身不访问 Hyperliquid、不触发恢复、
不重放订单。

## 策略 Paper 运维

策略模块只做 Binance Route B Paper 前向验证与历史回测只读展示，不接 Binance 交易
API、不读取交易所 API key、不下单，`automaticOrdersEnabled` 固定为 `false`。

生产 Compose 使用独立 `strategy_data` named volume，和 SQLite 的 `sqlite_data` 分离：

```bash
STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json
STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json
STRATEGY_FORWARD_WORKER_ENABLED=true
STRATEGY_FORWARD_WORKER_POLL_MS=300000
MARTINGALE_GRID_PAPER_REPORT_PATH=/app/strategy-data/martingale-grid-paper.json
MARTINGALE_GRID_PAPER_WORKER_ENABLED=true
MARTINGALE_GRID_PAPER_WORKER_POLL_MS=300000
FIXED_GRID_PAPER_REPORT_PATH=/app/strategy-data/fixed-grid-paper.json
FIXED_GRID_ARCHIVE_CACHE_PATH=/app/strategy-data/fixed-grid-archive-cache
FIXED_GRID_PAPER_WORKER_ENABLED=true
FIXED_GRID_PAPER_WORKER_POLL_MS=300000
```

前向 Paper Worker 启动后立即检查一次；之后默认每 5 分钟轻量查询最新已收盘 5m K 线。
只有 closed candle 推进时，才下载完整前向区间并重算报告。Binance 出网失败、限频、
数据缺口或报告写入失败不会让 API 退出，也不会让 `/api/health` 变为失败；前端只读接口会
继续返回上一份有效报告和脱敏后的 worker failure 状态。策略失败不得影响 `/app/demo`、
`/app/trade` 或 SQLite 数据。

后台运维状态：

```http
GET /api/admin/strategy/health
```

该接口走现有后台登录保护，只返回脱敏状态：worker enabled/running/lastAttemptAt/
lastSuccessAt/lastCompletedCandleAt/nextCheckAt/consecutiveFailures/lastError、报告可读性、
freshness 状态与告警条件。不要把本地路径、SMTP 密钥或外部 token 暴露到接口。

告警条件：连续失败 `>=3`、启用后超过宽限期仍无首次成功、最近 closed candle 超过 15 分钟
未推进、前向报告不可读。

本轮外部告警先使用 SMTP/Resend 邮件，默认关闭：

```bash
STRATEGY_EMAIL_ALERTS_ENABLED=false
STRATEGY_ALERT_EMAIL_TO=ops@example.invalid
STRATEGY_ALERT_COOLDOWN_MS=900000
```

生产启用时由项目管理在服务器 `.env.production` 写入实际收件邮箱；业务代码不硬编码个人
邮箱。邮件发送失败只写脱敏结构化日志，不影响 Worker、API health 或前向报告。其他外部
告警渠道后续再处理，本轮未实现、未配置。

历史回测报告需要手工一次性生成，不在 Docker build、API 启动或 HTTP 请求中执行：

```bash
. scripts/load-release-manifest.sh
node scripts/verify-deployment-revision.mjs images "$release_manifest"
production_compose --profile strategy-tools run --rm strategy-history
production_compose --profile strategy-tools run --rm strategy-history npm run strategy:history:check -- /app/strategy-data/route-b-history.json
```

生成脚本从 Binance Vision 下载官方历史归档、校验 checksum、拒绝 5m 缺口，并用临时文件
+ rename 原子覆盖 `route-b-history.json`。失败时旧报告保留；若旧报告仍可读，线上页面继续
展示旧数据。历史报告可重建，日常备份可把 `strategy_data` 作为独立 JSON 数据卷备份；
不要把它纳入 SQLite `.backup` / restore 流程，也不要在恢复 SQLite 时覆盖策略 JSON。

部署或故障 smoke 建议：

```bash
. scripts/load-release-manifest.sh
production_compose ps
production_compose logs --tail=200 api
curl -fsS "https://你的域名/api/health"
curl -fsS "https://你的域名/app/demo" >/dev/null
curl -fsS "https://你的域名/app/trade" >/dev/null
```

如果 Binance 暂时不可达，预期是 API health 仍为 200，`/app/demo` 与 `/app/trade` 不受影响，
`/api/strategy/ict/forward` 返回旧报告和安全的 worker failure；不要因此自动重启或恢复
SQLite。

## 邮件服务配置

注册和找回密码均依赖邮箱验证码。生产环境必须配置 SMTP，否则 API 启动会拒绝：

```bash
APP_PUBLIC_URL=https://你的域名
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM="Stella X <no-reply@example.com>"
```

常见取值：

- 587 端口通常配 `SMTP_SECURE=false`，使用 STARTTLS。
- 465 端口通常配 `SMTP_SECURE=true`。
- `APP_PUBLIC_URL` 必须与 `DOMAIN` 对应的 HTTPS origin 一致，用于生成找回密码链接。

Resend SMTP 推荐填法：

```bash
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASSWORD=Resend API Key
SMTP_FROM="Stella X <no-reply@已验证域名>"
```

`SMTP_PASSWORD` 是 Resend API Key，只能写入服务器本机 `.env.production` 或外部密钥系统，
不得提交到 Git，也不要粘贴到日志、Issue 或对话中。`SMTP_FROM` 必须使用 Resend 已验证域名。
`.gitignore` 默认忽略 `.env.*`，只放行 `.env.example` 和 `.env.production.example`。

上线前或部署后需要由拥有测试收件箱权限的人做一次真实发信 smoke：发送注册验证码或找回
密码邮件到测试邮箱，确认 Resend Activity 和收件箱都能看到邮件。没有收件邮箱授权时，
测试验收不应擅自发真实邮件。

开发环境未配置 SMTP 时，验证码和重置链接会打印到 API 日志；生产环境不会这样兜底。

## 日常操作

当前 XAUT MVP 的统一发布与真实闭环不属于日常部署或 smoke。执行前必须阅读
[`RWA_XAUT_MVP_CONTROLLED_VALIDATION_RUNBOOK.md`](./RWA_XAUT_MVP_CONTROLLED_VALIDATION_RUNBOOK.md)，
先运行 `npm run test:rwa-mainnet-readiness` 完成零资金离线 rehearsal，并分别停在“统一生产发布”
和“真实资金窗口”两个独立用户批准点。离线 rehearsal 会拒绝 production、真实 ADC/凭证相关
环境和已关闭的服务端总急停；它不能替代 Vultr、真实 WIF、真实 Binance 账户、产品或资金验证。
旧 [`RWA_BINANCE_25_USDT_MAINNET_RUNBOOK.md`](./RWA_BINANCE_25_USDT_MAINNET_RUNBOOK.md)
只保留为历史证据。当前首次 Capital Test 使用一次性 `single_connectivity_smoke`，总计划资本硬上限为
`40 USDT`，不是必须用满的固定预算。实际 XAUT 数量由服务端根据 Binance Spot 与 USD-M Futures
的实时交易规则和实际订单限价，取满足两端共同约束的最小可交易数量，不得为接近上限而放大；若
该数量对应的总计划资本超过 Permit 上限，必须 fail-closed，不得执行。历史 `25 USDT` 和
`0.002 XAUT` 不再作为当前执行常量。

```bash
# 服务状态和最近日志
. scripts/load-release-manifest.sh
production_compose ps
production_compose logs --tail=200 api web
production_compose logs -f api

# 一致性备份（默认保留 14 天）
./scripts/backup.sh

# 升级：先备份，再构建并以健康检查顺序替换
./scripts/backup.sh
REVISION="$(git rev-parse --verify HEAD^{commit})"
MANIFEST="/受控发布目录/xingheng-$REVISION.release.json"
./scripts/build-release-images.sh "$REVISION" "$MANIFEST"
# 受控交付清单中的镜像 digest 与清单，安装为 deploy/release-manifest.json，并更新交叉核对 revision：
./scripts/activate-release.sh deploy/release-manifest.json
./scripts/smoke.sh "https://你的域名"
```

可在 `.env.production` 用 `BACKUP_RETENTION_DAYS` 修改保留天数。建议由宿主机 cron
每天调用一次 `scripts/backup.sh`，并另行把 Docker 的 `sqlite_backups` 卷复制到
异机加密存储。脚本使用 SQLite 在线 `.backup`，会纳入已提交的 WAL 内容；禁止用
`cp`、`docker cp` 或文件同步工具直接复制运行中的 `trading.sqlite*`。

## 恢复

恢复只接受由备份命令输出和审计冻结的精确文件名，不提供任意容器 `exec/find` 入口：

```bash
sudo ./scripts/restore.sh trading-YYYYMMDDTHHMMSSZ.sqlite
sudo ./scripts/smoke.sh "https://你的域名"
```

恢复脚本只接受严格的 `trading-YYYYMMDDTHHMMSSZ.sqlite` 文件名，避免 SQLite
dot-command 路径注入；随后停止 API、对备份和恢复结果分别执行
`PRAGMA integrity_check`、清理旧 WAL/SHM 后原子替换数据库，再启动服务。恢复期间
网站 API 暂不可用。

## 回滚

1. 升级前保存当前 `0444` release manifest 的受控副本并运行备份。
2. 若新版本 smoke 失败，选择上一个已验证 manifest 绑定的三个精确镜像 digest。
3. 原子安装上一个只读 manifest，把 `.env.production` 的 `XINGHENG_REVISION` 改回其中的完整
   commit，并执行 `./scripts/activate-release.sh deploy/release-manifest.json`；不得在无可信 Git
   checkout 的生产目录重建镜像，也不得手工重写 digest。
4. 只有数据库迁移不向后兼容时，才用升级前备份执行恢复；不要因纯应用回滚覆盖新数据。
5. 再运行 smoke，执行 `. scripts/load-release-manifest.sh` 后检查
   `production_compose logs --tail=200 api web`。

## 故障边界

- 自动套利 `close-all` 只使用持久化 `strategyPosition` 作为策略所有权记录，不以近期 PnL
  或账户总余额代替。账户数量与策略剩余数量不一致、旧记录 coverage 不完整或 provider 快照
  非有限/负数时会在退出写操作前 fail-closed。即使最终数量相同，也必须证明从持久 execution
  最早创建时间起的全部持仓影响活动连续、完整且不存在非策略成交、转账、转换或余额调整；证明
  不完整或水位早于权威快照同样返回 `strategy_ownership_ambiguous`，且不得先撤单。当前真实
  Binance/Bybit adapter 因 REST 扫描期间活动窗口无法原子封闭，固定返回 `incomplete`；专用
  子账户和离线扫描成功也不能启用自动退出。运维应保持用户与服务端急停，不得通过修改状态文件、
  缩小数量或删除幂等记录强制重试。
- API 收到 SIGTERM 后停止行情、关闭 WebSocket/HTTP，再关闭 SQLite；Compose
  提供 20 秒退出窗口。
- API 健康检查失败时 Web 不会首次启动，但已运行的 Caddy 不等同于业务健康；
  运维监控应直接检查 `https://域名/api/health`。
- 证书、数据库、策略报告和备份分别使用 `caddy_data`、`sqlite_data`、`strategy_data`、`sqlite_backups`
  named volume。删除卷会删除对应持久数据，日常升级不得使用
  `production_compose down -v`。
- 私钥、助记词和管理员密码只放权限受限的服务器 `.env.production` 或外部密钥系统，
  不进入 Git、镜像或日志。
- 正式环境不会创建 `demo-user` 的演示钱包、资金账户或演示流水；若正式库中出现此类
  数据，应视为历史数据或错误导入并单独审计，不能依赖启动流程清理。
## 自动套利资产 profile 发布门禁

自动套利市场差异由服务端
`server/modules/arbitrage/automation/RwaAutomationAssetProfile.ts` 冻结。当前只有 XAUT 为
`enabled`；BTC、ETH、SOL 为 `reserved`，生产不得通过环境变量、Compose、客户端请求或手工
symbol 替换将其提升为可执行。部署验证必须确认：

- API 构建来自同一 verified revision，profile 注册表与 execution engine 未发生版本漂移。
- 旧 XAUT execution 缺少 `asset/profileId/reservedCapitalUsd` 时只走 additive migration；
  新写入和新备份要求 exact schema，未知/错配 profile 必须 fail-closed。
- XAUT V1 的 300 USDT 是 profile 当前阶段配置。单笔、单资产、单账户和全局额度只阻止新增风险；
  close-all、减仓、补偿和急停不能因超过入场额度而被阻止。
- profile 或持久风险状态无法完整读取时，不得通过 tag、运行时 env 或手工修改状态绕过 admission。
- 真实 Binance/Bybit attribution 仍为 `incomplete`；本 profile 发布不授权自动退出、Mainnet
  资金窗口或 BTC/ETH/SOL provider 写。

账户是否必须专用及账户内同资产授权范围尚未冻结，不属于本次 profile 发布门禁。生产继续沿用
既有 fail-closed 基线，待产品口径、后端契约和前端 TOTP 文案另行验收。
