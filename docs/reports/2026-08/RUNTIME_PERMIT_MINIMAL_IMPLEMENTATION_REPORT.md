# Runtime Permit Minimal Implementation Report

> Historical pre-commit implementation record. The resulting commit identity is
> recorded in [`RUNTIME_PERMIT_COMMIT_REPORT.md`](./RUNTIME_PERMIT_COMMIT_REPORT.md).

日期：2026-08-03
实现范围：Capital Test production self-test Permit 的最小 Runtime Schema 与验证逻辑。

## 1. 结果

```text
RUNTIME_PERMIT_MINIMAL_IMPLEMENTATION: PASS
ACTION_SCOPE: ["READ","TRADE"]
AUTHORIZATION_DIGEST_BINDING: IMPLEMENTED
SINGLE_CONSUME: IMPLEMENTED
REAL_PERMIT_GENERATED: NO
PROVIDER_CONNECTED: NO
REAL_TRADE_EXECUTED: NO
```

本结果仅表示指定的最小 Schema、验证与防重放逻辑已经实现并通过本地审查。代码尚未提交、构建新 release、部署或重新绑定授权材料，不授予 Provider 或真实资金执行权限。

## 2. Action Scope

Permit 的 `actionScope` 固定为精确只读 tuple：

```json
["READ","TRADE"]
```

验证规则：

- 必须同时存在 `READ` 与 `TRADE`。
- 长度必须为 `2`，顺序固定。
- 拒绝缺失、重复、额外项、不同顺序、大小写变化、空格及未知能力。
- Permit loader、持久 confirmation 和 runtime matching 使用同一 exact 规则。
- `TRADE` 只允许本次 Capital Test connectivity smoke 的开仓、必要撤单和平仓闭环。
- 不包含或推导 `WITHDRAW`、`TRANSFER`、`ADMIN`、`PERMISSION_CHANGE` 或 `ACCOUNT_CONFIGURATION_CHANGE`。
- Production self-test Permit 不再允许驱动普通 execute 或 takeover 新增风险路径；这些路径在 Provider write 前 fail-closed。
- 已归属 smoke 的撤单、Spot 卖出、reduce-only Futures 及其他风险降低动作保持可用。

## 3. Authorization Digest

新增必填字段：

```text
authorizationDigest: lowercase SHA-256
```

实现规则：

- 必须匹配 `^[a-f0-9]{64}$`。
- 缺失、非法或旧 Permit 均 fail-closed，不自动补默认值。
- `authorizationDigest` 与固定 `READ/TRADE` scope 一并进入主 Permit digest。
- Confirmation 必须精确匹配相同的 `authorizationDigest`、scope 和主 digest。
- Runtime 在新风险检查时重新计算 Permit digest；任一字段变化均拒绝。

本实现只绑定授权材料摘要，不新增账户字段、Provider identity、审批 metadata、风险字段或完整 authorization envelope。

## 4. Single-consume

新增权威消费记录，字段精确为：

```text
permitId
digest
consumedAt
```

实现规则：

- 记录采用 exact-key 验证；未知、缺失或非法字段均拒绝。
- `permitId` 与 `digest` 分别保持唯一；重复或冲突状态 fail-closed。
- Connectivity smoke 在已持有 execution lease 和进程内 `withLock` 的临界区中消费 Permit。
- Consumption 与 `reserved` smoke 在同一次原子 `writeState` 中落盘。
- 写入发生在 Provider client 创建及任何 Provider mutation 之前。
- 写盘失败不会进入 Provider；rename/chmod 后 fsync 父目录，成功返回前持久化目录项。
- Smoke 失败、超时、`UNKNOWN`、人工介入、重启或完成后均不删除 consumption。
- 常规 state compaction 不清除 consumption。
- 相同幂等请求可返回原 smoke；不同请求不能复用同一 Permit。
- Smoke 每次新增风险 mutation 前重新确认当前 Permit 对应的 consumption 已存在。
- 普通 execute/takeover/mutation guard 不能借该 Permit 绕过 single-consume；拒绝测试确认 Provider write 为 `0`。

## 5. Backup / Restore Boundary

- 加密备份保留并 exact-validate `productionSelfTestPermitConsumptions`。
- Restore/rollback 目标 generation 必须原样包含当前全部 consumption；缺失 tombstone 时 fail-closed。
- Production restore wrapper 先停止 API，Compose restore command 固定持有共享
  `/app/rwa-automation-lock/operation.lock`。
- Rollback wrapper 同样持有该锁。
- Tombstone 单调性检查与 generation pointer swap 因此处于同一现有跨进程锁边界。
- 未新增第二套锁、数据库或复杂状态机。

## 6. 修改文件

实现：

- `server/modules/arbitrage/automation/RwaBinanceProductionSelfTestPermit.ts`
- `server/modules/arbitrage/automation/RwaAutomationPersistentStore.ts`
- `server/modules/arbitrage/automation/RwaBinanceAutomationService.ts`
- `server/modules/arbitrage/automation/RwaAutomationBackupService.ts`

测试：

- `server/modules/arbitrage/automation/RwaBinanceProductionSelfTestPermit.test.ts`
- `server/modules/arbitrage/automation/RwaAutomationPersistentStore.test.ts`
- `server/modules/arbitrage/automation/RwaBinanceAutomationService.test.ts`
- `server/modules/arbitrage/automation/RwaAutomationBackupService.test.ts`

未修改 Permit 权限体系之外的业务模块，未新增账户、Provider、风险或审批模型。

## 7. 审查与验证

### Architecture Review

```text
APPROVED
```

确认最小边界为 exact `READ/TRADE`、authorization digest 主摘要绑定，以及 lease/lock 内永久 single-consume。

### Code Review

首轮发现：

- P1：普通 execute/takeover 可绕过 consumption。
- P1：需证明 restore pointer swap 与消费写入共享跨进程锁。
- P2：state rename 后缺少父目录 fsync。

上述问题已修复。最终复审：

```text
PASS
P0/P1/P2: 0/0/0
```

### Tests

```text
Permit / PersistentStore / BackupService / AutomationService: 127/127 PASS
Server TypeScript: PASS
git diff --check: PASS
```

测试全部使用本地 fixture/fake，未连接真实 Provider。

## 8. 未实施内容

- 未新增账户绑定；既有字段保持不变，未扩展。
- 未新增 Provider 或 subaccount identity 模型。
- 未新增风险参数或 risk-engine 字段。
- 未新增审批角色、审批流程或 approval metadata。
- 未增加 `READ/TRADE` 之外的权限。
- 未生成真实 Permit。
- 未修改 Provider 权限、Gate、kill switch、IAM/WIF/KMS。
- 未连接 Provider，未执行订单、仓位或资金操作。

## 9. 当前边界与后续阻断

```text
Provider Access: NOT_AUTHORIZED
Real Funds: NOT_AUTHORIZED
Execution: BLOCKED_PENDING_AUTHORIZATION
Permit: NO
```

后续仍需：

1. 将当前未提交实现形成新的 reviewed source revision。
2. 生成并独立验证新的 trusted release artifact identity。
3. 将授权材料重新绑定到新 release 和新文档 SHA 链。
4. 完成独立人工授权后，才可另行评估 Permit 生成。

本任务到此停止，不进入真实资金执行。
