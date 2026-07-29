import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const dockerfile = read("Dockerfile");
const compose = read("compose.yaml");
const composeBuild = read("compose.build.yaml");
const caddy = read("deploy/Caddyfile");
const env = read(".env.production.example");
const realTestEnv = read(".env.real-test.example");
const server = [read("server/index.ts"), read("server/config/runtimeConfig.ts")].join("\n");
const wallet = read("server/wallet/WalletService.ts");
const restore = read("scripts/restore.sh");
const backup = read("scripts/backup.sh");
const smoke = read("scripts/smoke.sh");
const rwaBackup = read("scripts/rwa-automation-backup.sh");
const rwaRestore = read("scripts/rwa-automation-restore.sh");
const rwaRollback = read("scripts/rwa-automation-rollback.sh");
const rwaBackupService = read("server/modules/arbitrage/automation/RwaAutomationBackupService.ts");
const rwaGovernance = read("server/modules/arbitrage/automation/RwaAutomationGovernance.ts");
const rwaExecutionLease = read("server/modules/arbitrage/automation/RwaAutomationExecutionLease.ts");
const rwaMainnetRunbook = read("deploy/RWA_BINANCE_25_USDT_MAINNET_RUNBOOK.md");
const rwaXautMvpRunbook = read("deploy/RWA_XAUT_MVP_CONTROLLED_VALIDATION_RUNBOOK.md");
const rwaReadinessRehearsal = read("scripts/rehearse-rwa-mainnet-readiness.mjs");
const stageFiveReadiness = read("scripts/stageFiveReadiness.ts");
const deploymentRevision = read("scripts/deploymentRevision.mjs");
const deploymentRevisionVerifier = read("scripts/verify-deployment-revision.mjs");
const runtimeRevisionVerifier = read("scripts/verify-runtime-revision.sh");
const releaseImageBuilder = read("scripts/build-release-images.sh");
const releaseActivator = read("scripts/activate-release.sh");
const firstReleaseActivator = read("scripts/activate-first-verified-release.sh");
const firstReleaseVolumeMigration = read("scripts/first-release-volume-migration.mjs");
const releaseManifestLoader = read("scripts/load-release-manifest.sh");
const productionCompose = read("scripts/production-compose.sh");
const realTestCompose = read("scripts/real-test-compose.sh");
const standaloneRealTestCompose = read("scripts/real-test-standalone-compose.sh");
const standaloneRealTestComposeConfig = read("compose.real-test-standalone.yaml");
const realTestActivator = read("scripts/activate-real-test-release.sh");
const realTestWebHealth = read("scripts/verify-real-test-web-health.sh");
const composeEnvironmentVerifier = read("scripts/verify-compose-environment-file.mjs");
const trustedDockerRuntime = read("scripts/trustedDockerRuntime.mjs");
const trustedOperationLauncher = read("scripts/trusted-operation-launcher.mjs");
const trustedOperationPreamble = read("scripts/trusted-operation-preamble.sh");
const trustedDockerCli = read("scripts/trusted-docker.mjs");
const trustedReleaseCandidate = read("scripts/trustedReleaseCandidate.mjs");
const trustedReleaseCandidateInstaller = read("scripts/install-trusted-release-candidate.mjs");
const realTestRuntimeReceipt = read("scripts/realTestRuntimeReceipt.mjs");
const realTestRuntimeInstaller = read("scripts/installRealTestRuntime.mjs");
const realTestRuntimeOperation = read("scripts/realTestRuntimeOperation.mjs");
const realTestRuntimeInstallEntry = read("scripts/install-real-test-runtime.sh");
const realTestRuntimeActivateEntry = read("scripts/activate-first-real-test-api.sh");
const realTestRuntimeStopEntry = read("scripts/stop-real-test-api.sh");
const realTestCleanup = read("scripts/realTestCleanup.mjs");
const cleanupTransactionStore = read("scripts/cleanupTransactionStore.mjs");
const realTestCleanupWrapper = read("scripts/real-test-cleanup.sh");
const realTestComposeConfig = read("compose.real-test.yaml");
const realTestCaddy = read("deploy/Caddyfile.real-test");
const standaloneRealTestCaddy = read("deploy/Caddyfile.real-test-standalone");
const dualEnvironmentTopology = read("scripts/dualEnvironmentTopology.mjs");
const dualEnvironmentRunbook = read("deploy/PRODUCTION_REAL_TEST_DUAL_ENVIRONMENT_RUNBOOK.md");
const deploymentReadme = read("deploy/README.md");
const stepZeroChecklist = read("deploy/STEP_0_PRODUCTION_CHECKLIST.md");
const releaseLifecycle = read("scripts/releaseLifecycleTransaction.mjs");
const releaseRollback = read("scripts/rollback-release.sh");
const providerIdentityPreflight = read("server/operations/RwaProviderIdentityPreflight.ts");
const providerIdentityPreflightCli = read("server/operations/rwaProviderIdentityPreflightCli.ts");
const providerIdentityReceipts = read("scripts/providerIdentityReceipts.mjs");
const legacyBridge = read("scripts/legacyReleaseBridge.mjs");
const legacyBridgeCli = read("scripts/legacy-release-bridge.mjs");
const legacyBridgeWrapper = read("scripts/legacy-release-bridge.sh");
const wifBundle = read("scripts/gcpWifBundle.mjs");
const wifInstaller = read("scripts/install-gcp-wif.sh");
const releaseVolumeVerifier = read("scripts/verify-release-volume-boundaries.mjs");
const releaseVolumeBoundaries = read("scripts/releaseVolumeBoundaries.mjs");
const activationPreflight = read("server/operations/RwaAutomationActivationPreflight.ts");
const activationPreflightCli = read("server/operations/rwaAutomationActivationPreflightCli.ts");
const packageJson = read("package.json");

