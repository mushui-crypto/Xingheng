# 正式与真实测试环境同机运行

本 runbook 只定义同一服务器上两套隔离运行时的发布、核验和测试数据清理边界，不构成生产发布、
真实资金窗口、交易所授权或订单批准。两套环境均以 `NODE_ENV=production` 运行，全部自动执行门禁
默认关闭；真实测试环境不得降低租约、KMS、幂等、风控或审计要求。

## 独立 real-test 主机模式

全新独立 real-test 单 VM 仍固定使用 `real-test / xingheng-real-test / .env.real-test` 身份，
但必须改用 `scripts/real-test-standalone-compose.sh` 和
`compose.real-test-standalone.yaml`。该 override 只增加独立主机所需的固定
`80/tcp`、`443/tcp`、`443/udp`，移除同机共享 ingress，并让 Web 使用
`deploy/Caddyfile.real-test-standalone` 直接基于 `REAL_TEST_DOMAIN` 获取和续期 TLS 证书。
API `8787`、SQLite 和 Docker socket 均不发布。

同机模式与独立模式互斥：

- production 同机运行时只允许 `scripts/real-test-compose.sh`，测试 Web 不发布宿主端口；
- 独立 VM 只允许 `scripts/real-test-standalone-compose.sh`，主机不得同时运行 production
  项目或共享 ingress 模式；
- 两个入口都拒绝调用方 `-f`、`-p`、`--env-file`、扩容、构建和任意端口覆盖；
- 不得对同一 `xingheng-real-test` 项目交替调用两个 wrapper。切换拓扑必须先停止并取得独立
  变更批准，不能把普通版本回滚当作拓扑切换。

独立 VM 的 release tree、manifest、`.env.real-test`、Docker socket、WIF/KMS 和运维收据
仍必须由既有受信安装链建立。WIF 使用：

```bash
sudo scripts/install-gcp-wif.sh real-test \
  /服务器本地受控source /服务器本地受控audience文件
```

安装目标只能是 `/run/xingheng-real-test/gcp-wif`。production 仍必须显式使用
`install-gcp-wif.sh production` 并落到 `/run/xingheng/gcp-wif`；安装器不接受任意目标路径。

real-test X.509 WIF 身份参数固定为：

- Provider ID：`rwa-api-x509`
- Provider 完整资源名：
  `projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509`
- ADC、`.env.real-test` 和 root-only audience 文件使用的完整 audience：
  `//iam.googleapis.com/projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509`

### DEVOPS CA tier 契约

real-test CA Pool `xingheng-real-test-wif` 固定为 DEVOPS tier。该 tier 不存储且不支持
list、describe 或 revoke 单张证书；`gcloud privateca certificates describe` 返回 `NOT_FOUND`
和按 Pool/location list 为空属于 tier 预期，不能作为签发失败证据。`CERT_ID` 仅是本地请求和
证据关联逻辑值，不得表述为可 describe 的持久 Certificate resource，也不得从返回证书反推
CLI exit code 或服务端 Certificate exact-set。

DEVOPS 签发成功必须以 CA 返回的 PEM chain 为权威输入，并同时满足：

- chain exact 2 blocks，顺序为 leaf + 当前冻结 Root，无 intermediate；
- leaf 公钥精确匹配本批冻结 CSR 和始终留在 VM 的 root-only KEY；
- subject、issuer、唯一 URI SAN、critical CA:false、critical Key Usage、EKU 仅 clientAuth、
  RSA2048、SHA256/RSA、serial、validity、leaf/Root fingerprint 及 leaf/chain SHA 全部精确；
- Root raw-byte SHA 必须直接对 chain 中原始、未修改的 Root PEM block 计算；禁止补删尾随 LF、
  规范化或重编码后再与 raw SHA 比较；
- leaf 必须由冻结 Root 验证通过。上述任一项不精确即 fail-closed，不得安装、probe 或重签降级。

当前接受 DEVOPS 固有残余风险只适用于 P30D、T-7d 轮换、单 workload、单 Provider、
单 CryptoKey、零资金且交易门禁关闭的 real-test。证书与 KEY 同时泄露时不能执行 CA 单证书
revoke；事件处置只能表述为：清除或隔离 runtime bundle、移除该 subject 的目标 CryptoKey IAM、
disable 单 workload Provider、停止 API/Web，并等待证书自然到期。不得声称已 CA revoke。
Provider 未来若服务多个独立主体，或需要长期身份、逐证书撤销、证书库存或合规级生命周期管理，
必须重新 Architecture Review 并评估 Enterprise 新 Pool/CA。

