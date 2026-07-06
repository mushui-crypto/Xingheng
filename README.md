# Xing Heng TradeSim Pro

星衡 TradeSim Pro 是一个基于 Hyperliquid 主 DEX 活跃永续公开行情的模拟交易系统。当前阶段只做：

- 公共行情接入
- K 线生成与查询
- 模拟账户
- 模拟下单 / 平仓
- 资金账户与交易账户划转
- 测试网链上入金出金方案准备

当前不做：

- 真实交易所下单
- 真实资金托管
- 清算与真实结算
- KYC / AML / 合规流程

## 仓库定位

- 当前实际 Git 仓库目录：`/Users/dq/Documents/StellarX/xingheng`
- 长期 `main` worktree：`/Users/dq/Documents/StellarX/xingheng-main`
- 上层 `StellarX` 目录目前只是本地工作区容器，不是当前仓库名
- Codex 内的持久工作树应单独通过 Codex worktree 线程维护，不等同于本地 `git worktree` 目录

仓库与 worktree 规则见：

- [`REPO_WORKFLOW.md`](./REPO_WORKFLOW.md)

## 主要文档

- 产品需求与边界：[`PRD.md`](./PRD.md)
- 版本变更记录：[`CHANGELOG.md`](./CHANGELOG.md)
- 行情与交易数据说明：[`MARKET_DATA.md`](./MARKET_DATA.md)
- Agent 协作约定：[`AGENTS.md`](./AGENTS.md)
- Git / worktree 规则：[`REPO_WORKFLOW.md`](./REPO_WORKFLOW.md)
- V0.4 任务文档：[`tasks/V0.4-onchain-testnet-wallet.md`](./tasks/V0.4-onchain-testnet-wallet.md)

## 运行要求

- Node.js：建议使用支持当前项目依赖的较新版本
- npm

## 快速启动

安装依赖：

```bash
npm install
```

同时启动前端和后端开发环境：

```bash
npm run dev
```

只启动后端开发环境：

```bash
npm run dev:api
```

构建：

```bash
npm run build
```

`npm run start:api` 用于运行已经由构建生成的 `dist-server/index.js`，不依赖
开发期的 `tsx`。

## 生产部署

生产基线使用单台服务器的 Docker Compose：Caddy 自动 HTTPS 并托管前端静态文件，
单个非 root Node API 进程负责接口与 WebSocket，SQLite 保存到 named volume。

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# 填写域名、管理员账号与安全密钥后：
docker compose --env-file .env.production config
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d
./scripts/smoke.sh "https://你的域名"
```

完整的部署、升级、日志、SQLite 一致性备份、恢复和回滚步骤见
[`deploy/README.md`](./deploy/README.md)。生产环境不得启动多个 API 实例，也不得
直接复制正在写入的 SQLite/WAL 文件。

## 环境变量

项目使用本地 `.env` 文件。示例见：

- [`.env.example`](./.env.example)

当前 `.env` 已被忽略，不会提交到仓库。

生产环境必须显式配置 `NODE_ENV=production`、`ADMIN_EMAIL`、至少 12 位的
`ADMIN_PASSWORD`、`TRADING_DB_PATH` 和反向代理对应的
`CORS_ALLOWED_ORIGINS`。如果 API 位于一层可信反向代理后，再设置
`TRUST_PROXY=true`。生产会话使用 `Secure`、`HttpOnly`、`SameSite=Strict`
Cookie，因此必须通过 HTTPS 访问。

演示用户仅在非生产环境默认启用；生产环境不会自动创建演示用户。私钥、助记词
和管理员密码不得写入仓库、前端构建产物或部署镜像。

## 目录结构

```text
xingheng/
├─ public/                 静态资源
├─ src/                    前端应用
├─ server/                 后端 API、行情、交易、存储
├─ tasks/                  任务文档
├─ PRD.md                  产品需求文档
├─ CHANGELOG.md            版本记录
├─ MARKET_DATA.md          行情/交易数据说明
├─ AGENTS.md               协作约定
├─ REPO_WORKFLOW.md        Git/worktree 规则
└─ README.md               仓库入口说明
```

## 工程约定

- 主线分支：`main`
- 当前开发目录适合承载功能分支
- 长期主线目录固定为 `xingheng-main`
- Codex 中如需长期并行上下文，优先创建独立 worktree 线程，而不是在同一线程里混合多阶段任务
- 涉及行情、交易、资金逻辑的变更后，至少执行：

```bash
npm run build
```

## 当前阶段重点

当前已完成：

- Hyperliquid 公共行情接入
- 模拟交易闭环
- SQLite 持久化
- 资金账户 / 交易账户体系
- 用户与管理员服务端鉴权

当前下一阶段：

- `BNB Chain Testnet` 测试网链上入金出金

详见：

- [`CHANGELOG.md`](./CHANGELOG.md)
- [`tasks/V0.4-onchain-testnet-wallet.md`](./tasks/V0.4-onchain-testnet-wallet.md)
