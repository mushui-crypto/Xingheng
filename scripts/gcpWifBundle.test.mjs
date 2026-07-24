import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readExpectedAudience, validateWifBundle } from "./gcpWifBundle.mjs";

const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/xingheng-prod/providers/vultr-mtls";
const INSTALLER = new URL("./install-gcp-wif.sh", import.meta.url).pathname;

function writeWifFixture(directory) {
  mkdirSync(directory, { mode: 0o700 });
  const files = {
    "adc.json": JSON.stringify({
      type: "external_account",
      audience: AUDIENCE,
      subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
      token_url: "https://sts.mtls.googleapis.com/v1/token",
      credential_source: {
        certificate: {
          certificate_config_location: "/run/secrets/gcp-wif/certificate_config.json",
          trust_chain_path: "/run/secrets/gcp-wif/trust-chain.pem",
        },
      },
    }),
    "certificate_config.json": JSON.stringify({
      cert_configs: {
        workload: {
          cert_path: "/run/secrets/gcp-wif/client-cert.pem",
          key_path: "/run/secrets/gcp-wif/client-key.pem",
        },
      },
    }),
    "trust-chain.pem": "test-only-trust-chain",
    "client-cert.pem": "test-only-certificate",
    "client-key.pem": "test-only-private-key-reference",
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(directory, name), value, { mode: 0o400 });
  }
  const audienceFile = join(directory, "..", "audience");
  writeFileSync(audienceFile, `${AUDIENCE}\n`, { mode: 0o400 });
  return { audienceFile };
}