`privateca.googleapis.com` 的 `DATA_WRITE` Data Access Audit Logs 不阻断现有公开 leaf/chain 的
隔离传输或离线 source 准备，但必须在下一次签发或续期前以独立批准批次启用并验收，建议同时在任何
真实交易启用前完成。该批次必须保留 project IAM etag 和既有 bindings，只增加所需 service/log
type、不得配置 exempted member，也不得用未保护的 `set-iam-policy` 覆盖策略；必须记录日志费用、
传播延迟，并在新签发前通过只读读取确认配置已生效。未开启期间的历史签发无法事后补记。

`create-cred-config` 的位置参数必须使用不带 `//iam.googleapis.com/` 前缀的 Provider 完整资源名；
生成的 ADC、服务端 `RWA_GCP_WIF_AUDIENCE` 和独立 audience 文件必须使用带该前缀的完整
audience。该 workload identity 直接在单一 CryptoKey 资源层级授权，禁止给命令增加
`--service-account` 或改成 VM 服务账号 impersonation。版本化证书和私钥文件名必须由已批准的
证书批次冻结。当前 D2A 已冻结 `VERSION=20260728T062225Z`，公开 leaf 和 issued chain 仅在 VM
root-only STAGE 隔离保存，KEY 未离开 VM；这不构成 ADC、source、安装或 probe 已获批。

real-test leaf 由 Provider trust store 中已冻结的 Root 直接签发，证书链没有 intermediate。
因此 real-test ADC 必须省略 `trust_chain_path`，source 不得创建 `trust-chain.pem`，Root 和
issued chain 继续只作为 D1/D2A STAGE evidence 保存。不得把 production 的五文件 profile
套用到 real-test，也不得把 Root-only 或 leaf+Root 文件伪装为 real-test trust chain。

D2B0 仅提供下列受控 helper；这段命令是未来 D2B1 的固定入口预览，不授权现在执行：

```bash
sudo env -i \
  HOME=/root PATH=/usr/bin:/bin \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/python3 scripts/prepare-real-test-gcp-wif-source.py real-test
```

helper 仅接受唯一参数 `real-test`，固定读取 D1/D2A STAGE 的冻结 inode/hash，固定调用
`/usr/bin/dash /usr/lib/google-cloud-sdk/bin/gcloud`，不执行 `/usr/bin/gcloud`，也不依赖
`PATH` 或 shebang 选择解释器。canonical gcloud 必须为 root:root `0755`、`nlink=1`、
size=5962、SHA-256=`8628b9f971d07c5e52fd2c6d469ee4a0940c75eb51820d628c3dd068981bd260`，
首行为 exact `#!/bin/sh\n`；`dash` 与 SDK bundled Python 也必须逐级 no-follow、root-owned、
不可组/全局写，并分别匹配冻结 size/SHA/package/version 收据。Google Cloud SDK 及
component exact-set 必须为冻结的 576.0.0 收据，`dpkg --verify google-cloud-cli` 必须为空。
任一工具、package、component、SDK parent/module 或收据漂移都必须在打开 STAGE 和复制 KEY/cert
之前 fail-closed。`create-cred-config` argv 不包含
`--credential-cert-trust-chain-path`、`--service-account` 或任意调用方路径。它只准备：

- `/root/xingheng-real-test-wif-source`：新建 root:root `0700`；
- `/root/xingheng-real-test-wif-audience`：exact audience + 单个 LF，root:root `0400`；
- source 四文件 exact-set：`adc.json`、`certificate_config.json`、
  `leaf-20260728T062225Z.cert.pem`、`leaf-20260728T062225Z.key.pem`。

四文件必须是 root-owned regular/non-symlink、`nlink=1`、`0400`。ADC certificate source
exact keys 只有 `certificate_config_location=/run/secrets/gcp-wif/certificate_config.json`；
不得含 `trust_chain_path`、impersonation、`client_email` 或嵌入私钥。certificate config 的
cert/key 路径必须统一指向 `/run/secrets/gcp-wif` 下的冻结版本化文件名。

