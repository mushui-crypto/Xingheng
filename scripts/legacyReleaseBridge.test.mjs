import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  LEGACY_BRIDGE_KIND,
  createRecoveryCompose,
  manifestFileName,
  sha256File,
  validateRecoveryCompose,
  validateResolvedRecoveryCompose,
  verifyLegacyBridgeFiles,
} from "./legacyReleaseBridge.mjs";
import {
  validateReleaseComposeMounts,
  validateReleaseRuntimeMounts,
  validateReleaseVolumeMetadata,
  validateReleaseVolumeMountCounts,
} from "./releaseVolumeBoundaries.mjs";

const API_IMAGE = `sha256:${"1".repeat(64)}`;
const WEB_IMAGE = `sha256:${"2".repeat(64)}`;
const REPO_ROOT = new URL("../", import.meta.url).pathname;
const ACTIVATOR = new URL("./activate-first-verified-release.sh", import.meta.url).pathname;
const BRIDGE_CLI = new URL("./legacy-release-bridge.mjs", import.meta.url).pathname;
const VOLUME_MIGRATION_CLI = new URL("./first-release-volume-migration.mjs", import.meta.url).pathname;

function writeBridge(directory) {
  mkdirSync(directory, { mode: 0o700 });
  const environmentPath = join(dirname(directory), ".env.production");
  if (!existsSync(environmentPath)) {
    writeFileSync(environmentPath, "PUBLIC_TEST_VALUE=true\nDOMAIN=trade.example.test\n", { mode: 0o600 });
  }
  const environmentMetadata = lstatSync(environmentPath, { bigint: true });
  const environmentFile = {
    path: environmentPath,
    dev: environmentMetadata.dev.toString(),
    ino: environmentMetadata.ino.toString(),
    uid: Number(environmentMetadata.uid),
    gid: Number(environmentMetadata.gid),
    mode: Number(environmentMetadata.mode & 0o777n),
    nlink: Number(environmentMetadata.nlink),
    sizeBytes: Number(environmentMetadata.size),
    sha256: sha256File(environmentPath),
  };
  const apiArchive = join(directory, "legacy-api.image.tar");
  const webArchive = join(directory, "legacy-web.image.tar");
  const composePath = join(directory, "legacy-recovery.compose.json");
  writeFileSync(apiArchive, "api-image-archive", { mode: 0o400 });
  writeFileSync(webArchive, "web-image-archive", { mode: 0o400 });
  const recovery = createRecoveryCompose({
    apiImage: API_IMAGE,
    webImage: WEB_IMAGE,
    environmentFile: environmentPath,
  });
  writeFileSync(composePath, `${JSON.stringify(recovery, null, 2)}\n`, { mode: 0o444 });
  const artifact = (path, file, mode) => ({
    file,
    mode,
    sha256: sha256File(path),
    sizeBytes: readFileSync(path).length,
  });
  const volumes = [
    ["api", "xingheng_sqlite_data", "/app/data"],
    ["api", "xingheng_strategy_data", "/app/strategy-data"],
    ["api", "xingheng_sqlite_backups", "/backups"],
    ["web", "xingheng_caddy_data", "/data"],
    ["web", "xingheng_caddy_config", "/config"],
  ].map(([service, name, target]) => ({
    service,
    name,
    target,
    ownerUid: 1000,
    ownerGid: 1000,
    mode: "755",
    preservedInPlace: true,
  })).sort((left, right) =>
    `${left.service}:${left.target}`.localeCompare(`${right.service}:${right.target}`));
  const manifest = {
    schemaVersion: 1,
    bridgeKind: LEGACY_BRIDGE_KIND,
    createdAt: "2026-07-24T12:00:00.000Z",
    projectName: "xingheng",
    environmentFile,
    images: { api: API_IMAGE, web: WEB_IMAGE },
    archives: {
      api: artifact(apiArchive, "legacy-api.image.tar", 0o400),
      web: artifact(webArchive, "legacy-web.image.tar", 0o400),
    },
    compose: artifact(composePath, "legacy-recovery.compose.json", 0o444),
    sqlite: {
      backupName: "trading-20260724T120000Z.sqlite",
      sha256: "3".repeat(64),
      sizeBytes: 4096,
      integrity: "ok",
      volume: "xingheng_sqlite_backups",
    },
    volumes,
  };
  const manifestPath = join(directory, manifestFileName());
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  return { manifest, manifestPath, apiArchive, composePath, environmentPath };
}