test("accepts one exact root-only WIF source bundle without printing material", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-wif-source-"));
  const source = join(root, "source");
  try {
    const { audienceFile } = writeWifFixture(source);
    const expected = readExpectedAudience(audienceFile);
    const result = validateWifBundle(source, expected);
    assert.deepEqual([...result.fileNames].sort(), [
      "adc.json",
      "certificate_config.json",
      "client-cert.pem",
      "client-key.pem",
      "trust-chain.pem",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects partial, extra, symlinked, hardlinked, and permissive WIF bundles", () => {
  const mutations = [
    (source) => rmSync(join(source, "trust-chain.pem")),
    (source) => writeFileSync(join(source, "unknown.txt"), "x", { mode: 0o400 }),
    (source) => {
      const path = join(source, "client-cert.pem");
      const target = `${path}.target`;
      rmSync(path);
      writeFileSync(target, "cert", { mode: 0o400 });
      symlinkSync(target, path);
    },
    (source) => linkSync(join(source, "client-key.pem"), join(source, "key-copy.pem")),
    (source) => chmodSync(join(source, "adc.json"), 0o600),
  ];
  for (const mutate of mutations) {
    const root = mkdtempSync(join(tmpdir(), "xingheng-wif-negative-"));
    const source = join(root, "source");
    try {
      const { audienceFile } = writeWifFixture(source);
      mutate(source);
      assert.throws(
        () => validateWifBundle(source, readExpectedAudience(audienceFile)),
        /boundary|unknown|missing/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects untrusted audience, STS URL, source shape, and path escape", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-wif-config-negative-"));
  const source = join(root, "source");
  try {
    const { audienceFile } = writeWifFixture(source);
    const adcPath = join(source, "adc.json");
    const configPath = join(source, "certificate_config.json");
    const originalAdc = JSON.parse(readFileSync(adcPath, "utf8"));
    const originalConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const rewrite = (path, value) => {
      chmodSync(path, 0o600);
      writeFileSync(path, JSON.stringify(value));
      chmodSync(path, 0o400);
    };
    const cases = [
      [adcPath, { ...originalAdc, audience: `${AUDIENCE}-other` }],
      [adcPath, { ...originalAdc, token_url: "https://example.invalid/token" }],
      [adcPath, { ...originalAdc, credential_source: { file: "/tmp/token" } }],
      [configPath, {
        ...originalConfig,
        cert_configs: {
          workload: {
            ...originalConfig.cert_configs.workload,
            key_path: "/run/secrets/gcp-wif/../client-key.pem",
          },
        },
      }],
    ];
    for (const [path, value] of cases) {
      rewrite(path, value);
      assert.throws(
        () => validateWifBundle(source, readExpectedAudience(audienceFile)),
        /boundary|invalid/u,
      );
      rewrite(adcPath, originalAdc);
      rewrite(configPath, originalConfig);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFakeInstallerCommands(directory) {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "node"), `#!/bin/sh
command="$2"
echo "node:$command" >> "$FAKE_EVENT_LOG"
if [ "\${FAKE_NODE_FAIL:-}" = "$command" ]; then exit 1; fi
`, { mode: 0o755 });
  writeFileSync(join(bin, "install"), `#!/bin/sh
eval "last=\\\${$#}"
mkdir -p "$last"
echo "install:$last" >> "$FAKE_EVENT_LOG"
`, { mode: 0o755 });
  writeFileSync(join(bin, "mount"), `#!/bin/sh
echo "mount:$*" >> "$FAKE_EVENT_LOG"
`, { mode: 0o755 });
  writeFileSync(join(bin, "findmnt"), "#!/bin/sh\necho tmpfs\n", { mode: 0o755 });
  writeFileSync(join(bin, "mountpoint"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(bin, "umount"), `#!/bin/sh
echo "umount:$*" >> "$FAKE_EVENT_LOG"
`, { mode: 0o755 });
  return bin;
}

test("WIF installer performs no mount when source validation fails", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-wif-installer-preflight-"));
  try {
    const bin = writeFakeInstallerCommands(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [INSTALLER, "/source", "/audience"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_NODE_FAIL: "source",
        WIF_HOST_ROOT: join(root, "host", "gcp-wif"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["node:source"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIF installer rejects a production target override before mounting", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-wif-installer-target-"));
  try {
    const bin = writeFakeInstallerCommands(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [INSTALLER, "/source", "/audience"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        WIF_HOST_ROOT: join(root, "host", "gcp-wif"),
      },
    });
    assert.equal(result.status, 78);
    assert.equal(existsSync(log), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIF installer moves the tmpfs only after complete copy validation", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-wif-installer-order-"));
  try {
    const bin = writeFakeInstallerCommands(root);
    const log = join(root, "events.log");
    const result = spawnSync("sh", [INSTALLER, "/source", "/audience"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        WIF_HOST_ROOT: join(root, "host", "gcp-wif"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(log, "utf8").trim().split("\n");
    const sourceIndex = events.indexOf("node:source");
    const copyIndex = events.indexOf("node:copy");
    const moveIndex = events.findIndex((entry) => entry.startsWith("mount:--move"));
    const installedIndex = events.indexOf("node:installed");
    assert.ok(sourceIndex >= 0 && sourceIndex < copyIndex);
    assert.ok(copyIndex < moveIndex && moveIndex < installedIndex);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIF installer unmounts a published target when final validation fails", () => {
  const root = mkdtempSync(join(tmpdir(), "xingheng-wif-installer-rollback-"));
  try {
    const bin = writeFakeInstallerCommands(root);
    const log = join(root, "events.log");
    const target = join(root, "host", "gcp-wif");
    const result = spawnSync("sh", [INSTALLER, "/source", "/audience"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENT_LOG: log,
        FAKE_NODE_FAIL: "installed",
        WIF_HOST_ROOT: target,
      },
    });
    assert.notEqual(result.status, 0);
    const events = readFileSync(log, "utf8").trim().split("\n");
    const moveIndex = events.findIndex((entry) => entry.startsWith("mount:--move"));
    const unmountIndex = events.findIndex((entry) => entry === `umount:${target}`);
    assert.ok(moveIndex >= 0 && unmountIndex > moveIndex);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const REPO_ROOT = new URL("../", import.meta.url).pathname;