helper 通过逐级 `dir_fd`/`O_NOFOLLOW`、`O_EXCL` 临时文件、fsync 和
`renameat2(RENAME_NOREPLACE)` 发布，只输出 path/dev/ino/mode/nlink/hash 与 schema 摘要。
失败时只按本批 path+dev+ino 收据清理；inode 不匹配立即停止清理。它不 install、不 mount、
不 probe，也不触碰 D1 STAGE。

所有 gcloud 子进程从空环境构造固定 allowlist，`PATH=/usr/bin:/bin`，并将
`CLOUDSDK_PYTHON` 固定为
`/usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3.14`。每批排他创建：

- `/root/.xingheng-real-test-gcloud-pycache-d2b1`
- `/root/.xingheng-real-test-gcloud-config-d2b1`

两目录必须执行前不存在，root:root `0700`，调用前后保持同一 inode 且为空；helper 固定设置
`PYTHONNOUSERSITE=1`、`PYTHONDONTWRITEBYTECODE=1`、`PYTHONPYCACHEPREFIX`、
`CLOUDSDK_CONFIG`、`CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true` 和关闭 prompt/usage/update
的 Cloud SDK 变量，不继承 proxy、loader、`ENV`/`BASH_ENV`、XDG、Python 或 Cloud SDK
ambient 变量。禁用文件日志不放宽空目录门禁：version/create/version 任一调用在 config 或
pycache 目录产生任何对象都必须 fail-closed。bundled Python probe 必须证明
user site 关闭、prefix 生效、SDK module source 由 dpkg manifest 覆盖；SDK 中未被 manifest
覆盖的对象只允许安全的 `__pycache__` 目录及其 `.pyc`，并以每批动态 count+sorted-set hash
作为调用前后 baseline，禁止硬编码现场缓存数量。成功与失败均只在两个隔离目录仍为空且 inode
匹配时 `rmdir` 并 fsync `/root`；非空或 inode 异常不得宽清理，也不得保留可用 SOURCE/AUDIENCE。

上述是 D2B0-R2 本地代码契约，不表示 VM 工具链或隔离目录已经现场通过。D2B0-R2-R1 临时
behavior runner 已在任何验证根创建和首次 gcloud 调用前因 `unsafe SDK object` fail-closed；
`behavior_attempts=0`、D2B1 helper attempts=0，固定验证根
`/root/.xingheng-real-test-gcloud-behavior-d2b0-r2-r1` 保持不存在。

D2B0-R3 将 SDK package boundary 归一化、分类、摘要和双扫描比较集中到唯一
`scripts/gcp_sdk_boundary.py`；prepare helper 与只读工具链诊断器
`scripts/verify-real-test-gcloud-toolchain.py diagnose` 复用该核心。manifest membership 仅使用
SDK root 下规范 POSIX 相对路径；manifest 对象和唯一允许的未 manifest `__pycache__`/direct
`.pyc` 例外均按 no-follow metadata 分类。稳定对象身份摘要必须包含
`dev/ino/uid/gid/mode/nlink/size/ctime_ns`、type、reason、membership 和 symlink raw target；
禁止为此读取并 hash 整棵 SDK 文件正文。`diagnose` 在同一进程内使用同一内存 manifest snapshot
连续执行 reference/current 扫描，并在 reference 后、current 后和返回前重新绑定 SDK root、
工具、package version、list/md5 receipts 与 `dpkg --verify`。任一对象身份或后置收据漂移必须
返回 `concurrent_drift=true`、首个差异或 drift phase 并 fail-closed。诊断只输出 count/hash、
首个 unsafe 和结构化漂移收据；它不 mkdir、不 open-write，也不调用 gcloud。`behavior` 子命令
当前明确 fail-closed，尚未实现或授权现场执行。

R3 已形成受信 revision `be83c732aa574bca7898fd31cf200024804ac049`，但 `diagnose` 尚未在
VM 执行；任何现场 diagnose 或后续 behavior 验证都需要独立授权。恢复 D2B1 前仍须完成受信
现场诊断与后续行为验证，并从同一受信 revision 冻结、验证和传输 prepare helper 与
`gcp_sdk_boundary.py` 两个 artifact；缺少共享核心或任一 bytes/mode 收据不一致必须
fail-closed，不得回退到复制分类逻辑。不得把本地 fixture 结果解释为现场工具链通过。D2B1
和后续 D2B2 必须分别取得独立用户授权。

