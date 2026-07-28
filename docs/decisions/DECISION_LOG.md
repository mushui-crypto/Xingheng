# DECISION_LOG.md

记录重要技术决策。

格式：

## ADR-编号

日期：

问题：

候选方案：

最终决定：

原因：

影响：

------------------------------------------------------------------------

## ADR-001：WIF source 使用显式 production/real-test 双 profile

日期：2026-07-28

问题：

production 的 X.509 WIF 链包含需要随 workload 提供的 trust chain，因此现有运行契约是
ADC、certificate config、证书、私钥和 `trust-chain.pem` 五文件。real-test 的叶证书由
Provider trust store 已配置的 Root 直接签发，链中没有 intermediate；继续强制
`trust_chain_path` 会制造与 Google credential source 语义不一致的文件。

候选方案：

1. real-test 继续复制 Root 或 leaf+Root 为 `trust-chain.pem`，维持单一五文件集合。
2. 按文件存在性自动判断四文件或五文件。
3. 由调用方显式选择 `production` 或 `real-test` profile，并分别执行严格 exact-set。

最终决定：

采用方案 3。`production` 保持五文件和 `trust_chain_path`；`real-test` 使用四文件
exact-set，ADC certificate source 只有 `certificate_config_location`，不得生成
`trust-chain.pem`。共享 installer/verifier 必须通过显式 environment 选择 profile，禁止自动
推断或跨环境安装。real-test source 只能由固定
`scripts/prepare-real-test-gcp-wif-source.py real-test` 入口准备。

原因：

- 与 direct-root、无 intermediate 的 Google X.509 credential source 契约一致。
- 保持 production 既有身份边界不变。
- 显式 profile 可以拒绝部分文件、额外文件和跨环境 bundle，不依赖模糊的存在性判断。
- 专用 helper 可集中执行冻结 inode/hash、no-follow、no-replace、fsync 和按收据清理门禁。

影响：

- D2B0 只增加本地代码、测试和文档能力，不授权生成真实 source、复制真实 KEY、安装或 probe。
- D2B1（离线 source/audience）和 D2B2（tmpfs 安装）必须分别获得用户明确批准。
- Backend verifier/installer 的 profile 支持和 Security DevOps helper 均须完成独立
  Code Review 后，real-test 现场批次才可执行。

------------------------------------------------------------------------

## ADR-002：production active WIF bundle 保持单 generation

日期：2026-07-28

问题：

D2B0 Code Review 发现 P1：文档允许在 active WIF 目录中同时保留旧、新 cert/key，并把旧文件
保留时间与已签发 access token 生命周期绑定。这与 production 五文件 exact-set validator 冲突，
也误述了当前尚未设计和现场验证的证书轮换能力。

最终决定：

- production active source/runtime 永远只能有单一 generation 的五文件 exact-set；active 内
  old+new 并存必须 fail-closed。
- candidate 只能在 active 外准备。旧 generation 如保留，只能位于容器不可见、active validator
  不扫描且备份排除的 root-only retired 边界，用于 rollback/evidence。
- 已签发 access token 不依赖旧文件；retired 不用于维持 token。
- 当前不宣称支持 production 无中断或原子整体轮换。candidate/retired 绝对路径、锁、mount
  切换、drain/restart、rollback 与销毁留待未来独立 Level 3 任务。

影响：

- 本裁定仅修正文档不变量，不新增轮换能力，不授权 production 现场操作。
- D2B0-R1 文档修复必须交同一 Code Reviewer 复审；D2B1/D2B2/E 仍须独立授权。

------------------------------------------------------------------------

## ADR-003：D2B1 固定 canonical gcloud 工具链并隔离 config/pycache

日期：2026-07-28

问题：

D2B1 首次执行前门禁发现 `/usr/bin/gcloud` 是到 Cloud SDK 的 symlink，既有 helper 却要求它是
regular file；第二次前门禁进一步确认 Cloud SDK 自带 Python 的既有 `__pycache__` 不能用静态
“零额外文件”规则判断。两次都在任何 helper 调用和 KEY/cert 复制前停止，attempts=0。

最终决定：

- 不执行 `/usr/bin/gcloud`。所有 gcloud 调用固定为
  `/usr/bin/dash /usr/lib/google-cloud-sdk/bin/gcloud ...`，并冻结 canonical gcloud、dash、
  bundled Python、SDK root、dpkg package/manifest/verify 和 component exact-set 收据。
- 子进程从空环境构造 exact allowlist，固定 bundled Python；OpenSSL 使用独立更小环境。
- exact allowlist 固定 `CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true`；它只关闭 Cloud SDK 文件日志，
  不放宽 config 空目录门禁，version/create/version 后出现任何对象仍必须 fail-closed。
- 每批在 `/root` 下排他创建固定 config/pycache 隔离目录，要求调用前后同 inode、`0700` 且为空，
  成功或失败仅在 receipt 匹配时 rmdir。
- SDK 未被 package manifest 覆盖的对象只允许安全 `__pycache__`/`.pyc`；每批动态记录允许集合的
  count 和 sorted-set SHA-256，并要求所有 gcloud 调用后不漂移。
- 全部工具链、Python prefix/user-site 和首次 version/component 门禁必须在打开 STAGE、复制
  KEY/cert 或创建 SOURCE/AUDIENCE 之前完成。

影响：

- D2B0-R2 仅实现和测试上述本地门禁，必须经独立 Code Review；不得表述为 VM 现场已通过。
- 真实 576.0.0 行为必须在另行授权的 D2B0-R2-R1 批次验证：使用独立 root-only 临时根和公开
  cert/key fixture 执行 version/create/version，要求 config/pycache 始终为空并按 inode 收据
  清理；该批次不得接触 D1 材料、SOURCE/AUDIENCE、Provider、IAM、KMS 或 STS。
- D2B1 仍保持 attempts=0，SOURCE/AUDIENCE/runtime target 仍不存在；D2B2/E 未授权。
- Cloud SDK/package/component 或允许 pycache baseline 任一漂移均 fail-closed，升级后必须重新取得
  只读现场收据、Architecture Review 和代码冻结。
