# XAUT MVP 统一发布与受控闭环手册

本手册冻结第五阶段的执行顺序和停止点。它当前只用于离线准备与 fake 演练，不授权构建最终发布
产物、连接生产、访问 WIF/KMS 或交易所私有接口，也不授权任何订单或资金动作。

旧 [`RWA_BINANCE_25_USDT_MAINNET_RUNBOOK.md`](./RWA_BINANCE_25_USDT_MAINNET_RUNBOOK.md)
只保留为历史证据。当前首次 Capital Test 使用一次性 `single_connectivity_smoke`，总计划资本
硬上限为 `40 USDT`，不是必须用满的固定预算。实际 XAUT 数量由服务端根据 Binance Spot 与
USD-M Futures 的实时交易规则和实际订单限价，取满足两端共同约束的最小可交易数量，不得为接近
上限而放大；若该数量对应的总计划资本超过 Permit 上限，必须 fail-closed，不得执行。历史
`25 USDT` 和 `0.002 XAUT` 不再作为当前执行常量。

## 不可合并的两个批准点

### Gate 1：统一生产发布

在构建最终 release archive/manifest、上传、生产备份、WIF/KMS 访问、activation 或任何生产连接
之前停止。只有以下事实全部成立后，项目管理才能另行向用户申请“统一生产发布”批准：

- 第一至第四阶段后端和第二至第四阶段前端已合入同一 clean、完整 40 字符 Git revision。
- `develop`、`main` 和准备构建的 revision 完全一致。
- 离线 fake 全链、三套 TypeScript、build、部署校验、production safety、revision、release bridge、
  WIF/灾备测试全部通过。
- 最终前后端组合 revision 已由固定安全整体复验通过。

脚本不得从普通环境变量或占位文件推断批准，也不得生成批准。未取得项目管理当场登记的外部批准
事实即停止。历史批准、任务描述或 Gate 2 批准均不能替代 Gate 1。

### Gate 2：真实资金窗口

Gate 1 发布完成且零资金只读门禁全部通过后再次停止。项目管理必须向用户展示精确脱敏的
Binance 账户绑定、XAUT、实时共同最小数量、实际 USDT 名义、预计费用与滑点、备用资金、强平
距离、最坏损失、最长 30 分钟窗口和当前全部门禁，再单独取得“真实资金窗口”批准。

Gate 1 不能复用为 Gate 2；历史确认和本手册都不是批准。Gate 2 前 provider mutation 必须为零。

## 当前离线准备

```bash
npm run test:stage-five-readiness
npm run test:rwa-mainnet-readiness
npm run test:deployment-revision
npm run test:release-bridge
npm run test:arbitrage
npm run test:strategy
npx tsc -p tsconfig.app.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npm run build
npm run deploy:validate
BSC_TESTNET_DEPOSIT_MNEMONIC='公开 Hardhat 测试助记词' npm run verify:production-safety
git diff --check
```

离线 rehearsal 必须使用 fake provider，并覆盖授权、takeover、reconfirm、monitor、外部减险、
Funding 退出、用户退出、每个 mutation 点崩溃/重启、加密备份恢复和其他资产零写。Binance 与
Bybit fixture 都要覆盖真实字段、签名参数、分页/游标/时间窗口、结算去重、精度/最小量、订单
受理后查询、错误 schema 和权限缺失；未知 coverage 必须 fail-closed。

前端未合入时只能记录“第五阶段后端/运维准备通过”，不能记录“五阶段整体通过”。

真实窗口通过证据不能使用自报布尔、计数或占位摘要。证据记录必须：

- 绑定同一脱敏 `userDomain`、账户 fingerprint、authorization、takeover、XAUT profile、
  window ID 和完整 release revision；私有检查、重启订单和审计条目逐项重复绑定并由验证器交叉核对。
- 提供预览和写前两次结构化权威现货/永续规则、价格与盘口深度，由验证器复用服务端共同最小数量
  计算器独立重算；调用方不能提交固定数量覆盖计算结果。