D2B0-R3 首轮 Code Review 发现 1 个 P1：原摘要未绑定 inode/ctime 等对象身份，且 package
verify 到扫描及 current 到返回存在未重新绑定窗口。D2B0-R3-R1 已按上述规则完成最小修复和
精确复现测试；同一 Reviewer 已确认该代码层 P1 关闭。

现场 presence/identity gate 随后证明冻结路径 `/opt/xingheng-release/code` 为真实
`ENOENT`，因此不能从 VM 持久文件执行 commit-exact verifier/core，分类固定为
`MISSING/R4_REQUIRED`。后续 R4-R1 只读启动链 probe 的两次连接上限已经耗尽：第一次在
remote exec 前 `Broken pipe`，第二次执行唯一 probe；`connection_attempts=2`、
`probe_attempt=1`、writes=0，diagnose、behavior 和 D2B1 attempts 仍均为 0。

D2B0-R4 的本地实现提供单一 stdin artifact
`scripts/verify-real-test-gcloud-toolchain-standalone.py`。它内嵌 revision
`be83c732aa574bca7898fd31cf200024804ac049` 的 verifier/core 原始 Git blob bytes，在
compile 前逐项验证 size、SHA-256 和 Git blob OID，以固定 synthetic module metadata 将 core
注册为内存模块后再执行 verifier；core 不从 ambient 路径 fallback import，但 verifier 运行期
仍从下述冻结 stdlib/dynload 边界加载 Python 标准库，只接受唯一 `diagnose` 参数，固定
`sys.dont_write_bytecode=True`，不提供 behavior、prepare 或 gcloud 调用路径。
`scripts/build-real-test-gcloud-toolchain-standalone.py` 只在可信本地侧从固定 commit blobs
确定性生成该 artifact。

R4-R1 冻结启动链必须精确为 `/usr/bin/env -i LC_ALL=C LANG=C TZ=UTC` 加 canonical
bundled Python 的 `-I -S -B - diagnose`。artifact 自身必须拒绝 argv、flags、environment、
prefix 或 ordered `sys.path` 漂移。初始 `sys.path` exact-set 且有序为
`python314.zip`、`python3.14`、`python3.14/lib-dynload`；其中 `python314.zip` 是现场
Python 3.14.6 的标准缺失 zip 搜索槽。唯一允许的 missing 例外必须同时满足冻结 absolute
path、父链逐级 no-follow 安全、leaf 恰为 `ENOENT`；leaf 若存在为任何类型或返回其他 errno
一律拒绝。随后必须从 `sys.path` 和 importer cache 删除该槽，只保留有序的 stdlib/dynload
两项，并证明两项目录属于受信 `google-cloud-cli` manifest、root-owned 且不可
group/world write。inner load 前、load 后和退出前必须重新绑定完整启动与文件系统收据。

本批明确排除“攻击者已取得并可并发使用 root 权限原地改写解释器、stdlib 或进程”的威胁模型；
该权限域同时能够读取 root-only KEY 或替换解释器，不能由同一可变 VM 上的 Python 用户态
verifier 自举消除。运维前提固定为：无并发 root 管理会话，解释器/stdlib/SDK 均为 root-owned、
不可 group/world write、package/version/manifest exact 且调用前后收据不漂移。标准库文件在
检查与默认 loader 执行之间遭同权限原地改写的 TOCTOU 作为明确残余风险保留，不得描述为已被
三阶段复核消除。若未来要求对抗并发 root compromise，必须另案采用无 filesystem runtime
imports 的专用诊断器或内核强制不可变执行边界，不得在本批静默扩大实现范围。

未来现场传递必须先形成并批准包含 standalone 的新受信 revision，再由可信侧执行
`git cat-file blob <standalone-OID>`，将原始 blob bytes 直接经 SSH stdin 送入 VM 固定
canonical 启动链。禁止 heredoc、base64、命令替换、网络下载、第二路模块或现场重组源码。
R4-R1 当前仅完成本地实现；新 revision、standalone OID、现场 diagnose、behavior 和 D2B1
均须后续独立确认，本文不构成执行授权。既有连接上限不得解释为新现场重试授权。

未来 D2B2 的固定 installer 入口为：

