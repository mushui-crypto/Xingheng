# 部署流程

本文定义当前项目实际可执行的部署流程。它替代此前未落地的 Release Workflow 草案。

项目定位是个人自用、小规模多用户、小额真实资金验证。部署流程保持简单、可审计、可回滚，不引入
不存在的 release gate、manifest、trusted launcher 或企业级发布系统。

## 1. 基本原则

- 部署必须绑定一个已提交的 commit SHA。
- 镜像 tag 必须使用完整 commit SHA，不以 `latest` 作为唯一依据。
- 部署前必须确认工作区 clean。
- 部署可以由用户明确授权后执行。
- 部署不等于真实交易授权。
- 部署流程不得自动打开 `LIVE_TRADING_ENABLED`。
- 部署流程不得自动关闭 `BINANCE_KILL_SWITCH`。
- 部署流程不得自动执行 funding cycle、repair、retry、residual close 或 provider mutation。

## 2. 提交检查

部署前记录：

```bash
git rev-parse --verify HEAD^{commit}
git rev-parse --verify HEAD^{tree}
git status --short --branch
git diff --check
```

要求：

- `git status` 必须 clean。
- commit SHA 必须与计划部署版本一致。
- 不允许把 `.env.production`、secret、SQLite、receipt、日志或 build artifact 纳入提交。

## 3. 构建检查

部署前运行：

```bash
npm run build
```

构建镜像时使用完整 commit SHA：

```bash
docker build --target api --build-arg GIT_COMMIT=<commit-sha> -t stellax-personal-api:<commit-sha> .
docker build --target web --build-arg GIT_COMMIT=<commit-sha> -t stellax-personal-web:<commit-sha> .
```

构建日志中的依赖审计提示需要记录，但不在部署流程中自动升级依赖。

## 4. Production 环境要求

生产环境必须配置：

```text
NODE_ENV=production
GIT_COMMIT=<commit-sha>
DOMAIN=<domain>
APP_PUBLIC_URL=https://<domain>
CORS_ALLOWED_ORIGINS=https://<domain>
TRADING_DB_PATH=/app/data/trading.sqlite
BINANCE_USER_ORDER_DB_DIR=/app/data/binance-users
BINANCE_TRADING_DB_PATH=/app/data/binance-personal.sqlite
LIVE_TRADING_ENABLED=false
BINANCE_KILL_SWITCH=true
GCP_KMS_CREDENTIAL_KEY_NAME=<full CryptoKey resource name>
GOOGLE_ADC_DIR=<host adc directory>
```

要求：

- `BINANCE_USER_ORDER_DB_DIR` 必须位于 `/app/data/binance-users`。
- `/app/data` 必须是持久 volume。
- `/backups` 必须是持久 volume。
- Binance API key 禁止提现权限。
- KMS/ADC 缺失时应 fail closed。

## 5. Compose 检查

部署前运行：

```bash
docker compose config
```

确认：

- `sqlite_data` 挂载到 `/app/data`。
- `sqlite_backups` 挂载到 `/backups`。
- `GOOGLE_ADC_DIR` 只读挂载到 `/run/secrets/gcp-wif`。
- `LIVE_TRADING_ENABLED=false`。
- `BINANCE_KILL_SWITCH=true`。

## 6. 部署

用户明确授权部署后，可以执行：

```bash
docker compose up -d api web
```

部署后检查：

```bash
docker compose ps
scripts/smoke.sh https://<domain>
```

部署动作只允许更新服务进程和镜像版本。不得在部署步骤中：

- 修改 `.env.production`。
- 打开 `LIVE_TRADING_ENABLED`。
- 关闭 `BINANCE_KILL_SWITCH`。
- 调用 provider mutation。
- 执行 capital harness。
- 执行 funding manual execution API。

## 7. 备份

部署前后可执行：

```bash
scripts/backup.sh
```

备份应覆盖：

- `TRADING_DB_PATH` 对应 SQLite。
- `BINANCE_USER_ORDER_DB_DIR` 下的 user order SQLite。
- receipt/audit `jsonl`。

## 8. 回滚

回滚使用已知可启动的上一组镜像 tag 和最近可用 SQLite backup snapshot。

代码回滚：

```bash
GIT_COMMIT=<previous-commit-sha> docker compose up -d api web
```

数据恢复：

```bash
scripts/restore.sh stellax-YYYYMMDDTHHMMSSZ
```

回滚期间必须保持：

```text
LIVE_TRADING_ENABLED=false
BINANCE_KILL_SWITCH=true
```

回滚不得自动 retry、resubmit、reopen position 或 residual close。

## 9. 真实资金激活

真实资金激活不是部署的一部分。

首次真实资金前必须人工确认：

- Binance credential 权限正确，且禁止提现。
- account / balance / position / orders readonly 检查通过。
- 当前无未知 exposure。
- 当前无异常 `UNKNOWN` / `PENDING_CONFIRMATION` execution。
- 已完成部署后 backup。

只有在人工确认后，才可以单独调整：

```text
LIVE_TRADING_ENABLED=true
BINANCE_KILL_SWITCH=false
```

完成小额验证后，应恢复：

```text
BINANCE_KILL_SWITCH=true
```