- 使用实际 regular file 的 release/rollback manifest、SQLite backup、RWA encrypted backup 和
  审计文件；验证器核对 owner、mode、单硬链接、size 与 SHA-256。SQLite 必须具有真实 header 并
  通过 `PRAGMA integrity_check`；RWA 归档必须通过现有加密备份 envelope exact-schema 校验。两类
  备份都由只读 sidecar 绑定校验结果、artifact SHA-256、size 和完整 revision，不能由 artifact
  参数自报 revision。
- 三次私有权威核对严格递增，第一条到最后一条本身覆盖至少 10 分钟。重启前后比较完整 canonical
  order 集合，不接受相同 count 代替相同订单。
- 预览、写前 sizing、私有核对、重启前后、退出快照与门禁关闭必须形成严格因果时间链。审计条目
  的事件时间、source ID、sequence 和原始非敏感 subject 必须与 runtime/mutation 事实双向 exact
  set 相等，不能用摘要回显代替原始证据。
- 退出时读取覆盖整个窗口且 cursor 连续终止的完整 provider 活动页，与系统 mutation journal
  按 provider event/order/client ID 双向一一对应。任何未知活动、人工现货卖出或跨
  user/account/venue/asset/takeover 写都拒绝；现货 residual 由权威退出规则和价格复用服务端
  `assessResidual` 独立重算，调用方不能提交 `tradable` 或零计数结论。

Docker 或受控 Linux 现场不可用时，必须保留以下现场门禁，不能以静态测试代替：

- `linux/amd64` 三镜像 build 与内置 revision/OCI label/image ID/digest 核对。
- volume owner/mode/mount/UID/GID、双实例 `flock`、崩溃释放和容器重建。
- 加密备份、restore、rollback 的实际本机与异机 `0600` 副本验证。

## Gate 1 后统一发布

本节现在只演练，不执行。

1. 创建生产 SQLite 一致性备份与自动套利整体加密备份，保存本机和异机 `0600` 副本及
   SHA-256；冻结上一个 verified manifest/env 回滚点。
2. 只从最终 clean commit 的 `git archive` 构建 `linux/amd64` API/Web/strategy 内容寻址镜像，
   安装 `0444`、单硬链接 manifest，并核对三个 image ID、OCI revision、镜像内 revision 和
   Compose 精确一致。
3. 保持 server/global/strategy/user kill switches 和 execution 全部关闭，只通过现有
   `production-compose.sh`/activation 链路部署。
4. 核对容器唯一性、revision/digest、WIF/KMS health、volume/mount/UID/GID、`flock`、health、
   restart count、公开 smoke、未登录 `401`/`no-store` 与敏感日志零输出。
5. activation 失败先停止未验证容器并恢复精确旧 manifest。若存在真实持仓，不得只回滚代码；
   必须由当前仍可验证的 runtime 先安全管理或退出持仓。

## 零资金只读门禁

Gate 1 后、Gate 2 前执行。任何 provider mutation 都是失败。

- 核对服务端账户/fingerprint 匹配布尔、权限、one-way/isolated 能力、提现关闭。
- 完整读取 XAUT 现货、永续、活动订单、实时精度/最小量、手续费、Funding、强平数据和新鲜度。
- 生成第二阶段授权 preview、第三阶段 takeover 计算和第四阶段 monitor 只读状态。
- 不创建真实授权、不创建 takeover、不打开执行开关。
- server kill switch 与所有 user kill switch 保持开启，global/strategy/execution 保持关闭。
- 返回不完整、分页或时间窗口未知、账户不匹配、WIF/KMS/lease/volume 异常时立即停止。

## Gate 2 后首次 Binance 小额闭环

本节现在只使用 fake 演练，不执行。真实窗口仅允许一个指定用户、一个 Binance 账户、XAUT 和
一个 takeover；其他用户、venue、asset 全部关闭。服务器侧窗口最长 30 分钟，到期原子关闭
新增执行，同时保留风险降低和退出能力。