```bash
sudo scripts/install-gcp-wif.sh real-test \
  /root/xingheng-real-test-wif-source \
  /root/xingheng-real-test-wif-audience
```

历史失败 ID `gcp-vm-x509` 使用 Google 保留的 `gcp-` 前缀，禁止作为当前配置、audience 或
credential config 输入。

独立模式激活前先验证 DNS 已指向该 VM、仅开放公网 80/443，并确认没有进程占用固定端口。
没有真实 DNS 时不得用自签名证书或 HTTP 冒充通过。使用 canonical manifest 激活：

```bash
sudo scripts/activate-real-test-release.sh standalone
node scripts/verify-deployment-revision.mjs \
  compose-real-test-standalone deploy/release-manifest.json .env.real-test
node scripts/verify-deployment-revision.mjs \
  containers-real-test deploy/release-manifest.json standalone
node scripts/verify-release-volume-boundaries.mjs real-test runtime
```

激活在 Compose、镜像、revision、容器或 volume 验证失败时会停止 real-test API/Web。
成功前还会有界等待 API/Web Docker Health 进入 `healthy`，并精确核对所选 topology label、
宿主端口、网络集合，以及内部 `/api/health` 的 `deploymentEnvironment=real-test`、
`composeProject=xingheng-real-test`、当前完整 revision 和 `Cache-Control: no-store`。
这些仅是容器内部运行态证据，不能替代公网 DNS、ACME 或证书链现场收据。
版本回滚必须先通过既有受信候选安装流程恢复上一份完整 canonical release tree、manifest 与
`.env.real-test`，再执行同一 `standalone` 激活；不得手工改写 manifest、env、镜像 tag 或
直接调用 Docker Compose。当前 production 的 `rollback-release.sh` 只属于 production
release lifecycle，禁止用于 real-test。

## 固定身份

| 环境 | Compose 项目 | env 文件 | 域名 | WIF 宿主路径 | cookie namespace |
| --- | --- | --- | --- | --- | --- |
| 正式 | `xingheng` | `.env.production` | `DOMAIN` | `/run/xingheng/gcp-wif` | `xh_user_session` / `xh_admin_session` |
| 真实测试 | `xingheng-real-test` | `.env.real-test` | `REAL_TEST_DOMAIN` | `/run/xingheng-real-test/gcp-wif` | `xh_real_test_user_session` / `xh_real_test_admin_session` |

禁止直接调用 `docker compose`。正式只使用 `scripts/production-compose.sh`，真实测试只使用
`scripts/real-test-compose.sh`；两者拒绝 `-f`、`-p`、调用方 `--env-file` 和全部 ambient
`COMPOSE_*`。wrapper 从仓库根目录固定解析 `.env.production` / `.env.real-test`，并在 Compose
前以 `O_NOFOLLOW` 打开两个独立描述符，验证 regular、`nlink=1`、`0600`、owner、同一
`dev/ino/size/SHA-256`；一个描述符供编排插值，另一个仅供 API `env_file`，两者保持打开直至
Compose 退出。Linux 使用 `/proc/self/fd/3` 和 `/proc/self/fd/4`，不得在验证后重新按固定路径
打开。生产主机固定使用 root:root、regular、`nlink=1`、不可组/全局写的
`/usr/libexec/docker/cli-plugins/docker-compose`；插件以 `O_NOFOLLOW` FD 读取并在 Linux
通过 `/proc/self/fd/5` 执行，避免 Docker CLI 丢弃继承描述符，也避免校验后路径替换；
启动前后输出的脱敏收据必须保持 `dev/ino/size/SHA-256` 精确一致。调用 cwd 不能改变身份。

所有 root 运维入口必须经 `scripts/trusted-operation-launcher.mjs`，以等价 `env -i` 的最小环境、
固定 `/root`、固定 `PATH`、仓库根 cwd 和 `umask 077` 运行，并按
`release-global.lock -> production.lock|real-test.lock -> 容器内 RWA operation.lock` 顺序持锁。
`NODE_OPTIONS`、`NODE_PATH`、`NODE_ENV`、`NODE_TEST_CONTEXT`、`LD_*`、`DYLD_*`、`BASH_ENV`、
`ENV`、`XDG_*`、`XINGHENG_TEST_*`、全部 `DOCKER_*` / `COMPOSE_*` 均在读取 env 或调用 Docker
前拒绝。现场 ambient 不能打开测试 seam。