const assertions = [
  [dockerfile.includes("AS build") && dockerfile.includes("AS api") && dockerfile.includes("AS web"), "Dockerfile must use build/api/web stages"],
  [dockerfile.includes("npm ci --omit=dev") && dockerfile.includes('CMD [\"node\", \"dist-server/index.js\"]'), "API runtime must use production dependencies and compiled JS"],
  [dockerfile.includes("USER 20001:20001"), "API must run as the pinned non-root user"],
  [
    dockerfile.includes("ARG XINGHENG_REVISION")
      && (dockerfile.match(/org\.opencontainers\.image\.revision/g) ?? []).length === 3
      && dockerfile.includes("/app/.build-revision")
      && dockerfile.split('ENTRYPOINT ["/usr/local/bin/verify-runtime-revision"]').length - 1 === 3,
    "all release image targets must embed and enforce the immutable build revision",
  ],
  [
    (compose.match(/XINGHENG_EXPECTED_REVISION:/g) ?? []).length === 7
      && (compose.match(/XINGHENG_API_IMAGE:\?/g) ?? []).length === 5
      && compose.includes("XINGHENG_WEB_IMAGE:?")
      && compose.includes("XINGHENG_STRATEGY_TOOLS_IMAGE:?")
      && (compose.match(/pull_policy: never/g) ?? []).length === 7
      && !compose.includes("build:"),
    "production Compose must consume only manifest-pinned immutable release images",
  ],
  [
    (composeBuild.match(/build:/g) ?? []).length === 3
      && composeBuild.includes("target: api")
      && composeBuild.includes("target: web")
      && composeBuild.includes("target: strategy-tools"),
    "local image builds must remain isolated in the non-production Compose override",
  ],
  [compose.includes("condition: service_healthy"), "web must wait for a healthy API"],
  [compose.includes('test -n "$$DOMAIN"'), "web must reject a missing domain"],
  [
    (compose.match(/env_file:/g) ?? []).length === 2
      && compose.includes("XINGHENG_COMPOSE_ENV_FD")
      && composeEnvironmentVerifier.includes('"/proc/self/fd"')
      && composeEnvironmentVerifier.includes("interpolationFdPath")
      && composeEnvironmentVerifier.includes("serviceFdPath")
      && composeEnvironmentVerifier.includes("sha256Descriptor"),
    "only API and the read-only identity preflight may receive the same verified production environment file object",
  ],
  [
    trustedDockerRuntime.includes('"/usr/bin/docker"')
      && trustedDockerRuntime.includes('"/usr/libexec/docker/cli-plugins/docker-compose"')
      && trustedDockerRuntime.includes('"/var/run/docker.sock"')
      && trustedDockerRuntime.includes("O_NOFOLLOW")
      && trustedDockerRuntime.includes("executableDescriptorPath")
      && trustedDockerRuntime.includes("DOCKER_HOST")
      && trustedDockerRuntime.includes("startsWith(\"DOCKER_\")")
      && composeEnvironmentVerifier.includes("openTrustedDockerRuntime"),
    "Docker and Compose must use one root-owned descriptor-bound local runtime",
  ],
  [
    trustedOperationLauncher.includes("assertNoDockerControlEnvironment")
      && trustedOperationLauncher.includes("assertTrustedReleaseRoot")
      && trustedOperationLauncher.includes("acquireOperationLocks")
      && trustedOperationLauncher.includes('HOME: "/root"')
      && trustedOperationLauncher.includes('PATH: "/usr/sbin:/usr/bin:/sbin:/bin"')
      && trustedOperationPreamble.includes("/usr/bin/env -i")
      && trustedOperationPreamble.includes("NODE_TEST_CONTEXT")
      && trustedOperationPreamble.includes("XINGHENG_TEST_")
      && trustedDockerCli.includes("XINGHENG_TRUSTED_DOCKER_PURPOSE")
      && trustedDockerCli.includes("validateTrustedReleaseBuildDockerArguments")
      && trustedDockerRuntime.includes("arguments are not allowlisted")
      && trustedOperationLauncher.includes('"release-build"')
      && trustedReleaseCandidate.includes("/opt/xingheng-release/candidates")
      && trustedReleaseCandidate.includes("/opt/xingheng-real-test-release/candidates")
      && trustedOperationLauncher.includes("XINGHENG_RELEASE_CANDIDATE_ENVIRONMENT")
      && trustedOperationPreamble.includes("/opt/xingheng-real-test-release/candidates/*/code")
      && trustedReleaseCandidateInstaller.includes("get-tar-commit-id")
      && deploymentReadme.includes("candidate-build-receipt.json")
      && deploymentReadme.includes("release-build production scripts/build-release-images.sh")
      && deploymentReadme.includes(
        "trusted-operation-launcher.mjs release-build real-test scripts/build-release-images.sh",
      ),
    "all root operations must enter through the minimal trusted launcher and the build Docker shim must remain internal",
  ],
  [
    realTestRuntimeReceipt.includes(
      '"/etc/xingheng-real-test/runtime-release.json"',
    )
      && realTestRuntimeReceipt.includes('"/etc/xingheng-real-test/runtime.env"')
      && realTestRuntimeReceipt.includes("candidateReceiptSha256")
      && realTestRuntimeReceipt.includes("candidateTreeSha256")
      && realTestRuntimeReceipt.includes("sourceArchiveSha256")
      && realTestRuntimeInstaller.includes("O_EXCL")
      && realTestRuntimeInstaller.includes("O_NOFOLLOW")
      && realTestRuntimeOperation.includes('"kms-health-preflight"')
      && realTestRuntimeOperation.includes('["up", "-d", "api"]')
      && realTestRuntimeOperation.includes('["stop", "api"]')
      && trustedOperationLauncher.includes('"real-test-runtime-install"')
      && trustedOperationLauncher.includes('"real-test-runtime"')
      && trustedOperationPreamble.includes("install-real-test-runtime.sh")
      && trustedOperationPreamble.includes("activate-first-real-test-api.sh")
      && trustedOperationPreamble.includes("stop-real-test-api.sh")
      && realTestRuntimeInstallEntry.includes("real-test-runtime-install")
      && realTestRuntimeActivateEntry.includes("real-test-runtime")
      && realTestRuntimeStopEntry.includes("real-test-runtime")
      && deploymentReadme.includes("real-test 单 revision API runtime"),
    "real-test runtime must bind one candidate revision to fixed install, KMS health, API activation and stop operations",
  ],
  [
    stepZeroChecklist.includes("cd /opt/xingheng-release/code")
      && stepZeroChecklist.includes("/opt/xingheng-release/code/deploy/release-manifest.json")
      && stepZeroChecklist.includes("/usr/bin/node scripts/install-trusted-operations.mjs install")
      && stepZeroChecklist.includes("sudo ./scripts/activate-first-verified-release.sh")
      && !stepZeroChecklist.includes("docker info")
      && !stepZeroChecklist.includes("docker compose")
      && !stepZeroChecklist.includes("first-release-volume-migration.mjs initialize")
      && !deploymentReadme.includes("production_compose run --rm --no-deps --user")
      && !deploymentReadme.includes("production_compose exec -T"),
    "production runbooks must use only the trusted fixed operation entries",
  ],
  [compose.includes('DOMAIN: "${DOMAIN:?'), "web must receive only the interpolated public domain"],
  [compose.includes("sqlite_data:/app/data"), "SQLite must use its named volume"],
  [compose.includes("strategy_data:/app/strategy-data"), "Strategy reports must use a dedicated named volume"],
  [
    compose.includes("rwa_automation_data:/app/rwa-automation-data")
      && compose.includes("rwa_automation_backups:/app/rwa-automation-backups")
      && compose.includes("rwa_automation_lock:/app/rwa-automation-lock")
      && !/api:[\s\S]*?rwa_automation_backups:\/app\/rwa-automation-backups/.test(compose.slice(0, compose.indexOf("\n  web:"))),
    "RWA automation data, backups, and operation lock must use isolated volumes; API must not mount backup storage",
  ],
  [
    compose.includes("rwa-automation-backup:")
      && compose.includes("rwa-automation-restore:")
      && compose.includes("rwa_automation_data:/app/rwa-automation-data:ro")
      && compose.includes("rwa_automation_backups:/app/rwa-automation-backups:ro"),
    "RWA backup must read data only and restore must read backup storage only",
  ],
  [
    (compose.match(/\/app\/rwa-automation-lock\/operation\.lock/g) ?? []).length === 3
      && (compose.match(/- flock/g) ?? []).length === 2
      && compose.includes("RWA_AUTOMATION_EXECUTION_MODE: single-host")
      && compose.includes("RWA_AUTOMATION_INSTANCE_COUNT: \"1\"")
      && compose.includes("- dist-server/index.js")
      && rwaExecutionLease.includes("O_NOFOLLOW")
      && rwaExecutionLease.includes("fstatSync")
      && rwaExecutionLease.includes("acquireWithFlock")
      && dockerfile.includes("chown 0:0 /app/rwa-automation-lock")
      && dockerfile.includes("chmod 0555 /app/rwa-automation-lock")
      && dockerfile.includes("chmod 0600 /app/rwa-automation-lock/operation.lock")
      && dockerfile.includes("util-linux"),
    "API must hold the in-process FD/flock lease while backup and restore share the same local lock",
  ],
  [compose.includes("STRATEGY_FORWARD_REPORT_PATH: /app/strategy-data/route-b-forward.json"), "Compose must pin the forward strategy report path"],
  [compose.includes("STRATEGY_HISTORY_REPORT_PATH: /app/strategy-data/route-b-history.json"), "Compose must pin the history strategy report path"],
  [composeBuild.includes("target: strategy-tools") && compose.includes("strategy-history:"), "Compose must provide a one-shot strategy history service"],
  [dockerfile.includes("AS strategy-tools") && dockerfile.includes("research:ict:history"), "Dockerfile must provide a strategy tools target"],
  [compose.includes('BSC_TESTNET_CHAIN_ID: \"97\"'), "BSC Testnet chain ID must be pinned"],
  [caddy.indexOf("reverse_proxy /api*") < caddy.indexOf("try_files"), "/api proxy must precede SPA fallback"],
  [caddy.indexOf("reverse_proxy /ws") < caddy.indexOf("try_files"), "/ws proxy must precede SPA fallback"],
  [
    [
      "DOMAIN=",
      "XINGHENG_REVISION=REPLACE_WITH_FULL_GIT_COMMIT",
      "APP_PUBLIC_URL=https://",
      "CORS_ALLOWED_ORIGINS=https://",
      "ADMIN_EMAIL=",
      "ADMIN_PASSWORD=",
      "SMTP_HOST=",
      "SMTP_PORT=",
      "SMTP_USER=",
      "SMTP_PASSWORD=",
      "SMTP_FROM=",
      "BSC_TESTNET_CHAIN_ID=97",
      "STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json",
      "STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json",
      "STRATEGY_EMAIL_ALERTS_ENABLED=false",
      "STRATEGY_ALERT_EMAIL_TO=",
      "RWA_CREDENTIAL_KEY_PROVIDER=gcp-kms",
      "RWA_GCP_KMS_AUTH_MODE=x509_wif",
      "RWA_GCP_KMS_KEY_NAME=projects/xingheng-production/locations/asia/keyRings/xingheng-rwa-prod-sg/cryptoKeys/exchange-credentials",
      "RWA_GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/REPLACE_WITH_PROJECT_NUMBER/locations/global/workloadIdentityPools/REPLACE_WITH_POOL/providers/REPLACE_WITH_PROVIDER",
      "GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp-wif/adc.json",
      "RWA_AUTOMATION_DATA_DIR=/app/rwa-automation-data",
      "RWA_AUTOMATION_INSTANCE_COUNT=1",
      "WEB_CONCURRENCY=1",
      "RWA_AUTOMATION_EXECUTION_MODE=single-host",
      "RWA_AUTOMATION_LOCK_DIR=/app/rwa-automation-lock",
      "RWA_AUTOMATION_LOCK_PATH=/app/rwa-automation-lock/operation.lock",
      "RWA_AUTOMATION_BACKUP_DIR=/app/rwa-automation-backups",
      "RWA_AUTOMATION_BACKUP_RETENTION_DAYS=30",
      "RWA_AUTOMATION_BACKUP_MAX_TOTAL_BYTES=1073741824",
      "RWA_AUTOMATION_BACKUP_MAX_SNAPSHOT_BYTES=104857600",
      "RWA_AUTOMATION_EXECUTE_BURST_MAX=2",
      "RWA_AUTOMATION_EXECUTE_CONCURRENCY=1",
      "RWA_AUTOMATION_IDEMPOTENCY_RETENTION_SECONDS=2592000",
      "RWA_AUTOMATION_STATE_MAX_BYTES_HARD=10485760",
    ].every((key) => env.includes(key)),
    "production env example is incomplete",
  ],
  [
    dockerfile.includes("useradd --uid 20001 --gid 20001")
      && (dockerfile.match(/USER 20001:20001/g) ?? []).length === 2
      && compose.includes('user: "20001:20001"'),
    "API and strategy tools must use the pinned non-root RWA runtime UID",
  ],
  [
    compose.includes("source: /run/xingheng/gcp-wif")
      && compose.includes("target: /run/secrets/gcp-wif")
      && compose.includes("read_only: true")
      && compose.includes("create_host_path: false"),
    "Compose must bind the WIF tmpfs directory read-only without creating it",
  ],
  [server.includes("STRATEGY_ALERT_EMAIL_TO 必须是有效且非示例"), "production config must validate strategy alert email when enabled"],
  [
    server.includes("loadRwaAutomationGovernanceConfig")
      && rwaGovernance.includes("automation_capacity_exceeded")
      && rwaGovernance.includes("executeConcurrencyPerAccount: count")
      && server.includes("当前只允许单 Node API 实例")
      && server.includes("自动套利执行拓扑必须使用冻结的单主机独占租约配置")
      && compose.includes('WEB_CONCURRENCY: "1"')
      && !compose.includes("replicas:"),
    "production must validate bounded automation rate and capacity governance",
  ],
  [
    server.includes("RWA_AUTOMATION_MASTER_KEY 已停用")
      && server.includes("RWA_CREDENTIAL_KEY_PROVIDER 必须固定为 gcp-kms")
      && server.includes("validateGcpWifRuntimeBoundary"),
    "production must reject local/fake key providers and unsafe WIF runtime boundaries",
  ],
  [
    packageJson.includes('"test:rwa-mainnet-readiness"')
      && rwaReadinessRehearsal.includes('process.env.NODE_ENV === "production"')
      && rwaReadinessRehearsal.includes('process.env.RWA_AUTOMATION_SERVER_KILL_SWITCH === "false"')
      && rwaReadinessRehearsal.includes("GOOGLE_APPLICATION_CREDENTIALS")
      && rwaReadinessRehearsal.includes("BINANCE_API_SECRET")
      && rwaMainnetRunbook.includes("25 USDT 是一次建立现货与永续对冲组合的总预算")
      && rwaMainnetRunbook.includes("不是 Mainnet 验证"),
    "historical RWA Mainnet readiness evidence must remain offline and unchanged",
  ],
  [
    packageJson.includes('"test:stage-five-readiness"')
      && rwaReadinessRehearsal.includes("stageFiveReadiness.test.mjs")
      && stageFiveReadiness.includes("gate_1_external_approval_required")
      && stageFiveReadiness.includes("gate_2_external_approval_required")
      && stageFiveReadiness.includes("calculateMinimumCommonBaseQuantity")
      && stageFiveReadiness.includes("validateAuthoritativeMarket")
      && stageFiveReadiness.includes("readArtifact")
      && stageFiveReadiness.includes("assessResidual")
      && stageFiveReadiness.includes("validateProviderActivity")
      && stageFiveReadiness.includes("scanBinancePositionAttribution")
      && stageFiveReadiness.includes("RWA_SPOT_ACTIVITY_SOURCES")
      && stageFiveReadiness.includes("parseBinanceActivityResponseForReadiness")
      && stageFiveReadiness.includes("validateSqliteBackup")
      && stageFiveReadiness.includes("validateRwaAutomationBackupEnvelopeForReadiness")
      && stageFiveReadiness.includes("causal_timeline_invalid")
      && rwaXautMvpRunbook.includes("Gate 1：统一生产发布")
      && rwaXautMvpRunbook.includes("Gate 2：真实资金窗口")
      && rwaXautMvpRunbook.includes("至少 10 分钟")
      && rwaXautMvpRunbook.includes("至少三次私有权威核对")
      && rwaXautMvpRunbook.includes("RwaProviderActivityContinuity")
      && rwaXautMvpRunbook.includes("requested/accepted quantity")
      && rwaXautMvpRunbook.includes("人工卖出现货不能作为通过证据")
      && rwaXautMvpRunbook.includes("只保留为历史证据"),
    "stage-five preparation must preserve two external stops and the dynamic Binance XAUT evidence contract",
  ],
  [
    packageJson.includes('"test:deployment-revision"')
      && deploymentRevision.includes("^[0-9a-f]{40}$")
      && deploymentRevision.includes("^sha256:[0-9a-f]{64}$")
      && deploymentRevision.includes("validateReleaseManifest")
      && deploymentRevision.includes("validateProductionComposeConfig")
      && deploymentRevision.includes("rwa-automation-backup")
      && deploymentRevisionVerifier.includes("docker")
      && deploymentRevisionVerifier.includes("image")
      && deploymentRevisionVerifier.includes("container")
      && deploymentRevisionVerifier.includes("manifestDigest")
      && deploymentRevisionVerifier.includes("actualDigest")
      && deploymentRevisionVerifier.includes("O_NOFOLLOW")
      && runtimeRevisionVerifier.includes("/app/.build-revision")
      && runtimeRevisionVerifier.includes("XINGHENG_EXPECTED_REVISION")
      && releaseImageBuilder.includes("git status --porcelain")
      && releaseImageBuilder.includes("git rev-parse --verify HEAD^{commit}")
      && releaseImageBuilder.includes("git archive --format=tar")
      && releaseImageBuilder.includes("linux/amd64")
      && releaseImageBuilder.includes('--platform "$platform"')
      && releaseImageBuilder.includes("{{.Os}}/{{.Architecture}}")
      && releaseImageBuilder.includes("write-manifest")
      && releaseManifestLoader.includes("manifest-values")
      && releaseManifestLoader.includes("verify_production_compose")
      && productionCompose.includes("grep -Eq '^(COMPOSE_|DOCKER_")
      && productionCompose.includes("-f*|-p*")
      && productionCompose.includes("config|up|run|exec|stop|ps|logs|down")
      && productionCompose.includes("verify-compose-environment-file.mjs")
      && productionCompose.includes('production "$@"')
      && composeEnvironmentVerifier.includes('"compose.yaml"')
      && composeEnvironmentVerifier.includes('"xingheng"')
      && deploymentRevisionVerifier.includes("production Compose release mapping verified")
      && releaseActivator.includes('images "$release_manifest"')
      && releaseActivator.includes("verify_release_containers"),
    "release revision, image digests, and the final production Compose mapping must be verified around activation",
  ],
  [
    realTestComposeConfig.includes("name: xingheng-real-test")
      && productionCompose.includes('production "$@"')
      && realTestCompose.includes('real-test "$@"')
      && composeEnvironmentVerifier.includes('"xingheng-real-test"')
      && composeEnvironmentVerifier.includes('"compose.real-test.yaml"')
      && realTestCompose.includes("real-test Compose env file override is not allowed")
      && !realTestComposeConfig.includes("\n    ports:")
      && caddy.includes("real-test-web:80")
      && realTestCaddy.includes("http://{$REAL_TEST_DOMAIN}")
      && realTestCaddy.includes("reverse_proxy /api* api:8787"),
    "production and real-test Compose identities and ingress routing must remain fixed",
  ],
  [
    standaloneRealTestCompose.includes("real-test-standalone")
      && standaloneRealTestCompose.includes("trusted-operation-launcher.mjs")
      && standaloneRealTestComposeConfig.includes('"80:80"')
      && standaloneRealTestComposeConfig.includes('"443:443"')
      && standaloneRealTestComposeConfig.includes('"443:443/udp"')
      && standaloneRealTestComposeConfig.includes("!reset null")
      && standaloneRealTestComposeConfig.includes("Caddyfile.real-test-standalone")
      && standaloneRealTestComposeConfig.includes("/usr/local/bin/verify-real-test-web-health")
      && standaloneRealTestCaddy.includes("{$REAL_TEST_DOMAIN}")
      && !standaloneRealTestCaddy.includes("http://")
      && standaloneRealTestCaddy.includes("Strict-Transport-Security")
      && dockerfile.includes("Caddyfile.real-test-standalone")
      && dockerfile.includes("verify-real-test-web-health.sh")
      && realTestWebHealth.includes("Cache-Control:")
      && realTestWebHealth.includes('"deploymentEnvironment":"real-test"')
      && realTestWebHealth.includes('"composeProject":"xingheng-real-test"')
      && deploymentRevisionVerifier.includes("compose-real-test-standalone")
      && deploymentRevisionVerifier.includes("healthStatus")
      && deploymentRevisionVerifier.includes("runtime topology label mismatch")
      && deploymentRevisionVerifier.includes("health status is starting")
      && dualEnvironmentTopology.includes("validateStandaloneRealTestTopology")
      && realTestActivator.includes("shared|standalone")
      && realTestActivator.includes("containers-real-test")
      && realTestActivator.includes("stop api web"),
    "standalone real-test must use the trusted release chain and exclusive HTTPS ingress",
  ],
  [
    deploymentRevision.includes("validateRealTestComposeConfig")
      && deploymentRevisionVerifier.includes("dual-compose")
      && deploymentRevisionVerifier.includes("containers-real-test")
      && dualEnvironmentTopology.includes("provider account fingerprint is shared")
      && dualEnvironmentTopology.includes("deployment service mount mapping is invalid")
      && realTestComposeConfig.includes('RWA_AUTOMATION_SERVER_KILL_SWITCH: "true"')
      && realTestComposeConfig.includes("RWA_GCP_KMS_AUTH_MODE: gce_attached_service_account")
      && realTestComposeConfig.includes("RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL:")
      && !realTestComposeConfig.includes("/run/xingheng-real-test/gcp-wif")
      && !realTestComposeConfig.includes("GOOGLE_APPLICATION_CREDENTIALS")
      && !realTestComposeConfig.includes("RWA_GCP_WIF_AUDIENCE")
      && realTestEnv.includes("RWA_GCP_KMS_AUTH_MODE=gce_attached_service_account")
      && realTestEnv.includes("RWA_GCE_EXPECTED_SERVICE_ACCOUNT_EMAIL=")
      && !realTestEnv.includes("GOOGLE_APPLICATION_CREDENTIALS")
      && !realTestEnv.includes("RWA_GCP_WIF_AUDIENCE")
      && compose.includes("/run/xingheng/gcp-wif"),
    "dual-environment topology must reject domain, account, mount, and execution-gate crossings",
  ],
  [
    releaseVolumeBoundaries.includes("REAL_TEST_VOLUME_BOUNDARIES")
      && releaseVolumeBoundaries.includes("validateRealTestRuntimeMounts")
      && releaseVolumeVerifier.includes('first === "real-test"')
      && dualEnvironmentRunbook.includes("real-test runtime"),
    "real-test live volumes must reuse the strict owner, filesystem, mount, and lock verifier",
  ],
  [
    realTestCleanup.includes("REAL_TEST_RESET_VOLUMES")
      && realTestCleanup.includes("PRODUCTION_PROTECTED_VOLUMES")
      && realTestCleanup.includes("production evidence changed")
      && realTestCleanup.includes("sqlite-backup")
      && realTestCleanup.includes("rwa-automation-backup")
      && realTestCleanup.includes('"down", "--remove-orphans"')
      && realTestCleanup.includes('"ps", "-aq"')
      && realTestCleanup.includes("restoreRealTest")
      && realTestCleanup.includes("incident_restore_failed")
      && realTestCleanup.includes("productionContainers")
      && realTestCleanup.includes("trading.sqlite-wal")
      && realTestCleanup.includes("treeEntries")
      && realTestComposeConfig.includes("sqlite-verify:")
      && realTestComposeConfig.includes("rwa-automation-verify:")
      && realTestCleanup.includes("constants.O_NOFOLLOW")
      && cleanupTransactionStore.includes("constants.O_EXCL")
      && realTestCleanup.includes("fstatSync")
      && cleanupTransactionStore.includes("fchmodSync")
      && realTestCleanup.includes("strategy-backup")
      && realTestCleanup.includes("publishRecoveryAudit")
      && realTestCleanupWrapper.includes("trusted-operation-launcher.mjs")
      && dualEnvironmentRunbook.includes("DELETE-XINGHENG-REAL-TEST-DATA")
      && packageJson.includes('"test:dual-environment"'),
    "real-test cleanup must be allowlisted, backed up, audited, and production-preserving",
  ],
  [
    packageJson.includes("rwa-provider-identity-preflight.js")
      && compose.includes("provider-identity-preflight:")
      && realTestComposeConfig.includes("provider-identity-preflight:")
      && providerIdentityPreflight.includes("validateAccess()")
      && providerIdentityPreflight.includes("provider_identity_mismatch")
      && providerIdentityPreflight.includes('serverKillSwitch !== "true"')
      && providerIdentityPreflightCli.includes("providerIdentityPreflightErrorCategory")
      && providerIdentityReceipts.includes("same authoritative provider account")
      && dualEnvironmentRunbook.includes("field-pending"),
    "provider identity isolation must use two read-only authoritative receipts and remain field-pending until现场 verification",
  ],
  [
    realTestComposeConfig.includes("kms-health-preflight:")
      && realTestComposeConfig.includes("dist-server/operations/rwa-activation-preflight.js")
      && dualEnvironmentTopology.includes("real-test KMS health preflight boundary is invalid")
      && deploymentRevisionVerifier.includes('"kms-health-preflight"')
      && activationPreflight.includes("config.deploymentEnvironment")
      && activationPreflight.includes("activation_preflight_deployment_invalid")
      && activationPreflightCli.includes("ACTIVATION_KMS_HEALTH_RECEIPT")
      && !activationPreflightCli.includes("activation WIF"),
    "real-test activation KMS health must use the reviewed image, verified deployment identity, and auth-neutral receipt",
  ],
  [
    releaseActivator.includes("releaseLifecycleTransaction.mjs prepare")
      && releaseActivator.includes("releaseLifecycleTransaction.mjs complete")
      && releaseActivator.includes("releaseLifecycleTransaction.mjs incident")
      && firstReleaseActivator.includes("releaseLifecycleTransaction.mjs establish")
      && releaseRollback.includes("releaseLifecycleTransaction.mjs rollback-values")
      && releaseRollback.includes("releaseLifecycleTransaction.mjs restore-environment")
      && releaseRollback.includes("releaseLifecycleTransaction.mjs verify-rollback-runtime")
      && releaseRollback.includes("releaseLifecycleTransaction.mjs rolled-back")
      && releaseLifecycle.includes("release lifecycle has an unresolved operation")
      && releaseLifecycle.includes("release lifecycle mutation requires the trusted production operation lock")
      && trustedOperationLauncher.includes('"rollback-release.sh"'),
    "verified first release, upgrade failure, and fixed rollback must share one durable locked lifecycle",
  ],
  [
    packageJson.includes('"test:release-bridge"')
      && packageJson.includes("rwa-activation-preflight.js")
      && legacyBridge.includes("xingheng-legacy-release-bridge")
      && legacyBridge.includes("assertNoSensitiveText")
      && legacyBridge.includes("directory contains unknown or missing files")
      && legacyBridge.includes("validateResolvedRecoveryCompose")
      && legacyBridge.includes("verifyLegacyEnvironmentFile")
      && legacyBridge.includes("readSync")
      && legacyBridgeCli.includes('docker(["image", "save"')
      && legacyBridgeCli.includes("verifyOfflineSqliteRecoveryPoint")
      && legacyBridgeCli.includes("--network")
      && legacyBridgeCli.includes("--read-only")
      && legacyBridgeCli.includes("markEstablished")
      && legacyBridgeCli.includes("verified release must use an independent environment file")
      && legacyBridgeCli.includes("VERIFIED_RELEASE_MARKER")
      && legacyBridgeCli.includes("O_EXCL")
      && legacyBridgeCli.includes("O_NOFOLLOW")
      && legacyBridgeCli.includes("legacy bridge mutation requires the trusted production operation lock")
      && legacyBridgeWrapper.includes("trusted-operation-preamble.sh")
      && trustedOperationLauncher.includes('"legacy-release-bridge.sh"'),
    "the one-time legacy bridge must freeze recoverable images, SQLite evidence, and a one-way marker",
  ],
  [
    firstReleaseActivator.indexOf('verify "$bridge_dir"')
      < firstReleaseActivator.indexOf('verify-runtime "$bridge_dir"')
      && firstReleaseActivator.indexOf('verify-runtime "$bridge_dir"')
        < firstReleaseActivator.indexOf("verify-release-environment")
      && firstReleaseActivator.indexOf("verify-release-environment")
        < firstReleaseActivator.indexOf("verify_production_compose")
      && firstReleaseActivator.indexOf("verify_production_compose")
        < firstReleaseActivator.indexOf("first-release-volume-migration.mjs initialize")
      && firstReleaseActivator.indexOf("first-release-volume-migration.mjs initialize")
        < firstReleaseActivator.indexOf("rwa-activation-preflight.js")
      && firstReleaseActivator.indexOf("rwa-activation-preflight.js")
        < firstReleaseActivator.indexOf("production_compose stop api")
      && firstReleaseActivator.indexOf("production_compose stop api")
        < firstReleaseActivator.indexOf("first-release-volume-migration.mjs migrate")
      && firstReleaseActivator.indexOf("first-release-volume-migration.mjs migrate")
        < firstReleaseActivator.indexOf("verify-release-volume-boundaries.mjs migration")
      && firstReleaseActivator.indexOf("verify-release-volume-boundaries.mjs migration")
        < firstReleaseActivator.lastIndexOf("activated=true")
      && firstReleaseActivator.indexOf("verify_release_containers")
        < firstReleaseActivator.indexOf("verify-release-volume-boundaries.mjs runtime")
      && firstReleaseActivator.includes("marker override is test-only")
      && firstReleaseActivator.includes("stop_unverified_release || stop_status=$?")
      && firstReleaseActivator.includes("first-release-volume-migration.mjs restore")
      && firstReleaseActivator.includes("legacy-release-bridge.mjs restore")
      && firstReleaseActivator.includes("legacy-release-bridge.mjs mark-established")
      && !releaseActivator.includes("legacy-release-bridge"),
    "first activation must preflight, migrate ownership transactionally, restore legacy on failure, and remain isolated from normal releases",
  ],
  [
    wifBundle.includes("https://sts.mtls.googleapis.com/v1/token")
      && wifBundle.includes("O_NOFOLLOW")
      && wifBundle.includes("nlink !== 1")
      && wifInstaller.includes("mount -t tmpfs")
      && wifInstaller.includes("WIF target override is test-only")
      && wifInstaller.includes('= /run ]')
      && wifInstaller.includes('= tmpfs ]')
      && wifInstaller.includes("uid=20001,gid=20001")
      && wifInstaller.includes('mount --bind "$parent" "$parent"')
      && wifInstaller.includes('mount --make-private "$parent"')
      && wifInstaller.includes('= private ]')
      && wifInstaller.includes("mount --move")
      && wifInstaller.includes('umount "$target"')
      && wifInstaller.includes("verify-gcp-wif-bundle.mjs installed")
      && wifInstaller.includes("trusted-operation-preamble.sh")
      && trustedOperationLauncher.includes('"install-gcp-wif.sh"')
      && wifInstaller.includes('production) target="/run/xingheng/gcp-wif"')
      && wifInstaller.includes('real-test) target="/run/xingheng-real-test/gcp-wif"')
      && wifInstaller.includes("production|real-test")
      && activationPreflight.includes('serverKillSwitch() !== "true"')
      && activationPreflight.includes("credential_key_provider_unavailable"),
    "WIF installation and activation KMS health must use the frozen mTLS, tmpfs, ownership, and fail-closed boundaries",
  ],
  [
    releaseVolumeVerifier.includes("RELEASE_VOLUME_BOUNDARIES")
      && releaseVolumeVerifier.includes("findmnt")
      && releaseVolumeVerifier.includes("inspected.Options")
      && releaseVolumeVerifier.includes("validateReleaseComposeMounts")
      && releaseVolumeVerifier.includes("validateReleaseRuntimeMounts")
      && releaseVolumeVerifier.includes("validateReleaseVolumeMountCounts")
      && releaseVolumeVerifier.includes("operation.lock")
      && releaseVolumeBoundaries.includes("NETWORK_FILESYSTEM")
      && releaseVolumeBoundaries.includes("EXPECTED_MOUNT_COUNTS"),
    "first release activation must inspect every local named-volume boundary",
  ],
  [
    firstReleaseVolumeMigration.includes("first release volume migration requires the controlled root operator")
      && firstReleaseVolumeMigration.includes('"--network",')
      && firstReleaseVolumeMigration.includes('"none",')
      && firstReleaseVolumeMigration.includes('"--read-only",')
      && firstReleaseVolumeMigration.includes('"no-new-privileges"')
      && firstReleaseVolumeMigration.includes("assertApiStopped")
      && firstReleaseVolumeMigration.includes("find \"$root\" -xdev -type l")
      && firstReleaseVolumeMigration.includes("find \"$root\" -xdev -type f -links +1")
      && firstReleaseVolumeMigration.includes("chown -R 20001:20001")
      && firstReleaseVolumeMigration.includes('chown -R "$old_uid:$old_gid"'),
    "first release owner migration must be root-controlled, volume-scoped, link-safe, and reversible",
  ],
  [env.includes(".invalid") && env.includes("REPLACE_WITH_BSC_TESTNET_RPC_URL") && env.includes("REPLACE_WITH_BSC_TESTNET_TOKEN_ADDRESS"), "production env example must use unmistakable rejected placeholders"],
  [server.includes('domain.endsWith(".invalid")') && server.includes("BSC_TESTNET_TOKEN_ADDRESS 必须是有效且非零") && server.includes("SMTP 配置仍是示例占位值"), "production startup must reject placeholder identity and unsafe token configuration"],
  [wallet.includes('process.env.NODE_ENV !== "production"') && wallet.includes('process.env.NODE_ENV === "production"'), "production must not initialize or seed demo wallet data"],
  [restore.includes("trading-[0-9][0-9]") && !restore.includes("trading-*.sqlite"), "restore filename must use a strict timestamp allowlist"],
  [
    [backup, restore, smoke, rwaBackup, rwaRestore, rwaRollback].every(
      (script) => script.includes("production_compose") && !script.includes("docker compose"),
    ),
    "operational scripts must use only the pinned production Compose wrapper",
  ],
  [
    [backup, restore, smoke, rwaBackup, rwaRestore, rwaRollback].every(
      (script) =>
        script.includes(". scripts/load-release-manifest.sh")
        && script.includes("verify_production_compose")
        && script.includes("production_compose"),
    ),
    "all deployment and recovery operations must load and verify the immutable release manifest",
  ],
  [[backup, restore].every((script) => !script.includes("gcp-wif")), "WIF identity material must be excluded from project backup and restore scripts"],
  [
    [rwaBackup, rwaRestore, rwaRollback].every(
      (script) =>
        script.includes("verify_production_compose")
        && script.includes("stop api")
        && script.includes("rwa-automation-ops"),
    ),
    "RWA disaster recovery scripts must stop API and load the explicit Compose environment",
  ],
  [
    rwaRestore.includes("rwa-automation-[0-9][0-9]")
      && !rwaRestore.includes("rwa-automation-*.rwa.enc.json")
      && rwaRollback.includes('= "rollback"'),
    "RWA restore and rollback must require explicit strict operator input",
  ],
  [
    !rwaBackupService.includes("/run/secrets/gcp-wif")
      && !rwaBackupService.includes("trading.sqlite")
      && !rwaBackupService.includes("/app/strategy-data")
      && rwaBackupService.includes("challenges: []")
      && rwaBackupService.includes("killSwitchActive: true"),
    "RWA backup scope must exclude WIF, SQLite, strategy reports, and ephemeral execution grants",
  ],
  [
    dockerfile.includes("rwa-automation-current.json")
      && dockerfile.includes("/app/rwa-automation-data/generation-initial")
      && dockerfile.includes("chmod 0700 /app/rwa-automation-data"),
    "RWA automation volume image seed must pin the generation pointer and private ownership modes",
  ],
];

const failures = assertions.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("deployment static validation passed");