test("accepts one strict legacy recovery bundle without sensitive values", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-bridge-"));
  const bundle = join(root, "bundle");
  try {
    writeBridge(bundle);
    const manifest = verifyLegacyBridgeFiles(bundle);
    assert.equal(manifest.images.api, API_IMAGE);
    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /password|secret|token|mnemonic|private_key/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first release volume initializer is scoped to three local volumes and a hardened helper container", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-volume-initialize-"));
  try {
    const { bin, log } = writeVolumeMigrationDocker(root);
    const result = spawnSync(process.execPath, [
      VOLUME_MIGRATION_CLI,
      "initialize",
      API_IMAGE,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: log,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(events.filter((entry) => entry.startsWith("volume create")).length, 3);
    const run = events.find((entry) => entry.startsWith("run --rm"));
    assert.match(run, /--network none/u);
    assert.match(run, /--read-only/u);
    assert.match(run, /--cap-drop ALL/u);
    assert.match(run, /no-new-privileges/u);
    for (const name of [
      "xingheng_rwa_automation_data",
      "xingheng_rwa_automation_backups",
      "xingheng_rwa_automation_lock",
    ]) {
      assert.match(run, new RegExp(name, "u"));
    }
    assert.doesNotMatch(run, /type=bind/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first release owner migration is reversible and refuses a running API", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-volume-owner-roundtrip-"));
  const bundle = join(root, "bridge");
  try {
    writeBridge(bundle);
    const { bin, log } = writeVolumeMigrationDocker(root);
    const baseEnvironment = {
      ...process.env,
      NODE_ENV: "test",
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: log,
    };
    for (const command of ["migrate", "restore"]) {
      const result = spawnSync(process.execPath, [
        VOLUME_MIGRATION_CLI,
        command,
        bundle,
        API_IMAGE,
      ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: baseEnvironment,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const serializedEvents = readFileSync(log, "utf8");
    const events = serializedEvents.trim().split("\n");
    const runs = events.filter((entry) => entry.startsWith("run --rm"));
    assert.equal(runs.length, 2);
    assert.match(serializedEvents, /chown -R 20001:20001/u);
    assert.match(serializedEvents, /chown -R "\$old_uid:\$old_gid"/u);
    for (const run of runs) {
      assert.match(run, /source=xingheng_sqlite_data,target=\/migration\/v0/u);
      assert.match(run, /source=xingheng_strategy_data,target=\/migration\/v1/u);
      assert.match(run, /source=xingheng_sqlite_backups,target=\/migration\/v2/u);
      assert.doesNotMatch(run, /xingheng_caddy/u);
    }

    const blocked = spawnSync(process.execPath, [
      VOLUME_MIGRATION_CLI,
      "migrate",
      bundle,
      API_IMAGE,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...baseEnvironment, FAKE_API_RUNNING: "true" },
    });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /API must be stopped/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing, tampered, writable, symlinked, and hardlinked artifacts", () => {
  for (const mutate of [
    ({ apiArchive }) => {
      chmodSync(apiArchive, 0o600);
      writeFileSync(apiArchive, "tampered");
      chmodSync(apiArchive, 0o400);
    },
    ({ apiArchive }) => chmodSync(apiArchive, 0o600),
    ({ apiArchive }) => {
      const target = `${apiArchive}.target`;
      rmSync(apiArchive);
      writeFileSync(target, "api-image-archive", { mode: 0o400 });
      symlinkSync(target, apiArchive);
    },
    ({ apiArchive }) => linkSync(apiArchive, `${apiArchive}.hardlink`),
    ({ apiArchive }) => writeFileSync(`${apiArchive}.unknown`, "unknown", { mode: 0o400 }),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-negative-"));
    const bundle = join(root, "bundle");
    try {
      const fixture = writeBridge(bundle);
      mutate(fixture);
      assert.throws(() => verifyLegacyBridgeFiles(bundle), /boundary|integrity|unknown/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects schema expansion, image mismatch, and sensitive evidence fields", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-schema-"));
  const bundle = join(root, "bundle");
  try {
    const { manifest, manifestPath } = writeBridge(bundle);
    for (const value of [
      { ...manifest, extra: true },
      { ...manifest, images: { ...manifest.images, api: "xingheng-api:latest" } },
      { ...manifest, environmentFile: { ...manifest.environmentFile, path: "/opt/secret-token.env" } },
    ]) {
      chmodSync(manifestPath, 0o600);
      writeFileSync(manifestPath, `${JSON.stringify(value)}\n`);
      chmodSync(manifestPath, 0o444);
      assert.throws(() => verifyLegacyBridgeFiles(bundle), /invalid|forbidden|immutable/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe recovery Compose expansion before and after resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-compose-schema-"));
  const bundle = join(root, "bundle");
  try {
    const { manifest } = writeBridge(bundle);
    const sourceMutations = [
      (compose) => { compose.services.api.privileged = true; },
      (compose) => { compose.services.api.network_mode = "host"; },
      (compose) => { compose.services.api.cap_add = ["SYS_ADMIN"]; },
      (compose) => { compose.services.api.pid = "host"; },
      (compose) => { compose.services.api.ipc = "host"; },
      (compose) => { compose.services.api.security_opt = ["seccomp=unconfined"]; },
      (compose) => { compose.services.api.volumes.push("/: /host".replace(" ", "")); },
      (compose) => { compose.services.web.devices = ["/dev/null:/dev/null"]; },
    ];
    for (const mutate of sourceMutations) {
      const compose = createRecoveryCompose({
        apiImage: API_IMAGE,
        webImage: WEB_IMAGE,
        environmentFile: manifest.environmentFile.path,
      });
      mutate(compose);
      assert.throws(
        () => validateRecoveryCompose(compose, manifest),
        /schema is invalid/u,
      );
    }

    const resolvedMutations = [
      (compose) => { compose.services.api.privileged = true; },
      (compose) => { compose.services.api.network_mode = "host"; },
      (compose) => { compose.services.api.cap_add = ["SYS_ADMIN"]; },
      (compose) => { compose.services.api.pid = "host"; },
      (compose) => { compose.services.api.ipc = "host"; },
      (compose) => { compose.services.api.security_opt = ["seccomp=unconfined"]; },
      (compose) => {
        compose.services.api.volumes.push({
          type: "bind",
          source: "/",
          target: "/host",
          bind: { create_host_path: true },
        });
      },
      (compose) => { compose.services.api.environment.NODE_ENV = "development"; },
    ];
    for (const mutate of resolvedMutations) {
      const compose = structuredClone(resolvedRecoveryCompose());
      mutate(compose);
      assert.throws(
        () => validateResolvedRecoveryCompose(compose, manifest),
        /invalid/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore refuses an expanded final Compose before starting legacy services", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-resolved-compose-"));
  try {
    const bundle = join(root, "bridge");
    writeBridge(bundle);
    const fixture = writeFakeDocker(root);
    const resolved = resolvedRecoveryCompose();
    resolved.services.api.cap_add = ["SYS_ADMIN"];
    writeFileSync(fixture.resolvedComposePath, JSON.stringify(resolved));
    const log = join(root, "docker.log");
    const state = join(root, "docker-state");
    const result = spawnSync(process.execPath, [BRIDGE_CLI, "restore", bundle], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: log,
        FAKE_DOCKER_STATE: state,
        FAKE_RESOLVED_COMPOSE_PATH: fixture.resolvedComposePath,
        NODE_ENV: "test",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resolved legacy API (?:schema )?is invalid/u);
    assert.equal(
      dockerEvents(log).some((args) => args[0] === "compose" && args.includes("up")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeActivationFixture(directory) {
  const scripts = join(directory, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "activate-first-verified-release.sh"), readFileSync(ACTIVATOR), {
    mode: 0o755,
  });
  writeFileSync(join(scripts, "load-release-manifest.sh"), `#!/bin/sh
XINGHENG_REVISION="${"a".repeat(40)}"
XINGHENG_API_IMAGE="${API_IMAGE}"
export XINGHENG_REVISION
export XINGHENG_API_IMAGE
verify_production_compose() { echo preflight:compose >> "$FAKE_EVENT_LOG"; }
		production_compose() {
		  case "$*" in
		    *"stop api"*) echo action:stop-legacy-api >> "$FAKE_EVENT_LOG" ;;
		    *) echo preflight:wif-kms >> "$FAKE_EVENT_LOG" ;;
		  esac
		}
	stop_unverified_release() {
	  echo rollback:stop-new >> "$FAKE_EVENT_LOG"
	  [ "\${FAKE_STOP_FAIL:-false}" != true ]
	}
	verify_release_containers() {
	  echo verify:new-containers >> "$FAKE_EVENT_LOG"
	  [ "\${FAKE_CONTAINER_VERIFY_FAIL:-false}" != true ]
	}
`, { mode: 0o755 });
  writeFileSync(join(scripts, "activate-release.sh"), `#!/bin/sh
echo action:activate >> "$FAKE_EVENT_LOG"
if [ "\${FAKE_ACTIVATION_FAIL:-false}" = true ]; then exit 1; fi
`, { mode: 0o755 });
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), `#!/bin/sh
	case "$*" in
	  *"legacy-release-bridge.mjs verify-runtime"*)
	    echo preflight:legacy-runtime >> "$FAKE_EVENT_LOG"
	    [ "\${FAKE_LEGACY_PREFLIGHT_FAIL:-false}" != true ]
	    ;;
	  *"legacy-release-bridge.mjs verify-release-environment"*)
	    echo preflight:release-environment >> "$FAKE_EVENT_LOG"
	    [ "\${FAKE_RELEASE_ENV_FAIL:-false}" != true ]
	    ;;
	  *"legacy-release-bridge.mjs verify "*)
	    echo preflight:legacy-files >> "$FAKE_EVENT_LOG"
	    ;;
	  *"legacy-release-bridge.mjs restore"*)
	    echo rollback:restore-legacy >> "$FAKE_EVENT_LOG"
	    [ "\${FAKE_RESTORE_FAIL:-false}" != true ]
	    ;;
		  *"legacy-release-bridge.mjs mark-established"*)
		    echo "$4" > "$3"
		    ;;
		  *"first-release-volume-migration.mjs initialize"*)
		    echo preflight:initialize-release-volumes >> "$FAKE_EVENT_LOG"
		    [ "\${FAKE_VOLUME_INIT_FAIL:-false}" != true ]
		    ;;
		  *"first-release-volume-migration.mjs migrate"*)
		    echo action:migrate-volume-owners >> "$FAKE_EVENT_LOG"
		    [ "\${FAKE_OWNER_MIGRATION_FAIL:-false}" != true ]
		    ;;
		  *"first-release-volume-migration.mjs restore"*)
		    echo rollback:restore-volume-owners >> "$FAKE_EVENT_LOG"
		    [ "\${FAKE_OWNER_RESTORE_FAIL:-false}" != true ]
		    ;;
		  *"verify-release-volume-boundaries.mjs migration"*)
		    echo verify:migrated-volumes >> "$FAKE_EVENT_LOG"
		    [ "\${FAKE_VOLUME_FAIL:-false}" != true ]
		    ;;
	  *"verify-release-volume-boundaries.mjs runtime"*)
	    echo verify:runtime-volumes >> "$FAKE_EVENT_LOG"
	    [ "\${FAKE_RUNTIME_VOLUME_FAIL:-false}" != true ]
    ;;
  *"verify-deployment-revision.mjs images"*)
    echo preflight:new-images >> "$FAKE_EVENT_LOG"
    ;;
	  *"verify-deployment-revision.mjs containers"*)
	    echo verify:new-runtime >> "$FAKE_EVENT_LOG"
	    [ "\${FAKE_RUNTIME_VERIFY_FAIL:-false}" != true ]
	    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return { scripts, bin };
}

function writeVolumeMigrationDocker(directory) {
  const bin = join(directory, "migration-bin");
  mkdirSync(bin);
  const log = join(directory, "migration-docker.log");
  writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  "image inspect") printf '[{"Id":"%s"}]\\n' "${API_IMAGE}" ;;
  "volume create") printf '%s\\n' "$4" ;;
  "volume inspect")
    name="$3"
    printf '[{"Name":"%s","Driver":"local","Scope":"local","Options":{}}]\\n' "$name"
    ;;
  ps*)
    [ "\${FAKE_API_RUNNING:-false}" != true ] || printf 'running-api\\n'
    ;;
  "run --rm") ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return { bin, log };
}

function resolvedRecoveryCompose() {
  const healthcheck = {
    test: [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))",
    ],
    timeout: "5s",
    interval: "15s",
    retries: 5,
    start_period: "30s",
  };
  const apiEnvironment = {
    PUBLIC_TEST_VALUE: "true",
    DOMAIN: "trade.example.test",
    NODE_ENV: "production",
    API_PORT: "8787",
    TRADING_DB_PATH: "/app/data/trading.sqlite",
    STRATEGY_FORWARD_REPORT_PATH: "/app/strategy-data/route-b-forward.json",
    STRATEGY_HISTORY_REPORT_PATH: "/app/strategy-data/route-b-history.json",
    STRATEGY_FORWARD_WORKER_POLL_MS: "300000",
    MARTINGALE_GRID_PAPER_REPORT_PATH: "/app/strategy-data/martingale-grid-paper.json",
    MARTINGALE_GRID_PAPER_WORKER_POLL_MS: "300000",
    FIXED_GRID_PAPER_REPORT_PATH: "/app/strategy-data/fixed-grid-paper.json",
    FIXED_GRID_ARCHIVE_CACHE_PATH: "/app/strategy-data/fixed-grid-archive-cache",
    FIXED_GRID_PAPER_WORKER_POLL_MS: "300000",
    TRUST_PROXY: "true",
    BSC_TESTNET_CHAIN_ID: "97",
  };
  const volume = (source, target) => ({ type: "volume", source, target, volume: {} });
  return {
    name: "xingheng",
    networks: {
      default: { name: "xingheng_default", external: true, ipam: {} },
    },
    services: {
      api: {
        command: null,
        entrypoint: null,
        environment: apiEnvironment,
        healthcheck,
        image: API_IMAGE,
        init: true,
        networks: { default: null },
        pull_policy: "never",
        restart: "unless-stopped",
        stop_grace_period: "20s",
        volumes: [
          volume("sqlite_data", "/app/data"),
          volume("strategy_data", "/app/strategy-data"),
          volume("sqlite_backups", "/backups"),
        ],
      },
      web: {
        command: [
          'test -n "trade.example.test" || { echo "DOMAIN is required" >&2; exit 1; }; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile',
        ],
        depends_on: { api: { condition: "service_healthy", required: true } },
        entrypoint: ["/bin/sh", "-c"],
        environment: { DOMAIN: "trade.example.test" },
        image: WEB_IMAGE,
        networks: { default: null },
        ports: [
          { mode: "ingress", target: 80, published: "80", protocol: "tcp" },
          { mode: "ingress", target: 443, published: "443", protocol: "tcp" },
          { mode: "ingress", target: 443, published: "443", protocol: "udp" },
        ],
        pull_policy: "never",
        restart: "unless-stopped",
        volumes: [
          volume("caddy_data", "/data"),
          volume("caddy_config", "/config"),
        ],
      },
    },
    volumes: Object.fromEntries(
      ["sqlite_data", "strategy_data", "sqlite_backups", "caddy_data", "caddy_config"]
        .map((name) => [name, { name: `xingheng_${name}`, external: true }]),
    ),
  };
}

function releaseComposeMountConfig() {
  const volume = (source, target, readOnly = false) => ({
    type: "volume",
    source,
    target,
    ...(readOnly ? { read_only: true } : {}),
    volume: {},
  });
  const bind = () => ({
    type: "bind",
    source: "/run/xingheng/gcp-wif",
    target: "/run/secrets/gcp-wif",
    read_only: true,
    bind: { create_host_path: false },
  });
  return {
    services: {
      api: {
        volumes: [
          volume("sqlite_data", "/app/data"),
          volume("strategy_data", "/app/strategy-data"),
          volume("sqlite_backups", "/backups"),
          volume("rwa_automation_data", "/app/rwa-automation-data"),
          volume("rwa_automation_lock", "/app/rwa-automation-lock"),
          bind(),
        ],
      },
      web: {
        volumes: [
          volume("caddy_data", "/data"),
          volume("caddy_config", "/config"),
        ],
      },
      "strategy-history": {
        volumes: [volume("strategy_data", "/app/strategy-data")],
      },
      "rwa-automation-backup": {
        volumes: [
          volume("rwa_automation_data", "/app/rwa-automation-data", true),
          volume("rwa_automation_backups", "/app/rwa-automation-backups"),
          volume("rwa_automation_lock", "/app/rwa-automation-lock"),
          bind(),
        ],
      },
      "rwa-automation-restore": {
        volumes: [
          volume("rwa_automation_data", "/app/rwa-automation-data"),
          volume("rwa_automation_backups", "/app/rwa-automation-backups", true),
          volume("rwa_automation_lock", "/app/rwa-automation-lock"),
          bind(),
        ],
      },
    },
  };
}

function releaseRuntimeMounts() {
  const volume = (name, destination) => ({
    type: "volume",
    name,
    source: "",
    destination,
    rw: true,
  });
  const bind = {
    type: "bind",
    name: "",
    source: "/run/xingheng/gcp-wif",
    destination: "/run/secrets/gcp-wif",
    rw: false,
  };
  return {
    api: [
      volume("xingheng_sqlite_data", "/app/data"),
      volume("xingheng_strategy_data", "/app/strategy-data"),
      volume("xingheng_sqlite_backups", "/backups"),
      volume("xingheng_rwa_automation_data", "/app/rwa-automation-data"),
      volume("xingheng_rwa_automation_lock", "/app/rwa-automation-lock"),
      bind,
    ],
    web: [
      volume("xingheng_caddy_data", "/data"),
      volume("xingheng_caddy_config", "/config"),
    ],
  };
}

function writeFakeDocker(directory) {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const docker = join(bin, "docker");
  const runner = join(bin, "docker-runner.mjs");
  const resolvedComposePath = join(directory, "resolved-recovery.json");
  writeFileSync(resolvedComposePath, JSON.stringify(resolvedRecoveryCompose()));
  writeFileSync(runner, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const state = process.env.FAKE_DOCKER_STATE;
mkdirSync(state, { recursive: true });
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const apiImage = "sha256:" + "1".repeat(64);
const webImage = "sha256:" + "2".repeat(64);
const mounts = {
  api: [
    ["xingheng_sqlite_data", "/app/data"],
    ["xingheng_strategy_data", "/app/strategy-data"],
    ["xingheng_sqlite_backups", "/backups"],
  ],
  web: [
    ["xingheng_caddy_data", "/data"],
    ["xingheng_caddy_config", "/config"],
  ],
};
const serviceInspect = (service) => [{
  Id: service + "-id",
  Image: service === "api"
    && existsSync(join(state, "compose-up"))
    && process.env.FAKE_RESTORED_API_IMAGE
      ? process.env.FAKE_RESTORED_API_IMAGE
      : service === "api" ? apiImage : webImage,
  State: {
    Running: true,
    ...(service === "api" ? { Health: { Status: "healthy" } } : {}),
  },
  Config: { Labels: {
    "com.docker.compose.project": "xingheng",
    "com.docker.compose.service": service,
  } },
  Mounts: mounts[service].map(([Name, Destination]) => ({
    Type: "volume", Name, Destination, RW: true,
  })),
}];
if (args[0] === "ps") {
  const serviceFilter = args.find((value) => value.startsWith("label=com.docker.compose.service="));
  if (serviceFilter) process.stdout.write(serviceFilter.endsWith("=api") ? "api-id\\n" : "web-id\\n");
  else process.stdout.write("api-id\\nweb-id\\n");
} else if (args[0] === "container" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify(serviceInspect(args[2].startsWith("api") ? "api" : "web")));
} else if (args[0] === "image" && args[1] === "save") {
  writeFileSync(args[3], "archive:" + args[4]);
} else if (args[0] === "image" && args[1] === "inspect") {
  const service = args[2] === apiImage ? "api" : "web";
  const unavailable = process.env.FAKE_MISSING_IMAGE === service
    && !existsSync(join(state, "loaded-" + service));
  if (unavailable) process.exit(1);
  process.stdout.write(JSON.stringify([{ Id: service === "api" ? apiImage : webImage }]));
} else if (args[0] === "image" && args[1] === "load") {
  const service = args[3].includes("api") ? "api" : "web";
  writeFileSync(join(state, "loaded-" + service), "1");
} else if (args[0] === "exec" && args[2] === "stat" && args[4] === "%u %g %a") {
  process.stdout.write("1000 1000 755\\n");
} else if (args[0] === "exec" && args[2] === "sqlite3" && args.some((value) => value.startsWith(".backup "))) {
  writeFileSync(join(state, "sqlite-backup"), "1");
} else if (args[0] === "exec" && args[2] === "sqlite3") {
  process.stdout.write((process.env.FAKE_RUNTIME_INTEGRITY || "ok") + "\\n");
} else if (args[0] === "exec" && args[2] === "sha256sum") {
  if (process.env.FAKE_CAPTURE_HASH_FAIL === "true") process.exit(1);
  process.stdout.write((process.env.FAKE_RUNTIME_HASH || "3".repeat(64)) + "  backup\\n");
} else if (args[0] === "exec" && args[2] === "stat" && args[4] === "%s") {
  process.stdout.write((process.env.FAKE_RUNTIME_SIZE || "4096") + "\\n");
} else if (args[0] === "exec" && args[2] === "rm") {
  rmSync(join(state, "sqlite-backup"), { force: true });
} else if (args[0] === "run") {
  const entrypoint = args[args.indexOf("--entrypoint") + 1];
  if (entrypoint === "sqlite3") process.stdout.write((process.env.FAKE_OFFLINE_INTEGRITY || "ok") + "\\n");
  if (entrypoint === "sha256sum") process.stdout.write((process.env.FAKE_OFFLINE_HASH || "3".repeat(64)) + "  backup\\n");
  if (entrypoint === "stat") process.stdout.write((process.env.FAKE_OFFLINE_SIZE || "4096") + "\\n");
} else if (args[0] === "compose" && args.includes("config")) {
  process.stdout.write(readFileSync(process.env.FAKE_RESOLVED_COMPOSE_PATH, "utf8"));
} else if (args[0] === "compose" && args.includes("up")) {
  writeFileSync(join(state, "compose-up"), "1");
} else {
  process.stderr.write("unsupported fake docker command\\n");
  process.exit(2);
}
`);
  writeFileSync(docker, `#!/bin/sh
exec "${process.execPath}" -- "${runner}" "$@"
`, { mode: 0o755 });
  return { bin, resolvedComposePath };
}

function runBridgeCli(root, command, args, environment = {}) {
  const log = join(root, "docker.log");
  const state = join(root, "docker-state");
  const { bin, resolvedComposePath } = writeFakeDocker(root);
  return {
    log,
    state,
    result: spawnSync(process.execPath, [BRIDGE_CLI, command, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: log,
        FAKE_DOCKER_STATE: state,
        FAKE_RESOLVED_COMPOSE_PATH: resolvedComposePath,
        NODE_ENV: "test",
        ...environment,
      },
    }),
  };
}

function dockerEvents(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("capture freezes image archives, SQLite recovery evidence, and cleans interrupted snapshots", () => {
  for (const fail of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-capture-cli-"));
    try {
      const environmentFile = join(root, ".env.production");
      const bundle = join(root, "bridge");
      writeFileSync(environmentFile, "PUBLIC_TEST_VALUE=true\n", { mode: 0o600 });
      const { result, log, state } = runBridgeCli(
        root,
        "capture",
        [bundle, environmentFile],
        fail ? { FAKE_CAPTURE_HASH_FAIL: "true" } : {},
      );
      if (fail) {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(bundle), false);
        assert.equal(existsSync(join(state, "sqlite-backup")), false);
        assert.ok(dockerEvents(log).some((args) => args[0] === "exec" && args[2] === "rm"));
      } else {
        assert.equal(result.status, 0, result.stderr);
        const manifest = verifyLegacyBridgeFiles(bundle);
        assert.equal(manifest.images.api, API_IMAGE);
        assert.equal(manifest.sqlite.sha256, "3".repeat(64));
        assert.equal(manifest.sqlite.sizeBytes, 4096);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("capture publishes exact read-only artifacts under the production umask", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-capture-umask-"));
  const originalUmask = process.umask(0o077);
  try {
    const environmentFile = join(root, ".env.production");
    const bundle = join(root, "bridge");
    writeFileSync(environmentFile, "PUBLIC_TEST_VALUE=true\n", { mode: 0o600 });
    const { result } = runBridgeCli(root, "capture", [bundle, environmentFile]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = verifyLegacyBridgeFiles(bundle);
    assert.equal(lstatSync(join(bundle, manifestFileName())).mode & 0o777, 0o444);
    assert.equal(lstatSync(join(bundle, manifest.archives.api.file)).mode & 0o777, 0o400);
    assert.equal(lstatSync(join(bundle, manifest.archives.web.file)).mode & 0o777, 0o400);
    assert.equal(lstatSync(join(bundle, manifest.compose.file)).mode & 0o777, 0o444);
  } finally {
    process.umask(originalUmask);
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore loads missing images and verifies SQLite before starting legacy services", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-restore-cli-"));
  try {
    const bundle = join(root, "bridge");
    writeBridge(bundle);
    const { result, log } = runBridgeCli(root, "restore", [bundle], {
      FAKE_MISSING_IMAGE: "api",
    });
    assert.equal(result.status, 0, result.stderr);
    const events = dockerEvents(log);
    const loadIndex = events.findIndex((args) => args[0] === "image" && args[1] === "load");
    const sqliteIndex = events.findIndex((args) => args[0] === "run" && args.includes("sqlite3"));
    const composeIndex = events.findIndex((args) => args[0] === "compose" && args.includes("up"));
    assert.ok(loadIndex >= 0 && loadIndex < sqliteIndex && sqliteIndex < composeIndex);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects damaged SQLite before Compose and fails on restored image mismatch", () => {
  for (const environment of [
    { FAKE_OFFLINE_INTEGRITY: "corrupt" },
    { FAKE_RESTORED_API_IMAGE: `sha256:${"9".repeat(64)}` },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-restore-negative-"));
    try {
      const bundle = join(root, "bridge");
      writeBridge(bundle);
      const { result, log } = runBridgeCli(root, "restore", [bundle], environment);
      assert.notEqual(result.status, 0);
      const events = dockerEvents(log);
      const composeIndex = events.findIndex((args) => args[0] === "compose" && args.includes("up"));
      if (environment.FAKE_OFFLINE_INTEGRITY) assert.equal(composeIndex, -1);
      else assert.ok(composeIndex >= 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("restore rejects a changed legacy environment and release must use a separate file", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-environment-"));
  try {
    const bundle = join(root, "bridge");
    const { environmentPath } = writeBridge(bundle);
    const releaseEnvironment = join(root, ".env.verified-release");
    writeFileSync(releaseEnvironment, "PUBLIC_TEST_VALUE=true\nDOMAIN=trade.example.test\n", {
      mode: 0o600,
    });

    const independent = runBridgeCli(
      root,
      "verify-release-environment",
      [bundle, releaseEnvironment],
    );
    assert.equal(independent.result.status, 0, independent.result.stderr);

    const shared = runBridgeCli(
      root,
      "verify-release-environment",
      [bundle, environmentPath],
    );
    assert.notEqual(shared.result.status, 0);
    assert.match(shared.result.stderr, /independent environment/u);

    chmodSync(environmentPath, 0o600);
    writeFileSync(environmentPath, "PUBLIC_TEST_VALUE=changed\nDOMAIN=trade.example.test\n");
    const restore = runBridgeCli(root, "restore", [bundle]);
    assert.notEqual(restore.result.status, 0);
    assert.match(restore.result.stderr, /identity changed/u);
    assert.equal(existsSync(restore.log), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects a same-content legacy environment inode replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-environment-inode-"));
  try {
    const bundle = join(root, "bridge");
    const { environmentPath } = writeBridge(bundle);
    const original = readFileSync(environmentPath);
    renameSync(environmentPath, `${environmentPath}.original`);
    writeFileSync(environmentPath, original, { mode: 0o600 });

    const restore = runBridgeCli(root, "restore", [bundle]);
    assert.notEqual(restore.result.status, 0);
    assert.match(restore.result.stderr, /identity changed/u);
    assert.equal(existsSync(restore.log), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first activation rejects before production action when legacy preflight fails", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-activation-preflight-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_LEGACY_PREFLIGHT_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: join(root, "state"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "preflight:legacy-files",
      "preflight:legacy-runtime",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed new activation stops it and restores the frozen legacy runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-activation-rollback-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_ACTIVATION_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: join(root, "state"),
      },
    });
    assert.notEqual(result.status, 0);
    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(events, [
      "preflight:legacy-files",
      "preflight:legacy-runtime",
      "preflight:release-environment",
      "preflight:compose",
      "preflight:new-images",
      "preflight:initialize-release-volumes",
      "preflight:wif-kms",
      "action:stop-legacy-api",
      "action:migrate-volume-owners",
      "verify:migrated-volumes",
      "action:activate",
      "rollback:stop-new",
      "rollback:restore-volume-owners",
      "rollback:restore-legacy",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release volume gate rejects UID migration and operation lock failures", () => {
  const runtime = {
    type: "directory",
    symlink: false,
    uid: 20001,
    gid: 20001,
    mode: 0o755,
    driver: "local",
    scope: "local",
    options: {},
    dockerRoot: "/var/lib/docker",
    dockerFilesystemTarget: "/",
    dockerFilesystemSource: "/dev/vda1",
    dockerFilesystemType: "ext4",
    mountpoint: "/var/lib/docker/volumes/xingheng_sqlite_data/_data",
    filesystemTarget: "/",
    filesystemSource: "/dev/vda1",
    filesystemType: "ext4",
    filesystemOptions: "rw,relatime",
    mountCount: 0,
  };
  assert.equal(validateReleaseVolumeMetadata("xingheng_sqlite_data", runtime), true);
  assert.throws(
    () => validateReleaseVolumeMetadata("xingheng_sqlite_data", { ...runtime, uid: 1000 }),
    /runtime ownership/u,
  );
  const lockRoot = {
    ...runtime,
    uid: 0,
    gid: 0,
    mode: 0o555,
    mountpoint: "/var/lib/docker/volumes/xingheng_rwa_automation_lock/_data",
  };
  const lock = {
    type: "file",
    symlink: false,
    nlink: 1,
    uid: 20001,
    gid: 20001,
    mode: 0o600,
  };
  assert.equal(validateReleaseVolumeMetadata("xingheng_rwa_automation_lock", lockRoot, lock), true);
  assert.throws(
    () => validateReleaseVolumeMetadata(
      "xingheng_rwa_automation_lock",
      lockRoot,
      { ...lock, nlink: 2 },
    ),
    /operation lock/u,
  );
});

test("release volume gate rejects local-driver options and non-local storage backends", () => {
  const base = {
    type: "directory",
    symlink: false,
    uid: 20001,
    gid: 20001,
    mode: 0o700,
    driver: "local",
    scope: "local",
    options: {},
    dockerRoot: "/var/lib/docker",
    dockerFilesystemTarget: "/",
    dockerFilesystemSource: "/dev/vda1",
    dockerFilesystemType: "ext4",
    mountpoint: "/var/lib/docker/volumes/xingheng_rwa_automation_data/_data",
    filesystemTarget: "/",
    filesystemSource: "/dev/vda1",
    filesystemType: "ext4",
    filesystemOptions: "rw,relatime",
    mountCount: 1,
  };
  assert.equal(validateReleaseVolumeMetadata("xingheng_rwa_automation_data", base), true);
  for (const mutation of [
    { options: { type: "nfs", device: "server:/volume" } },
    { options: { type: "none", o: "bind", device: "/srv/data" } },
    {
      filesystemType: "nfs4",
      filesystemSource: "server:/volume",
    },
    {
      filesystemTarget: base.mountpoint,
      filesystemSource: "/srv/external",
      filesystemOptions: "rw,bind",
    },
    {
      filesystemTarget: "/var/lib/docker/volumes",
      filesystemSource: "/dev/vdb1",
      filesystemType: "ext4",
    },
  ]) {
    assert.throws(
      () => validateReleaseVolumeMetadata(
        "xingheng_rwa_automation_data",
        { ...base, ...mutation },
      ),
      /boundary|storage backend/u,
    );
  }
});

test("release Compose and running containers require exact mount mappings", () => {
  const compose = releaseComposeMountConfig();
  assert.equal(validateReleaseComposeMounts(compose), true);
  for (const mutate of [
    (value) => value.services.api.volumes.push({
      type: "bind",
      source: "/",
      target: "/host",
      bind: { create_host_path: true },
    }),
    (value) => { value.services["rwa-automation-backup"].volumes[0].read_only = false; },
    (value) => { value.services.web.volumes[0].target = "/other"; },
  ]) {
    const changed = structuredClone(compose);
    mutate(changed);
    assert.throws(() => validateReleaseComposeMounts(changed), /mount mapping|schema/u);
  }

  const runtime = releaseRuntimeMounts();
  assert.equal(validateReleaseRuntimeMounts(runtime), true);
  for (const mutate of [
    (value) => value.api.pop(),
    (value) => { value.api[0].rw = false; },
    (value) => { value.web[0].name = "external_data"; },
    (value) => value.api.push({
      type: "bind",
      name: "",
      source: "/",
      destination: "/host",
      rw: true,
    }),
  ]) {
    const changed = structuredClone(runtime);
    mutate(changed);
    assert.throws(() => validateReleaseRuntimeMounts(changed), /runtime mount mapping/u);
  }
});

test("release volume mount counts distinguish legacy preflight from verified runtime", () => {
  const preflight = {
    xingheng_sqlite_data: 1,
    xingheng_strategy_data: 1,
    xingheng_sqlite_backups: 1,
    xingheng_rwa_automation_data: 0,
    xingheng_rwa_automation_backups: 0,
    xingheng_rwa_automation_lock: 0,
    xingheng_caddy_data: 1,
    xingheng_caddy_config: 1,
  };
  assert.equal(validateReleaseVolumeMountCounts("preflight", preflight), true);
  assert.equal(validateReleaseVolumeMountCounts("runtime", {
    ...preflight,
    xingheng_rwa_automation_data: 1,
    xingheng_rwa_automation_lock: 1,
  }), true);
  assert.equal(validateReleaseVolumeMountCounts("migration", {
    ...preflight,
    xingheng_sqlite_data: 0,
    xingheng_strategy_data: 0,
    xingheng_sqlite_backups: 0,
  }), true);
  for (const counts of [
    { ...preflight, xingheng_sqlite_data: 0 },
    { ...preflight, xingheng_sqlite_data: 2 },
    { ...preflight, unexpected: 1 },
  ]) {
    assert.throws(
      () => validateReleaseVolumeMountCounts("preflight", counts),
      /mount count/u,
    );
  }
});

test("new automation volume initialization failure rejects before WIF/KMS or legacy stop", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-volume-preflight-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_VOLUME_INIT_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: join(root, "state"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "preflight:legacy-files",
      "preflight:legacy-runtime",
      "preflight:release-environment",
      "preflight:compose",
      "preflight:new-images",
      "preflight:initialize-release-volumes",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner migration failure restores volume owners and the frozen legacy runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-owner-migration-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_OWNER_MIGRATION_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: join(root, "state"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").slice(-5), [
      "action:stop-legacy-api",
      "action:migrate-volume-owners",
      "rollback:stop-new",
      "rollback:restore-volume-owners",
      "rollback:restore-legacy",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy restore failure remains a blocking activation failure", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-restore-failure-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_ACTIVATION_FAIL: "true",
        FAKE_RESTORE_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: join(root, "state"),
      },
    });
    assert.notEqual(result.status, 0);
    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(events.at(-1), "rollback:restore-legacy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback still attempts legacy restore when stopping the unverified release fails", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-stop-failure-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_ACTIVATION_FAIL: "true",
        FAKE_STOP_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: join(root, "state"),
      },
    });
    assert.notEqual(result.status, 0);
    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(events.slice(-3), [
      "rollback:stop-new",
      "rollback:restore-volume-owners",
      "rollback:restore-legacy",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-start verification failure restores legacy and leaves bridge marker absent", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-post-start-failure-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const state = join(root, "state");
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_RUNTIME_VERIFY_FAIL: "true",
        LEGACY_BRIDGE_STATE_FILE: state,
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(state), false);
    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(events.slice(-4), [
      "verify:new-runtime",
      "rollback:stop-new",
      "rollback:restore-volume-owners",
      "rollback:restore-legacy",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful bridge writes a one-way marker and rejects a second bridge", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-one-way-"));
  try {
    const { bin } = writeActivationFixture(root);
    const log = join(root, "events.log");
    const state = join(root, "state");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_EVENT_LOG: log,
      LEGACY_BRIDGE_STATE_FILE: state,
      NODE_ENV: "test",
    };
    const first = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], { cwd: root, encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal((readFileSync(state, "utf8").trim()), "a".repeat(40));
    const second = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], { cwd: root, encoding: "utf8", env });
    assert.equal(second.status, 78);
    assert.match(second.stderr, /permanently disabled/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production marker path cannot be overridden", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-marker-override-"));
  try {
    writeActivationFixture(root);
    const result = spawnSync("sh", [
      "scripts/activate-first-verified-release.sh",
      "/bridge",
      "/release.json",
      "/release.env",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LEGACY_BRIDGE_STATE_FILE: join(root, "alternate-marker"),
      },
    });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /override is test-only/u);
    assert.equal(existsSync(join(root, "alternate-marker")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker CLI rejects a production alternate path without creating it", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-marker-cli-"));
  try {
    chmodSync(root, 0o700);
    const marker = join(root, "alternate-marker");
    const environment = { ...process.env };
    delete environment.NODE_ENV;
    delete environment.LEGACY_BRIDGE_TEST_FAIL_MARKER_WRITE;
    const result = spawnSync(process.execPath, [
      BRIDGE_CLI,
      "mark-established",
      marker,
      "a".repeat(40),
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: environment,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /marker boundary is invalid/u);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial marker write is removed only when its inode is still owned", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-legacy-marker-partial-"));
  try {
    chmodSync(root, 0o700);
    const marker = join(root, "state");
    const result = spawnSync(process.execPath, [
      BRIDGE_CLI,
      "mark-established",
      marker,
      "a".repeat(40),
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        LEGACY_BRIDGE_TEST_FAIL_MARKER_WRITE: "after-write",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /marker fsync failure/u);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