非 Compose
Docker 操作固定使用 root:root 的 `/usr/bin/docker` 并通过其已验证 FD 执行；子进程只接收
`DOCKER_HOST=unix:///var/run/docker.sock`。该 socket 必须是 leaf 非 symlink 的本机 Unix socket、
root owner、`0660`、`nlink=1`。不得从调用方 `HOME`、`PATH`、Docker context、TLS/cert 或远端
daemon 解析执行目标。测试替身只允许 Node test context 下显式提交绝对路径、预期 SHA-256 和
真实临时 Unix socket，不能作为现场正例。

可信安装收据 `/etc/xingheng/trusted-operations.json` 绑定 Node、dash、flock、findmnt、git、tar、
sha256sum、Docker CLI、Compose plugin、socket、daemon ID/RootDir/version/storage driver，以及
canonical release tree 内 manifest、Compose、脚本的 exact dev/ino/size/mode/mtime/ctime/SHA。
每个变更步骤前后的 wrapper/运行时复核不得漂移。

正式 Caddy 是唯一绑定宿主 `80/443` 的公网入口。测试 Web 不发布宿主端口，只能通过固定
`xingheng-public-ingress` 网络的 `real-test-web` 别名接收 `REAL_TEST_DOMAIN` 流量。
`REAL_TEST_DOMAIN` 不得与 `DOMAIN` 相同，也不得回落到正式 API。

## 发布前门禁

两套 Compose 必须消费同一只读 release manifest 的三个不可变镜像 digest，并绑定同一完整 revision：

```bash
node scripts/verify-deployment-revision.mjs dual-compose \
  deploy/release-manifest.json .env.production .env.real-test
npm run test:dual-environment
npm run test:deployment-revision
npm run deploy:validate
```

校验冻结服务 exact-set、域名、项目名、共享 ingress 别名、所有 mount、named volume 名、WIF bind、
测试无宿主端口及测试 server kill switch。两套 API 的
`RWA_AUTOMATION_MONITORED_BINANCE_ACCOUNT_IDS` 任一 fingerprint 交叉即硬停止。每套环境的批准只读
provider preflight 还必须由 Binance `UID` 独立计算权威 fingerprint，并由 client 精确匹配该环境
冻结的 monitored account；UID 缺失、读取失败或不匹配均拒绝上线。因此，即便两套 env 自报不同
fingerprint，同一真实 Binance 账户也无法同时通过。真实测试必须使用
独立 KMS CryptoKey、WIF audience/certificate bundle 和 Binance API key，推荐绑定独立
sub-account。real-test CryptoKey 完整资源名冻结为
`projects/xingheng-real-test/locations/asia-southeast1/keyRings/xingheng-rwa-real-test-sg/cryptoKeys/exchange-credentials`；
不得引用 production 项目或其他 location/keyRing/CryptoKey。应用 volume 隔离不能替代
provider account 隔离。

现场 provider 身份门禁只允许以下固定 operations service。它不监听、不取得 execution lease、
不扫描活动、不写 state，也不包含 provider mutation：

```bash
install -d -o 0 -g 0 -m 0700 /var/lib/xingheng/provider-identity-preflight
umask 077
sudo scripts/production-compose.sh --profile provider-identity-preflight \
  run --rm --no-deps provider-identity-preflight \
  > /var/lib/xingheng/provider-identity-preflight/production.json
sudo scripts/real-test-compose.sh --profile provider-identity-preflight \
  run --rm --no-deps provider-identity-preflight \
  > /var/lib/xingheng/provider-identity-preflight/real-test.json
chmod 0400 /var/lib/xingheng/provider-identity-preflight/*.json
node scripts/providerIdentityReceipts.mjs \
  /var/lib/xingheng/provider-identity-preflight/production.json \
  /var/lib/xingheng/provider-identity-preflight/real-test.json
```

两份收据必须绑定同一 full revision、各自固定 environment/project、十分钟新鲜度和只读标记；
`accountIdentitySha256` 相同立即拒绝。该步骤需要另行批准的真实只读 Binance 访问，本轮离线代码
不得执行，当前状态为 `field-pending`。

## 现场启动与核验

