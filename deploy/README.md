# 生产部署与运维

当前拓扑固定为单台服务器、单个 Node API、SQLite 与 Caddy。不得横向扩展 API
副本；SQLite 数据卷只能由这一实例写入。行情和成交仍是 Hyperliquid 公开行情驱动的
内部模拟交易，链上能力固定为 BSC Testnet。

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
docker compose --env-file .env.production config
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
./scripts/smoke.sh "https://你的域名"
```

Caddy 自动申请和续期 HTTPS 证书。API 不发布宿主机端口，仅由 Caddy 在 Compose
内部网络访问。`/api/*` 和 `/ws` 会先反代到 API，其余路径由静态前端处理；不存在
的路径回退到 `index.html`。Web 容器只接收 `DOMAIN`；管理员密码、私钥和助记词
仅进入 API 容器。所有手工 Compose 命令都必须带 `--env-file .env.production`。

## Hyperliquid Testnet 真实交易运维

`/app/trade` 第一阶段固定 Hyperliquid Testnet。平台后端不保存用户 API wallet 私钥、
助记词、签名或可重放 payload；exchange 动作只转发前端已签名请求，并继续拒绝 Mainnet、
资金转移、Builder fee 等越界动作。

生产 `.env.production` 中可调整以下安全默认值；Compose 已通过 `env_file` 注入 API 容器，
不需要在 `compose.yaml` 里硬编码：

```bash
REAL_TRADING_EXCHANGE_RATE_LIMIT_MAX=30
REAL_TRADING_RISK_MAX_LEVERAGE=20
REAL_TRADING_RISK_MAX_ORDER_NOTIONAL_EQUITY_RATIO=0.5
REAL_TRADING_RISK_MAX_TOTAL_NOTIONAL_EQUITY_RATIO=2
REAL_TRADING_RISK_MAX_OPEN_ORDERS=20
REAL_TRADING_RISK_MAX_SNAPSHOT_AGE_MS=10000
REAL_TRADING_AUDIT_RETENTION_DAYS=180
REAL_TRADING_REALTIME_TOKEN_TTL_MS=60000
REAL_TRADING_REALTIME_MAX_ADDRESSES=100
REAL_TRADING_RECONCILIATION_INTERVAL_MS=60000
REAL_TRADING_RECONCILIATION_BATCH_SIZE=50
```

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
docker compose --env-file .env.production --profile strategy-tools build strategy-history
docker compose --env-file .env.production --profile strategy-tools run --rm strategy-history
docker compose --env-file .env.production --profile strategy-tools run --rm strategy-history npm run strategy:history:check -- /app/strategy-data/route-b-history.json
```

生成脚本从 Binance Vision 下载官方历史归档、校验 checksum、拒绝 5m 缺口，并用临时文件
+ rename 原子覆盖 `route-b-history.json`。失败时旧报告保留；若旧报告仍可读，线上页面继续
展示旧数据。历史报告可重建，日常备份可把 `strategy_data` 作为独立 JSON 数据卷备份；
不要把它纳入 SQLite `.backup` / restore 流程，也不要在恢复 SQLite 时覆盖策略 JSON。

部署或故障 smoke 建议：

```bash
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=200 api
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

```bash
# 服务状态和最近日志
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=200 api web
docker compose --env-file .env.production logs -f api

# 一致性备份（默认保留 14 天）
./scripts/backup.sh

# 升级：先备份，再构建并以健康检查顺序替换
./scripts/backup.sh
docker compose --env-file .env.production build --pull
docker compose --env-file .env.production up -d
./scripts/smoke.sh "https://你的域名"
```

可在 `.env.production` 用 `BACKUP_RETENTION_DAYS` 修改保留天数。建议由宿主机 cron
每天调用一次 `scripts/backup.sh`，并另行把 Docker 的 `sqlite_backups` 卷复制到
异机加密存储。脚本使用 SQLite 在线 `.backup`，会纳入已提交的 WAL 内容；禁止用
`cp`、`docker cp` 或文件同步工具直接复制运行中的 `trading.sqlite*`。

## 恢复

先列出备份卷中的文件：

```bash
docker compose --env-file .env.production exec -T api find /backups -maxdepth 1 -name 'trading-*.sqlite' -print
./scripts/restore.sh trading-YYYYMMDDTHHMMSSZ.sqlite
./scripts/smoke.sh "https://你的域名"
```

恢复脚本只接受严格的 `trading-YYYYMMDDTHHMMSSZ.sqlite` 文件名，避免 SQLite
dot-command 路径注入；随后停止 API、对备份和恢复结果分别执行
`PRAGMA integrity_check`、清理旧 WAL/SHM 后原子替换数据库，再启动服务。恢复期间
网站 API 暂不可用。

## 回滚

1. 升级前记录当前 Git commit/镜像版本并运行备份。
2. 若新版本 smoke 失败，切回上一个已验证 commit 或镜像标签。
3. 执行 `docker compose --env-file .env.production build`，再执行
   `docker compose --env-file .env.production up -d`。
4. 只有数据库迁移不向后兼容时，才用升级前备份执行恢复；不要因纯应用回滚覆盖新数据。
5. 再运行 smoke，并检查
   `docker compose --env-file .env.production logs --tail=200 api web`。

## 故障边界

- API 收到 SIGTERM 后停止行情、关闭 WebSocket/HTTP，再关闭 SQLite；Compose
  提供 20 秒退出窗口。
- API 健康检查失败时 Web 不会首次启动，但已运行的 Caddy 不等同于业务健康；
  运维监控应直接检查 `https://域名/api/health`。
- 证书、数据库、策略报告和备份分别使用 `caddy_data`、`sqlite_data`、`strategy_data`、`sqlite_backups`
  named volume。删除卷会删除对应持久数据，日常升级不得使用
  `docker compose --env-file .env.production down -v`。
- 私钥、助记词和管理员密码只放权限受限的服务器 `.env.production` 或外部密钥系统，
  不进入 Git、镜像或日志。
- 正式环境不会创建 `demo-user` 的演示钱包、资金账户或演示流水；若正式库中出现此类
  数据，应视为历史数据或错误导入并单独审计，不能依赖启动流程清理。
