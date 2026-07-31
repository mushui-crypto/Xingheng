import assert from "node:assert/strict";
import test from "node:test";
import { validateProductionTopology } from "./productionTopology.mjs";

const REVISION = "a".repeat(40);
const API = `sha256:${"1".repeat(64)}`;
const WEB = `sha256:${"2".repeat(64)}`;
const STRATEGY = `sha256:${"3".repeat(64)}`;
const manifest = {
  schemaVersion: 1,
  revision: REVISION,
  images: { api: API, web: WEB, strategyTools: STRATEGY },
};

test("accepts the fixed production topology", () => {
  assert.equal(validateProductionTopology(manifest, fixture()), true);
});

test("rejects crossed production identity, domain, WIF, ingress and volume boundaries", () => {
  const mutations = [
    (config) => { config.name = "other-project"; },
    (config) => { config.services.api.environment.DOMAIN = "other.example.com"; },
    (config) => { config.services.api.environment.XINGHENG_COMPOSE_PROJECT = "other-project"; },
    (config) => { config.services.api.environment.XINGHENG_DEPLOYMENT_ENVIRONMENT = "staging"; },
    (config) => { config.services.api.environment.XINGHENG_WIF_HOST_PATH = "/run/other/gcp-wif"; },
    (config) => { config.services.api.volumes.at(-1).source = "/run/other/gcp-wif"; },
    (config) => { config.services.web.ports.pop(); },
    (config) => { config.services.web.networks.public_ingress.aliases = ["other-web"]; },
    (config) => { config.networks.public_ingress.name = "other-ingress"; },
    (config) => { config.volumes.sqlite_data.name = "other_sqlite_data"; },
    (config) => { config.services["provider-identity-preflight"].read_only = false; },
    (config) => { config.services["rwa-automation-verify"].volumes[0].read_only = false; },
    (config) => { config.services["rwa-automation-verify"].command.push("restore"); },
  ];

  for (const mutate of mutations) {
    const config = fixture();
    mutate(config);
    assert.throws(() => validateProductionTopology(manifest, config));
  }
});

test("rejects mutable, missing or crossed release image mappings", () => {
  const mutations = [
    (config) => { config.services.api.image = `sha256:${"9".repeat(64)}`; },
    (config) => { config.services.api.pull_policy = "always"; },
    (config) => { config.services.api.build = "."; },
    (config) => { delete config.services["strategy-history"]; },
    (config) => { config.services.web.environment.XINGHENG_EXPECTED_REVISION = "b".repeat(40); },
  ];

  for (const mutate of mutations) {
    const config = fixture();
    mutate(config);
    assert.throws(() => validateProductionTopology(manifest, config));
  }
});

test("requires a Web init reaper and an internal HTTP healthcheck", () => {
  const mutations = [
    (config) => { delete config.services.web.init; },
    (config) => { config.services.web.init = false; },
    (config) => {
      config.services.web.healthcheck.test[1] =
        "wget -qO- http://127.0.0.1/api/health | grep -q '\"production\"'";
    },
    (config) => {
      config.services.web.healthcheck.test[1] =
        "wget -qO- https://api:8787/api/health | grep -q '\"production\"'";
    },
    (config) => {
      config.services.web.healthcheck.test[1] =
        "wget -qO- --header 'Host: $DOMAIN' http://api:8787/api/health | grep -q '\"production\"'";
    },
  ];

  for (const mutate of mutations) {
    const config = fixture();
    mutate(config);
    assert.throws(() => validateProductionTopology(manifest, config));
  }
});