1. 先验证正式环境健康且 revision 未漂移；不得因测试部署停止、替换或重建正式容器。
2. 创建并核验固定共享 ingress network，再重新执行 `dual-compose`。
3. 使用现有 manifest 加载链导出三个 digest；不得构建第二套镜像。
4. 使用 `scripts/real-test-compose.sh up -d api web` 启动测试环境；不得传入 `--env-file`。
5. 验证两个项目各只有一个 API/Web，镜像 digest/revision 一致，restart 可解释。
6. 分别请求两域 `/api/health`。正式必须返回
   `deploymentEnvironment=production, composeProject=xingheng`；测试必须返回
   `deploymentEnvironment=real-test, composeProject=xingheng-real-test`。
7. 分别验证未登录 `401/no-store`、CORS/CSRF 只接受本域、WebSocket 不串线及敏感日志零输出。
8. 核验两套 volume owner/mode/mount count、本地文件系统、lock inode/flock、WIF 只读 bind 和
   独立 KMS health。任一 incomplete 或跨环境引用立即停止测试环境，不改正式环境。

```bash
node scripts/verify-release-volume-boundaries.mjs real-test runtime
```

前端可依赖 `/api/health` 的两个稳定字段识别环境；真实测试界面必须显示“真实测试环境”，不得根据
hostname 猜测，也不得把该字段解释为真实资金批准。

## 只清真实测试数据

清理只允许以下三个固定数据卷，测试 backup/lock/Caddy state 和既有审计保留：

- `xingheng-real-test_sqlite_data`
- `xingheng-real-test_strategy_data`
- `xingheng-real-test_rwa_automation_data`

先执行 dry-run：

```bash
sudo scripts/real-test-cleanup.sh dry-run
```

确认项目、revision、目标 exact-set 和正式摘要后才可执行：

```bash
sudo scripts/real-test-cleanup.sh execute OPERATION_ID \
  'DELETE-XINGHENG-REAL-TEST-DATA:OPERATION_ID:RECEIPT_SHA256'
```

dry-run 生成一次性、限时 receipt；confirmation 精确绑定 operation ID、revision、daemon、双项目
摘要、三卷目标和三份备份，execute 原子 claim。命令通过固定宿主 `flock` 取得独占锁，验证双环境
topology，读取正式 API/Web exact runtime、SQLite 主文件/WAL/SHM 及 RWA current generation
exact-set 的脱敏摘要。停止测试 API 后创建 SQLite、RWA、strategy 三份备份，分别执行 SQLite
`integrity_check`、RWA exact-envelope/KMS verifier 和 strategy archive verifier，并冻结 artifact
path identity、inode、size、SHA、owner/mode/nlink 到审计。随后 `down` 精确移除测试项目
容器引用（不使用 `down -v`），确认 `docker ps -a` 无引用后仅删除三个 allowlist 数据卷并重建
测试卷。固定无网络、最小 capability 初始化器建立 UID/GID 20001、权限、lock 和 root-owned
volume identity marker，再启动 API/Web。删除后重新验证正式/测试容器 revision、双环境 volume
boundary、双域 identity 和全部正式摘要。exact phase journal、receipt、成功/事故/recovery audit
写入 root-only `/var/lib/xingheng-real-test/reset-audit`，每次 file 与 directory publish 均 fsync。

删除开始后的任何失败都必须在同一独占锁内重建固定测试数据卷，从刚冻结的 SQLite、RWA、strategy
三份备份恢复并复验后才能恢复测试服务。SIGTERM/SIGKILL/掉电后的同 operation 重试只按 durable
journal 的唯一下一阶段恢复；同一已完成 operation 幂等返回，不同证据拒绝。恢复失败输出稳定
`incident_restore_failed` 并保持测试 API/Web 停止；再次使用同 operation 才能继续恢复。成功仅
清除三份 live data，测试 backup/lock/Caddy、receipt、journal 和全部审计永久保留。禁止通用
volume 删除、任意路径参数、直接编辑 SQLite/JSON 或删除既有备份/审计。

## 回滚与停止

测试部署失败只停止 `xingheng-real-test` API/Web，不得调用正式 activation、替换正式
manifest/env、删除共享 ingress 或重启正式容器。存在测试环境真实持仓时，不能用清数据或回滚代码
代替安全退出；必须先由当前可验证 runtime 管理/退出仓位。正式首次 verified release/legacy bridge
语义保持不变。

