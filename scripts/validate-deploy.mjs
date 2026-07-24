import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const dockerfile = read("Dockerfile");
const compose = read("compose.yaml");
const composeBuild = read("compose.build.yaml");
const caddy = read("deploy/Caddyfile");
const env = read(".env.production.example");
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
const rwaReadinessRehearsal = read("scripts/rehearse-rwa-mainnet-readiness.mjs");
const deploymentRevision = read("scripts/deploymentRevision.mjs");
const deploymentRevisionVerifier = read("scripts/verify-deployment-revision.mjs");
const runtimeRevisionVerifier = read("scripts/verify-runtime-revision.sh");
const releaseImageBuilder = read("scripts/build-release-images.sh");
const releaseActivator = read("scripts/activate-release.sh");
const releaseManifestLoader = read("scripts/load-release-manifest.sh");
const productionCompose = read("scripts/production-compose.sh");
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
    (compose.match(/XINGHENG_EXPECTED_REVISION:/g) ?? []).length === 5
      && (compose.match(/XINGHENG_API_IMAGE:\?/g) ?? []).length === 3
      && compose.includes("XINGHENG_WEB_IMAGE:?")
      && compose.includes("XINGHENG_STRATEGY_TOOLS_IMAGE:?")
      && (compose.match(/pull_policy: never/g) ?? []).length === 5
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
  [(compose.match(/env_file:/g) ?? []).length === 1, "only API may receive the production secret env file"],
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
    "RWA Mainnet readiness rehearsal must remain offline and document the frozen total budget",
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
      && releaseImageBuilder.includes("write-manifest")
      && releaseManifestLoader.includes("manifest-image")
      && releaseManifestLoader.includes("verify_production_compose")
      && productionCompose.includes("COMPOSE_FILE")
      && productionCompose.includes("-f*|-p*")
      && productionCompose.includes("config|up|run|exec|stop|ps|logs|down")
      && productionCompose.includes('-f "$repo_root/compose.yaml"')
      && productionCompose.includes("-p xingheng")
      && deploymentRevisionVerifier.includes("production Compose release mapping verified")
      && releaseActivator.includes('images "$release_manifest"')
      && releaseActivator.includes("verify_release_containers"),
    "release revision, image digests, and the final production Compose mapping must be verified around activation",
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
