import { validateProductionComposeConfig } from "./deploymentRevision.mjs";

export const PRODUCTION_PROJECT = "xingheng";
export const SHARED_INGRESS_NETWORK = "xingheng-public-ingress";

const LOGICAL_VOLUMES = Object.freeze([
  "caddy_config",
  "caddy_data",
  "rwa_automation_backups",
  "rwa_automation_data",
  "rwa_automation_lock",
  "sqlite_backups",
  "sqlite_data",
  "strategy_data",
]);
const SERVICE_MOUNTS = Object.freeze({
  api: Object.freeze([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "sqlite_backups", "/backups", false],
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", "wif", "/run/secrets/gcp-wif", true],
  ]),
  web: Object.freeze([
    ["volume", "caddy_data", "/data", false],
    ["volume", "caddy_config", "/config", false],
  ]),
  "strategy-history": Object.freeze([
    ["volume", "strategy_data", "/app/strategy-data", false],
  ]),
  "sqlite-backup": Object.freeze([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "sqlite_backups", "/backups", false],
  ]),
  "sqlite-restore": Object.freeze([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "sqlite_backups", "/backups", true],
  ]),
  "sqlite-verify": Object.freeze([
    ["volume", "sqlite_backups", "/backups", true],
  ]),
  "strategy-backup": Object.freeze([
    ["volume", "strategy_data", "/app/strategy-data", true],
    ["volume", "sqlite_backups", "/backups", false],
  ]),
  "strategy-verify": Object.freeze([
    ["volume", "sqlite_backups", "/backups", true],
  ]),
  "strategy-restore": Object.freeze([
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "sqlite_backups", "/backups", true],
  ]),
  "volume-initialize": Object.freeze([
    ["volume", "sqlite_data", "/app/data", false],
    ["volume", "strategy_data", "/app/strategy-data", false],
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
  ]),
  "provider-identity-preflight": Object.freeze([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", true],
    ["bind", "wif", "/run/secrets/gcp-wif", true],
  ]),
  "rwa-automation-backup": Object.freeze([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", true],
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", false],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", "wif", "/run/secrets/gcp-wif", true],
  ]),
  "rwa-automation-restore": Object.freeze([
    ["volume", "rwa_automation_data", "/app/rwa-automation-data", false],
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", true],
    ["volume", "rwa_automation_lock", "/app/rwa-automation-lock", false],
    ["bind", "wif", "/run/secrets/gcp-wif", true],
  ]),
  "rwa-automation-verify": Object.freeze([
    ["volume", "rwa_automation_backups", "/app/rwa-automation-backups", true],
    ["bind", "wif", "/run/secrets/gcp-wif", true],
  ]),
});

export function validateProductionTopology(manifest, production) {
  validateProductionComposeConfig(manifest, production);

  const productionApi = service(production, "api");
  const productionWeb = service(production, "web");

  const productionDomain = requiredString(productionWeb.environment?.DOMAIN);
  if (productionApi.environment?.DOMAIN !== productionDomain) {
    throw new Error("production domain boundary is invalid");
  }
  assertProductionIngressPorts(productionWeb);
  assertHealthcheck(productionApi, "production", "xingheng", false);
  assertHealthcheck(productionWeb, "production", "xingheng", true);

  assertVolumes(production, PRODUCTION_PROJECT);
  assertServiceMounts(production, "/run/xingheng/gcp-wif");
  assertWifMount(productionApi, "/run/xingheng/gcp-wif");
  assertProviderIdentityPreflight(
    production,
    productionApi,
    "production",
    "xingheng",
  );
  assertRwaAutomationVerify(production, productionApi);
  assertIngress(production, productionWeb, "production-web");
  return true;
}

function assertProductionIngressPorts(web) {
  const ports = Array.isArray(web.ports) ? web.ports : [];
  const normalized = ports.map((port) =>
    `${String(port?.published)}:${String(port?.target)}/${port?.protocol ?? "tcp"}`).sort();
  if (normalized.join(",") !== ["443:443/tcp", "443:443/udp", "80:80/tcp"].sort().join(",")) {
    throw new Error("production ingress port set is invalid");
  }
}

function assertHealthcheck(serviceValue, environment, project, web) {
  const health = serviceValue.healthcheck;
  const command = health?.test;
  const webCommandValid = Array.isArray(command)
    && command.length === 2
    && command[0] === "CMD-SHELL"
    && typeof command[1] === "string"
    && command[1].includes(environment)
    && command[1].includes("127.0.0.1/api/health");
  if (
    !Array.isArray(command)
    || (web && !webCommandValid)
    || (!web && (
      command.length !== 4
      || command[0] !== "CMD"
      || typeof command.at(-1) !== "string"
      || !command.at(-1).includes(environment)
      || !command.at(-1).includes(project)
      || !command.at(-1).includes("cache-control")
      || !command.at(-1).includes("XINGHENG_EXPECTED_REVISION")
    ))
    || health.interval !== "15s"
    || health.timeout !== "5s"
    || health.start_period !== "30s"
    || health.retries !== 5
  ) throw new Error("deployment health identity contract is invalid");
}

