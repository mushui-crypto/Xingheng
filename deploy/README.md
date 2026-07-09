# 生产部署与运维

当前拓扑固定为单台服务器、单个 Node API、SQLite 与 Caddy。不得横向扩展 API
副本；SQLite 数据卷只能由这一实例写入。行情和成交仍是 Hyperliquid 公开行情驱动的
内部模拟交易，链上能力固定为 BSC Testnet。

## 首次部署

要求：安装 Docker Engine 与 Docker Compose plugin；域名 A/AAAA 记录已指向服务器，
并开放入站 TCP 80/443 和 UDP 443。服务器出站网络必须能访问
`api.hyperliquid.xyz:443`（HTTPS/WSS）及配置的 BSC Testnet RPC；若云厂商或节点区域
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
- 证书、数据库和备份分别使用 `caddy_data`、`sqlite_data`、`sqlite_backups`
  named volume。删除卷会删除对应持久数据，日常升级不得使用
  `docker compose --env-file .env.production down -v`。
- 私钥、助记词和管理员密码只放权限受限的服务器 `.env.production` 或外部密钥系统，
  不进入 Git、镜像或日志。
- 正式环境不会创建 `demo-user` 的演示钱包、资金账户或演示流水；若正式库中出现此类
  数据，应视为历史数据或错误导入并单独审计，不能依赖启动流程清理。
