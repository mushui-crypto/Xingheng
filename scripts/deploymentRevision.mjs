export const REVISION_LABEL = "org.opencontainers.image.revision";
export const REQUIRED_IMAGE_COMPONENTS = Object.freeze([
  "api",
  "web",
  "strategy-tools",
  "rwa-automation-backup",
  "rwa-automation-restore",
]);

const FULL_REVISION = /^[0-9a-f]{40}$/;
const IMMUTABLE_IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_IMAGE_KEYS = Object.freeze(["api", "web", "strategyTools"]);
const PRODUCTION_SERVICE_IMAGES = Object.freeze({
  api: "api",
  web: "web",
  "strategy-history": "strategyTools",
  "sqlite-restore": "api",
  "provider-identity-preflight": "api",
  "rwa-automation-backup": "api",
  "rwa-automation-restore": "api",
});
const REAL_TEST_SERVICE_IMAGES = Object.freeze({
  api: "api",
  web: "web",
  "strategy-history": "strategyTools",
  "sqlite-backup": "api",
  "sqlite-restore": "api",
  "sqlite-verify": "api",
  "strategy-backup": "api",
  "strategy-restore": "api",
  "strategy-verify": "api",
  "volume-initialize": "api",
  "provider-identity-preflight": "api",
  "kms-health-preflight": "api",
  "rwa-automation-backup": "api",
  "rwa-automation-restore": "api",
  "rwa-automation-verify": "api",
});

export function assertFullRevision(value, field = "deployment revision") {
  if (typeof value !== "string" || !FULL_REVISION.test(value)) {
    throw new Error(`${field} must be a full lowercase Git commit`);
  }
  return value;
}

export function assertImageDigest(value, field = "image digest") {
  if (typeof value !== "string" || !IMMUTABLE_IMAGE_DIGEST.test(value)) {
    throw new Error(`${field} must be an immutable sha256 digest`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export function validateReleaseManifest(value) {
  if (!hasExactKeys(value, ["schemaVersion", "revision", "images"])) {
    throw new Error("release manifest schema is invalid");
  }
  if (value.schemaVersion !== 1 || !hasExactKeys(value.images, MANIFEST_IMAGE_KEYS)) {
    throw new Error("release manifest schema is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: assertFullRevision(value.revision, "release manifest revision"),
    images: Object.freeze({
      api: assertImageDigest(value.images.api, "API image digest"),
      web: assertImageDigest(value.images.web, "Web image digest"),
      strategyTools: assertImageDigest(
        value.images.strategyTools,
        "strategy tools image digest",
      ),
    }),
  });
}

export function parseRevisionEnv(source) {
  if (typeof source !== "string") {
    throw new Error("deployment environment is invalid");
  }
  const matches = source
    .split(/\r?\n/u)
    .filter((line) => /^XINGHENG_REVISION=/u.test(line))
    .map((line) => line.slice("XINGHENG_REVISION=".length));
  if (matches.length !== 1) {
    throw new Error("deployment environment must contain one XINGHENG_REVISION");
  }
  return assertFullRevision(matches[0], "deployment environment revision");
}

export function validateProductionComposeConfig(manifestValue, config) {
  return validateComposeConfig(
    manifestValue,
    config,
    "xingheng",
    "production",
    PRODUCTION_SERVICE_IMAGES,
  );
}

export function validateRealTestComposeConfig(manifestValue, config) {
  return validateComposeConfig(
    manifestValue,
    config,
    "xingheng-real-test",
    "real-test",
    REAL_TEST_SERVICE_IMAGES,
  );
}

function validateComposeConfig(manifestValue, config, project, environment, serviceImages) {
  const manifest = validateReleaseManifest(manifestValue);
  if (
    !config
    || typeof config !== "object"
    || Array.isArray(config)
    || config.name !== project
    || !hasExactKeys(config.services, Object.keys(serviceImages))
  ) {
    throw new Error(`${environment} Compose topology is invalid`);
  }

  for (const [serviceName, manifestKey] of Object.entries(serviceImages)) {
    const service = config.services[serviceName];
    if (
      !service
      || typeof service !== "object"
      || Array.isArray(service)
      || Object.hasOwn(service, "build")
      || service.image !== manifest.images[manifestKey]
      || service.pull_policy !== "never"
      || !service.environment
      || typeof service.environment !== "object"
      || Array.isArray(service.environment)
      || service.environment.XINGHENG_EXPECTED_REVISION !== manifest.revision
      || service.environment.XINGHENG_DEPLOYMENT_ENVIRONMENT !== environment
      || service.environment.XINGHENG_COMPOSE_PROJECT !== project
    ) {
      throw new Error(`${environment} Compose release mapping is invalid`);
    }
  }

  return manifest.revision;
}

export function verifyRevisionEvidence({
  expectedRevision,
  components,
  requireRuntimeEvidence = false,
}) {
  const expected = assertFullRevision(expectedRevision, "expected revision");
  if (!Array.isArray(components)) {
    throw new Error("deployment revision components are invalid");
  }

  const byName = new Map();
  for (const component of components) {
    if (!component || typeof component.name !== "string" || byName.has(component.name)) {
      throw new Error("deployment revision components are invalid");
    }
    byName.set(component.name, component);
  }

  for (const name of REQUIRED_IMAGE_COMPONENTS) {
    const component = byName.get(name);
    if (!component) {
      throw new Error("deployment revision component is missing");
    }
    const imageRevision = assertFullRevision(component.imageRevision, "image revision");
    const builtRevision = assertFullRevision(component.builtRevision, "built revision");
    const manifestDigest = assertImageDigest(component.manifestDigest, "manifest image digest");
    const actualDigest = assertImageDigest(component.actualDigest, "actual image digest");
    if (imageRevision !== expected || builtRevision !== expected) {
      throw new Error("deployment revision mismatch");
    }
    if (actualDigest !== manifestDigest) {
      throw new Error("deployment image digest mismatch");
    }
    if (requireRuntimeEvidence) {
      const runtimeRevision = assertFullRevision(component.runtimeRevision, "runtime revision");
      if (runtimeRevision !== expected) {
        throw new Error("deployment runtime revision mismatch");
      }
    }
  }

  return expected;
}