function fixture() {
  const service = (image, extra = {}) => ({
    image,
    pull_policy: "never",
    environment: {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
      ...extra,
    },
  });
  const api = service(API, {
    DOMAIN: "app.example.com",
    XINGHENG_WIF_HOST_PATH: "/run/xingheng/gcp-wif",
    RWA_GCP_KMS_KEY_NAME:
      "projects/xingheng-production/locations/asia/keyRings/production/cryptoKeys/credentials",
    RWA_GCP_WIF_AUDIENCE:
      "//iam.googleapis.com/projects/111111/locations/global/workloadIdentityPools/production/providers/vultr",
  });
  api.volumes = mounts([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "sqlite_backups", "/backups", false],
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", "/run/xingheng/gcp-wif", "/run/secrets/gcp-wif", true],
  ]);
  api.healthcheck = healthcheck(false);

  const web = service(WEB, { DOMAIN: "app.example.com" });
  web.init = true;
  web.volumes = mounts([
    ["volume", "caddy_data", "/data", false],
    ["volume", "caddy_config", "/config", false],
  ]);
  web.networks = {
    default: {},
    public_ingress: { aliases: ["production-web"] },
  };
  web.ports = [
    { published: "80", target: 80, protocol: "tcp" },
    { published: "443", target: 443, protocol: "tcp" },
    { published: "443", target: 443, protocol: "udp" },
  ];
  web.healthcheck = healthcheck(true);

  const strategyHistory = service(STRATEGY);
  strategyHistory.volumes = mounts([
    ["volume", "strategy_data", "/app/strategy-data", false],
  ]);

  const sqliteRestore = service(API);
  sqliteRestore.volumes = mounts([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "sqlite_backups", "/backups", true],
  ]);

  const preflight = service(API, {
    RWA_PROVIDER_PREFLIGHT_USER_ID: "",
    RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
    RWA_GCP_KMS_KEY_NAME: api.environment.RWA_GCP_KMS_KEY_NAME,
    RWA_GCP_WIF_AUDIENCE: api.environment.RWA_GCP_WIF_AUDIENCE,
  });
  preflight.volumes = mounts([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", true],
    ["bind", "/run/xingheng/gcp-wif", "/run/secrets/gcp-wif", true],
  ]);
  Object.assign(preflight, {
    command: ["node", "dist-server/operations/rwa-provider-identity-preflight.js"],
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
  });

  const automationBackup = service(API);
  automationBackup.volumes = mounts([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", true],
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", false],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", "/run/xingheng/gcp-wif", "/run/secrets/gcp-wif", true],
  ]);

  const automationRestore = service(API);
  automationRestore.volumes = mounts([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", true],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", "/run/xingheng/gcp-wif", "/run/secrets/gcp-wif", true],
  ]);
  const automationVerify = service(API, {
    RWA_AUTOMATION_VERIFY_FILE: "",
    RWA_GCP_KMS_KEY_NAME: api.environment.RWA_GCP_KMS_KEY_NAME,
    RWA_GCP_WIF_AUDIENCE: api.environment.RWA_GCP_WIF_AUDIENCE,
  });
  automationVerify.volumes = mounts([
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", true],
    ["bind", "/run/xingheng/gcp-wif", "/run/secrets/gcp-wif", true],
  ]);
  Object.assign(automationVerify, {
    command: ["node", "dist-server/operations/rwa-automation-backup-verify.js"],
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
  });

  return {
    name: "xingheng",
    services: {
      api,
      web,
      "strategy-history": strategyHistory,
      "sqlite-restore": sqliteRestore,
      "provider-identity-preflight": preflight,
      "rwa-automation-backup": automationBackup,
      "rwa-automation-restore": automationRestore,
      "rwa-automation-verify": automationVerify,
    },
    networks: {
      default: {},
      public_ingress: { name: "xingheng-public-ingress" },
    },
    volumes: Object.fromEntries([
      "caddy_config",
      "caddy_data",
      "rwa_automation_backups",
      "rwa_automation_data",
      "rwa_automation_lock",
      "sqlite_backups",
      "sqlite_data",
      "strategy_data",
    ].map((name) => [name, { name: `xingheng_${name}` }])),
  };
}

function healthcheck(web) {
  return {
    test: web
      ? ["CMD-SHELL", "wget -qO- http://api:8787/api/health | grep -q '\"production\"'"]
      : ["CMD", "node", "-e", "cache-control production xingheng XINGHENG_EXPECTED_REVISION"],
    interval: "15s",
    timeout: "5s",
    start_period: "30s",
    retries: 5,
  };
}

function mounts(values) {
  return values.map(([type, source, target, readOnly]) => ({
    type,
    source,
    target,
    read_only: readOnly,
    ...(type === "bind" ? { bind: { create_host_path: false } } : {}),
  }));
}