Capital Test connectivity smoke 使用独立 `single_connectivity_smoke` Permit mode。生产 server
kill switch 不得修改默认值；窗口只能由固定 trusted operation 前台 controller 建立，并由 canonical
receipt、不可延长的 `hardEndAt` 和短 lease 共同授权。API 通过只读 bind mount 在每次新增风险
Provider mutation 前重读并核对 Permit/Binding/mode/window/lease；缺失、过期、controller 退出、
身份漂移或 receipt 文件边界异常均视为 CLOSED。窗口关闭后不得新开风险或自动补单，但必须保留
cancel、reduce-only、Spot Sell 和 flat reconciliation。该窗口不是通用 kill-switch 管理能力，
不得通过环境变量、Admin API、续期或常驻 daemon 控制。

### 持久 takeover 发现与确认中止

- `GET /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/current` 无 body。服务端只接受
  已认证 session，从 session 用户、路由 venue、服务端 configured account/fingerprint 和 enabled
  `xaut` profile 查找，返回 `null` 或唯一脱敏 takeover；客户端不提交 `takeoverId`、账户或 profile。
- 非空响应固定提供 `takeoverId/venue/assetId/profileId/authorizationId/state/runtime`、资金与双腿
  数量、`requiresReconfirmation`、脱敏错误和时间。`awaiting_reconfirm`、
  `managed`、runtime `exiting` 和 `manual_intervention` 均可在浏览器或前端重启后发现。
- `POST /api/arbitrage/automation/venues/:venue/assets/:assetId/takeover/:takeoverId/abort` 的 body
  必须精确为 `{}`，仅处理当前账户唯一的 `awaiting_reconfirm`。它先经过第一阶段
  `risk_control` admission，再以持久记录中的 account ID 进入账户级 admission；只有通过后才
  读取当前 metadata、credential/client 和权威 XAUT 状态，全程 provider mutation 为零。
- 权威空仓且无 XAUT 活动单时，abort 持久急停后进入 `failed`、清零 reserve 并释放同授权单活；
  任何仓位、活动单、账户变化、未知或不可唯一核对状态进入 `manual_intervention` 并保留 reserve，
  不得宣称安全终止。服务重启会对遗留 `awaiting_reconfirm` 执行同一收口，避免永久孤儿。
- 错 user/session/venue/asset/profile/takeover、非 `awaiting_reconfirm` 或额外 body 字段返回稳定的
  `asset_takeover_invalid` / `invalid_request` 且零状态写。已定位有效记录后，metadata 缺失或异常、
  fingerprint 轮换、client 构造失败、授权变化以及 snapshot 读取或绑定失败均在有效 lease 内持久为
  `manual_intervention` 并保留 reserve；lease error 原样传播，失租后零状态写。第一阶段 429 前
  registry、账户 metadata、provider read 和持久 mutation 均为零。

`current` 的 200 body 精确为 `null` 或以下 DTO；`abort` 的 200 body 精确复用同一 DTO：

```ts
type CurrentAssetTakeover = {
  takeoverId: string;
  venue: "binance" | "bybit";
  assetId: "xaut";
  profileId: string;
  authorizationId: string;
  state: "planned" | "cancelling_orders" | "awaiting_reconfirm"
    | "setting_leverage" | "opening_spot" | "opening_perpetual"
    | "managed" | "manual_intervention" | "failed";
  newCapitalUsd: number;
  totalManagedCapitalUsd: number;
  reservedCapitalUsd: number;
  leverage: 1 | 2 | 3;
  targetHedgedQuantity: number;
  finalSpotQuantity: number;
  finalPerpetualQuantity: number;
  residualQuantity: number;
  errorCategory: string | null;
  message: string;
  createdAt: number;
  updatedAt: number;
  runtime: PublicTakeoverRuntime | null;
  requiresReconfirmation: boolean;
};
```

