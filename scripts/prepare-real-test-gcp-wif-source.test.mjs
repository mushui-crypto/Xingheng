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
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HELPER = join(SCRIPT_DIRECTORY, "prepare-real-test-gcp-wif-source.py");
const VERIFIER = join(SCRIPT_DIRECTORY, "verify-gcp-wif-bundle.mjs");
const VERSION = "20260728T062225Z";
const CERT_NAME = `leaf-${VERSION}.cert.pem`;
const KEY_NAME = `leaf-${VERSION}.key.pem`;
const SOURCE = "root/xingheng-real-test-wif-source";
const AUDIENCE_FILE = "root/xingheng-real-test-wif-audience";
const AUDIENCE = "//iam.googleapis.com/projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509";
const OPENSSL = "/usr/bin/openssl";

const PYTHON_HARNESS = String.raw`
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys

spec = importlib.util.spec_from_file_location("prepare_real_test_wif", os.environ["HELPER"])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

root = os.environ["FIXTURE_ROOT"]
stage_actual = os.path.join(root, module.STAGE.lstrip("/"))
key_actual = os.path.join(stage_actual, module.KEY_NAME)
cert_actual = os.path.join(stage_actual, module.CERT_NAME)
stage_stat = os.lstat(stage_actual)
key_stat = os.lstat(key_actual)
cert_stat = os.lstat(cert_actual)

def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

openssl = os.environ["OPENSSL"]
public_der = subprocess.check_output(
    [openssl, "pkey", "-in", key_actual, "-pubout", "-outform", "DER"]
)
key_ino = key_stat.st_ino + int(os.environ.get("KEY_INO_OFFSET", "0"))
key_sha = os.environ.get("KEY_SHA_OVERRIDE", sha(key_actual))
config = module.PrepareConfig(
    filesystem_root=root,
    gcloud_path=os.path.join(root, "usr/bin/gcloud"),
    gcloud_uid=os.geteuid(),
    openssl_path=openssl,
    openssl_uid=os.lstat(openssl).st_uid,
    owner_uid=os.geteuid(),
    owner_gid=os.getegid(),
    stage=module.STAGE,
    source=module.SOURCE,
    audience_file=module.AUDIENCE_FILE,
    key_name=module.KEY_NAME,
    cert_name=module.CERT_NAME,
    stage_dev=stage_stat.st_dev,
    stage_ino=stage_stat.st_ino,
    key=module.FrozenFile(
        dev=key_stat.st_dev,
        ino=key_ino,
        size=key_stat.st_size,
        sha256=key_sha,
    ),
    cert=module.FrozenFile(
        dev=cert_stat.st_dev,
        ino=cert_stat.st_ino,
        size=cert_stat.st_size,
        sha256=sha(cert_actual),
    ),
    public_key_sha256=hashlib.sha256(public_der).hexdigest(),
)

rename_mode = os.environ.get("RENAME_MODE", "success")

def publish(parent_fd, source, destination):
    if rename_mode == "conflict" and destination == "adc.json":
        fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
            dir_fd=parent_fd,
        )
        try:
            os.write(fd, b"foreign-receipt")
            os.fsync(fd)
        finally:
            os.close(fd)
    if rename_mode == "failure" and destination == "certificate_config.json":
        raise OSError(5, "injected publication failure")
    module._link_noreplace_for_tests(parent_fd, source, destination)

try:
    receipt = module.prepare_source(
        config,
        require_root=False,
        rename_noreplace=publish,
    )
    print(json.dumps({"ok": True, "receipt": receipt}, sort_keys=True))
except module.PreparationError as error:
    print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
    raise SystemExit(1)
`;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "xingheng-real-test-wif-helper-"));
  chmodSync(root, 0o700);
  const stage = join(root, "var/lib/xingheng-real-test/gcp-wif-build", VERSION);
  const rootHome = join(root, "root");
  const fakeBin = join(root, "usr/bin");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  mkdirSync(rootHome, { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  chmodSync(stage, 0o700);
  chmodSync(rootHome, 0o700);

  const key = join(stage, KEY_NAME);
  const cert = join(stage, CERT_NAME);
  const generated = spawnSync(
    OPENSSL,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=xingheng-test-fixture",
      "-days",
      "1",
      "-sha256",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  chmodSync(key, 0o400);
  chmodSync(cert, 0o400);

  const fakeGcloud = join(fakeBin, "gcloud");
  const fakeMode = join(fakeBin, "fake-mode");
  writeFileSync(fakeMode, "success\n", { mode: 0o600 });
  writeFileSync(
    fakeGcloud,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const mode = fs.readFileSync(path.join(path.dirname(process.argv[1]), "fake-mode"), "utf8").trim();
const args = process.argv.slice(2);
if (args[0] === "version") {
  if (args.length !== 2 || args[1] !== "--format=json") process.exit(89);
  process.stdout.write(JSON.stringify({
    "Google Cloud SDK": mode === "version-mismatch" ? "575.0.0" : "576.0.0",
  }));
  process.exit(0);
}
const expectedPrefix = [
  "iam",
  "workload-identity-pools",
  "create-cred-config",
  "projects/185789474550/locations/global/workloadIdentityPools/xingheng-rwa-real-test/providers/rwa-api-x509",
];
if (
  args.length !== 9
  || expectedPrefix.some((value, index) => args[index] !== value)
  || args[8] !== "--quiet"
  || args.some((argument) =>
    argument.startsWith("--credential-cert-trust-chain-path")
    || argument.startsWith("--service-account"))
) process.exit(89);
const value = (prefix) => {
  const item = args.find((argument) => argument.startsWith(prefix + "="));
  if (!item) process.exit(90);
  return item.slice(prefix.length + 1);
};
const certPath = value("--credential-cert-path");
const keyPath = value("--credential-cert-private-key-path");
const configPath = value("--credential-cert-configuration-output-file");
const adcPath = value("--output-file");
const certificate = {certificate_config_location: configPath};
const adc = {
  type: "external_account",
  audience: ${JSON.stringify(AUDIENCE)},
  subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
  token_url: "https://sts.mtls.googleapis.com/v1/token",
  credential_source: {certificate},
};
const config = {cert_configs: {workload: {cert_path: certPath, key_path: keyPath}}};
if (mode === "unknown") adc.unknown = true;
if (mode === "impersonation") adc.service_account_impersonation_url = "https://example.invalid";
if (mode === "client-email") adc.client_email = "forbidden@example.invalid";
if (mode === "private-key") adc.private_key = "test-only-forbidden-material";
if (mode === "unknown-source") adc.credential_source = {file: "/forbidden/token"};
if (mode === "trust-chain") certificate.trust_chain_path = "/forbidden/trust-chain.pem";
if (mode === "bad-json") {
  fs.writeFileSync(adcPath, "{", {mode: 0o600});
} else {
  fs.writeFileSync(adcPath, JSON.stringify(adc), {mode: 0o600});
}
if (mode !== "partial") {
  fs.writeFileSync(configPath, JSON.stringify(config), {mode: 0o600});
}
if (mode === "gcloud-failure") process.exit(1);
`,
    { mode: 0o755 },
  );
  chmodSync(fakeGcloud, 0o755);
  return {
    root,
    stage,
    key,
    cert,
    fakeMode,
    source: join(root, SOURCE),
    audienceFile: join(root, AUDIENCE_FILE),
  };
}

function runHarness(fixture, extraEnv = {}) {
  return spawnSync("python3", ["-c", PYTHON_HARNESS], {
    encoding: "utf8",
    env: {
      ...process.env,
      HELPER,
      FIXTURE_ROOT: fixture.root,
      OPENSSL,
      ...extraEnv,
    },
  });
}

function outputJson(result) {
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function assertNoPreparedOutput(fixture) {
  assert.equal(existsSync(fixture.source), false);
  assert.equal(existsSync(fixture.audienceFile), false);
}

test("prepares one exact four-file direct-root source without material output", () => {
  const fixture = makeFixture();
  try {
    const result = runHarness(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN (?:RSA )?PRIVATE KEY/u);
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN CERTIFICATE/u);
    assert.deepEqual(readdirSync(fixture.source).sort(), [
      "adc.json",
      "certificate_config.json",
      CERT_NAME,
      KEY_NAME,
    ].sort());
    assert.equal(readFileSync(fixture.audienceFile, "utf8"), `${AUDIENCE}\n`);
    const sourceMetadata = lstatSync(fixture.source);
    assert.equal(sourceMetadata.isDirectory(), true);
    assert.equal(sourceMetadata.mode & 0o777, 0o700);
    const audienceMetadata = lstatSync(fixture.audienceFile);
    assert.equal(audienceMetadata.isFile(), true);
    assert.equal(audienceMetadata.nlink, 1);
    assert.equal(audienceMetadata.mode & 0o777, 0o400);
    for (const name of readdirSync(fixture.source)) {
      const metadata = lstatSync(join(fixture.source, name));
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.nlink, 1);
      assert.equal(metadata.mode & 0o777, 0o400);
    }
    const adc = JSON.parse(readFileSync(join(fixture.source, "adc.json"), "utf8"));
    assert.deepEqual(adc.credential_source.certificate, {
      certificate_config_location: "/run/secrets/gcp-wif/certificate_config.json",
    });
    assert.equal("service_account_impersonation_url" in adc, false);
    assert.equal(existsSync(join(fixture.source, "trust-chain.pem")), false);
    assert.equal(readdirSync(fixture.source).some((name) => name.startsWith(".")), false);
    const verified = spawnSync(
      process.execPath,
      [VERIFIER, "source", "real-test", fixture.source, fixture.audienceFile],
      { encoding: "utf8" },
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /WIF source bundle verified/u);
    const receipt = outputJson(result);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.receipt.trust_chain, "omitted-direct-root");
    assert.equal(receipt.receipt.installed, false);
    assert.equal(receipt.receipt.probed, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects existing regular, symlinked, and hardlinked output paths without overwrite", async (t) => {
  const cases = [
    ["regular source", (fixture) => writeFileSync(fixture.source, "existing", { mode: 0o400 })],
    ["symlink source", (fixture) => {
      const target = join(fixture.root, "source-target");
      writeFileSync(target, "sentinel", { mode: 0o400 });
      symlinkSync(target, fixture.source);
    }],
    ["hardlinked audience", (fixture) => {
      const target = join(fixture.root, "audience-target");
      writeFileSync(target, "sentinel", { mode: 0o400 });
      linkSync(target, fixture.audienceFile);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture();
      try {
        mutate(fixture);
        const before = lstatSync(
          existsSync(fixture.source) ? fixture.source : fixture.audienceFile,
        );
        const result = runHarness(fixture);
        assert.notEqual(result.status, 0);
        const after = lstatSync(
          existsSync(fixture.source) ? fixture.source : fixture.audienceFile,
        );
        assert.equal(after.ino, before.ino);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("rejects frozen input inode, hash, and hardlink drift", async (t) => {
  const cases = [
    ["inode", { KEY_INO_OFFSET: "1" }, null],
    ["hash", { KEY_SHA_OVERRIDE: "0".repeat(64) }, null],
    ["hardlink", {}, (fixture) => linkSync(fixture.key, `${fixture.key}.copy`)],
  ];
  for (const [name, env, mutate] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture();
      try {
        mutate?.(fixture);
        const result = runHarness(fixture, env);
        assert.notEqual(result.status, 0);
        assertNoPreparedOutput(fixture);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("rejects failed, partial, expanded, impersonating, and invalid gcloud output", async (t) => {
  for (const mode of [
    "gcloud-failure",
    "partial",
    "unknown",
    "impersonation",
    "client-email",
    "private-key",
    "unknown-source",
    "trust-chain",
    "bad-json",
    "version-mismatch",
  ]) {
    await t.test(mode, () => {
      const fixture = makeFixture();
      try {
        writeFileSync(fixture.fakeMode, `${mode}\n`, { mode: 0o600 });
        const result = runHarness(fixture);
        assert.notEqual(result.status, 0, result.stdout);
        assertNoPreparedOutput(fixture);
        assert.doesNotMatch(result.stdout + result.stderr, /BEGIN (?:RSA )?PRIVATE KEY/u);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("no-replace collision preserves the foreign inode and stops cleanup", () => {
  const fixture = makeFixture();
  try {
    const result = runHarness(fixture, { RENAME_MODE: "conflict" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(fixture.source, "adc.json"), "utf8"), "foreign-receipt");
    assert.equal(existsSync(fixture.audienceFile), false);
    assert.match(outputJson(result).error, /cleanup stopped/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publication failure removes only batch-created receipt objects", () => {
  const fixture = makeFixture();
  try {
    const result = runHarness(fixture, { RENAME_MODE: "failure" });
    assert.notEqual(result.status, 0);
    assertNoPreparedOutput(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production and extra parameters are rejected by the fixed CLI", () => {
  for (const args of [["production"], ["real-test", "/tmp/source"], []]) {
    const result = spawnSync("python3", [HELPER, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/u);
  }
  if (process.getuid() !== 0) {
    const result = spawnSync("python3", [HELPER, "real-test"], { encoding: "utf8" });
    assert.equal(result.status, 77);
    assert.match(result.stderr, /requires root/u);
  }
});
