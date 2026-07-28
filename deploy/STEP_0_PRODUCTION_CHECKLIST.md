# 步骤 0：生产现场执行 Checklist

目标：在不录入交易所凭证、不关闭任何执行急停、不产生订单或资金动作的前提下，建立首个可验证
release，并证明旧版本可恢复、WIF/KMS 可用、生产容器与本地卷边界正确。

> 适用一次：仅用于服务器尚无
> `/var/lib/xingheng/verified-release-established` 的 legacy → verified release。marker 已存在时，
> 停止使用本清单，改走标准 `activate-release.sh`。任一检查失败都停止，不临时改权限、不跳过门禁。

## A. 窗口与输入

- [ ] 两名人员在线：操作者、复核者；已登记窗口起止、回滚负责人和域名。
- [ ] 服务端总急停为 `true`；没有真实交易所凭证；没有准备在本窗口解除 global/strategy/user 急停。
- [ ] 服务器使用 root 受控终端；当前目录是与 release manifest 同批交付的代码目录。
- [ ] 已填好以下服务器本地绝对路径，材料内容未进入聊天、命令行参数、日志或 shell history：

```bash
cd /opt/xingheng-release/code
STEP0_MANIFEST=/opt/xingheng-release/code/deploy/release-manifest.json
STEP0_OLD_ENV=/opt/xingheng/.env.production
STEP0_NEW_ENV=/opt/xingheng/.env.verified-release
STEP0_BRIDGE=/var/lib/xingheng/legacy-bridge-bundle/legacy-bridge
STEP0_WIF_SOURCE=/root/xingheng-wif-source
STEP0_WIF_AUDIENCE_FILE=/root/xingheng-wif-audience
STEP0_PUBLIC_URL=https://app.stellaxtrade.com
export STEP0_MANIFEST STEP0_OLD_ENV STEP0_NEW_ENV STEP0_BRIDGE
export STEP0_WIF_SOURCE STEP0_WIF_AUDIENCE_FILE STEP0_PUBLIC_URL
unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME
umask 077
```

- [ ] 新旧 env 是不同的 regular file、不同 inode；新 env 权限为 `0600`，包含完整 40 字符
  `XINGHENG_REVISION`、精确 `RWA_GCP_WIF_AUDIENCE`，并满足
  `RWA_AUTOMATION_SERVER_KILL_SWITCH=true`。
- [ ] manifest 是非 symlink、单硬链接、`0444` regular file；三个精确镜像 digest 已导入本机。
- [ ] WIF source 目录为 root-owned `0700`，且只含五个 `0400` 文件：
  `adc.json`、`certificate_config.json`、`trust-chain.pem`、配置引用的 leaf cert、leaf key；
  audience 文件为 root-owned `0400`。

## B. 只读预检：失败即停

```bash
test "$(id -u)" -eq 0
test ! -e /var/lib/xingheng/verified-release-established
findmnt -n -o FSTYPE,TARGET -T /run

env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node scripts/install-trusted-operations.mjs install
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node scripts/verify-deployment-revision.mjs env "$STEP0_MANIFEST" "$STEP0_NEW_ENV"
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node scripts/verify-deployment-revision.mjs images "$STEP0_MANIFEST"
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node scripts/verify-gcp-wif-bundle.mjs source production \
  "$STEP0_WIF_SOURCE" "$STEP0_WIF_AUDIENCE_FILE"
```

- [ ] `/run` 的文件系统为 `tmpfs`。
- [ ] revision/env/images 三项通过；输出 revision 与批准发布的完整 commit 完全一致。
- [ ] WIF source 通过；没有输出证书、私钥、ADC 正文、audience、token 或 env 全文。
- [ ] `sqlite_data`、`strategy_data`、`sqlite_backups` 的目录树 owner 与当前 legacy root owner
  一致，且没有 symlink 或 hardlinked file；不在旧 API 运行时手工 `chown`。
- [ ] `rwa_automation_data/backups/lock` 不存在，或是此前同一 release 初始化留下且仍满足严格初始
  schema；任何未知文件、宽权限、网络卷或 bind-backed local volume 都停止。

## C. 冻结 legacy 恢复点：旧服务保持运行

```bash
install -d -o root -g root -m 0700 "$(dirname "$STEP0_BRIDGE")"
sudo scripts/legacy-release-bridge.sh capture "$STEP0_BRIDGE" "$STEP0_OLD_ENV"
```

- [ ] bridge 冻结了旧 API/Web 精确 image ID、只读 image archives/hash、恢复 Compose、SQLite
  `.backup` integrity/hash/size、五个既有 volume 的 owner/mode/mount。
- [ ] bridge 目录没有 env 内容、WIF、Secret、token、固定 IP 或 provider 原始响应。
- [ ] 旧 API/Web 仍各只有一个运行实例且健康；旧 env 在整个窗口内不再改写或替换。

## D. 注入 WIF tmpfs，并重复完整 preflight