function assertServiceMounts(config, wifSource) {
  for (const [name, value] of Object.entries(record(config.services, "Compose services"))) {
    const expected = SERVICE_MOUNTS[name];
    if (!expected) throw new Error("deployment service mount contract is missing");
    const actual = Array.isArray(value?.volumes) ? value.volumes : [];
    if (actual.length !== expected.length) {
      throw new Error("deployment service mount set is invalid");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const [type, source, target, readOnly] = expected[index];
      const mount = actual[index];
      const expectedSource = type === "bind" ? wifSource : source;
      if (
        mount?.type !== type
        || mount?.source !== expectedSource
        || mount?.target !== target
        || Boolean(mount?.read_only) !== readOnly
        || (
          type === "bind"
          && mount?.bind?.create_host_path !== false
        )
      ) {
        throw new Error("deployment service mount mapping is invalid");
      }
    }
  }
}

function assertVolumes(config, project) {
  const volumes = record(config.volumes, "Compose volumes");
  const keys = Object.keys(volumes).sort();
  if (keys.join("\n") !== [...LOGICAL_VOLUMES].sort().join("\n")) {
    throw new Error("deployment volume set is invalid");
  }
  for (const name of LOGICAL_VOLUMES) {
    if (volumes[name]?.name !== `${project}_${name}`) {
      throw new Error("deployment volume identity is invalid");
    }
  }
}

function assertWifMount(api, expectedSource) {
  const mounts = Array.isArray(api.volumes) ? api.volumes : [];
  const wif = mounts.filter((mount) => mount?.target === "/run/secrets/gcp-wif");
  if (
    wif.length !== 1
    || wif[0].type !== "bind"
    || wif[0].source !== expectedSource
    || wif[0].read_only !== true
    || wif[0].bind?.create_host_path !== false
    || api.environment?.XINGHENG_WIF_HOST_PATH !== expectedSource
  ) {
    throw new Error("deployment WIF boundary is invalid");
  }
}

function assertIngress(config, web, alias) {
  const networks = record(config.networks, "Compose networks");
  if (networks.public_ingress?.name !== SHARED_INGRESS_NETWORK) {
    throw new Error("shared ingress network identity is invalid");
  }
  const serviceNetworks = record(web.networks, "Web networks");
  const aliases = serviceNetworks.public_ingress?.aliases;
  if (!Array.isArray(aliases) || aliases.length !== 1 || aliases[0] !== alias) {
    throw new Error("shared ingress alias is invalid");
  }
}

function assertProviderIdentityPreflight(config, api, environment, project) {
  const preflight = service(config, "provider-identity-preflight");
  const expectedCommand = [
    "node",
    "dist-server/operations/rwa-provider-identity-preflight.js",
  ];
  if (
    preflight.environment?.XINGHENG_DEPLOYMENT_ENVIRONMENT !== environment
    || preflight.environment?.XINGHENG_COMPOSE_PROJECT !== project
    || preflight.environment?.RWA_AUTOMATION_SERVER_KILL_SWITCH !== "true"
    || preflight.environment?.RWA_PROVIDER_PREFLIGHT_USER_ID === undefined
    || api.environment?.RWA_PROVIDER_PREFLIGHT_USER_ID !== undefined
    || preflight.environment?.RWA_GCP_KMS_KEY_NAME !== api.environment?.RWA_GCP_KMS_KEY_NAME
    || preflight.environment?.RWA_GCP_WIF_AUDIENCE !== api.environment?.RWA_GCP_WIF_AUDIENCE
    || JSON.stringify(preflight.command) !== JSON.stringify(expectedCommand)
    || preflight.read_only !== true
    || JSON.stringify(preflight.cap_drop) !== JSON.stringify(["ALL"])
    || !Array.isArray(preflight.security_opt)
    || !preflight.security_opt.includes("no-new-privileges:true")
    || (Array.isArray(preflight.ports) && preflight.ports.length > 0)
  ) {
    throw new Error("provider identity preflight boundary is invalid");
  }
}

function assertRwaAutomationVerify(config, api) {
  const verify = service(config, "rwa-automation-verify");
  if (
    verify.environment?.RWA_GCP_KMS_KEY_NAME !== api.environment?.RWA_GCP_KMS_KEY_NAME
    || verify.environment?.RWA_GCP_WIF_AUDIENCE !== api.environment?.RWA_GCP_WIF_AUDIENCE
    || verify.environment?.RWA_AUTOMATION_VERIFY_FILE === undefined
    || JSON.stringify(verify.command) !== JSON.stringify([
      "node", "dist-server/operations/rwa-automation-backup-verify.js",
    ])
    || verify.read_only !== true
    || JSON.stringify(verify.cap_drop) !== JSON.stringify(["ALL"])
    || !Array.isArray(verify.security_opt)
    || !verify.security_opt.includes("no-new-privileges:true")
    || (Array.isArray(verify.ports) && verify.ports.length > 0)
  ) throw new Error("RWA automation verify boundary is invalid");
}

function service(config, name) {
  return record(record(config.services, "Compose services")[name], `Compose ${name}`);
}

function requiredString(value) {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error("deployment domain is missing");
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