标准正式升级在启动候选容器前持久化 release intent，绑定上一 verified pointer、候选
manifest/env FD 收据、三镜像、daemon 和环境快照。成功原子推进 pointer；任一失败停止候选并保持
`incident_stopped`，禁止新 activation。仅允许用同 operation ID 执行固定 rollback：

```bash
sudo scripts/rollback-release.sh RELEASE_OPERATION_ID
```

rollback 从 root-only 快照原子恢复上一 env，使用 intent 中上一组三镜像启动，精确验证 API/Web
唯一容器、digest、full revision、health/restart 和 volume boundary 后才标记 `rolled_back`；
失败继续停服。首次 bridge 建立 pointer 与 one-way marker，失败时撤销未标记 pointer，marker 一旦
建立后不可重新打开 legacy bridge。

## 要求到证据矩阵

| # | 要求 | 代码 | 测试/离线证据 | 现场状态 |
| --- | --- | --- | --- | --- |
| 1 | 唯一 root launcher、最小环境、固定工具 | `trusted-operation-preamble.sh`、`trusted-operation-launcher.mjs`、`trustedDockerRuntime.mjs` | `linuxTrustedOperations.test.mjs` 污染变量与 binary/plugin/socket 负例 | Linux fixture 已通过；生产收据 `field-pending` |
| 2 | release tree/env/manifest/daemon 全事务身份 | `trustedReleaseTree.mjs`、`install-trusted-operations.mjs`、env FD 3/4、plugin FD 5 | `/proc/self/fd` 竞争、inode/link/mode/SHA/daemon 漂移负例 | Linux fixture 已通过；生产 daemon 收据 `field-pending` |
| 3 | Compose exact operation allowlist | `verify-compose-environment-file.mjs`、固定双 wrapper | 跨项目、`run -v`、network/env/user/entrypoint/privileged、`down -v`、scale/build/pull、任意 exec 拒绝 | 离线通过 |
| 4 | cleanup 崩溃一致、可恢复、幂等 | `cleanupTransactionStore.mjs`、`realTestCleanup.mjs` | receipt 伪造/过期/重放、全阶段 intent/resume、audit pending | 离线通过；真实掉电演练 `field-pending` |
| 5 | 全局锁层级 | `operationLocks.mjs`、trusted launcher、容器 RWA flock | util-linux flock、并发、inode/owner/mode 负例 | Linux fixture 已通过；全入口现场并发演练 `field-pending` |
| 6 | SQLite/RWA/strategy 三卷备份恢复 | cleanup、三套 backup/restore、volume initializer/identity marker | 真实本地 Docker volume、SQLite integrity、strategy roundtrip、stopped ref | Linux fixture 已通过；真实 KMS RWA restore `field-pending` |
| 7 | production 不变与双项目完整证据 | `runtimeEvidence()`、revision/volume/topology verifiers | Web/container/WAL/SHM/generation/credential/volume/network 漂移负例 | 离线通过；双域真实 health/TLS `field-pending` |
| 8 | 全失败 fail-closed | cleanup journal、incident/recovery audit | rm/create/init/restore/up/verify/audit/production drift 注入 | 离线通过；SIGKILL/磁盘故障现场演练 `field-pending` |
| 9 | 现场双环境身份与真实 provider UID | deployment environment contract、provider identity operations/receipt comparator | domain/WIF/KMS/AAD/cookie/fingerprint 交换；同 UID 不同自报值拒绝 | 离线契约通过；DNS/TLS/WIF/KMS/Binance UID/gates `field-pending` |
| 10 | 首次、升级、回滚、test-only rebuild、双运行生命周期 | legacy bridge、release lifecycle transaction、fixed rollback、cleanup | 首次 bridge 全失败、upgrade intent/inode/daemon、rollback runtime、test cleanup | 离线通过；五条完整现场演练 `field-pending` |

真实 Linux / DNS / TLS / WIF / KMS / provider / gate 证据任一未取得时，只能判定对应现场门禁
`field-pending`，不得把离线代码、fake provider 或本机 Docker fixture写成可上线、Gate 1 或 Gate 2。

## 非阻塞建议

SBOM/镜像签名、关键 binary digest attestation 的外部签名、Binance fingerprint 加长只作为纵深
建议记录；不属于本轮阻塞实现，也不能替代权威 provider UID 精确绑定。
