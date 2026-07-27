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

独立模式激活前先验证 DNS 已指向该 VM、仅开放公网 80/443，并确认没有进程占用固定端口。
没有真实 DNS 时不得用自签名证书或 HTTP 冒充通过。使用 canonical manifest 激活：

```bash
sudo scripts/activate-real-test-release.sh standalone
node scripts/verify-deployment-revision.mjs \
  compose-real-test-standalone deploy/release-manifest.json .env.real-test
node scripts/verify-deployment-revision.mjs \
  containers-real-test deploy/release-manifest.json
node scripts/verify-release-volume-boundaries.mjs real-test runtime
```

激活在 Compose、镜像、revision、容器或 volume 验证失败时会停止 real-test API/Web。
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
sub-account。应用 volume 隔离不能替代 provider account 隔离。

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