DTO 不含 `userId/userDomain/accountId/accountFingerprint/orderLinkPrefix`、provider payload、订单 ID
或内部摘要。`state === "managed" && runtime?.phase === "exiting"` 表示退出中；
`requiresReconfirmation` 仅在 `state === "awaiting_reconfirm"` 时为 `true`。abort 空仓成功返回
`state: "failed"` 的同形 DTO 后，后续 `current` 返回 `null`；带仓或歧义返回
`state: "manual_intervention"`，后续仍可由 `current` 发现且不会释放单活。

1. 当场读取现货与永续规则、价格和深度，调用服务端共同最小数量计算；在任何下单前重算。规则、
   价格或结果变化即停止并重新预览。
2. 展示实际 USDT 名义、费用/最多滑点、25% 备用资金、强平距离和最坏损失。不得出现固定
   `25 USDT` 或固定 `0.002 XAUT`。
3. 建立资产授权并形成共同最小数量的严格对冲。
4. 观察至少 10 分钟，并在不同时间完成至少三次私有权威核对。
5. 在严格对冲持仓仍存在时受控重启 API，按 provider/client order ID 恢复；重启前后 provider
   订单集合必须相同，不能重复下单。
6. 用户通过普通确认执行全部退出。系统先 reduce-only 退出永续，再按权威实际减量卖出对应现货。
7. 完成条件是永续残余精确为零，现货只剩权威规则证明不可交易的 dust，其他范围零写。
8. 立即关闭全部执行门禁，并持久审计 accepted/fill/cancel、重启和门禁变化。

真实窗口的 provider activity 证据必须由受信只读采集器保存逐来源的不可变原始响应和请求绑定，
并通过现有 `RwaProviderActivityContinuity` / Binance scanner 重放。来源集合必须精确包含冻结的
现货/永续订单与成交、账户 transaction/income、internal/universal transfer、充值、内部充值、
提现、convert、dust 和余额调整；每个来源都要覆盖同一窗口，证明 endpoint、参数、页限、
cursor/watermark 和完整终止。缺少任一来源、游标无进展、重复页、达到页上限仍未终止、原始
响应无法验证，或官方接口客观上不能证明连续性时，Gate 2 必须阻塞，不能用 `coverage=true`、
空页或调用方整理的 events 代替。

Binance 的 `deposits` 与 `internal_deposits` 使用相同 endpoint 和请求参数时，受信采集器必须只
保存并引用同一次已认证原始响应，再由两个冻结 parser 按 `transferType` 严格分区。两项证据必须
绑定完全相同的 artifact、采集时间、分页、水位和终止状态；source 顺序、原始响应或引用交叉替换
一律阻塞。

订单受理记录分别保存 requested/accepted quantity；成交按 provider order ID 和唯一 fill ID
聚合实际数量，允许 IOC 部分成交及重试，但每单实际成交总量必须大于零且不超过 accepted
quantity。现货卖出总量不得超过权威永续 reduce-only 实际成交总量。

初次 30 分钟窗口不强行等待两个 Funding 结算周期，只验证结算采集和去重状态。连续两个真实
结算周期的自动收益退出属于后续单独批准的长观察。

人工卖出现货不能作为通过证据。任何失败先关闭新增执行；有权威 snapshot 时按第四阶段减险或
退出，无权威 snapshot 时保持零盲写、急停并进入人工处理。

## MVP 通过证据

- 自动形成严格对冲，观察至少 10 分钟并完成至少三次私有权威核对。
- 持仓中重启没有重复 provider 订单。
- 自动完成双腿退出，永续残余精确为零，现货仅不可交易 dust。
- 其他资产、用户和账户 provider 写为零；全过程不依赖人工卖出现货。
- 异常急停可恢复；备份、manifest、rollback 和持久审计完整。

XAUT 通过后 BTC/ETH/SOL 仍为 `reserved`，不能自动启用。