```bash
test ! -e /run/xingheng/gcp-wif
sudo ./scripts/install-gcp-wif.sh production \
  "$STEP0_WIF_SOURCE" "$STEP0_WIF_AUDIENCE_FILE"
env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node scripts/verify-gcp-wif-bundle.mjs installed production \
  /run/xingheng/gcp-wif "$STEP0_WIF_AUDIENCE_FILE"
```

- [ ] WIF 目标是独立 tmpfs；目录 `20001:20001/0700`，五文件 `20001:20001/0400`，Compose
  挂载为只读。
- [ ] 到此为止旧 API/Web、既有业务卷和新自动套利卷均未改变。
- [ ] 下一步 activation 会在停止旧 API 前安装固定 env，并在同一 production lock 内完成
  Compose、镜像、volume、WIF/KMS preflight；不得提前直接调用内部 migration CLI。

## E. 一次性激活与上线核验

```bash
sudo ./scripts/activate-first-verified-release.sh \
  "$STEP0_BRIDGE" "$STEP0_MANIFEST" "$STEP0_NEW_ENV"

sudo ./scripts/smoke.sh "$STEP0_PUBLIC_URL"
test -f /var/lib/xingheng/verified-release-established
```

- [ ] 命令输出 `first verified release activated`；API/Web 各一个实例且健康。
- [ ] 激活脚本已自动完成“停旧 API → owner `1000 → 20001` → migration 卷验证 → 启动新
  release”；没有执行任何手工宽权限迁移。
- [ ] 容器 image ID、OCI revision、镜像内 revision、运行时 revision 均与 manifest 一致。
- [ ] API/Web mount 数量、target、RW 属性和全部卷边界通过；没有第二 API 实例。
- [ ] `/api/health`、Web、登录保护、公开套利看板、`/app/demo`、`/app/trade` 冒烟通过。
- [ ] 自动套利仍为 fail-closed：无凭证、global/strategy execution 关闭、user kill switch 开启、
  server kill switch 开启、provider write/订单/资金动作均为 0。
- [ ] 保存的证据只有：完整 commit、三个 digest、时间、PASS/FAIL、脱敏 health/mount/backup
  结果；不保存 env、WIF、Secret、token、固定 IP 或 provider response。

## F. 失败与回滚

- [ ] B–D 任一步失败：旧服务未被替换，停止窗口并记录稳定错误类别。
- [ ] E 失败：激活脚本会停止未验证新容器、恢复旧卷 owner，再恢复 bridge 中冻结的旧 image ID；
  随后只做验证：

```bash
test ! -e /var/lib/xingheng/verified-release-established
```

- [ ] 若自动恢复也失败：保持总急停，不重复激活、不删除卷、不改 env、不手工恢复 SQLite；升级为
  生产事故，由回滚负责人按冻结 bridge 单独执行恢复。
- [ ] 成功后不再使用 legacy bridge；下一步是独立的备份/恢复/flock/容器重建现场演练。
  未完成这些演练前，不录入真实交易所凭证、不申请关闭总急停、不进入 Mainnet 资金验证。

## G. 必须留存与必须销毁

长期留存（服务器 root-only，禁止进入 Git、SQLite、应用备份或聊天）：

- [ ] `/root/xingheng-wif-source/`：精确五文件 bundle；目录 `0700`、文件 `0400`。其中
  `leaf.key` 是唯一长期私钥副本，不额外复制到项目备份；主机丢失时按新 trust root / Provider
  重建身份，不从应用备份恢复。
- [ ] `/root/xingheng-wif-audience`：完整 Provider audience，`0400`。
- [ ] `/root/xingheng-wif-public/`：root CA 公钥证书、leaf 公钥证书、CSR、指纹和到期时间；
  不含任何私钥。
- [ ] `/opt/xingheng/.env.verified-release`：本次 release 的 root-only `0600` 环境文件；
  不复制正文到证据或沟通文档。
- [ ] `/opt/xingheng-release/code/deploy/release-manifest.json`：不可变 `0444` manifest；同步留存
  完整 commit 与三个镜像 digest。
- [ ] `$STEP0_BRIDGE`：legacy 镜像归档、SQLite recovery point 与恢复证据；保留到首个 verified
  release 上线复验和回滚窗口结束，之后按独立销毁流程处理。
- [ ] 仅留存脱敏证据：窗口时间、操作者/复核者、PASS/FAIL、commit、digest、证书指纹/到期时间、
  KMS key/Pool/Provider 资源名、回滚点；不保存 token、env 正文、WIF 私钥或 provider 原始响应。

必须销毁：

- [ ] 一次性离线 root CA 私钥：Provider/IAM 建立且真实 STS/KMS health 通过后销毁，不长期保留。
- [ ] CSR staging 中重复的 leaf 私钥与 Cloud Shell 临时 trust-store；只保留上述唯一 source
  私钥副本和公共归档。
- [ ] 证书轮换至少提前 60 天登记；当前 leaf 到期日前必须通过未来独立 Level 3 任务完成受控
  整体 bundle 轮换。active 永远保持单 generation 五文件 exact-set；旧 generation 只能在
  active 外的 root-only retired 边界延迟清理。当前 checklist 不代表该轮换能力已实现。
