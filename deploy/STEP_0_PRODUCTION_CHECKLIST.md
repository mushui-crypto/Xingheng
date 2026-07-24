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
STEP0_MANIFEST=/opt/xingheng-release/deploy/release-manifest.json
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
docker info >/dev/null
docker compose version
findmnt -n -o FSTYPE,TARGET -T /run

node scripts/verify-deployment-revision.mjs env "$STEP0_MANIFEST" "$STEP0_NEW_ENV"
node scripts/verify-deployment-revision.mjs images "$STEP0_MANIFEST"
node scripts/verify-gcp-wif-bundle.mjs source \
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
node scripts/legacy-release-bridge.mjs capture "$STEP0_BRIDGE" "$STEP0_OLD_ENV"
node scripts/legacy-release-bridge.mjs verify "$STEP0_BRIDGE"
node scripts/legacy-release-bridge.mjs verify-runtime "$STEP0_BRIDGE"
node scripts/legacy-release-bridge.mjs verify-release-environment \
  "$STEP0_BRIDGE" "$STEP0_NEW_ENV"
```

- [ ] bridge 冻结了旧 API/Web 精确 image ID、只读 image archives/hash、恢复 Compose、SQLite
  `.backup` integrity/hash/size、五个既有 volume 的 owner/mode/mount。
- [ ] bridge 目录没有 env 内容、WIF、Secret、token、固定 IP 或 provider 原始响应。
- [ ] 旧 API/Web 仍各只有一个运行实例且健康；旧 env 在整个窗口内不再改写或替换。

## D. 注入 WIF tmpfs，并重复完整 preflight

```bash
test ! -e /run/xingheng/gcp-wif
./scripts/install-gcp-wif.sh "$STEP0_WIF_SOURCE" "$STEP0_WIF_AUDIENCE_FILE"
node scripts/verify-gcp-wif-bundle.mjs installed \
  /run/xingheng/gcp-wif "$STEP0_WIF_AUDIENCE_FILE"

RELEASE_MANIFEST_FILE="$STEP0_MANIFEST"
COMPOSE_ENV_FILE="$STEP0_NEW_ENV"
export RELEASE_MANIFEST_FILE COMPOSE_ENV_FILE
. scripts/load-release-manifest.sh
verify_production_compose
node scripts/first-release-volume-migration.mjs initialize "$XINGHENG_API_IMAGE"
production_compose run --rm --no-deps --entrypoint node api \
  dist-server/operations/rwa-activation-preflight.js
```

- [ ] WIF 目标是独立 tmpfs；目录 `20001:20001/0700`，五文件 `20001:20001/0400`，Compose
  挂载为只读。
- [ ] Compose 无 `build`、无 override、无漂移 tag；镜像/revision 与 manifest 完全一致。
- [ ] 所有 volume 为允许的本机 local filesystem；owner/mode/mount count 与 lock file 契约通过。
- [ ] activation preflight 输出 `activation WIF and KMS health verified`；服务端总急停仍为 `true`。
- [ ] 到此为止旧 API/Web 和三个既有业务卷尚未改变；新自动套利卷只含冻结的初始结构。

## E. 一次性激活与上线核验

```bash
./scripts/activate-first-verified-release.sh \
  "$STEP0_BRIDGE" "$STEP0_MANIFEST" "$STEP0_NEW_ENV"

node scripts/verify-deployment-revision.mjs containers "$STEP0_MANIFEST"
node scripts/verify-release-volume-boundaries.mjs runtime
./scripts/smoke.sh "$STEP0_PUBLIC_URL"
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
node scripts/legacy-release-bridge.mjs verify "$STEP0_BRIDGE"
node scripts/legacy-release-bridge.mjs verify-runtime "$STEP0_BRIDGE"
test ! -e /var/lib/xingheng/verified-release-established
```

- [ ] 若自动恢复也失败：保持总急停，不重复激活、不删除卷、不改 env、不手工恢复 SQLite；升级为
  生产事故，由回滚负责人按冻结 bridge 单独执行恢复。
- [ ] 成功后不再使用 legacy bridge；下一步是独立的备份/恢复/flock/容器重建现场演练。
  未完成这些演练前，不录入真实交易所凭证、不申请关闭总急停、不进入 Mainnet 资金验证。
